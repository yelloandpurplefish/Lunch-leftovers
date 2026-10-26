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
const { COL, ids, ROLES, BUCKET_LAYOUT, MENU_SLOTS, SLOT_LABEL, SLOT_CATEGORY, COIN_RULES } = require('../config/schema');
const { today, isYmd, daysAgo } = require('../lib/dates');
const { computeLeftover, summarize, computeReduction, clamp01, round, computeNutrition, computeEnergyCoins, computeSdg, leftoverFromWeight } = require('../lib/scoring');
const { getSettings } = require('../lib/settings');
const { recognizeBucket } = require('../lib/recognizer');
const vision = require('../lib/vision');
const { awardClassAndMembers } = require('../lib/coins');
const { latestReading } = require('../lib/scaleReadings');
const bucketTare = require('../lib/bucketTare');
const scaleReadings = require('../lib/scaleReadings');
const {
  PROVENANCE, LEVEL, isRejected, needsAttention, usableForCalibration,
  normalizeLevel, normalizeProvenance,
} = require('../lib/provenance');

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
/**
 * 決定這筆紀錄的資料來源標記。
 *
 * 辨識服務有給就用它的（判斷邏輯在模組裡，後端不重做）；
 * 沒有給就依實際用到什麼推定，而且**一律取最保守的值**——
 * 寧可標成不可用於校正，也不要讓亂數估算混進迴歸樣本。
 */
function resolveProvenance({ review, image, source, reading }) {
  if (review && review.provenance) return normalizeProvenance(review.provenance);
  if (source === 'mock') return PROVENANCE.MANUAL;      // 預設估算不是量測
  if (image) {
    return reading && reading.state === 'ok'
      ? PROVENANCE.AUTO
      : PROVENANCE.IMAGE_ONLY;
  }
  return PROVENANCE.MANUAL;
}

/**
 * 這筆是否還有未處理的提示（L1 以上且記錄者尚未確認）。
 *
 * provenance 說的是「**如果**這筆被接受，它的來源是什麼」；
 * 但只要還有沒回應的 confirm/input，這筆就還是暫定的。
 * 待確認的紀錄**不可進校正資料集**——601% 殘差的那一筆若混進迴歸，
 * 汙染程度比沒有資料更嚴重。記錄者確認後會帶 confirmed=true 重送，
 * 屆時 provenance 變成 confirmed，才真正可用。
 */
function isPendingReview(review, confirmed) {
  if (!review) return false;
  return needsAttention(review.level) && !confirmed;
}

/** 秤重只在讀數有效時才採用，離線/未穩定一律留 null，不可拿舊值充數。 */
function pickWeight(review, reading) {
  if (review && review.weightG != null) return review.weightG;
  if (reading && reading.state === 'ok' && reading.value_g != null) return reading.value_g;
  return null;
}

/**
 * 取某班某桶最新的秤讀數。
 *
 * 用途是**影像模組的 CloudScale 驅動**：校正資料收集階段會在筆電上直接跑
 * module4 的 CLI / Web UI，那邊沒有 Firestore 憑證，需要一個 HTTP 出口。
 * 正式紀錄流程不走這支（measureBucket 直接讀 Firestore，少一次往返）。
 *
 * 權限：記錄者只能讀自己班；技術員與管理員可指定班級（現場排查需要）。
 */
