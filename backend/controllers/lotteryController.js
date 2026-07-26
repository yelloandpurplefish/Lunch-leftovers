const { db, admin } = require('../config/firebase');

// 進行抽獎
const spinLottery = async (req, res) => {
  try {
    const userId = req.user.uid;
    const lotteryCost = 10;

    // 獲取使用者資料
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: '使用者不存在'
      });
    }

    const userData = userDoc.data();

    // 檢查 E幣是否足夠
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

    // 抽獎邏輯
    const rand = Math.random() * 100;
    let prize, prizeType, prizeValue;

    if (rand < 5) {
      // 大獎 5%
      const grandPrizes = [
        { name: '豪華文具組', value: 60 },
        { name: '特別獎勵包', value: 55 },
        { name: '稀有空氣清新劑', value: 50 }
      ];
      const selected = grandPrizes[Math.floor(Math.random() * grandPrizes.length)];
      prize = selected.name;
      prizeValue = selected.value;
      prizeType = 'grand';
    } else if (rand < 35) {
      // 普通 30%
      const normalPrizes = [
        { name: '筆記本', value: 30 },
        { name: '鉛筆組', value: 25 },
        { name: '尺', value: 20 },
        { name: '書籤', value: 15 }
      ];
      const selected = normalPrizes[Math.floor(Math.random() * normalPrizes.length)];
      prize = selected.name;
      prizeValue = selected.value;
      prizeType = 'normal';
    } else {
      // 小獎 65%
      const smallPrizes = [
        { name: '糖果', value: 5 },
        { name: '紙巾', value: 3 },
        { name: '飲用水', value: 2 }
      ];
      const selected = smallPrizes[Math.floor(Math.random() * smallPrizes.length)];
      prize = selected.name;
      prizeValue = selected.value;
      prizeType = 'small';
    }

    // 發放獎勵
    await db.collection('users').doc(userId).update({
      eCoin: admin.firestore.FieldValue.increment(prizeValue)
    });

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

    // 獲取更新後的餘額
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
      .orderBy('drawnAt', 'desc')
      .limit(limit)
      .get();

    const history = historyQuery.docs.map(doc => {
      const data = doc.data();
      return {
        prizeName: data.prizeName,
        prizeType: data.prizeType,
        prizeValue: data.prizeValue,
        drawnAt: data.drawnAt.toDate().toISOString()
      };
    });

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

module.exports = { spinLottery, getLotteryHistory };
