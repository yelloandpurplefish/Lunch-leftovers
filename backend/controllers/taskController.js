const { db, admin } = require('../config/firebase');

// 完成光盤行動任務
const completeLightDisc = async (req, res) => {
  try {
    const userId = req.user.uid;
    const now = admin.firestore.FieldValue.serverTimestamp();
    const cooldownHours = 24;
    const cooldownMs = cooldownHours * 60 * 60 * 1000;

    // 檢查上次完成時間
    const taskQuery = await db.collection('task_records')
      .where('userId', '==', userId)
      .where('taskType', '==', 'light_disc')
      .orderBy('completedAt', 'desc')
      .limit(1)
      .get();

    if (!taskQuery.empty) {
      const lastRecord = taskQuery.docs[0].data();
      const lastCompletedAt = lastRecord.completedAt.toDate();
      const timeSinceLast = Date.now() - lastCompletedAt.getTime();

      if (timeSinceLast < cooldownMs) {
        const hoursRemaining = Math.ceil((cooldownMs - timeSinceLast) / (60 * 60 * 1000));
        return res.status(400).json({
          success: false,
          message: '尚未達到領取時間',
          hoursRemaining
        });
      }
    }

    // 獲取使用者資料
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    // 計算獎勵
    const rewards = {
      eCoin: 10,
      sCoin: 5,
      score: 30
    };

    // 更新使用者貨幣
    await db.collection('users').doc(userId).update({
      eCoin: admin.firestore.FieldValue.increment(rewards.eCoin),
      sCoin: admin.firestore.FieldValue.increment(rewards.sCoin),
      score: admin.firestore.FieldValue.increment(rewards.score)
    });

    // 記錄任務完成
    await db.collection('task_records').add({
      userId,
      taskType: 'light_disc',
      completedAt: now,
      rewards,
      metadata: {}
    });

    // 計算下次可領取時間
    const nextAvailableAt = new Date(Date.now() + cooldownMs);

    res.status(200).json({
      success: true,
      message: '任務完成！',
      rewards,
      nextAvailableAt: nextAvailableAt.toISOString()
    });
  } catch (error) {
    console.error('完成光盤行動失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '完成任務失敗'
    });
  }
};

// 領取剩食獎勵
const claimLeftoverReward = async (req, res) => {
  try {
    const userId = req.user.uid;
    const { leftoverWeight, foodAnalysis } = req.body;
    const now = admin.firestore.FieldValue.serverTimestamp();
    const cooldownHours = 24;
    const cooldownMs = cooldownHours * 60 * 60 * 1000;

    // 驗證輸入
    if (!leftoverWeight || leftoverWeight < 0) {
      return res.status(400).json({
        success: false,
        message: '請提供有效的剩食重量'
      });
    }

    if (!foodAnalysis || foodAnalysis.length === 0) {
      return res.status(400).json({
        success: false,
        message: '請先填寫分析剩食資料'
      });
    }

    // 檢查是否有填寫剩食資料
    const hasAnalysis = foodAnalysis.some(item => item.leftoverGrams > 0);
    if (!hasAnalysis) {
      return res.status(400).json({
        success: false,
        message: '請至少填寫一項剩食資料'
      });
    }

    // 檢查上次領取時間
    const taskQuery = await db.collection('task_records')
      .where('userId', '==', userId)
      .where('taskType', '==', 'leftover_reward')
      .orderBy('completedAt', 'desc')
      .limit(1)
      .get();

    if (!taskQuery.empty) {
      const lastRecord = taskQuery.docs[0].data();
      const lastCompletedAt = lastRecord.completedAt.toDate();
      const timeSinceLast = Date.now() - lastCompletedAt.getTime();

      if (timeSinceLast < cooldownMs) {
        const hoursRemaining = Math.ceil((cooldownMs - timeSinceLast) / (60 * 60 * 1000));
        return res.status(400).json({
          success: false,
          message: '尚未達到領取時間',
          hoursRemaining
        });
      }
    }

    // 計算獎勵
    let addE, addS;
    if (leftoverWeight <= 10) {
      addE = 20;
      addS = 10;
    } else if (leftoverWeight <= 30) {
      addE = 15;
      addS = 8;
    } else if (leftoverWeight <= 50) {
      addE = 10;
      addS = 5;
    } else {
      addE = 5;
      addS = 2;
    }

    const rewards = { eCoin: addE, sCoin: addS };

    // 更新使用者貨幣
    await db.collection('users').doc(userId).update({
      eCoin: admin.firestore.FieldValue.increment(rewards.eCoin),
      sCoin: admin.firestore.FieldValue.increment(rewards.sCoin)
    });

    // 記錄任務完成
    await db.collection('task_records').add({
      userId,
      taskType: 'leftover_reward',
      completedAt: now,
      rewards,
      metadata: {
        leftoverWeight,
        foodAnalysis
      }
    });

    // 計算下次可領取時間
    const nextAvailableAt = new Date(Date.now() + cooldownMs);

    res.status(200).json({
      success: true,
      message: '獎勵已發放！',
      rewards,
      nextAvailableAt: nextAvailableAt.toISOString()
    });
  } catch (error) {
    console.error('領取剩食獎勵失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '領取獎勵失敗'
    });
  }
};

// 提交問卷
const submitSurvey = async (req, res) => {
  try {
    const userId = req.user.uid;
    const { favoriteFood, hateFood } = req.body;
    const now = admin.firestore.FieldValue.serverTimestamp();
    const cooldownHours = 24;
    const cooldownMs = cooldownHours * 60 * 60 * 1000;

    // 驗證輸入
    if (!favoriteFood || !hateFood) {
      return res.status(400).json({
        success: false,
        message: '請填寫所有欄位'
      });
    }

    // 檢查上次提交時間
    const taskQuery = await db.collection('task_records')
      .where('userId', '==', userId)
      .where('taskType', '==', 'survey')
      .orderBy('completedAt', 'desc')
      .limit(1)
      .get();

    if (!taskQuery.empty) {
      const lastRecord = taskQuery.docs[0].data();
      const lastCompletedAt = lastRecord.completedAt.toDate();
      const timeSinceLast = Date.now() - lastCompletedAt.getTime();

      if (timeSinceLast < cooldownMs) {
        const hoursRemaining = Math.ceil((cooldownMs - timeSinceLast) / (60 * 60 * 1000));
        return res.status(400).json({
          success: false,
          message: '尚未達到送出時間',
          hoursRemaining
        });
      }
    }

    // 記錄問卷提交
    await db.collection('task_records').add({
      userId,
      taskType: 'survey',
      completedAt: now,
      rewards: {},
      metadata: {
        favoriteFood,
        hateFood
      }
    });

    // 計算下次可送出時間
    const nextAvailableAt = new Date(Date.now() + cooldownMs);

    res.status(200).json({
      success: true,
      message: '問卷已送出！',
      nextAvailableAt: nextAvailableAt.toISOString()
    });
  } catch (error) {
    console.error('提交問卷失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '提交問卷失敗'
    });
  }
};

module.exports = { completeLightDisc, claimLeftoverReward, submitSurvey };
