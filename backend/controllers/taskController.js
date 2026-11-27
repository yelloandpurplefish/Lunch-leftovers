const { db, admin } = require('../config/firebase');
const { today } = require('../lib/dates');
const { dishNameSet } = require('../lib/dailyMenu');

/**
 * 每日菜色問卷（不發幣）。
 *  · 吃得怎麼樣 → 學生在 /api/plate 拍自己的餐盤，結果決定 ESG 幣
 *  · 全班剩食量 → 由午餐長在 /api/record 依序稱重
 */

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

// 提交問卷（24 小時認領制）
/** 原因欄位的長度限制，理由同家長評論：太短等於沒填，太長塞爆資料庫。 */
const REASON_MIN = 5;
const REASON_MAX = 200;

const submitSurvey = async (req, res) => {
  try {
    const userId = req.user.uid;
    const { favoriteFood, hateFood } = req.body;
    // 不喜歡的原因才是廚房能據以改善的資訊，單純知道「哪道菜被討厭」不夠
    const reason = String(req.body.reason == null ? '' : req.body.reason)
      .replace(/\s+/g, ' ').trim();
    const now = admin.firestore.FieldValue.serverTimestamp();
    const cooldownHours = 24;
    const cooldownMs = cooldownHours * 60 * 60 * 1000;

    if (!favoriteFood || !hateFood) {
      return res.status(400).json({
        success: false,
        message: '請填寫所有欄位'
      });
    }

    /**
     * 菜名必須是今天真的供應過的菜。
     *
     * 下拉選單已經由當日菜單產生，但驗證不能只靠前端——
     * 問卷的用途是告訴廚房「哪一道菜被討厭、為什麼」，
     * 如果存進了今天沒出現的菜名，那筆回饋就無從對應，等於髒資料。
     */
    const { served, names } = await dishNameSet(today());
    if (!served) {
      return res.status(400).json({
        success: false,
        message: '今天沒有供餐，沒有菜色可以評分'
      });
    }
    const pickFavorite = String(favoriteFood).trim();
    const pickHate = String(hateFood).trim();
    const unknown = [pickFavorite, pickHate].filter((n) => !names.has(n));
    if (unknown.length) {
      return res.status(400).json({
        success: false,
        message: `今天的菜單沒有「${unknown[0]}」，請重新整理後再填`,
        menuDishes: [...names]
      });
    }
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: '請填寫不喜歡的原因'
      });
    }
    if (reason.length < REASON_MIN) {
      return res.status(400).json({
        success: false,
        message: `原因太短了，請至少寫 ${REASON_MIN} 個字`
      });
    }
    if (reason.length > REASON_MAX) {
      return res.status(400).json({
        success: false,
        message: `原因請在 ${REASON_MAX} 字以內（目前 ${reason.length} 字）`
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
        favoriteFood: pickFavorite,
        hateFood: pickHate,
        reason,
        // 存下日期：task_records 只有 completedAt（伺服器時間），
        // 跨午夜或時區換算時不該用它回推「這是哪一天的菜」
        date: today()
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

module.exports = { submitSurvey };
