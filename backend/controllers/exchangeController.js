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

    // 獲取物品資訊
    const itemDoc = await db.collection('reward_items').doc(itemId).get();
    if (!itemDoc.exists) {
      return res.status(404).json({
        success: false,
        message: '物品不存在'
      });
    }

    const itemData = itemDoc.data();

    if (!itemData.isActive) {
      return res.status(400).json({
        success: false,
        message: '物品已下架'
      });
    }

    // 檢查庫存
    if (itemData.stock !== null && itemData.stock <= 0) {
      return res.status(400).json({
        success: false,
        message: '物品庫存不足'
      });
    }

    // 獲取使用者資料
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    // 檢查貨幣是否足夠
    const coinField = itemData.costType === 'E' ? 'eCoin' : 'sCoin';
    if (userData[coinField] < itemData.cost) {
      return res.status(400).json({
        success: false,
        message: `${itemData.costType}幣不足`,
        required: itemData.cost,
        current: userData[coinField]
      });
    }

    // 扣除貨幣
    await db.collection('users').doc(userId).update({
      [coinField]: admin.firestore.FieldValue.increment(-itemData.cost)
    });

    // 更新庫存
    if (itemData.stock !== null) {
      await db.collection('reward_items').doc(itemId).update({
        stock: admin.firestore.FieldValue.increment(-1)
      });
    }

    // 記錄兌換
    const exchangeRecord = await db.collection('exchange_records').add({
      userId,
      itemName: itemData.name,
      itemType: itemData.costType,
      cost: itemData.cost,
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
        itemName: itemData.name,
        cost: itemData.cost
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
