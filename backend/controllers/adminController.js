/**
 * 管理員專區：可調參數、Google 試算表同步（名冊、菜單）、商城開關、桶型皮重。
 * 班級與帳號的操作在 adminRosterController.js。
 *
 * 全部端點都要 admin 角色（middleware/auth.js 的 requireRole 會讓 admin 通行）。
 */
const { db, admin } = require('../config/firebase');
const { COL, ROLES, MENU_SLOTS, SLOT_LABEL, DEVICE, TUNABLE_DEFAULTS } = require('../config/schema');
const { createUserWithAccount } = require('./authController');
const { getSettings, saveSettings } = require('../lib/settings');
const sheet = require('../lib/studentSheet');
const menu = require('../lib/menuSheet');
const shop = require('../lib/shop');
const bucketTare = require('../lib/bucketTare');
const scaleReadings = require('../lib/scaleReadings');

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const norm = (v) => String(v == null ? '' : v).trim();
const bad = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

// ── 可調參數（拍餐盤的 ESG 幣、建議攝取）──────────────────────────────────

/**
 * GET /api/admin/coin-rules
 * 回傳目前採用值與出廠預設值。
 *
 * 同時回傳預設值是刻意的：調參數的人需要知道「原廠是多少」才敢動，
 * 也才有辦法還原。
 */
const getCoinRules = async (req, res) => {
  try {
    const current = await getSettings({ force: true });
    return res.status(200).json({
      success: true,
      values: current,
      defaults: TUNABLE_DEFAULTS,
    });
  } catch (error) {
    console.error('讀取發幣參數失敗:', error);
    return bad(res, 500, error.message || '讀取發幣參數失敗');
  }
};

/**
 * PUT /api/admin/coin-rules
 * 只存與預設不同的欄位，讀取時再與預設合併（見 lib/settings.js）。
 */
const updateCoinRules = async (req, res) => {
  try {
    const result = await saveSettings(req.body && req.body.values, { uid: req.user.uid });
    return res.status(200).json({
      success: true,
      message: '已更新，之後的餐盤結果與建議值即生效（已發出的幣不會重算）',
      values: result.current,
      defaults: TUNABLE_DEFAULTS,
    });
  } catch (error) {
    if (error.status === 400) return bad(res, 400, error.message);
    console.error('更新發幣參數失敗:', error);
    return bad(res, 500, error.message || '更新發幣參數失敗');
  }
};



// ── 學生名冊同步（Google 試算表 → Firestore）────────────────────────

/**
 * POST /api/admin/sync/students
 * body: { dryRun?: boolean }
 *
 * 從 Apps Script 取回名冊，驗證後寫入。預設**真的寫入**；
 * 帶 dryRun 則只回報「會發生什麼」，不動資料庫——
 * 第一次接上試算表時應該先跑一次 dryRun 確認欄位對得上。
 *
 * 不碰的東西：幣、角色、密碼，以及試算表裡沒有的學生（只列出來）。
 */
