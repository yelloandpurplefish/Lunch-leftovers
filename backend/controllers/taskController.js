const { db, admin } = require('../config/firebase');

// 可支援班級列表（示範用）
const SUPPORT_CLASSES = [
  { classId: 'class-1a', className: '一年A班', leftoverWeight: 12 },
  { classId: 'class-1b', className: '一年B班', leftoverWeight: 25 },
  { classId: 'class-2a', className: '二年A班', leftoverWeight: 8 },
  { classId: 'class-2b', className: '二年B班', leftoverWeight: 32 },
  { classId: 'class-3a', className: '三年A班', leftoverWeight: 18 }
];

// 支援任務獎勵：光盤行動的 1.5 倍
const SUPPORT_REWARDS = {
  eCoin: 15,
  sCoin: 8,
  score: 45
};

function isToday(date) {
  const now = new Date();
  return date.getFullYear() === now.getFullYear() &&
         date.getMonth() === now.getMonth() &&
         date.getDate() === now.getDate();
}

function getUserTaskRecords(recordsSnapshot) {
  return recordsSnapshot.docs.map(doc => doc.data());
}

// 取得使用者某類任務的最新記錄
async function getLastTaskRecord(userId, taskType) {
  const snapshot = await db.collection('task_records')
    .where('userId', '==', userId)
    .get();

  if (snapshot.empty) return null;

  const records = snapshot.docs
    .map(doc => doc.data())
    .filter(record => record.taskType === taskType && record.completedAt)
    .sort((a, b) => b.completedAt.toDate().getTime() - a.completedAt.toDate().getTime());

  return records[0] || null;
}

// 檢查是否已有待審核的同類記錄
async function hasPendingRecord(userId, taskType) {
  const snapshot = await db.collection('task_records')
    .where('userId', '==', userId)
    .get();

  return snapshot.docs.some(doc => {
    const data = doc.data();
    return data.taskType === taskType && data.status === 'pending';
  });
}

// 完成光盤行動任務（改為老師驗證）
const completeLightDisc = async (req, res) => {
  try {
    const userId = req.user.uid;
    const now = admin.firestore.FieldValue.serverTimestamp();

    if (await hasPendingRecord(userId, 'light_disc')) {
      return res.status(400).json({
        success: false,
        message: '已有待審核的光盤行動記錄'
      });
    }

    const rewards = {
      eCoin: 10,
      sCoin: 5,
      score: 30
    };

    await db.collection('task_records').add({
      userId,
      taskType: 'light_disc',
      status: 'pending',
      requestedAt: now,
      rewards,
      metadata: {}
    });

    res.status(200).json({
      success: true,
      message: '已送出老師審核',
      pending: true,
      rewards
    });
  } catch (error) {
    console.error('完成光盤行動失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '完成任務失敗'
    });
  }
};

// 領取剩食獎勵（改為老師驗證）
const claimLeftoverReward = async (req, res) => {
  try {
    const userId = req.user.uid;
    const { leftoverWeight, foodAnalysis } = req.body;
    const now = admin.firestore.FieldValue.serverTimestamp();

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

    const hasAnalysis = foodAnalysis.some(item => item.leftoverGrams > 0);
    if (!hasAnalysis) {
      return res.status(400).json({
        success: false,
        message: '請至少填寫一項剩食資料'
      });
    }

    if (await hasPendingRecord(userId, 'leftover_reward')) {
      return res.status(400).json({
        success: false,
        message: '已有待審核的剩食獎勵記錄'
      });
    }

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

    await db.collection('task_records').add({
      userId,
      taskType: 'leftover_reward',
      status: 'pending',
      requestedAt: now,
      rewards,
      metadata: {
        leftoverWeight,
        foodAnalysis
      }
    });

    res.status(200).json({
      success: true,
      message: '已送出老師審核',
      pending: true,
      rewards
    });
  } catch (error) {
    console.error('領取剩食獎勵失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '領取獎勵失敗'
    });
  }
};

// 提交問卷（改為老師驗證）
const submitSurvey = async (req, res) => {
  try {
    const userId = req.user.uid;
    const { favoriteFood, hateFood } = req.body;
    const now = admin.firestore.FieldValue.serverTimestamp();

    if (!favoriteFood || !hateFood) {
      return res.status(400).json({
        success: false,
        message: '請填寫所有欄位'
      });
    }

    if (await hasPendingRecord(userId, 'survey')) {
      return res.status(400).json({
        success: false,
        message: '已有待審核的問卷記錄'
      });
    }

    await db.collection('task_records').add({
      userId,
      taskType: 'survey',
      status: 'pending',
      requestedAt: now,
      rewards: {},
      metadata: {
        favoriteFood,
        hateFood
      }
    });

    res.status(200).json({
      success: true,
      message: '已送出老師審核',
      pending: true
    });
  } catch (error) {
    console.error('提交問卷失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '提交問卷失敗'
    });
  }
};

// 老師取得待審核項目
const getPendingTasks = async (req, res) => {
  try {
    const snapshot = await db.collection('task_records')
      .where('status', '==', 'pending')
      .get();

    const pendingList = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const userDoc = await db.collection('users').doc(data.userId).get();
      const userData = userDoc.exists ? userDoc.data() : {};

      pendingList.push({
        recordId: doc.id,
        userId: data.userId,
        displayName: userData.displayName || '匿名',
        taskType: data.taskType,
        rewards: data.rewards || {},
        metadata: data.metadata || {},
        requestedAt: data.requestedAt ? data.requestedAt.toDate().toISOString() : null
      });
    }

    pendingList.sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));

    res.status(200).json({
      success: true,
      pending: pendingList
    });
  } catch (error) {
    console.error('取得待審核項目失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '取得待審核項目失敗'
    });
  }
};

