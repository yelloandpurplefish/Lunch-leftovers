/**
 * 剩食紀錄流程（取代原本的「填寫剩食克數領獎」）。
 *
 * 一班一天一場量測，四個餐桶依序辨識：
 *   主食桶 → 配菜桶A(主菜+副菜一) → 配菜桶B(副菜二+蔬菜) → 湯桶 → 完成彙總
 *
 * 每桶：拍照 → 辨識服務回各菜殘餘比例 → 午餐長確認/微調 → 換算克數/成本/碳排。
 * 每次量測或微調都會即時更新 `dish_leftovers`（每班每天每菜品一筆），
 * 跨班支援查詢才有即時資料可用。
 *
 * 完成彙總時：算當餐減碳量 → 班級 E幣（+完成四桶的班級 S幣）→ 全額分給班上每位成員。
 * 以 `coinsAwarded` 旗標保護，重新辨識重算不會重複發幣。
 *
 * 權限：只有午餐長（含導師/管理員）能紀錄；學生端是唯讀。
 */
const { db, admin } = require('../config/firebase');
const {
  COL, ids, BUCKET_LAYOUT, MENU_SLOTS, SLOT_LABEL, SLOT_CATEGORY, COIN_RULES,
} = require('../config/schema');
const { today, isYmd, daysAgo } = require('../lib/dates');
const { computeLeftover, summarize, computeReduction, computeClassECoins, clamp01, round } = require('../lib/scoring');
const { recognizeBucket } = require('../lib/recognizer');
const vision = require('../lib/vision');
const { awardClassAndMembers } = require('../lib/coins');

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const bad = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

// ── 讀取輔助 ────────────────────────────────────────────────────────
async function getClass(classId) {
  const snap = await db.collection(COL.classes).doc(classId).get();
  if (!snap.exists) {
    const err = new Error('查無此班級');
    err.status = 404;
    throw err;
  }
  return { id: snap.id, ...snap.data() };
}

/** daily_menu/{date}.dishes = { staple: dishId, ... } */
async function getMenuSlots(date) {
  const snap = await db.collection(COL.dailyMenu).doc(date).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data.dishes) return null;
  return data.dishes;
}

