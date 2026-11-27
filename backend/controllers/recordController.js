/**
 * 全班剩食紀錄（午餐長依序稱重）。
 *
 * 一班一天一場。一個班級一台秤，午餐長把當天每道菜的桶子一桶一桶放上去，
 * 每一筆只需要兩個資訊：**現在這桶是哪道菜**，以及**秤上的讀數**。
 * 桶型由菜色推得（主食→主食桶、主菜/副菜/蔬菜→菜桶、湯品→湯桶），
 * 所以現場不必選桶、不必歸零：
 *
 *      剩餘量 = 秤的 netG − 該桶型皮重
 *
 * 每量一道就即時更新 `dish_leftovers`（每班每天每道菜一筆），
 * 跨班支援與剩餘量曲線才有即時資料可用。
 *
 * 這是**單純的紀錄**：結算只彙總全班剩了多少，不發幣、不排名。
 * 個人的回饋改由學生拍自己的餐盤（見 plateController）。
 *
 * 權限：本班午餐長、導師、管理員（middleware/auth.js 的 requireRecorder）。
 * 秤連不上時的**手動輸入重量**只限管理員（任何班、任何日期都可以補）。
 */
const { db, admin } = require('../config/firebase');
const { COL, ids, ROLES, MENU_SLOTS, SLOT_LABEL, SLOT_CATEGORY } = require('../config/schema');
const { today, isYmd } = require('../lib/dates');
const { summarize, round, leftoverFromWeight } = require('../lib/scoring');
const bucketTare = require('../lib/bucketTare');
const scaleReadings = require('../lib/scaleReadings');

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const bad = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

const sessionRef = (classId, date) => db.collection(COL.mealSessions).doc(ids.mealSession(classId, date));

/** 「今日」或「11-27」——補登過去的日期時，錯誤訊息要講對是哪一天。 */
const dayWord = (date) => (date === today() ? '今日' : `${date} `);

