const { db, admin } = require('../config/firebase');
const { spendUser } = require('../lib/coins');

/** 每抽一次的 ESG 幣。前端的「需要 40 ESG 幣」說明與這裡一致。 */
const LOTTERY_COST = 40;

const PRIZES = {
  grand: [
    { name: '🎁 豪華文具組', value: 240 },
    { name: '🌟 特別獎勵包', value: 220 },
    { name: '💎 稀有空氣清新劑', value: 200 },
    { name: '🎧 無線藍牙耳機', value: 280 },
    { name: '🎮 掌上遊戲機', value: 260 },
    { name: '🎒 限量後背包', value: 232 },
  ],
  rare: [
    { name: '📝 筆記本', value: 120 },
    { name: '✏️ 鉛筆組', value: 100 },
    { name: '📏 尺', value: 80 },
    { name: '🔖 書籤', value: 60 },
    { name: '🖊️ 原子筆', value: 72 },
    { name: '🗂️ 資料夾', value: 88 },
    { name: '🧃 果汁', value: 48 },
    { name: '🍪 餅乾', value: 56 },
  ],
  small: [
    { name: '🍬 糖果', value: 20 },
    { name: '🧻 紙巾', value: 12 },
    { name: '💧 飲用水', value: 8 },
    { name: '🍭 棒棒糖', value: 16 },
    { name: '🍫 巧克力', value: 24 },
    { name: '🥠 幸運餅乾', value: 12 },
    { name: '🧼 小肥皂', value: 8 },
    { name: '🎈 氣球', value: 8 },
  ],
};

/** 抽獎邏輯：大獎 2%、稀有 18%、小獎 80% */
function drawPrize() {
  const rand = Math.random() * 100;
  const type = rand < 2 ? 'grand' : rand < 20 ? 'rare' : 'small';
  const pool = PRIZES[type];
  return { type, ...pool[Math.floor(Math.random() * pool.length)] };
}

// 進行抽獎
const spinLottery = async (req, res) => {
  try {
    const userId = req.user.uid;
    const prize = drawPrize();
    const now = admin.firestore.FieldValue.serverTimestamp();

    // 扣幣、抽獎紀錄、大獎公告在同一個 transaction：不會扣了幣卻沒有紀錄
    let spent;
    try {
      spent = await spendUser({
        userId,
        amount: LOTTERY_COST,
        reason: '幸運抽獎',
        refType: 'lottery',
        extra: (tx) => {
          tx.set(db.collection('lottery_records').doc(), {
            userId,
            cost: LOTTERY_COST,
            prizeType: prize.type,
            prizeName: prize.name,
            prizeValue: prize.value,
            drawnAt: now,
            isGrandPrize: prize.type === 'grand',
          });
          if (prize.type === 'grand') {
            tx.set(db.collection('lottery_announcements').doc('latest'), {
              userId,
              displayName: req.user.displayName || '匿名使用者',
              prizeName: prize.name,
              createdAt: now,
            });
          }
        },
      });
    } catch (err) {
      return res.status(err.status || 400).json({
        success: false,
        message: err.message || '扣款失敗',
        required: LOTTERY_COST,
      });
    }

    res.status(200).json({
      success: true,
      prize: {
        type: prize.type,
        name: prize.name,
        value: prize.value,
        isGrandPrize: prize.type === 'grand',
      },
      remainingCoin: spent.balanceAfter,
    });
  } catch (error) {
    console.error('抽獎失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '抽獎失敗'
    });
  }
};

// 獲取抽獎歷史
const getLotteryHistory = async (req, res) => {
  try {
    const userId = req.user.uid;
    const limit = parseInt(req.query.limit) || 10;

    const historyQuery = await db.collection('lottery_records')
      .where('userId', '==', userId)
      .get();

    const history = historyQuery.docs
      .map(doc => {
        const data = doc.data();
        return {
          prizeName: data.prizeName,
          prizeType: data.prizeType,
          prizeValue: data.prizeValue,
          drawnAt: data.drawnAt ? data.drawnAt.toDate().toISOString() : null
        };
      })
      .sort((a, b) => new Date(b.drawnAt || 0) - new Date(a.drawnAt || 0))
      .slice(0, limit);

    res.status(200).json({
      success: true,
      history
    });
  } catch (error) {
    console.error('獲取抽獎歷史失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '獲取抽獎歷史失敗'
    });
  }
};

// 獲取最新大獎公告
const getLatestGrandPrize = async (req, res) => {
  try {
    const doc = await db.collection('lottery_announcements').doc('latest').get();

    if (!doc.exists) {
      return res.status(200).json({
        success: true,
        announcement: null
      });
    }

    const data = doc.data();
    res.status(200).json({
      success: true,
      announcement: {
        displayName: data.displayName,
        prizeName: data.prizeName,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
      }
    });
  } catch (error) {
    console.error('獲取大獎公告失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '獲取大獎公告失敗'
    });
  }
};

module.exports = { spinLottery, getLotteryHistory, getLatestGrandPrize };
