const { db, admin } = require('../config/firebase');

// 兌換物品
const redeemItem = async (req, res) => {
  try {
    const userId = req.user.uid;
    const { itemId } = req.body;

    if (!itemId) {
      return res.status(400).json({
        success: false,
        message: '請提供物品 ID'
      });
    }

    // 定義物品配置（暫時硬編碼，後續可從資料庫讀取）
    const itemConfig = {
      'eco_cup': { name: '環保杯', cost: 50, costType: 'E' },
      'eco_utensils': { name: '環保餐具', cost: 80, costType: 'E' },
      'stationery_set': { name: '文具禮包', cost: 30, costType: 'S' }
    };

    const item = itemConfig[itemId];
    if (!item) {
      return res.status(404).json({
        success: false,
        message: '物品不存在'
      });
    }

    // 獲取使用者資料
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    // 檢查貨幣是否足夠
    const coinField = item.costType === 'E' ? 'eCoin' : 'sCoin';
    if (userData[coinField] < item.cost) {
      return res.status(400).json({
        success: false,
        message: `${item.costType}幣不足`,
        required: item.cost,
        current: userData[coinField]
      });
    }

    // 扣除貨幣
    await db.collection('users').doc(userId).update({
      [coinField]: admin.firestore.FieldValue.increment(-item.cost)
    });

    // 記錄兌換
    const exchangeRecord = await db.collection('exchange_records').add({
      userId,
      itemName: item.name,
      itemType: item.costType,
      cost: item.cost,
      exchangedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'completed'
    });

    // 獲取更新後的餘額
    const updatedUserDoc = await db.collection('users').doc(userId).get();
    const updatedUserData = updatedUserDoc.data();

    res.status(200).json({
      success: true,
      message: '兌換成功！',
      remainingCoin: updatedUserData[coinField],
      exchangeRecord: {
        recordId: exchangeRecord.id,
        itemName: item.name,
        cost: item.cost
      }
    });
  } catch (error) {
    console.error('兌換物品失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '兌換物品失敗'
    });
  }
};

// 獲取可兌換物品列表
const getExchangeItems = async (req, res) => {
  try {
    const itemsQuery = await db.collection('reward_items')
      .where('isActive', '==', true)
      .where('category', '==', 'exchange')
      .get();

    const items = itemsQuery.docs.map(doc => {
      const data = doc.data();
      return {
        itemId: doc.id,
        name: data.name,
        description: data.description,
        costType: data.costType,
        cost: data.cost,
        stock: data.stock,
        imageUrl: data.imageUrl
      };
    });

    res.status(200).json({
      success: true,
      items
    });
  } catch (error) {
    console.error('獲取物品列表失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '獲取物品列表失敗'
    });
  }
};

// 獲取兌換歷史
const getExchangeHistory = async (req, res) => {
  try {
    const userId = req.user.uid;
    const limit = parseInt(req.query.limit) || 10;

    const historyQuery = await db.collection('exchange_records')
      .where('userId', '==', userId)
      .orderBy('exchangedAt', 'desc')
      .limit(limit)
      .get();

    const history = historyQuery.docs.map(doc => {
      const data = doc.data();
      return {
        itemName: data.itemName,
        itemType: data.itemType,
        cost: data.cost,
        exchangedAt: data.exchangedAt.toDate().toISOString(),
        status: data.status
      };
    });

    res.status(200).json({
      success: true,
      history
    });
  } catch (error) {
    console.error('獲取兌換歷史失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '獲取兌換歷史失敗'
    });
  }
};

module.exports = { redeemItem, getExchangeItems, getExchangeHistory };
