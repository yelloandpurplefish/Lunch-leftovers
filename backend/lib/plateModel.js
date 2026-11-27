/**
 * 個人餐盤辨識模型 —— TensorFlow.js 影像分類（object classification）的**預留端點**。
 *
 * 流程只需要一張照片：學生吃完拍自己的餐盤 → 這裡判斷剩多少 →
 * controllers/plateController.js 依剩餘量給回饋。
 * 模型在**後端**跑，不在學生手機上：結果學生改不了，之後依結果發 ESG 幣才可信。
 *
 * ## 這一輪定下來的介面（controller 只依賴這兩支）
 *
 *   modelStatus()          → { ready, mode, note }
 *   analyzePlate(buffer)   → { leftoverRatio, label, confidence, mode, modelVersion }
 *                             leftoverRatio：0＝吃光、1＝原封不動
 *
 * ## 下一輪要定的（刻意留空）
 *
 *   1. 模型檔：PLATE_MODEL_URL 指向 TF.js 的 model.json（http(s) 或 file://），
 *      在 classify() 裡用 @tensorflow/tfjs-node 的 loadLayersModel / loadGraphModel 載入、
 *      decodeImage → resize → predict。套件到時再加，這一輪不裝。
 *   2. 模型回傳：classify() 的原始輸出格式（類別標籤、機率）。
 *      目前暫定沿用 TF.js 影像分類慣用的 [{ className, probability }]（機率由高到低）。
 *   3. toLeftover()：原始輸出 → leftoverRatio 的換算（現在用的是下面的暫定類別表）。
 *   4. ESG 幣怎麼發——在 controller，不在這裡。
 *
 * ## 模式
 *
 *   stub   開發用假結果：連模擬器、或 PLATE_MODEL_STUB=true（正式環境一律不給）
 *   model  已設定 PLATE_MODEL_URL —— 執行環境下一輪才接上，目前回 503
 *   none   都沒有 → 回 503「辨識模型尚未接上」
 */
const crypto = require('crypto');
const { plateStubEnabled } = require('./runtimeFlags');

/**
 * 暫定的類別表：類別 → 代表的剩餘比例。
 * 只是讓假結果與回饋流程走得通；真正的類別與換算下一輪隨模型一起定。
 */
const PROVISIONAL_CLASSES = [
  { className: 'clean', label: '吃光', ratio: 0 },
  { className: 'little', label: '剩一點', ratio: 0.15 },
  { className: 'half', label: '剩一半', ratio: 0.4 },
  { className: 'most', label: '剩很多', ratio: 0.75 },
];

function notReady(note) {
  const err = new Error(note);
  err.status = 503;
  return err;
}

function modelStatus(env = process.env) {
  if (plateStubEnabled(env)) {
    return { ready: true, mode: 'stub', note: '開發用假結果：辨識模型尚未接上' };
  }
  if (String(env.PLATE_MODEL_URL || '').trim()) {
    return { ready: false, mode: 'model', note: '已設定 PLATE_MODEL_URL，但模型執行環境還沒接上' };
  }
  return { ready: false, mode: 'none', note: '餐盤辨識模型尚未接上' };
}

/**
 * 假結果：由照片內容決定（同一張照片永遠同一個結果，測試才好比對），
 * 不是亂數，也完全不看照片裡有什麼。
 */
function stubClassify(image) {
  const h = crypto.createHash('sha256').update(image).digest();
  const top = h[0] % PROVISIONAL_CLASSES.length;
  const p = 0.55 + (h[1] / 255) * 0.4;
  const rest = (1 - p) / (PROVISIONAL_CLASSES.length - 1);
  return PROVISIONAL_CLASSES
    .map((c, i) => ({ className: c.className, probability: i === top ? p : rest }))
    .sort((a, b) => b.probability - a.probability);
}

/**
 * 模型端點：照片 → 模型的原始輸出。
 * @param {Buffer} image 已驗證過格式與大小的 JPEG / PNG / WebP
 */
async function classify(image, env = process.env) {
  const status = modelStatus(env);
  if (status.mode === 'stub') return stubClassify(image);
  throw notReady(status.note);
}

/** 原始輸出 → { leftoverRatio, label, confidence }。 */
function toLeftover(predictions) {
  const top = Array.isArray(predictions) ? predictions[0] : null;
  const cls = top && PROVISIONAL_CLASSES.find((c) => c.className === top.className);
  if (!cls) {
    const err = new Error('辨識結果無法解讀');
    err.status = 502;
    throw err;
  }
  return {
    leftoverRatio: cls.ratio,
    label: cls.label,
    confidence: Math.round(Number(top.probability || 0) * 1000) / 1000,
  };
}

async function analyzePlate(image, env = process.env) {
  const status = modelStatus(env);
  const predictions = await classify(image, env);
  return {
    ...toLeftover(predictions),
    mode: status.mode,
    modelVersion: status.mode === 'stub' ? 'stub' : null,
  };
}

module.exports = { modelStatus, analyzePlate, PROVISIONAL_CLASSES };