// 老師審核項目
const verifyTask = async (req, res) => {
  try {
    const teacherId = req.user.uid;
    const { recordId, action } = req.body;

    if (!recordId || !action) {
      return res.status(400).json({
        success: false,
        message: '請提供記錄 ID 與審核動作'
      });
    }

    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({
        success: false,
        message: '審核動作必須為 approve 或 reject'
      });
    }

    const recordRef = db.collection('task_records').doc(recordId);
    const recordDoc = await recordRef.get();

    if (!recordDoc.exists) {
      return res.status(404).json({
        success: false,
        message: '記錄不存在'
      });
    }

    const record = recordDoc.data();

    if (record.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: '此記錄已審核過'
      });
    }

    const userRef = db.collection('users').doc(record.userId);
    const now = admin.firestore.FieldValue.serverTimestamp();

    if (action === 'approve') {
      const updates = {};
      const rewards = record.rewards || {};

      if (rewards.eCoin) updates.eCoin = admin.firestore.FieldValue.increment(rewards.eCoin);
      if (rewards.sCoin) updates.sCoin = admin.firestore.FieldValue.increment(rewards.sCoin);
      if (rewards.score) updates.score = admin.firestore.FieldValue.increment(rewards.score);

      if (Object.keys(updates).length > 0) {
        await userRef.update(updates);
      }

      await recordRef.update({
        status: 'approved',
        completedAt: now,
        verifiedAt: now,
        verifiedBy: teacherId
      });

      res.status(200).json({
        success: true,
        message: '已核准',
        rewards
      });
    } else {
      await recordRef.update({
        status: 'rejected',
        rejectedAt: now,
        rejectedBy: teacherId
      });

      res.status(200).json({
        success: true,
        message: '已拒絕'
      });
    }
  } catch (error) {
    console.error('審核任務失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '審核任務失敗'
    });
  }
};

// 取得可支援班級列表
const getSupportClasses = async (req, res) => {
  try {
    const userId = req.user.uid;
    const recordsSnapshot = await db.collection('task_records')
      .where('userId', '==', userId)
      .get();
    const records = getUserTaskRecords(recordsSnapshot);
    const today = new Date();

    const lightDiscCompleted = records.some(record =>
      record.taskType === 'light_disc' &&
      record.completedAt &&
      isToday(record.completedAt.toDate())
    );

    if (!lightDiscCompleted) {
      return res.status(200).json({
        success: true,
        unlocked: false,
        message: '請先完成今日光盤行動，即可開啟支援任務',
        classes: []
      });
    }

    const supportedToday = new Set(
      records
        .filter(record =>
          record.taskType === 'support' &&
          record.completedAt &&
          isToday(record.completedAt.toDate())
        )
        .map(record => record.classId)
    );

    const classes = SUPPORT_CLASSES.map(c => ({
      ...c,
      completed: supportedToday.has(c.classId)
    }));

    res.status(200).json({
      success: true,
      unlocked: true,
      classes
    });
  } catch (error) {
    console.error('取得支援班級失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '取得支援班級失敗'
    });
  }
};

// 完成支援任務
const completeSupport = async (req, res) => {
  try {
    const userId = req.user.uid;
    const { classId } = req.body;

    if (!classId) {
      return res.status(400).json({
        success: false,
        message: '請選擇要支援的班級'
      });
    }

    const classInfo = SUPPORT_CLASSES.find(c => c.classId === classId);
    if (!classInfo) {
      return res.status(404).json({
        success: false,
        message: '班級不存在'
      });
    }

    const recordsSnapshot = await db.collection('task_records')
      .where('userId', '==', userId)
      .get();
    const records = getUserTaskRecords(recordsSnapshot);

    const lightDiscCompleted = records.some(record =>
      record.taskType === 'light_disc' &&
      record.completedAt &&
      isToday(record.completedAt.toDate())
    );

    if (!lightDiscCompleted) {
      return res.status(400).json({
        success: false,
        message: '請先完成今日光盤行動'
      });
    }

    const alreadySupported = records.some(record =>
      record.taskType === 'support' &&
      record.classId === classId &&
      record.completedAt &&
      isToday(record.completedAt.toDate())
    );

    if (alreadySupported) {
      return res.status(400).json({
        success: false,
        message: '今天已支援過這個班級'
      });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    await db.collection('users').doc(userId).update({
      eCoin: admin.firestore.FieldValue.increment(SUPPORT_REWARDS.eCoin),
      sCoin: admin.firestore.FieldValue.increment(SUPPORT_REWARDS.sCoin),
      score: admin.firestore.FieldValue.increment(SUPPORT_REWARDS.score)
    });

    await db.collection('task_records').add({
      userId,
      taskType: 'support',
      classId,
      className: classInfo.className,
      leftoverWeight: classInfo.leftoverWeight,
      completedAt: now,
      rewards: SUPPORT_REWARDS,
      metadata: {}
    });

    res.status(200).json({
      success: true,
      message: `成功支援 ${classInfo.className}！`,
      rewards: SUPPORT_REWARDS
    });
  } catch (error) {
    console.error('完成支援任務失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '完成支援任務失敗'
    });
  }
};

module.exports = { completeLightDisc, claimLeftoverReward, submitSurvey, getSupportClasses, completeSupport, getPendingTasks, verifyTask };
