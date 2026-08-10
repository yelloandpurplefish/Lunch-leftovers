// ============================================================
// 手動觸發資料庫初始化的 CLI 工具
// 實際邏輯統一由 backend/config/seed.js 提供
//
// 使用方式：
//   npm run seed
//
// 需要的環境變數（寫在 backend/.env）：
//   SEED_TEST_ACCOUNTS=true
//   TEST_USER_PASSWORD=<至少 12 字元>
// ============================================================

const path = require('path');

require('dotenv').config({
  path: path.join(__dirname, '..', 'backend', '.env')
});

const { initializeDatabase, TEST_ACCOUNTS } = require('../backend/config/seed');

async function main() {
  await initializeDatabase();

  if (process.env.SEED_TEST_ACCOUNTS === 'true' && process.env.TEST_USER_PASSWORD) {
    console.log('📋 測試帳號：');
    console.log('================================================');
    TEST_ACCOUNTS.forEach(({ email, displayName, role }) => {
      console.log(`${email}  (${displayName} / ${role})`);
    });
    console.log('================================================');
    console.log('密碼：由 TEST_USER_PASSWORD 環境變數決定\n');
    console.log('⚠️  這些帳號僅供開發測試，正式上線前請刪除\n');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ 執行失敗:', error);
    process.exit(1);
  });