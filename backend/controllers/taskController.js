const { db, admin } = require('../config/firebase');

/**
 * 註：原本的「光盤行動自行領獎」與「剩食獎勵（自填剩食克數）」已移除。
 *  · 吃完一餐 → 由教師在 /api/meal-check 逐生勾選後發幣（+1E +1S）
 *  · 剩食克數 → 由午餐長在 /api/record 以四桶影像辨識產生
 * 本檔只保留問卷、跨班支援與教師審核。
 */

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


// 提交問卷（24 小時認領制）
const submitSurvey = async (req, res) => {
  try {
    const userId = req.user.uid;
    const { favoriteFood, hateFood } = req.body;
    const now = admin.firestore.FieldValue.serverTimestamp();
    const cooldownHours = 24;
    const cooldownMs = cooldownHours * 60 * 60 * 1000;

    if (!favoriteFood || !hateFood) {
      return res.status(400).json({
        success: false,
        message: '請填寫所有欄位'
      });
    }

    const lastRecord = await getLastTaskRecord(userId, 'survey');

    if (lastRecord) {
      const timeSince = Date.now() - lastRecord.completedAt.toDate().getTime();
      if (timeSince < cooldownMs) {
        const hoursRemaining = Math.ceil((cooldownMs - timeSince) / (60 * 60 * 1000));
        return res.status(400).json({
          success: false,
          message: '尚未達到送出時間',
          hoursRemaining
        });
      }
    }

    await db.collection('task_records').add({
      userId,
      taskType: 'survey',
      status: 'completed',
      completedAt: now,
      rewards: {},
      metadata: {
        favoriteFood,
        hateFood
      }
    });

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
      if (rewards.gCoin) updates.gCoin = admin.firestore.FieldValue.increment(rewards.gCoin);
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

module.exports = { submitSurvey, getPendingTasks, verifyTask };