const syncStudents = async (req, res) => {
  try {
    if (!sheet.configured()) {
      return bad(res, 400,
        '尚未設定試算表來源，請在後端 .env 填入 STUDENT_SHEET_URL 與 STUDENT_SHEET_TOKEN');
    }
    const dryRun = Boolean(req.body && req.body.dryRun);

    const roster = await sheet.fetchRoster();
    if (roster.students.length > sheet.MAX_ROWS) {
      return bad(res, 400,
        `試算表有 ${roster.students.length} 列，超過單次上限 ${sheet.MAX_ROWS} 列`);
    }

    const [classesByName, { byEmail, accounts, all: allUsers }] = await Promise.all([
      sheet.loadClassesByName(),
      sheet.loadUsers(),
    ]);

    const created = [];
    const updated = [];
    const unchanged = [];
    const errors = [];
    const seenEmails = new Set();
    const takenAccounts = new Set(accounts);

    for (const row of roster.students) {
      const where = `第 ${row.rowNumber} 列`;
      const v = sheet.validateRow(row);
      if (!v.ok) {
        errors.push({ row: row.rowNumber, name: sheet.norm(row.displayName), reason: v.reason });
        continue;
      }
      const s = v.value;

      // 同一張表裡重複的 Gmail 是資料錯誤，不是「要更新兩次」
      if (seenEmails.has(s.gmail)) {
        errors.push({ row: row.rowNumber, name: s.displayName, reason: `Gmail 在表中重複：${s.gmail}` });
        continue;
      }
      seenEmails.add(s.gmail);

      const matches = classesByName.get(s.className) || [];
      if (matches.length === 0) {
        errors.push({ row: row.rowNumber, name: s.displayName,
          reason: `查無「${s.className}」班，請先在上方新增班級` });
        continue;
      }
      if (matches.length > 1) {
        errors.push({ row: row.rowNumber, name: s.displayName,
          reason: `有多個班名為「${s.className}」的班級（${matches.map((m) => m.grade + '年').join('、')}），無法判斷` });
        continue;
      }
      const klass = matches[0];

      // 以 Gmail 認人：學號會因轉學重編而變，Gmail 不會
      const existingList = byEmail.get(s.gmail) || [];
      if (existingList.length > 1) {
        errors.push({ row: row.rowNumber, name: s.displayName,
          reason: `資料庫有 ${existingList.length} 個帳號共用這個 Gmail，請先人工處理` });
        continue;
      }
      const existing = existingList[0] || null;

      // 只覆寫明確來自試算表的欄位
      const fields = {
        email: s.gmail,
        displayName: s.displayName,
        studentNo: s.studentNo,
        classId: klass.id,
        grade: klass.grade,
        className: klass.name,
        seatNo: s.seatNo,
        gender: s.gender || null,
        age: s.age,
        heightCm: s.heightCm,
        weightKg: s.weightKg,
        bmi: s.bmi,
        syncedAt: serverTime(),
        syncSource: 'google_sheet',
      };

      if (existing) {
        if (existing.role !== ROLES.STUDENT) {
          errors.push({ row: row.rowNumber, name: s.displayName,
            reason: `這個 Gmail 已是「${existing.role}」帳號，同步不會改動非學生角色` });
          continue;
        }

        const diff = changedFields(existing, fields);
        if (diff.length === 0) {
          unchanged.push({ row: row.rowNumber, name: s.displayName, bmi: s.bmi });
          continue;
        }
        if (!dryRun) {
          await db.collection(COL.users).doc(existing.id).set(fields, { merge: true });
        }
        updated.push({ row: row.rowNumber, name: s.displayName, bmi: s.bmi, changed: diff });
        continue;
      }

      // 新建。學號當帳號（現有的帳密路徑要用），但不給密碼——
      // 之後會改用 Google 登入，由 Gmail 認人。
      const account = s.studentNo;
      if (takenAccounts.has(account.toLowerCase())) {
        errors.push({ row: row.rowNumber, name: s.displayName,
          reason: `學號 ${account} 已被其他帳號使用` });
        continue;
      }

      if (!dryRun) {
        const userId = db.collection(COL.users).doc().id;
        await createUserWithAccount({
          userId,
          account,
          userData: {
            userId,
            account,
            role: ROLES.STUDENT,
            isActive: true,
            schoolId: klass.schoolId || null,
            createdAt: serverTime(),
            esgCoin: 0,
            // 沒有 passwordHash：帳密登入會被擋（回 401），
            // 要等 Google 登入上線這些帳號才真正可用
            authProvider: 'google',
            ...fields,
          },
        });
      }
      takenAccounts.add(account.toLowerCase());
      created.push({ row: row.rowNumber, name: s.displayName, account, bmi: s.bmi });
    }

    // 資料庫有、試算表沒有的學生：只列出來，不動它們
    // 掃完整份使用者清單，而不是只掃有 email 的——
    // 沒填 Gmail 的學生同樣要被列出來，他們反而最需要被注意到。
    const notInSheet = allUsers
      .filter((u) => u.role === ROLES.STUDENT
        && u.isActive !== false
        && !seenEmails.has(String(u.email || '').toLowerCase()))
      .map((u) => ({
        name: u.displayName || '(未命名)',
        className: u.className || null,
        account: u.account || null,
        hasEmail: Boolean(u.email),
      }));

    return res.status(200).json({
      success: true,
      dryRun,
      message: dryRun
        ? `試算完成：會新增 ${created.length}、更新 ${updated.length}、未變 ${unchanged.length}`
        : `同步完成：新增 ${created.length}、更新 ${updated.length}、未變 ${unchanged.length}`,
      source: { sheet: roster.sheet, exportedAt: roster.exportedAt, rows: roster.students.length },
      summary: {
        created: created.length,
        updated: updated.length,
        unchanged: unchanged.length,
        errors: errors.length,
        notInSheet: notInSheet.length,
      },
      created, updated, errors, notInSheet,
    });
  } catch (error) {
    console.error('學生名冊同步失敗:', error);
    return bad(res, error.status || 500, error.message || '學生名冊同步失敗');
  }
};

