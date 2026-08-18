const { db } = require('../config/firebase');

// 獲取班級排行榜
const getLeaderboard = async (req, res) => {
  try {
    const userId = req.user.uid;
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: '使用者不存在'
      });
    }

    const userData = userDoc.data();
    const classId = userData.classId || null;
    const limit = parseInt(req.query.limit) || 10;

    // 在 Node.js 端依 classId 篩選並排序，避免 Firestore 複合索引
    const snapshot = await db.collection('users').get();

    const allStudents = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(user => user.isActive !== false && (user.classId || null) === classId)
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    const leaderboard = allStudents.slice(0, limit).map((student, index) => ({
      rank: index + 1,
      displayName: student.displayName || '匿名',
      score: student.score || 0,
      classId: student.classId || null
    }));

    // 計算自己的名次
    const myIndex = allStudents.findIndex(s => s.id === userId);
    const myRank = myIndex >= 0
      ? { rank: myIndex + 1, score: allStudents[myIndex].score || 0 }
      : null;

    res.status(200).json({
      success: true,
      leaderboard,
      myRank
    });
  } catch (error) {
    console.error('獲取班級排行榜失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '獲取班級排行榜失敗'
    });
  }
};

module.exports = { getLeaderboard };
