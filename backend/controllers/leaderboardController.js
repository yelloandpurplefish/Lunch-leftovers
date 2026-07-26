const { db } = require('../config/firebase');

// 獲取排行榜
const getLeaderboard = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const schoolId = req.query.schoolId;

    // 構建查詢
    let query = db.collection('users')
      .where('isActive', '==', true)
      .orderBy('score', 'desc')
      .limit(limit);

    // 如果指定學校，過濾學校
    if (schoolId) {
      query = query.where('schoolId', '==', schoolId);
    }

    const leaderboardQuery = await query.get();

    const leaderboard = leaderboardQuery.docs.map((doc, index) => {
      const data = doc.data();
      return {
        rank: index + 1,
        displayName: data.displayName,
        score: data.score,
        schoolId: data.schoolId,
        classId: data.classId
      };
    });

    // 獲取當前使用者的排名
    const userId = req.user.uid;
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    // 計算使用者排名（需要查詢所有使用者）
    let allUsersQuery = db.collection('users')
      .where('isActive', '==', true)
      .orderBy('score', 'desc');

    if (schoolId) {
      allUsersQuery = allUsersQuery.where('schoolId', '==', schoolId);
    }

    const allUsers = await allUsersQuery.get();
    let myRank = null;
    
    for (let i = 0; i < allUsers.docs.length; i++) {
      if (allUsers.docs[i].id === userId) {
        myRank = {
          rank: i + 1,
          score: userData.score
        };
        break;
      }
    }

    res.status(200).json({
      success: true,
      leaderboard,
      myRank
    });
  } catch (error) {
    console.error('獲取排行榜失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '獲取排行榜失敗'
    });
  }
};

module.exports = { getLeaderboard };