/** 哪些欄位真的變了。沒變就不寫入，省掉一次寫入也讓報告看得出重點。 */
function changedFields(existing, fields) {
  const SKIP = new Set(['syncedAt', 'syncSource']);
  const out = [];
  for (const [k, v] of Object.entries(fields)) {
    if (SKIP.has(k)) continue;
    const before = existing[k];
    const same = (before == null && v == null) || String(before) === String(v);
    if (!same) out.push(k);
  }
  return out;
}


// ── 每月菜單同步（Google 試算表 → daily_menu）──────────────────────

/**
 * POST /api/admin/sync/menus
 * body: { month?: 'YYYY-MM', dryRun?: boolean, createMissingDishes?: boolean }
 *
 * 以日期為主鍵逐日寫入 daily_menu。只處理表上出現的日期，
 * 沒出現的日期不動——同步一個月不該影響其他月份。
 *
 * 菜名查不到對應菜色時**預設報錯不建立**：自動建立的話，
 * 一個打錯的菜名就會變成一道份量與營養都是預設值的新菜，
 * 而那些數字會直接影響供應量與發幣。要建立得明確勾選。
 */
const syncMenus = async (req, res) => {
  try {
    if (!menu.configured()) {
      return bad(res, 400,
        '尚未設定菜單來源，請在後端 .env 填入 MENU_SHEET_URL 與 MENU_SHEET_TOKEN');
    }
    const body = req.body || {};
    const dryRun = Boolean(body.dryRun);
    const createMissing = Boolean(body.createMissingDishes);
    const month = norm(body.month);
    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      return bad(res, 400, '月份格式需為 YYYY-MM，例如 2026-11');
    }

    const sheetData = await menu.fetchMenus(month);
    if (sheetData.menus.length > menu.MAX_ROWS) {
      return bad(res, 400,
        `試算表有 ${sheetData.menus.length} 列，超過單次上限 ${menu.MAX_ROWS} 列，請指定月份`);
    }

    const dishesByName = await menu.loadDishesByName();

    const created = [];
    const updated = [];
    const unchanged = [];
    const closed = [];
    const errors = [];
    const newDishes = [];
    const seenDates = new Set();

    for (const row of sheetData.menus) {
      const v = menu.validateRow(row);
      if (!v.ok) {
        errors.push({ row: row.rowNumber, date: menu.norm(row.date), reason: v.reason });
        continue;
      }
      const day = v.value;

      if (seenDates.has(day.date)) {
        errors.push({ row: row.rowNumber, date: day.date, reason: '同一個日期在表中出現兩次' });
        continue;
      }
      seenDates.add(day.date);

      const ref = db.collection(COL.dailyMenu).doc(day.date);
      const before = (await ref.get()).data() || null;

      // 不供餐：只標 isActive=false，保留原本排好的菜色
      if (!day.served) {
        if (before && before.isActive === false) {
          unchanged.push({ date: day.date, served: false });
          continue;
        }
        if (!dryRun) {
          await ref.set({
            menuId: day.date, date: day.date, weekday: day.weekday,
            isActive: false, note: day.note,
            syncedAt: serverTime(), syncSource: 'google_sheet',
          }, { merge: true });
        }
        closed.push({ date: day.date, note: day.note });
        continue;
      }

      // 菜名 → dishId
      const dishes = {};
      const rowProblems = [];
      for (const slot of MENU_SLOTS) {
        const name = day.dishNames[slot];
        const matches = dishesByName.get(menu.dishKey(name)) || [];

        if (matches.length === 1) { dishes[slot] = matches[0].id; continue; }
        if (matches.length > 1) {
          rowProblems.push(`「${name}」有 ${matches.length} 道同名菜色，無法判斷`);
          continue;
        }

        if (!createMissing) {
          rowProblems.push(`查無菜色「${name}」（${SLOT_LABEL[slot]}）`);
          continue;
        }
        // 勾了才建立。同一次同步裡同名只建一次。
        const data = menu.newDishData(name, slot);
        const dishId = `dish-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        if (!dryRun) {
          await db.collection(COL.dishes).doc(dishId).set({ dishId, ...data });
        }
        const entry = { id: dishId, dishId, ...data };
        dishesByName.set(menu.dishKey(name), [entry]);
        newDishes.push({ name: data.name, category: data.category, portionG: data.portionG });
        dishes[slot] = dishId;
      }

      if (rowProblems.length) {
        errors.push({ row: row.rowNumber, date: day.date, reason: rowProblems.join('；') });
        continue;
      }

      const sameDishes = before && before.dishes
        && MENU_SLOTS.every((s) => before.dishes[s] === dishes[s]);
      if (before && sameDishes && before.isActive !== false
          && menu.norm(before.note) === day.note) {
        unchanged.push({ date: day.date, served: true });
        continue;
      }

      if (!dryRun) {
        await ref.set({
          menuId: day.date, date: day.date, weekday: day.weekday,
          dishes, isActive: true, note: day.note,
          syncedAt: serverTime(), syncSource: 'google_sheet',
        }, { merge: true });
      }

      const names = MENU_SLOTS.map((s) => day.dishNames[s]);
      (before ? updated : created).push({ date: day.date, dishes: names });
    }

    return res.status(200).json({
      success: true,
      dryRun,
      message: `${dryRun ? '試算' : '同步'}完成：新增 ${created.length}、更新 ${updated.length}、`
        + `未變 ${unchanged.length}、不供餐 ${closed.length}`,
      source: {
        sheet: sheetData.sheet, exportedAt: sheetData.exportedAt,
        timeZone: sheetData.timeZone, rows: sheetData.menus.length,
        month: month || null,
      },
      summary: {
        created: created.length,
        updated: updated.length,
        unchanged: unchanged.length,
        closed: closed.length,
        errors: errors.length,
        newDishes: newDishes.length,
      },
      created, updated, closed, errors, newDishes,
    });
  } catch (error) {
    console.error('菜單同步失敗:', error);
    return bad(res, error.status || 500, error.message || '菜單同步失敗');
  }
};


// ── 商城開關 ────────────────────────────────────────────────────
/**
 * GET /api/admin/shop
 * 面板需要分別看到「環境變數允不允許」與「管理員開不開」，
 * 只回一個 enabled 的話，被環境變數鎖住時面板會看起來像壞了。
 */
const getShop = async (req, res) => {
  try {
    const state = await shop.getShopState({ force: true });
    return res.status(200).json({ success: true, shop: state });
  } catch (error) {
    console.error('讀取商城開關失敗:', error);
    return res.status(500).json({ success: false, message: error.message || '讀取商城開關失敗' });
  }
};

/**
 * PUT /api/admin/shop
 * body: { enabled: boolean, message?: string }
 * message 是關閉期間給學生看的說明（例如「獎品盤點中，下週一恢復」）。
 */
const updateShop = async (req, res) => {
  try {
    if (typeof req.body.enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: 'enabled 需為 true 或 false' });
    }
    const state = await shop.setShopEnabled({
      enabled: req.body.enabled,
      message: req.body.message,
      uid: req.user.uid,
      displayName: req.user.displayName,
    });
    return res.status(200).json({
      success: true,
      message: state.enabled
        ? '商城已開張'
        : (state.lockedByEnv
          ? '已記錄為開啟，但這個環境的 SHOP_ENABLED 仍鎖著商城'
          : '商城已暫停'),
      shop: state,
    });
  } catch (error) {
    console.error('設定商城開關失敗:', error);
    return res.status(500).json({ success: false, message: error.message || '設定商城開關失敗' });
  }
};


// ── 桶型皮重（空桶扣重）────────────────────────────────────────
/**
 * GET /api/admin/bucket-tare
 *
 * 一次回齊面板需要的三樣東西，省掉前端串接多支端點：
 *   桶型與目前皮重、是哪一台秤量的、以及可用的裝置清單（含在線狀態）。
 */
const getBucketTare = async (req, res) => {
  try {
    const tares = await bucketTare.getTares({ force: true });
    const snap = await db.collection(COL.devices).get();
    const now = Date.now();
    const devices = snap.docs.map((d) => {
      const v = d.data();
      const lastSeen = v.lastSeenAt ? v.lastSeenAt.toDate() : null;
      const secs = lastSeen ? Math.round((now - lastSeen.getTime()) / 1000) : null;
      return {
        deviceId: d.id,
        label: v.label || null,
        className: v.className || null,
        status: v.status || 'active',
        online: secs != null && secs < DEVICE.offlineAfterSeconds,
        secondsSinceSeen: secs,
      };
    }).sort((a, b) => Number(b.online) - Number(a.online)
      || String(a.deviceId).localeCompare(String(b.deviceId)));

    return res.status(200).json({
      success: true,
      types: bucketTare.BUCKET_TYPES.map((x) => ({
        id: x.id,
        label: x.label,
        slots: x.slots.map((s) => SLOT_LABEL[s] || s),
      })),
      tares: tares.values,
      meta: tares.meta,
      devices,
      range: bucketTare.TARE_RANGE,
    });
  } catch (error) {
    console.error('讀取桶型皮重失敗:', error);
    return bad(res, 500, error.message || '讀取桶型皮重失敗');
  }
};

/**
 * POST /api/admin/bucket-tare/measure
 * body: { deviceId, bucketType }
 *
 * 用指定的那台秤量現在放在上面的空桶。取 netG 而不是 grossG：
 * netG 已經扣掉裝置自身的 tareG（秤台上固定的托盤），
 * 所以量到的就是「容器本身」的重量，兩層扣重不會重複計算。
 */
const measureBucketTare = async (req, res) => {
  try {
    const deviceId = String(req.body.deviceId || '').trim();
    const bucketType = String(req.body.bucketType || '').trim();
    if (!deviceId) return bad(res, 400, '請選擇要用哪一台秤量測');
    if (!bucketType) return bad(res, 400, '請選擇桶型');

    const reading = await scaleReadings.latestByDevice(deviceId);
    if (reading.state !== 'ok') {
      return bad(res, 409, `這台秤現在讀不到有效重量：${reading.note || reading.state}`, {
        reading,
      });
    }
    // 重量欄位是 value_g（classify() 的輸出），不是 netG。
    // value_g 已經是 grossG − 裝置 tareG，也就是「放在秤上的容器」的重量。
    if (!Number.isFinite(Number(reading.value_g))) {
      return bad(res, 409, '讀數沒有有效的重量值', { reading });
    }

    const after = await bucketTare.setTare({
      bucketType,
      tareG: Number(reading.value_g),
      method: 'measured',
      deviceId,
      uid: req.user.uid,
      displayName: req.user.displayName,
    });

    return res.status(200).json({
      success: true,
      message: `已把「${bucketTare.bucketTypeLabel(bucketType)}」的皮重設為 `
        + `${Math.round(Number(reading.value_g) * 10) / 10} g（全校共用）`,
      measuredG: Number(reading.value_g),
      reading,
      tares: after.values,
      meta: after.meta,
    });
  } catch (error) {
    console.error('量測桶型皮重失敗:', error);
    return bad(res, error.status || 500, error.message || '量測桶型皮重失敗');
  }
};

/**
 * PUT /api/admin/bucket-tare
 * body: { bucketType, tareG }
 * 手動輸入（秤不在手邊、或拿別的磅秤量好了）。
 */
const updateBucketTare = async (req, res) => {
  try {
    const after = await bucketTare.setTare({
      bucketType: String(req.body.bucketType || '').trim(),
      tareG: req.body.tareG,
      method: 'manual',
      uid: req.user.uid,
      displayName: req.user.displayName,
    });
    return res.status(200).json({
      success: true,
      message: '已更新皮重（全校共用）',
      tares: after.values,
      meta: after.meta,
    });
  } catch (error) {
    return bad(res, error.status || 500, error.message || '更新皮重失敗');
  }
};


module.exports = {
  getCoinRules,
  updateCoinRules,
  syncStudents,
  syncMenus,
  getShop,
  updateShop,
  getBucketTare,
  measureBucketTare,
  updateBucketTare,
};
