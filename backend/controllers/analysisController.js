const { db, admin } = require('../config/firebase');

// 提交剩食分析
const submitAnalysis = async (req, res) => {
  try {
    const userId = req.user.uid;
    const { foodItems } = req.body;

    if (!foodItems || foodItems.length === 0) {
      return res.status(400).json({
        success: false,
        message: '請提供剩食分析資料'
      });
    }

    // 計算總剩食量
    const totalLeftover = foodItems.reduce((sum, item) => sum + (item.leftoverGrams || 0), 0);

    // 找出最多和最少剩食
    let mostLeftover = null;
    let leastLeftover = null;
    let maxGrams = -1;
    let minGrams = Infinity;

    foodItems.forEach(item => {
      if (item.leftoverGrams > maxGrams) {
        maxGrams = item.leftoverGrams;
        mostLeftover = item.foodName;
      }
      if (item.leftoverGrams < minGrams && item.leftoverGrams > 0) {
        minGrams = item.leftoverGrams;
        leastLeftover = item.foodName;
      }
    });

    // 記錄分析
    const analysisDoc = await db.collection('leftover_analysis').add({
      userId,
      date: new Date().toISOString().split('T')[0],
      foodItems,
      totalLeftover,
      mostLeftover,
      leastLeftover,
      analyzedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json({
      success: true,
      analysisId: analysisDoc.id,
      mostLeftover,
      leastLeftover,
      totalLeftover
    });
  } catch (error) {
    console.error('提交剩食分析失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '提交剩食分析失敗'
    });
  }
};

// 獲取剩食統計 (管理員用)
const getAnalysisStats = async (req, res) => {
  try {
    const { startDate, endDate, schoolId } = req.query;

    // 構建查詢
    let query = db.collection('leftover_analysis');

    if (startDate) {
      query = query.where('date', '>=', startDate);
    }
    if (endDate) {
      query = query.where('date', '<=', endDate);
    }

    const analysisQuery = await query.get();

    let totalLeftover = 0;
    const foodWasteMap = {};

    analysisQuery.docs.forEach(doc => {
      const data = doc.data();
      totalLeftover += data.totalLeftover;

      data.foodItems.forEach(item => {
        if (!foodWasteMap[item.foodName]) {
          foodWasteMap[item.foodName] = 0;
        }
        foodWasteMap[item.foodName] += item.leftoverGrams;
      });
    });

    // 找出最多和最少浪費的菜色
    let mostWastedFood = null;
    let leastWastedFood = null;
    let maxWaste = -1;
    let minWaste = Infinity;

    Object.entries(foodWasteMap).forEach(([foodName, waste]) => {
      if (waste > maxWaste) {
        maxWaste = waste;
        mostWastedFood = foodName;
      }
      if (waste < minWaste && waste > 0) {
        minWaste = waste;
        leastWastedFood = foodName;
      }
    });

    const studentCount = analysisQuery.size;
    const averagePerStudent = studentCount > 0 ? Math.round(totalLeftover / studentCount) : 0;

    res.status(200).json({
      success: true,
      stats: {
        totalLeftover,
        averagePerStudent,
        mostWastedFood,
        leastWastedFood,
        studentCount
      }
    });
  } catch (error) {
    console.error('獲取剩食統計失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '獲取剩食統計失敗'
    });
  }
};

module.exports = { submitAnalysis, getAnalysisStats };
