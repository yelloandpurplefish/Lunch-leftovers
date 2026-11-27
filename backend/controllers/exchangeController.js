const { db, admin } = require('../config/firebase');
const { COL, COIN_HOLDER_ROLES, ESG } = require('../config/schema');
const { getShopState, closedReason } = require('../lib/shop');

// 兌換物品
// 使用 Firestore transaction 確保「檢查餘額 → 扣款 → 扣庫存」為原子操作，
// 避免併發請求造成餘額或庫存變成負數
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

    const itemRef = db.collection('reward_items').doc(itemId);
    const userRef = db.collection('users').doc(userId);
    const recordRef = db.collection('exchange_records').doc();

    const result = await db.runTransaction(async (transaction) => {
      const [itemDoc, userDoc] = await Promise.all([
        transaction.get(itemRef),
        transaction.get(userRef)
      ]);

      if (!itemDoc.exists) {
        return { error: { status: 404, message: '物品不存在' } };
      }
      if (!userDoc.exists) {
        return { error: { status: 404, message: '使用者不存在' } };
      }

      const item = itemDoc.data();
      const userData = userDoc.data();

      // 只有學生持幣（家長、教師沒有幣系統）——擋在扣款的同一個 transaction 內
      if (!COIN_HOLDER_ROLES.includes(userData.role)) {
        return { error: { status: 403, message: '此身份沒有兌換功能' } };
      }

      if (!item.isActive) {
        return { error: { status: 400, message: '物品已下架' } };
      }
      if (item.stock !== null && item.stock !== undefined && item.stock <= 0) {
        return { error: { status: 400, message: '物品庫存不足' } };
      }

      // 只有一種幣：價格就是 ESG 幣
      const coinField = 'esgCoin';
      const balance = userData[coinField] || 0;

      if (balance < item.cost) {
        return {
          error: {
            status: 400,
            message: 'ESG 幣不足',
            required: item.cost,
            current: balance
          }
        };
      }

      transaction.update(userRef, {
        [coinField]: admin.firestore.FieldValue.increment(-item.cost)
      });

      // 寫入幣別總帳，餘額才有稽核依據（見 lib/coins.js 的記帳規則）
      transaction.set(db.collection(COL.coinTx).doc(), {
        ownerType: 'user',
        ownerId: userId,
        coin: ESG,
        source: null,               // 消耗沒有來源
        amount: -item.cost,
        reason: `兌換「${item.name}」`,
        refType: 'exchange',
        refId: itemRef.id,
        date: new Date().toLocaleDateString('sv'),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      if (item.stock !== null && item.stock !== undefined) {
        transaction.update(itemRef, {
          stock: admin.firestore.FieldValue.increment(-1),
          isActive: item.stock > 1
        });
      }

      transaction.set(recordRef, {
        userId,
        itemId,
        itemName: item.name,
        cost: item.cost,
        exchangedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'completed'
      });

      return {
        itemName: item.name,
        cost: item.cost,
        remainingCoin: balance - item.cost,
        remainingStock: item.stock !== null && item.stock !== undefined ? item.stock - 1 : null
      };
    });

    if (result.error) {
      const { status, message, ...extra } = result.error;
      return res.status(status).json({ success: false, message, ...extra });
    }

    res.status(200).json({
      success: true,
      message: '兌換成功！',
      remainingCoin: result.remainingCoin,
      remainingStock: result.remainingStock,
      exchangeRecord: {
        recordId: recordRef.id,
        itemName: result.itemName,
        cost: result.cost
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
    const limit = parseInt(req.query.limit) || 3;

    const itemsQuery = await db.collection('reward_items')
      .where('category', '==', 'exchange')
      .get();

    const items = itemsQuery.docs
      .map(doc => {
        const data = doc.data();
        return {
          itemId: doc.id,
          name: data.name,
          description: data.description,
          cost: data.cost,
          stock: data.stock,
          imageUrl: data.imageUrl,
          isActive: data.isActive !== false
        };
      })
      .filter(item => item.isActive && (item.stock === null || item.stock === undefined || item.stock > 0))
      .sort((a, b) => Number(a.cost || 0) - Number(b.cost || 0))
      .slice(0, limit);

    // 關閉期間仍回商品清單（學生看得到獎品才有動機），
    // 但要讓前端知道現在換不了，否則按下去才吃 503 體驗很差。
    const shop = await getShopState();
    res.status(200).json({
      success: true,
      items,
      shopEnabled: shop.enabled,
      shopClosedReason: shop.enabled ? null : closedReason(shop)
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