async function getDishMap(dishIds) {
  const unique = [...new Set(dishIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const snaps = await db.getAll(...unique.map((id) => db.collection(COL.dishes).doc(id)));
  const map = new Map();
  snaps.forEach((s) => {
    if (s.exists) map.set(s.id, { dishId: s.id, ...s.data() });
  });
  return map;
}

/** 由菜單 slot 對應建立四桶初始狀態。*/
function buildBuckets(menuSlots, dishMap) {
  const buckets = {};
  for (const layout of BUCKET_LAYOUT) {
    buckets[layout.id] = {
      bucketId: layout.id,
      label: layout.label,
      measured: false,
      emptied: false,
      source: null,
      bucketConfidence: 0,
      warnings: [],
      items: layout.dishSlots.map((slot) => {
        const dishId = menuSlots[slot] || null;
        const dish = dishId ? dishMap.get(dishId) : null;
        return {
          slot,
          label: SLOT_LABEL[slot],
          category: SLOT_CATEGORY[slot],
          dishId,
          dishName: dish ? dish.name : SLOT_LABEL[slot],
          remainingRatio: 0,
          confidence: 0,
          needsReview: false,
          suppliedG: 0,
          leftoverG: 0,
          cost: 0,
          co2e: 0,
        };
      }),
    };
  }
  return buckets;
}

const sessionRef = (classId, date) => db.collection(COL.mealSessions).doc(ids.mealSession(classId, date));

async function loadSession(classId, date) {
  const snap = await sessionRef(classId, date).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/** 依殘餘比例重算單桶各菜的克數/成本/碳排。*/
async function recomputeBucket(bucket, servings) {
  const dishMap = await getDishMap(bucket.items.map((i) => i.dishId));
  const items = bucket.items.map((it) => {
    if (!it.dishId || bucket.emptied) {
      return { ...it, remainingRatio: 0, leftoverG: 0, cost: 0, co2e: 0 };
    }
    const dish = dishMap.get(it.dishId);
    if (!dish) return it;
    return { ...it, ...computeLeftover(dish, it.remainingRatio, servings) };
  });
  return { ...bucket, items };
}

/**
 * 把某桶的各菜寫進 dish_leftovers（每班每天每菜品一筆，決定性 id）。
 * 這是跨班支援與剩餘量曲線的資料來源，量測/微調後即時更新。
 */
async function upsertDishLeftovers(session, bucket) {
  const batch = db.batch();
  bucket.items.forEach((it) => {
    if (!it.dishId) return;
    batch.set(
      db.collection(COL.dishLeftovers).doc(ids.dishLeftover(session.classId, session.date, it.slot)),
      {
        schoolId: session.schoolId || null,
        classId: session.classId,
        className: session.className || null,
        grade: session.grade || null,
        date: session.date,
        slot: it.slot,
        dishId: it.dishId,
        dishName: it.dishName,
        category: it.category || null,
        suppliedG: it.suppliedG || 0,
        leftoverG: it.leftoverG || 0,
        remainingRatio: it.remainingRatio || 0,
        cost: it.cost || 0,
        co2e: it.co2e || 0,
        source: bucket.source || 'mock',
        confidence: it.confidence || 0,
        needsReview: Boolean(it.needsReview),
        sessionId: ids.mealSession(session.classId, session.date),
        emptied: Boolean(bucket.emptied),
        updatedAt: serverTime(),
      },
      { merge: true }
    );
  });
  await batch.commit();
}

/** 該班該菜近 N 餐的平均剩食克數，作為減碳基準線。*/
async function baselineByDish(classId, dishIds, excludeDate) {
  const map = new Map();
  for (const dishId of [...new Set(dishIds.filter(Boolean))]) {
    const snap = await db.collection(COL.dishLeftovers)
      .where('classId', '==', classId)
      .where('dishId', '==', dishId)
      .orderBy('date', 'desc')
      .limit(COIN_RULES.baselineWindow + 1)
      .get();
    const past = snap.docs
      .map((d) => d.data())
      .filter((d) => d.date !== excludeDate && Number(d.suppliedG) > 0);
    if (past.length === 0) continue;
    const avg = past.reduce((a, d) => a + Number(d.leftoverG || 0), 0) / past.length;
    map.set(dishId, avg);
  }
  return map;
}

/** 對外的場次摘要（前端用）。*/
function presentSession(session) {
  if (!session) return null;
  const buckets = BUCKET_LAYOUT.map((l) => session.buckets[l.id]).filter(Boolean);
  return {
    sessionId: session.id,
    classId: session.classId,
    className: session.className,
    date: session.date,
    status: session.status,
    servings: session.servings,
    coinsAwarded: Boolean(session.coinsAwarded),
    buckets: buckets.map((b) => ({
      bucketId: b.bucketId,
      label: b.label,
      measured: b.measured,
      emptied: b.emptied,
      source: b.source,
      bucketConfidence: b.bucketConfidence,
      warnings: b.warnings || [],
      remainingPct: avgRemainingPct(b),
      items: b.items,
    })),
    summary: session.summary || null,
    reduction: session.reduction || null,
    finalizedAt: session.finalizedAt ? session.finalizedAt.toDate().toISOString() : null,
  };
}

function avgRemainingPct(bucket) {
  const items = bucket.items.filter((i) => i.dishId);
  if (items.length === 0 || bucket.emptied) return 0;
  return Math.round((items.reduce((a, i) => a + Number(i.remainingRatio || 0), 0) / items.length) * 100);
}

/** 紀錄者的班級（午餐長/導師自己的班，管理員可用 query 指定）。*/
function recorderClassId(req) {
  return String(req.query.classId || req.body.classId || req.user.classId || '');
}

// ── 端點 ────────────────────────────────────────────────────────────

/** GET /api/record/today — 今日場次狀態（沒有就回 status: none）*/
const getTodaySession = async (req, res) => {
  try {
    const classId = recorderClassId(req);
    if (!classId) return bad(res, 400, '此帳號尚未編入班級');
    const date = isYmd(req.query.date) ? req.query.date : today();

    const session = await loadSession(classId, date);
    if (!session) {
      const menuSlots = await getMenuSlots(date);
      return res.status(200).json({
        success: true,
        status: 'none',
        date,
        classId,
        menuReady: Boolean(menuSlots),
        message: menuSlots ? '今日尚未開始紀錄' : '今日尚無菜單，請先由管理員排菜',
      });
    }
    return res.status(200).json({ success: true, status: session.status, session: presentSession(session) });
  } catch (error) {
    console.error('取得今日場次失敗:', error);
    return bad(res, error.status || 500, error.message || '取得今日場次失敗');
  }
};

/** POST /api/record/start — 建立當日場次（同班同日重複呼叫回同一場）*/
const startSession = async (req, res) => {
  try {
    const classId = recorderClassId(req);
    if (!classId) return bad(res, 400, '此帳號尚未編入班級');
    const date = isYmd(req.body.date) ? req.body.date : today();

    const existing = await loadSession(classId, date);
    if (existing) {
      return res.status(200).json({ success: true, session: presentSession(existing), message: '沿用今日已開始的紀錄' });
    }

    const menuSlots = await getMenuSlots(date);
    if (!menuSlots) return bad(res, 404, `${date} 尚無菜單，請先由管理員排菜`);

    const klass = await getClass(classId);
    const dishMap = await getDishMap(MENU_SLOTS.map((s) => menuSlots[s]));
    const servings = Number(klass.headcount || 0);
    if (servings <= 0) return bad(res, 400, '此班級尚未設定人數，無法換算供應量');

    const session = {
      sessionId: ids.mealSession(classId, date),
      classId,
      className: klass.name || null,
      grade: klass.grade || null,
      schoolId: klass.schoolId || null,
      date,
      menuId: date,
      status: 'measuring',
      servings,
      buckets: buildBuckets(menuSlots, dishMap),
      coinsAwarded: false,
      startedBy: req.user.uid,
      startedAt: serverTime(),
    };
    await sessionRef(classId, date).set(session);

    return res.status(201).json({ success: true, session: presentSession({ id: session.sessionId, ...session }) });
  } catch (error) {
    console.error('建立場次失敗:', error);
    return bad(res, error.status || 500, error.message || '建立場次失敗');
  }
};

/**
 * POST /api/record/bucket/:bucketId/measure
 * body: { image?(base64), ratios?, emptied?, rectified?, pxPerMm?, tiltDeg? }
 *
 * 來源優先序：ratios（人工）→ image + 辨識服務 → 預設估算。
 */
const measureBucket = async (req, res) => {
  try {
    const classId = recorderClassId(req);
    const date = isYmd(req.body.date) ? req.body.date : today();
    const { bucketId } = req.params;

    const session = await loadSession(classId, date);
    if (!session) return bad(res, 404, '今日尚未開始紀錄，請先開始');
    if (!session.buckets[bucketId]) return bad(res, 404, `場次沒有這個桶：${bucketId}`);

    const bucket = session.buckets[bucketId];
    const emptied = Boolean(req.body.emptied);
    const manualRatios = req.body.ratios || null;
    const image = typeof req.body.image === 'string' ? req.body.image : null;

    let updated;
    const warnings = [];
    let source = 'mock';

    if (emptied) {
      updated = { ...bucket, emptied: true, measured: true, source: 'manual', bucketConfidence: 1, warnings: [] };
      source = 'manual';
    } else {
      let rec = null;
      if (image && !manualRatios && vision.visionEnabled()) {
        const dishMap = await getDishMap(bucket.items.map((i) => i.dishId));
        try {
          rec = await vision.recognizeBucketWithVision({
            bucketId,
            image,
            rectified: Boolean(req.body.rectified),
            pxPerMm: req.body.pxPerMm,
            tiltDeg: req.body.tiltDeg,
            expected: bucket.items.map((it) => {
              const dish = it.dishId ? dishMap.get(it.dishId) : null;
              return {
                slot: it.slot,
                dishId: it.dishId,
                dishName: it.dishName,
                category: it.category,
                suppliedG: dish ? Number(dish.portionG || 0) * session.servings : undefined,
              };
            }),
          });
          warnings.push(...(rec.warnings || []));
        } catch (err) {
          warnings.push(`影像辨識無法使用（${err.message}），已改用預設估算，請確認各菜殘餘比例`);
          rec = null;
        }
      }

      if (!rec) {
        rec = recognizeBucket({
          bucketId,
          expected: bucket.items.map((i) => ({ slot: i.slot, dishId: i.dishId, dishName: i.dishName })),
          manualRatios,
          seed: `${session.sessionId}_${bucketId}`,
        });
        warnings.push(...(rec.warnings || []));
      }
      source = rec.source;

      const bySlot = new Map(rec.items.map((i) => [i.slot, i]));
      updated = {
        ...bucket,
        emptied: false,
        measured: true,
        source,
        bucketConfidence: rec.bucketConfidence,
        warnings,
        measuredBy: req.user.uid,
        measuredAt: serverTime(),
        photoProvided: Boolean(image),
        visionMs: rec.serverMs || null,
        tiltDeg: rec.tiltDeg == null ? null : rec.tiltDeg,
        items: bucket.items.map((it) => {
          const r = bySlot.get(it.slot);
          if (!r) return it;
          return {
            ...it,
            remainingRatio: clamp01(r.remainingRatio),
            confidence: r.confidence,
            needsReview: Boolean(r.needsReview),
            // 保留辨識當下的原始輸出，供演算法優化分析（前期主要目的）
            visionGrams: r.visionGrams == null ? null : r.visionGrams,
            visionAreaFraction: r.visionAreaFraction == null ? null : r.visionAreaFraction,
            method: r.method || null,
          };
        }),
      };
      updated = await recomputeBucket(updated, session.servings);
    }

    const buckets = { ...session.buckets, [bucketId]: updated };
    await sessionRef(classId, date).update({ buckets, status: 'measuring', updatedAt: serverTime() });
    await upsertDishLeftovers({ ...session, id: session.sessionId }, updated);

    return res.status(200).json({
      success: true,
      source,
      warnings,
      bucket: presentSession({ ...session, buckets }).buckets.find((b) => b.bucketId === bucketId),
    });
  } catch (error) {
    console.error('量測餐桶失敗:', error);
    return bad(res, error.status || 500, error.message || '量測餐桶失敗');
  }
};

/** PATCH /api/record/bucket/:bucketId — 午餐長微調殘餘比例／標記清空 */
const adjustBucket = async (req, res) => {
  try {
    const classId = recorderClassId(req);
    const date = isYmd(req.body.date) ? req.body.date : today();
    const { bucketId } = req.params;

    const session = await loadSession(classId, date);
    if (!session) return bad(res, 404, '今日尚未開始紀錄');
    const bucket = session.buckets[bucketId];
    if (!bucket) return bad(res, 404, `場次沒有這個桶：${bucketId}`);

    const ratios = req.body.ratios || {};
    let next = { ...bucket, measured: true };
    if (req.body.emptied !== undefined) next.emptied = Boolean(req.body.emptied);

    let edited = false;
    next.items = bucket.items.map((it) => {
      if (ratios[it.slot] === undefined) return it;
      const v = clamp01(ratios[it.slot]);
      if (Math.abs(v - Number(it.remainingRatio || 0)) > 1e-6) edited = true;
      // 午餐長看過並確認的欄位不再標示「需確認」
      return { ...it, remainingRatio: v, needsReview: false };
    });
    // 只有真的改過數值才把來源記為人工，否則保留 vision/mock 供品質統計
    if (edited) next.source = 'manual';
    next = await recomputeBucket(next, session.servings);

    const buckets = { ...session.buckets, [bucketId]: next };
    await sessionRef(classId, date).update({ buckets, updatedAt: serverTime() });
    await upsertDishLeftovers({ ...session, id: session.sessionId }, next);

    return res.status(200).json({
      success: true,
      edited,
      bucket: presentSession({ ...session, buckets }).buckets.find((b) => b.bucketId === bucketId),
    });
  } catch (error) {
    console.error('微調餐桶失敗:', error);
    return bad(res, error.status || 500, error.message || '微調餐桶失敗');
  }
};

/** POST /api/record/finalize — 完成當日紀錄：彙總 + 減碳 + 班級發幣 */
const finalizeSession = async (req, res) => {
  try {
    const classId = recorderClassId(req);
    const date = isYmd(req.body.date) ? req.body.date : today();

    const session = await loadSession(classId, date);
    if (!session) return bad(res, 404, '今日尚未開始紀錄');

    const buckets = Object.values(session.buckets);
    const unmeasured = buckets.filter((b) => !b.measured && !b.emptied);
    if (unmeasured.length > 0) {
      return bad(res, 400, `還有 ${unmeasured.length} 個餐桶未辨識`, {
        pending: unmeasured.map((b) => b.label),
      });
    }

    const leftovers = [];
    buckets.forEach((b) => leftovers.push(...b.items.filter((i) => i.dishId)));

    const summary = summarize(leftovers);
    const dishMap = await getDishMap(leftovers.map((l) => l.dishId));
    const baseline = await baselineByDish(classId, leftovers.map((l) => l.dishId), date);
    const reduction = computeReduction(leftovers, dishMap, baseline, session.servings);

    const classE = computeClassECoins(reduction.reducedCo2e);
    const classS = COIN_RULES.FULL_SESSION_CLASS_S;

    let awarded = null;
    if (!session.coinsAwarded && (classE > 0 || classS > 0)) {
      // 班級增長全額加給班上每位成員（班級池另外記帳）
      awarded = await awardClassAndMembers({
        classId,
        E: classE,
        S: classS,
        reason: `當餐減碳 ${reduction.reducedCo2e} kgCO2e`,
        refType: 'meal_session',
        refId: session.sessionId,
        date,
      });
    }

    await sessionRef(classId, date).update({
      status: 'done',
      summary,
      reduction,
      classCoins: { E: classE, S: classS },
      baselineUsed: [...baseline.entries()].map(([dishId, g]) => ({ dishId, baselineG: round(g, 1) })),
      coinsAwarded: true,
      finalizedBy: req.user.uid,
      finalizedAt: serverTime(),
    });

    return res.status(200).json({
      success: true,
      message: session.coinsAwarded ? '已重新計算（本餐先前已發幣，不重複發放）' : '今日紀錄完成！',
      summary,
      reduction,
      classCoins: { E: classE, S: classS },
      sharedTo: awarded ? awarded.members : 0,
    });
  } catch (error) {
    console.error('完成紀錄失敗:', error);
    return bad(res, error.status || 500, error.message || '完成紀錄失敗');
  }
};

/** GET /api/record/history?range=week|month — 本班剩餘量歷史（曲線用）*/
const getRecordHistory = async (req, res) => {
  try {
    const classId = recorderClassId(req) || req.user.classId;
    if (!classId) return bad(res, 400, '此帳號尚未編入班級');
    const days = String(req.query.range || 'week').includes('month') ? 30 : 7;
    const since = daysAgo(days - 1);

    const snap = await db.collection(COL.mealSessions)
      .where('classId', '==', classId)
      .orderBy('date', 'desc')
      .limit(days)
      .get();

    const records = snap.docs
      .map((d) => d.data())
      .filter((s) => s.date >= since && s.status === 'done')
      .map((s) => ({
        date: s.date,
        totalG: s.summary ? s.summary.totalG : 0,
        totalCost: s.summary ? s.summary.totalCost : 0,
        totalCo2e: s.summary ? s.summary.totalCo2e : 0,
        reducedCo2e: s.reduction ? s.reduction.reducedCo2e : 0,
        classCoins: s.classCoins || null,
      }))
      .reverse();

    return res.status(200).json({ success: true, classId, range: `${days}d`, records });
  } catch (error) {
    console.error('取得紀錄歷史失敗:', error);
    return bad(res, 500, error.message || '取得紀錄歷史失敗');
  }
};

/** GET /api/record/vision-status — 辨識服務是否可用 */
const getVisionStatus = async (req, res) => {
  const status = await vision.visionStatus();
  return res.status(200).json({ success: true, ...status });
};

module.exports = {
  getTodaySession,
  startSession,
  measureBucket,
  adjustBucket,
  finalizeSession,
  getRecordHistory,
  getVisionStatus,
  // 供其他 controller 重用
  _internals: { getClass, getMenuSlots, getDishMap, loadSession, presentSession },
};