const getLatestScale = async (req, res) => {
  try {
    const bucketId = String(req.query.bucketId || '').trim();
    if (!bucketId) return bad(res, 400, '未指定桶別（bucketId）');
    if (!BUCKET_LAYOUT.some((b) => b.id === bucketId)) {
      return bad(res, 400, `未知的桶別：${bucketId}`);
    }

    const requested = String(req.query.classId || '').trim();
    const own = req.user.classId || null;
    const privileged = req.user.role === ROLES.TECHNICIAN || req.user.role === ROLES.ADMIN;
    if (!privileged && requested && requested !== own) {
      return bad(res, 403, '只能讀取自己班級的感測器');
    }
    const classId = privileged ? (requested || own) : own;
    if (!classId) return bad(res, 400, '未指定班級');

    const maxAgeSec = Number(req.query.maxAgeSec);
    const reading = await latestReading({
      classId,
      bucketId,
      ...(Number.isFinite(maxAgeSec) && maxAgeSec > 0 ? { maxAgeSec } : {}),
    });
    return res.status(200).json({ success: true, classId, bucketId, reading });
  } catch (error) {
    console.error('讀取秤讀數失敗:', error);
    return bad(res, error.status || 500, error.message || '讀取秤讀數失敗');
  }
};

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

    // 這個桶綁的稱重模組最新讀數。取不到不算錯——會是 offline/disabled，
    // 由影像模組的分級決定要提示、強制輸入，還是直接降級為純影像。
    const reading = await latestReading({ classId, bucketId });

    let updated;
    const warnings = [];
    let source = 'mock';
    let review = null;

    if (emptied) {
      // 「整桶吃完」由記錄者宣告，沒有影像也沒有量測 → manual，不進校正資料集。
      updated = {
        ...bucket, emptied: true, measured: true, source: 'manual',
        bucketConfidence: 1, warnings: [],
        provenance: PROVENANCE.MANUAL,
        reviewLevel: LEVEL.AUTO,
        pendingReview: false,
        findings: [],
        weightG: pickWeight(null, reading),
        scaleState: reading.state,
        scaleNote: reading.note || null,
      };
      source = 'manual';
    } else {
      let rec = null;
      // ⛔ 影像辨識分支：已停用（vision.VISION_DISABLED = true）。
      //    visionEnabled() 現在一律回 false，所以這整段不會執行。
      //    剩餘量改由「依序稱重」取得，見 weighDish()。
      //    保留此段是為了日後要恢復影像時不必重寫。
      if (image && !manualRatios && vision.visionEnabled()) {
        const dishMap = await getDishMap(bucket.items.map((i) => i.dishId));
        try {
          rec = await vision.recognizeBucketWithVision({
            bucketId,
            image,
            rectified: Boolean(req.body.rectified),
            pxPerMm: req.body.pxPerMm,
            tiltDeg: req.body.tiltDeg,
            scale: reading,
            retryCount: Number(req.body.retryCount || 0),
            confirmed: Boolean(req.body.confirmed),
            dishCorrected: Boolean(req.body.dishCorrected),
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
          review = rec.review || null;
        } catch (err) {
          review = err.review || null;
          if (review && review.provenance === PROVENANCE.WEIGHT_ONLY) {
            // 秤仍然正常：重量是真值，只是缺了各菜的拆分比例。
            // 這種情況不可用亂數估算蓋過去，交給記錄者選擇（僅記錄重量／手動指定／重拍）。
            warnings.push(`影像辨識失敗（${err.message}），但秤讀數正常，請選擇處理方式`);
          } else {
            warnings.push(`影像辨識無法使用（${err.message}），已改用預設估算，請確認各菜殘餘比例`);
          }
          rec = null;
        }
      }

      // L3 拒絕：依模組設計「不留量測紀錄」，因此在寫入前就中止。
      if (review && isRejected(review.level)) {
        return bad(res, 409, '本次量測未通過檢查，未寫入紀錄', {
          review, scaleState: reading.state, scaleNote: reading.note || null,
        });
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
        // ── 資料來源與人工介入（決定這筆能否進校正資料集）──
        provenance: resolveProvenance({ review, image, source: rec.source, reading }),
        reviewLevel: review ? normalizeLevel(review.level) : LEVEL.AUTO,
        pendingReview: isPendingReview(review, Boolean(req.body.confirmed)),
        findings: review ? review.findings : [],
        weightG: pickWeight(review, reading),
        scaleState: reading.state,
        scaleNote: reading.note || null,
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
      review,
      scale: { state: reading.state, note: reading.note || null, weightG: pickWeight(review, reading) },
      calibrationUsable: usableForCalibration(updated.provenance) && !updated.pendingReview,
      pendingReview: Boolean(updated.pendingReview),
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

/**
 * 全校歷史人均廚餘平均（公克/人/餐），S 幣公式的比較基準。
 *
 * 取最近 N 場**已結算**的場次。樣本不足時改用起步基準，
 * 否則開學頭幾天會被一兩場極端值主導整個學校的標準。
 *
 * 多撈一些再於記憶體過濾 status，是為了避免為 (schoolId, status, date)
 * 另開一個複合索引——這個查詢一天只跑幾次，省一個索引比較划算。
 */
async function schoolWasteBaseline(schoolId, settings, excludeSessionId) {
  const s = (settings && settings.sdg) || {};
  const fallback = Number(s.fallbackSchoolWastePerCapitaG || 0);
  const window = Math.max(1, Number(s.schoolBaselineWindow || 30));
  const minSamples = Math.max(0, Number(s.minSchoolSamples || 0));
  const none = (samples) => ({ perCapitaG: fallback, samples, source: 'fallback' });

  if (!schoolId) return none(0);
  try {
    const snap = await db.collection(COL.mealSessions)
      .where('schoolId', '==', schoolId)
      .orderBy('date', 'desc')
      .limit(Math.min(window * 3, 200))
      .get();

    const values = [];
    for (const doc of snap.docs) {
      if (values.length >= window) break;
      const x = doc.data();
      if (x.status !== 'done') continue;
      if (excludeSessionId && x.sessionId === excludeSessionId) continue;
      const servings = Number(x.servings || 0);
      const totalG = Number((x.summary || {}).totalG);
      if (servings > 0 && Number.isFinite(totalG)) values.push(totalG / servings);
    }
    if (values.length < minSamples) return none(values.length);

    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return { perCapitaG: round(avg, 1), samples: values.length, source: 'history' };
  } catch (error) {
    console.error('全校歷史平均計算失敗，改用起步基準:', error.message);
    return none(0);
  }
}

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
    // 減碳量仍然計算並留存：趨勢圖與歷史比較用得到，只是不再決定發幣
    const reduction = computeReduction(leftovers, dishMap, baseline, session.servings);

    const settings = await getSettings();

    // E = 實際吃下去的營養（供應 − 剩餘），人均
    const nutrition = computeNutrition(leftovers, dishMap, session.servings, settings);
    const energy = computeEnergyCoins(nutrition, settings);

    // S = 比全校歷史人均廚餘少浪費的部分 → 碳排 → 樹
    const schoolBaseline = await schoolWasteBaseline(session.schoolId, settings, session.sessionId);
    const classWastePerCapitaG = session.servings > 0
      ? round(Number(summary.totalG || 0) / session.servings, 1)
      : 0;
    const sdg = computeSdg({
      classWastePerCapitaG,
      schoolAvgPerCapitaG: schoolBaseline.perCapitaG,
      servings: session.servings,
      settings,
    });

    const classE = energy.coins;
    const classS = sdg.coins;

    let awarded = null;
    if (!session.coinsAwarded && (classE > 0 || classS > 0 || sdg.treesPerCapita > 0)) {
      // 人均計算的結果全額加給班上每位成員（班級池另外記帳）
      awarded = await awardClassAndMembers({
        classId,
        E: classE,
        S: classS,
        treesPerCapita: sdg.treesPerCapita,
        treesClass: sdg.treesClass,
        reason: `人均攝取蛋白質 ${nutrition.perCapita.proteinG}g、纖維 ${nutrition.perCapita.fiberG}g；`
          + `較全校平均少浪費 ${sdg.savedPerCapitaG}g/人（約 ${sdg.treesClass} 棵樹）`,
        refType: 'meal_session',
        refId: session.sessionId,
        date,
      });
    }

    await sessionRef(classId, date).update({
      status: 'done',
      summary,
      reduction,
      nutrition,
      energy,
      sdg,
      schoolBaseline,
      wastePerCapitaG: classWastePerCapitaG,
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
      nutrition,
      energy,
      sdg,
      schoolBaseline,
      wastePerCapitaG: classWastePerCapitaG,
      classCoins: { E: classE, S: classS },
      trees: { perCapita: sdg.treesPerCapita, class: sdg.treesClass },
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


// ══════════════════════════════════════════════════════════════════
//  依序稱重（取代影像辨識的主流程）
// ══════════════════════════════════════════════════════════════════
//
//  一個班級一台秤，午餐長把六道菜的桶子一桶一桶放上去。
//  每一筆稱重只需要兩個資訊：**現在這桶是哪道菜**，以及**秤上的讀數**。
//  桶型由菜色推得（主食→主食桶、主菜/副菜/蔬菜→菜桶、湯品→湯桶），
//  所以現場不必選桶、不必歸零。
//
//      剩餘量 = netG − 該桶型皮重
//
//  netG 已經扣掉裝置自身的 tareG（秤台上固定的托盤），皮重是容器本身。

/** 菜色欄位 → 它在 BUCKET_LAYOUT 的哪一桶（沿用既有結構儲存，結算與統計不必改）。 */
function bucketIdForSlot(slot) {
  const b = BUCKET_LAYOUT.find((x) => x.dishSlots.includes(slot));
  return b ? b.id : null;
}

/**
 * GET /api/record/weigh-queue
 * 今天要量哪幾道、順序、各自用哪種桶、哪幾道已經量完。
 * 順序刻意用 MENU_SLOTS：主食桶 → 四個菜桶 → 湯桶，換桶次數最少。
 */
const getWeighQueue = async (req, res) => {
  try {
    const classId = recorderClassId(req);
    const date = isYmd(req.query.date) ? req.query.date : today();
    const session = await loadSession(classId, date);
    if (!session) return bad(res, 404, '今日尚未開始紀錄，請先開始');

    const tares = await bucketTare.getTares();
    const reading = await scaleReadings.latestByClass(classId);

    const queue = [];
    for (const slot of MENU_SLOTS) {
      const bucketId = bucketIdForSlot(slot);
      const bucket = bucketId ? session.buckets[bucketId] : null;
      const item = bucket ? (bucket.items || []).find((i) => i.slot === slot) : null;
      if (!item || !item.dishId) continue;        // 今天沒有這道菜
      const tare = bucketTare.tareForSlot(slot, tares);
      queue.push({
        slot,
        slotLabel: SLOT_LABEL[slot] || slot,
        dishId: item.dishId,
        dishName: item.dishName,
        bucketType: tare.bucketType,
        bucketLabel: tare.ok ? tare.label : bucketTare.bucketTypeLabel(tare.bucketType),
        tareG: tare.ok ? tare.tareG : null,
        tareReady: tare.ok,
        tareProblem: tare.ok ? null : tare.reason,
        weighed: Boolean(item.weighedAt),
        leftoverG: item.weighedAt ? Number(item.leftoverG || 0) : null,
        suppliedG: Number(item.suppliedG || 0) || null,
      });
    }

    const done = queue.filter((q) => q.weighed).length;
    return res.status(200).json({
      success: true,
      date,
      servings: session.servings,
      scale: { state: reading.state, note: reading.note || null, netG: reading.value_g ?? null },
      queue,
      progress: { done, total: queue.length, allDone: queue.length > 0 && done === queue.length },
      blocked: queue.filter((q) => !q.tareReady).map((q) => q.tareProblem),
    });
  } catch (error) {
    console.error('取得稱重清單失敗:', error);
    return bad(res, 500, error.message || '取得稱重清單失敗');
  }
};

/**
 * POST /api/record/weigh
 * body: { slot, netG?, emptied?, date? }
 *
 * netG 不給就從這個班級的秤讀最新值（正常操作就是這樣：放上去、按確認）。
 * 給 netG 是為了讓現場在秤故障時能手動輸入，以及供測試使用。
 * emptied:true 代表「這道全部吃完」，一鍵記 0，不必把空桶放上去。
 */
const weighDish = async (req, res) => {
  try {
    const classId = recorderClassId(req);
    const date = isYmd(req.body.date) ? req.body.date : today();
    const slot = String(req.body.slot || '').trim();
    const emptied = Boolean(req.body.emptied);

    if (!MENU_SLOTS.includes(slot)) {
      return bad(res, 400, `slot 需為 ${MENU_SLOTS.join(' / ')}`);
    }

    const session = await loadSession(classId, date);
    if (!session) return bad(res, 404, '今日尚未開始紀錄，請先開始');

    const bucketId = bucketIdForSlot(slot);
    const bucket = bucketId ? session.buckets[bucketId] : null;
    if (!bucket) return bad(res, 404, `場次沒有對應的桶：${slot}`);
    const item = (bucket.items || []).find((i) => i.slot === slot);
    if (!item || !item.dishId) return bad(res, 404, `今天的菜單沒有「${SLOT_LABEL[slot] || slot}」`);

    const warnings = [];
    let measuredG = 0;
    let reading = { state: 'disabled', note: '吃光，未使用磅秤' };
    let tareG = 0;
    let bucketType = bucketTare.bucketTypeForSlot(slot);

    if (!emptied) {
      // 皮重要先設定好，否則算不出剩餘量
      const tares = await bucketTare.getTares();
      const tare = bucketTare.tareForSlot(slot, tares);
      if (!tare.ok) return bad(res, 409, tare.reason, { bucketType: tare.bucketType });
      tareG = tare.tareG;
      bucketType = tare.bucketType;

      if (req.body.netG != null) {
        const v = Number(req.body.netG);
        if (!Number.isFinite(v)) return bad(res, 400, 'netG 必須是數字');
        measuredG = v - tareG;
        reading = { state: 'manual', note: '手動輸入秤上讀數', value_g: v };
        warnings.push('這筆是手動輸入的讀數，不是由磅秤讀取');
      } else {
        reading = await scaleReadings.latestByClass(classId);
        if (reading.state !== 'ok') {
          return bad(res, 409,
            `秤目前讀不到有效重量：${reading.note || reading.state}。`
            + '請確認裝置在線，或改用手動輸入。',
            { scale: reading });
        }
        measuredG = Number(reading.value_g) - tareG;
      }

      if (measuredG < -30) {
        return bad(res, 409,
          `扣掉皮重後是負的（${Math.round(measuredG)} g）。`
          + `多半是「${bucketTare.bucketTypeLabel(bucketType)}」的皮重設錯，或放上去的是別種桶。`,
          { measuredG, tareG, reading });
      }
      if (measuredG < 0) {
        warnings.push('扣掉皮重後略小於 0，已當作 0（磅秤雜訊）');
        measuredG = 0;
      }
    }

    // ── 寫回該桶的這道菜 ──
    const dishMap = await getDishMap([item.dishId]);
    const dish = dishMap.get(item.dishId);
    if (!dish) return bad(res, 404, '查無此菜色資料');

    const calc = leftoverFromWeight(dish, emptied ? 0 : measuredG, session.servings);
    warnings.push(...calc.warnings);

    const newItems = bucket.items.map((it) => (it.slot !== slot ? it : {
      ...it,
      remainingRatio: calc.remainingRatio,
      rawRatio: calc.rawRatio,
      leftoverG: calc.leftoverG,
      suppliedG: calc.suppliedG,
      cost: calc.cost,
      co2e: calc.co2e,
      // ── 這一筆的來源：量測、手動輸入、還是宣告吃光 ──
      method: emptied ? 'emptied' : (reading.state === 'manual' ? 'manual' : 'scale'),
      // 這裡**不能**用 serverTimestamp()：那是哨兵值，Firestore 不允許放在陣列元素裡
      // （items 是陣列），會丟 Update() requires ... 的驗證錯誤。
      // Timestamp.now() 是具體值，放陣列裡沒問題，精度對這個用途也足夠。
      weighedAt: admin.firestore.Timestamp.now(),
      weighedBy: req.user.uid,
      scaleNetG: emptied ? null : (reading.value_g ?? null),
      bucketType,
      tareG: emptied ? null : tareG,
      needsReview: false,
      confidence: emptied ? 1 : 0.99,
    }));

    // 整桶的狀態由「桶內各菜是否都量過」推得
    const allWeighed = newItems.filter((i) => i.dishId).every((i) => i.weighedAt);
    const updated = {
      ...bucket,
      items: newItems,
      measured: allWeighed,
      emptied: newItems.filter((i) => i.dishId).every((i) => i.method === 'emptied'),
      source: 'scale',
      provenance: PROVENANCE.WEIGHT_ONLY,
      reviewLevel: LEVEL.AUTO,
      pendingReview: false,
      findings: [],
      bucketConfidence: allWeighed ? 1 : 0,
      warnings,
      measuredBy: req.user.uid,
      measuredAt: serverTime(),
      weightG: emptied ? null : (reading.value_g ?? null),
      scaleState: reading.state,
      scaleNote: reading.note || null,
    };

    const buckets = { ...session.buckets, [bucketId]: updated };
    await sessionRef(classId, date).update({
      buckets, status: 'measuring', updatedAt: serverTime(),
    });
    await upsertDishLeftovers({ ...session, id: session.sessionId }, updated);

    // 回傳進度，前端才知道下一道要量什麼
    const remaining = [];
    for (const s of MENU_SLOTS) {
      const bid = bucketIdForSlot(s);
      const b = bid === bucketId ? updated : (bid ? session.buckets[bid] : null);
      const it = b ? (b.items || []).find((i) => i.slot === s) : null;
      if (it && it.dishId && !it.weighedAt) {
        remaining.push({ slot: s, slotLabel: SLOT_LABEL[s] || s, dishName: it.dishName });
      }
    }

    return res.status(200).json({
      success: true,
      message: emptied
        ? `已記錄「${item.dishName}」吃光`
        : `已記錄「${item.dishName}」剩 ${calc.leftoverG} g`,
      slot,
      dishName: item.dishName,
      bucketType,
      bucketLabel: bucketTare.bucketTypeLabel(bucketType),
      scaleNetG: emptied ? null : (reading.value_g ?? null),
      tareG: emptied ? null : tareG,
      leftoverG: calc.leftoverG,
      suppliedG: calc.suppliedG,
      remainingRatio: calc.remainingRatio,
      warnings,
      scale: { state: reading.state, note: reading.note || null },
      remaining,
      allDone: remaining.length === 0,
    });
  } catch (error) {
    console.error('稱重失敗:', error);
    return bad(res, error.status || 500, error.message || '稱重失敗');
  }
};

module.exports = {
  getWeighQueue,
  weighDish,
  getTodaySession,
  startSession,
  measureBucket,
  getLatestScale,
  adjustBucket,
  finalizeSession,
  getRecordHistory,
  getVisionStatus,
  // 供其他 controller 重用
  _internals: { getClass, getMenuSlots, getDishMap, loadSession, presentSession },
};