async function loadSession(classId, date) {
  const snap = await sessionRef(classId, date).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/** daily_menu/{date}.dishes = { staple: dishId, ... }；不供餐或沒有菜色回 null。 */
async function getMenuSlots(date) {
  const snap = await db.collection(COL.dailyMenu).doc(date).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (data.isActive === false || !data.dishes) return null;
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

/** 依稱重順序列出今天有的菜（沒排菜的欄位略過）。 */
function orderedDishes(session) {
  const dishes = session.dishes || {};
  return MENU_SLOTS.map((slot) => dishes[slot]).filter((d) => d && d.dishId);
}

const isWeighed = (d) => Boolean(d.weighedAt);

/** 對外的場次摘要（前端用）。 */
function presentSession(session) {
  const list = orderedDishes(session);
  return {
    sessionId: session.id,
    classId: session.classId,
    className: session.className,
    date: session.date,
    status: session.status,
    servings: session.servings,
    progress: { done: list.filter(isWeighed).length, total: list.length },
    summary: session.summary || null,
    wastePerCapitaG: session.wastePerCapitaG == null ? null : session.wastePerCapitaG,
    finalizedAt: session.finalizedAt ? session.finalizedAt.toDate().toISOString() : null,
  };
}

/** 把一道菜寫進 dish_leftovers（跨班支援與剩餘量曲線的資料來源）。 */
async function upsertDishLeftover(session, item) {
  await db.collection(COL.dishLeftovers)
    .doc(ids.dishLeftover(session.classId, session.date, item.slot))
    .set({
      schoolId: session.schoolId || null,
      classId: session.classId,
      className: session.className || null,
      grade: session.grade || null,
      date: session.date,
      slot: item.slot,
      dishId: item.dishId,
      dishName: item.dishName,
      category: item.category || null,
      suppliedG: item.suppliedG || 0,
      leftoverG: item.leftoverG || 0,
      remainingRatio: item.remainingRatio || 0,
      cost: item.cost || 0,
      co2e: item.co2e || 0,
      method: item.method || null,
      sessionId: ids.mealSession(session.classId, session.date),
      updatedAt: serverTime(),
    }, { merge: true });
}

// ── 端點 ────────────────────────────────────────────────────────────

/** GET /api/record/today — 今日場次狀態（沒有就回 status: none）*/
const getTodaySession = async (req, res) => {
  try {
    const { classId } = req;
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
        message: menuSlots ? '今日尚未開始紀錄' : '今天沒有菜單（或不供餐），不需要紀錄',
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
    const { classId } = req;
    const date = isYmd(req.body.date) ? req.body.date : today();

    const existing = await loadSession(classId, date);
    if (existing) {
      return res.status(200).json({ success: true, session: presentSession(existing), message: '沿用今日已開始的紀錄' });
    }

    const menuSlots = await getMenuSlots(date);
    if (!menuSlots) return bad(res, 404, `${date} 沒有菜單（或不供餐），請先由管理員排菜`);

    const classSnap = await db.collection(COL.classes).doc(classId).get();
    if (!classSnap.exists) return bad(res, 404, '查無此班級');
    const klass = classSnap.data();
    const servings = Number(klass.headcount || 0);
    if (servings <= 0) return bad(res, 400, '此班級尚未設定人數，無法換算供應量');

    const dishMap = await getDishMap(MENU_SLOTS.map((s) => menuSlots[s]));
    const dishes = {};
    for (const slot of MENU_SLOTS) {
      const dishId = menuSlots[slot] || null;
      if (!dishId) continue;
      const dish = dishMap.get(dishId);
      dishes[slot] = {
        slot,
        label: SLOT_LABEL[slot],
        category: (dish && dish.category) || SLOT_CATEGORY[slot],
        dishId,
        dishName: dish ? dish.name : SLOT_LABEL[slot],
        suppliedG: dish ? round(Number(dish.portionG || 0) * servings, 1) : 0,
      };
    }

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
      dishes,
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
 * GET /api/record/weigh-queue
 * 今天要量哪幾道、順序、各自用哪種桶、哪幾道已經量完，以及秤的即時讀數。
 */
const getWeighQueue = async (req, res) => {
  try {
    const { classId } = req;
    const date = isYmd(req.query.date) ? req.query.date : today();
    const session = await loadSession(classId, date);
    if (!session) {
      // 還沒開始不是錯誤：前端據此顯示「開始今日紀錄」，不必當成失敗處理
      const menuSlots = await getMenuSlots(date);
      return res.status(200).json({
        success: true, date, classId, status: 'none', menuReady: Boolean(menuSlots),
        queue: [], progress: { done: 0, total: 0, allDone: false }, blocked: [],
      });
    }

    const [tares, reading] = await Promise.all([
      bucketTare.getTares(),
      scaleReadings.latestByClass(classId),
    ]);

    const queue = orderedDishes(session).map((item) => {
      const tare = bucketTare.tareForSlot(item.slot, tares);
      return {
        slot: item.slot,
        slotLabel: SLOT_LABEL[item.slot] || item.slot,
        dishId: item.dishId,
        dishName: item.dishName,
        bucketType: tare.bucketType,
        bucketLabel: tare.ok ? tare.label : bucketTare.bucketTypeLabel(tare.bucketType),
        tareG: tare.ok ? tare.tareG : null,
        tareReady: tare.ok,
        tareProblem: tare.ok ? null : tare.reason,
        weighed: isWeighed(item),
        leftoverG: isWeighed(item) ? Number(item.leftoverG || 0) : null,
        suppliedG: Number(item.suppliedG || 0) || null,
      };
    });

    const done = queue.filter((q) => q.weighed).length;
    return res.status(200).json({
      success: true,
      date,
      classId,
      // 'done' = 已結算：前端據此停止每 2 秒的讀數輪詢
      status: session.status || null,
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
 * 給 netG＝秤連不上時的手動輸入，只限管理員——那等於繞過感測器，要由負責的人做。
 * emptied:true 代表「這道全部吃完」，一鍵記 0，不必把空桶放上去。
 * 已結算的場次再量一次會重新開啟，要再結算一次。
 */
const weighDish = async (req, res) => {
  try {
    const { classId } = req;
    const date = isYmd(req.body.date) ? req.body.date : today();
    const slot = String(req.body.slot || '').trim();
    const emptied = Boolean(req.body.emptied);

    if (!MENU_SLOTS.includes(slot)) {
      return bad(res, 400, `slot 需為 ${MENU_SLOTS.join(' / ')}`);
    }
    if (req.body.netG != null && !emptied && req.user.role !== ROLES.ADMIN) {
      return bad(res, 403, '手動輸入重量只限管理員；秤連不上時請聯絡管理員');
    }

    const session = await loadSession(classId, date);
    if (!session) return bad(res, 404, `${dayWord(date)}尚未開始紀錄，請先開始`);
    const item = (session.dishes || {})[slot];
    if (!item || !item.dishId) return bad(res, 404, `今天的菜單沒有「${SLOT_LABEL[slot] || slot}」`);

    const warnings = [];
    let measuredG = 0;
    let reading = { state: 'disabled', note: '吃光，未使用磅秤' };
    let tareG = 0;
    let bucketType = bucketTare.bucketTypeForSlot(slot);

    if (!emptied) {
      // 皮重要先設定好，否則算不出剩餘量
      const tare = bucketTare.tareForSlot(slot, await bucketTare.getTares());
      if (!tare.ok) return bad(res, 409, tare.reason, { bucketType: tare.bucketType });
      tareG = tare.tareG;
      bucketType = tare.bucketType;

      if (req.body.netG != null) {
        const v = Number(req.body.netG);
        if (!Number.isFinite(v)) return bad(res, 400, 'netG 必須是數字');
        measuredG = v - tareG;
        reading = { state: 'manual', note: '管理員手動輸入', value_g: v };
        warnings.push('這筆是管理員手動輸入的讀數，不是由磅秤讀取');
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

    const dish = (await getDishMap([item.dishId])).get(item.dishId);
    if (!dish) return bad(res, 404, '查無此菜色資料');

    const calc = leftoverFromWeight(dish, emptied ? 0 : measuredG, session.servings);
    warnings.push(...calc.warnings);

    const updated = {
      ...item,
      suppliedG: calc.suppliedG,
      leftoverG: calc.leftoverG,
      remainingRatio: calc.remainingRatio,
      rawRatio: calc.rawRatio,
      cost: calc.cost,
      co2e: calc.co2e,
      // 這一筆的來源：量測、手動輸入、還是宣告吃光
      method: emptied ? 'emptied' : (reading.state === 'manual' ? 'manual' : 'scale'),
      scaleNetG: emptied ? null : (reading.value_g ?? null),
      bucketType,
      tareG: emptied ? null : tareG,
      weighedBy: req.user.uid,
      weighedAt: serverTime(),
    };

    await sessionRef(classId, date).update({
      [`dishes.${slot}`]: updated,
      status: 'measuring',
      updatedAt: serverTime(),
    });
    await upsertDishLeftover(session, updated);

    // 回傳進度，前端才知道下一道要量什麼
    const remaining = orderedDishes(session)
      .filter((d) => d.slot !== slot && !isWeighed(d))
      .map((d) => ({ slot: d.slot, slotLabel: SLOT_LABEL[d.slot] || d.slot, dishName: d.dishName }));

    return res.status(200).json({
      success: true,
      message: emptied
        ? `已記錄「${item.dishName}」吃光`
        : `已記錄「${item.dishName}」剩 ${calc.leftoverG} g`,
      slot,
      dishName: item.dishName,
      bucketType,
      bucketLabel: bucketTare.bucketTypeLabel(bucketType),
      scaleNetG: updated.scaleNetG,
      tareG: updated.tareG,
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

/** POST /api/record/finalize — 完成當日紀錄：彙總全班剩了多少（不發幣） */
const finalizeSession = async (req, res) => {
  try {
    const { classId } = req;
    const date = isYmd(req.body.date) ? req.body.date : today();

    const session = await loadSession(classId, date);
    if (!session) return bad(res, 404, `${dayWord(date)}尚未開始紀錄`);

    const list = orderedDishes(session);
    const pending = list.filter((d) => !isWeighed(d));
    if (pending.length > 0) {
      return bad(res, 400, `還有 ${pending.length} 道菜沒量`, {
        pending: pending.map((d) => d.dishName),
      });
    }

    const summary = summarize(list);
    const wastePerCapitaG = session.servings > 0
      ? round(Number(summary.totalG || 0) / session.servings, 1)
      : 0;

    await sessionRef(classId, date).update({
      status: 'done',
      summary,
      wastePerCapitaG,
      finalizedBy: req.user.uid,
      finalizedAt: serverTime(),
    });

    return res.status(200).json({
      success: true,
      message: '今日紀錄完成！',
      summary,
      wastePerCapitaG,
      servings: session.servings,
    });
  } catch (error) {
    console.error('完成紀錄失敗:', error);
    return bad(res, error.status || 500, error.message || '完成紀錄失敗');
  }
};

/**
 * DELETE /api/record/session?classId=&date= （限管理員）
 * 整場重來：刪掉這班這天的場次與各菜紀錄。開錯日期、量到一半發現菜單錯了時用。
 */
const resetSession = async (req, res) => {
  try {
    if (req.user.role !== ROLES.ADMIN) return bad(res, 403, '只有管理員可以重設紀錄');
    const { classId } = req;
    const date = isYmd(req.query.date) ? req.query.date : today();
    const session = await loadSession(classId, date);
    if (!session) return bad(res, 404, '這天沒有紀錄');
    const batch = db.batch();
    batch.delete(sessionRef(classId, date));
    for (const slot of MENU_SLOTS) {
      batch.delete(db.collection(COL.dishLeftovers).doc(ids.dishLeftover(classId, date, slot)));
    }
    await batch.commit();
    return res.status(200).json({ success: true, message: `已清除 ${session.className || classId} 班 ${date} 的稱重紀錄` });
  } catch (error) {
    console.error('重設紀錄失敗:', error);
    return bad(res, 500, error.message || '重設紀錄失敗');
  }
};

module.exports = {
  resetSession,
  getTodaySession,
  startSession,
  getWeighQueue,
  weighDish,
  finalizeSession,
};
