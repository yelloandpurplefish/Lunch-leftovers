/**
 * 體位判定與建議攝取熱量。
 *
 * ## 為什麼不能用成人的 18.5 / 24
 *
 * 兒童與青少年的 BMI 判讀隨年齡變化：一個 10 歲學生 BMI 19 其實已經過重，
 * 但用成人標準會被判成「正常」，進而拿到偏高的建議熱量——判錯的方向
 * 剛好是最不該錯的方向。因此優先查「衛生福利部．兒童及青少年生長身體質量
 * 指數（BMI）建議值」，依**年齡與性別**各有一組界線。
 * 名冊同步時已經存了年齡與性別（lib/studentSheet.js），正好供這裡使用。
 *
 * ## 表格請定期核對
 *
 * 下表為 6–18 歲的界線（過輕下限 / 過重上限，以「肥胖」併入過重處理，
 * 因為這個功能只需要過輕、正常、過重三類）。這是會被主管機關更新的數據，
 * 刻意獨立成一個資料模組，校方可直接比對官方公告修改，不必動到任何邏輯。
 *
 * 查不到年齡或性別（例如名冊還沒填）時，退回開發者面板上的
 * intake.fallbackUnderweightBmi / fallbackOverweightBmi 這組全校共用界線，
 * 並在結果裡標明 source='fallback'，讓前端可以說明這是估算。
 */

/** [過輕下限, 過重上限]，index 0 = 男、1 = 女。 */
const TABLE = {
  6:  { male: [13.5, 16.9], female: [13.1, 17.2] },
  7:  { male: [13.8, 17.9], female: [13.4, 17.7] },
  8:  { male: [14.1, 19.0], female: [13.8, 18.4] },
  9:  { male: [14.3, 19.5], female: [14.0, 19.1] },
  10: { male: [14.5, 20.0], female: [14.3, 19.7] },
  11: { male: [14.8, 20.7], female: [14.7, 20.5] },
  12: { male: [15.2, 21.3], female: [15.2, 21.3] },
  13: { male: [15.7, 21.9], female: [15.7, 21.9] },
  14: { male: [16.3, 22.5], female: [16.3, 22.5] },
  15: { male: [16.9, 22.9], female: [16.7, 22.7] },
  16: { male: [17.4, 23.3], female: [17.1, 22.7] },
  17: { male: [17.8, 23.5], female: [17.3, 22.7] },
  18: { male: [18.0, 23.6], female: [17.5, 22.7] },
};

const UNDERWEIGHT = '過輕';
const NORMAL = '正常';
const OVERWEIGHT = '過重';

/**
 * 性別欄位可能是「男」「女」「M」「F」「male」…，一律收斂成 male / female。
 * 認不出來就回 null，交給 fallback——猜性別比用全校界線更糟。
 */
function normGender(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v) return null;
  if (['男', '男生', '男性', 'm', 'male', 'boy', '1'].includes(v)) return 'male';
  if (['女', '女生', '女性', 'f', 'female', 'girl', '2'].includes(v)) return 'female';
  return null;
}

/** 年齡取整數歲；超出表格範圍回 null。 */
function tableAge(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const age = Math.floor(n);
  return TABLE[age] ? age : null;
}

/**
 * 依 BMI 判定體位。
 * @returns {{category:string, source:'table'|'fallback', cutoffs:[number,number],
 *            age:number|null, gender:string|null}|null} BMI 無效時回 null
 */
function classify({ bmi, age, gender, fallbackUnderweight, fallbackOverweight }) {
  const b = Number(bmi);
  if (!Number.isFinite(b) || b <= 0) return null;

  const g = normGender(gender);
  const a = tableAge(age);

  let cutoffs;
  let source;
  if (a !== null && g) {
    cutoffs = TABLE[a][g];
    source = 'table';
  } else {
    const lo = Number(fallbackUnderweight);
    const hi = Number(fallbackOverweight);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return null;
    cutoffs = [lo, hi];
    source = 'fallback';
  }

  const [under, over] = cutoffs;
  let category = NORMAL;
  if (b < under) category = UNDERWEIGHT;
  else if (b >= over) category = OVERWEIGHT;

  return { category, source, cutoffs, age: a, gender: g };
}

/**
 * 體位 → 建議的**一餐**熱量。
 * 正常 = normalKcal；過重往下、過輕往上各調整 adjustKcal。
 * 夾在 0 以上：面板若把調整量設得比基準還大，不該算出負的熱量。
 */
function kcalFor(category, { normalKcal, adjustKcal }) {
  const base = Number(normalKcal);
  const delta = Number(adjustKcal);
  if (!Number.isFinite(base)) return null;
  const d = Number.isFinite(delta) ? delta : 0;
  if (category === OVERWEIGHT) return Math.max(0, Math.round(base - d));
  if (category === UNDERWEIGHT) return Math.max(0, Math.round(base + d));
  return Math.max(0, Math.round(base));
}

/** 由身高體重算 BMI（名冊沒同步到 bmi 欄位時的備援）。 */
function computeBmi(heightCm, weightKg) {
  const h = Number(heightCm);
  const w = Number(weightKg);
  if (!Number.isFinite(h) || !Number.isFinite(w) || h <= 0 || w <= 0) return null;
  return Math.round((w / ((h / 100) ** 2)) * 10) / 10;
}

/**
 * 給前端用的完整結果：體位 + 建議熱量 + 判定依據。
 * 判定依據要回傳，因為「依年齡性別查表」和「用全校共用界線估算」
 * 對家長與學生的意義不同，介面上必須說得出來是哪一種。
 */
function intakeAdvice({ bmi, heightCm, weightKg, age, gender }, settings) {
  const intake = (settings && settings.intake) || {};
  const value = Number.isFinite(Number(bmi)) && Number(bmi) > 0
    ? Math.round(Number(bmi) * 10) / 10
    : computeBmi(heightCm, weightKg);

  if (value === null) {
    return { bmi: null, category: null, kcal: null, source: 'no_data' };
  }

  const c = classify({
    bmi: value,
    age,
    gender,
    fallbackUnderweight: intake.fallbackUnderweightBmi,
    fallbackOverweight: intake.fallbackOverweightBmi,
  });
  if (!c) return { bmi: value, category: null, kcal: null, source: 'no_data' };

  return {
    bmi: value,
    category: c.category,
    kcal: kcalFor(c.category, intake),
    normalKcal: kcalFor(NORMAL, intake),
    source: c.source,
    cutoffs: c.cutoffs,
    age: c.age,
    gender: c.gender,
  };
}

module.exports = {
  TABLE,
  UNDERWEIGHT,
  NORMAL,
  OVERWEIGHT,
  normGender,
  classify,
  kcalFor,
  computeBmi,
  intakeAdvice,
};
