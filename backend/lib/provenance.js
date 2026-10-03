/**
 * 資料來源標記與人工介入分級 —— 影像模組 `lunch_vision/session.py` 的鏡像。
 *
 * ## 為什麼後端也要有一份
 *
 * 分級判斷本身在 Python 模組裡（`session.evaluate()`），後端不重做判斷。
 * 但後端是**系統的紀錄真實來源**，必須能：
 *   1. 驗證辨識服務回傳的標記是不是合法值（外部服務的輸出一律當不可信）
 *   2. 在匯出校正資料集時，**由程式強制**篩掉不可用的來源
 *
 * 第 2 點是關鍵：`manual` 與 `image_only` 沒有可靠真值，`weight_only` 沒有影像特徵，
 * 納入迴歸會污染模型。這個篩選不能依賴人工記憶，必須寫死在程式裡。
 *
 * ⚠️ 這份常數與 `lunch_vision/session.py` 的 `Provenance` / `Level` 必須一致，
 *    改動任一邊都要同步另一邊。
 */

/** 資料來源。決定該筆紀錄能否用於自動校正。 */
const PROVENANCE = {
  AUTO: 'auto',                 // 全自動通過
  CONFIRMED: 'confirmed',       // 經人工確認後採用
  CORRECTED: 'corrected',       // 人工修正過菜色對應（重量未被修改）
  WEIGHT_ONLY: 'weight_only',   // 影像失敗，僅有重量
  IMAGE_ONLY: 'image_only',     // 無秤或秤故障，僅有影像估計
  MANUAL: 'manual',             // 管理員事後補登
  VOIDED: 'voided',             // 已作廢
};

/** 人工介入層級，數值越大越需要介入。 */
const LEVEL = {
  AUTO: 'auto',        // L0 自動通過
  CONFIRM: 'confirm',  // L1 提示確認，可採用亦可重測
  INPUT: 'input',      // L2 強制輸入，必須操作才能繼續
  REJECT: 'reject',    // L3 拒絕記錄，不留量測紀錄
};

const LEVEL_ORDER = { auto: 0, confirm: 1, input: 2, reject: 3 };

/**
 * 可用於自動校正的來源。
 * 只有「有影像 + 有可信重量」的紀錄能當迴歸樣本。
 */
const CALIBRATION_USABLE = new Set([
  PROVENANCE.AUTO,
  PROVENANCE.CONFIRMED,
  PROVENANCE.CORRECTED,
]);

const PROVENANCE_VALUES = new Set(Object.values(PROVENANCE));
const LEVEL_VALUES = new Set(Object.values(LEVEL));

/** 辨識服務回傳的標記可能是舊版或壞掉的值；不認得就當最保守的 image_only。 */
function normalizeProvenance(v) {
  const s = String(v || '').toLowerCase();
  return PROVENANCE_VALUES.has(s) ? s : PROVENANCE.IMAGE_ONLY;
}

/** 同理：不認得的層級一律當成需要人工確認，不可預設放行。 */
function normalizeLevel(v) {
  const s = String(v || '').toLowerCase();
  return LEVEL_VALUES.has(s) ? s : LEVEL.CONFIRM;
}

function usableForCalibration(provenance) {
  return CALIBRATION_USABLE.has(normalizeProvenance(provenance));
}

function atLeast(level, min) {
  return (LEVEL_ORDER[normalizeLevel(level)] || 0) >= (LEVEL_ORDER[min] || 0);
}

/** L3：不得留下量測紀錄。 */
function isRejected(level) {
  return normalizeLevel(level) === LEVEL.REJECT;
}

/** L1 以上：必須呈現給記錄者。 */
function needsAttention(level) {
  return atLeast(level, LEVEL.CONFIRM);
}

const PROVENANCE_ZH = {
  auto: '自動通過',
  confirmed: '人工確認',
  corrected: '人工修正菜色',
  weight_only: '僅重量（影像失敗）',
  image_only: '僅影像（無秤）',
  manual: '人工補登',
  voided: '已作廢',
};

module.exports = {
  PROVENANCE,
  PROVENANCE_ZH,
  LEVEL,
  LEVEL_ORDER,
  CALIBRATION_USABLE,
  normalizeProvenance,
  normalizeLevel,
  usableForCalibration,
  atLeast,
  isRejected,
  needsAttention,
};
