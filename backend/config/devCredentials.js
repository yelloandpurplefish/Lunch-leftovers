/**
 * 開發/測試帳號的密碼來源。
 *
 * 目標：本機 `npm start` 不必先設任何環境變數，啟動就有一組可登入的測試帳密；
 * 同時保證**正式環境不會憑空長出共用帳號**。
 *
 * 解析順序：
 *  1. `TEST_USER_PASSWORD`（≥12 字元）→ 直接用，行為與原本相同。
 *  2. 非正式環境且未設定 → 自動產生一組隨機密碼，並存到 `backend/.dev-test-password`。
 *     **一定要存檔**：帳號只會在第一次啟動時建立（idempotent），
 *     若每次重啟都換密碼，資料庫裡的舊雜湊就再也對不上，帳號等於鎖死。
 *  3. 正式環境未設定 → 回 null，不建立任何測試帳號。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PASSWORD_FILE = path.join(__dirname, '..', '.dev-test-password');
const MIN_LENGTH = 12;

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/** 產生易讀又夠長的密碼（避免容易看錯的字元）。*/
function generatePassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function readStored() {
  try {
    const text = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
    return text.length >= MIN_LENGTH ? text : null;
  } catch {
    return null;
  }
}

function writeStored(password) {
  try {
    fs.writeFileSync(
      PASSWORD_FILE,
      password + '\n',
      { encoding: 'utf8', mode: 0o600 }
    );
    return true;
  } catch (error) {
    console.warn('  ⚠️  無法寫入 .dev-test-password：' + error.message);
    return false;
  }
}

/**
 * @returns {{password: string|null, source: string, reason?: string}}
 */
function resolveTestPassword() {
  const fromEnv = process.env.TEST_USER_PASSWORD;

  if (fromEnv) {
    if (fromEnv.length < MIN_LENGTH) {
      return { password: null, source: 'env', reason: `TEST_USER_PASSWORD 需至少 ${MIN_LENGTH} 字元` };
    }
    return { password: fromEnv, source: 'env' };
  }

  if (isProduction()) {
    return {
      password: null,
      source: 'none',
      reason: '正式環境未設定 TEST_USER_PASSWORD，不自動建立測試帳號',
    };
  }

  const stored = readStored();
  if (stored) return { password: stored, source: 'file' };

  const generated = generatePassword();
  const saved = writeStored(generated);
  return {
    password: generated,
    source: saved ? 'generated' : 'generated-unsaved',
    reason: saved ? undefined : '密碼未能存檔，重啟後可能無法再登入既有測試帳號',
  };
}

/** 是否要建立測試帳號：正式環境需明確開啟，開發環境預設開啟。*/
function shouldSeedTestAccounts() {
  const flag = process.env.SEED_TEST_ACCOUNTS;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return !isProduction();          // 開發環境預設建立，省去手動設定
}

module.exports = {
  PASSWORD_FILE,
  MIN_LENGTH,
  isProduction,
  resolveTestPassword,
  shouldSeedTestAccounts,
};
