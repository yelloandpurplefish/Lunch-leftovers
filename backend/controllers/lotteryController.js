const { db, admin } = require('../config/firebase');

// 進行抽獎
const spinLottery = async (req, res) => {
  try {
    const userId = req.user.uid;
    const lotteryCost = 10;

    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: '使用者不存在'
      });
    }

    const userData = userDoc.data();

    if (userData.eCoin < lotteryCost) {
      return res.status(400).json({
        success: false,
        message: 'E幣不足',
        required: lotteryCost,
        current: userData.eCoin
      });
    }

    // 扣除 E幣
    await db.collection('users').doc(userId).update({
      eCoin: admin.firestore.FieldValue.increment(-lotteryCost)
    });

    // 抽獎邏輯：大獎 2%、稀有 18%、小獎 80%
    const rand = Math.random() * 100;
    let prize, prizeType, prizeValue;

    if (rand < 2) {
      const grandPrizes = [
        { name: '🎁 豪華文具組', value: 60 },
        { name: '🌟 特別獎勵包', value: 55 },
        { name: '💎 稀有空氣清新劑', value: 50 },
        { name: '🎧 無線藍牙耳機', value: 70 },
        { name: '🎮 掌上遊戲機', value: 65 },
        { name: '🎒 限量後背包', value: 58 }
      ];
      const selected = grandPrizes[Math.floor(Math.random() * grandPrizes.length)];
      prize = selected.name;
      prizeValue = selected.value;
      prizeType = 'grand';
    } else if (rand < 20) {
      const rarePrizes = [
        { name: '📝 筆記本', value: 30 },
        { name: '✏️ 鉛筆組', value: 25 },
        { name: '📏 尺', value: 20 },
        { name: '🔖 書籤', value: 15 },
        { name: '🖊️ 原子筆', value: 18 },
        { name: '🗂️ 資料夾', value: 22 },
        { name: '🧃 果汁', value: 12 },
        { name: '🍪 餅乾', value: 14 }
      ];
      const selected = rarePrizes[Math.floor(Math.random() * rarePrizes.length)];
      prize = selected.name;
      prizeValue = selected.value;
      prizeType = 'rare';
    } else {
      const smallPrizes = [
        { name: '🍬 糖果', value: 5 },
        { name: '🧻 紙巾', value: 3 },
        { name: '💧 飲用水', value: 2 },
        { name: '🍭 棒棒糖', value: 4 },
        { name: '🍫 巧克力', value: 6 },
        { name: '🥠 幸運餅乾', value: 3 },
        { name: '🧼 小肥皂', value: 2 },
        { name: '🎈 氣球', value: 2 }
      ];
      const selected = smallPrizes[Math.floor(Math.random() * smallPrizes.length)];
      prize = selected.name;
      prizeValue = selected.value;
      prizeType = 'small';
    }

    // 記錄抽獎
    await db.collection('lottery_records').add({
      userId,
      cost: lotteryCost,
      prizeType,
      prizeName: prize,
      prizeValue,
      drawnAt: admin.firestore.FieldValue.serverTimestamp(),
      isGrandPrize: prizeType === 'grand'
    });

    // 若為大獎，寫入全站公告
    if (prizeType === 'grand') {
      await db.collection('lottery_announcements').doc('latest').set({
        userId,
        displayName: userData.displayName || '匿名使用者',
        prizeName: prize,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    const updatedUserDoc = await db.collection('users').doc(userId).get();
    const updatedUserData = updatedUserDoc.data();

    res.status(200).json({
      success: true,
      prize: {
        type: prizeType,
        name: prize,
        value: prizeValue,
        isGrandPrize: prizeType === 'grand'
      },
      remainingECoin: updatedUserData.eCoin
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
