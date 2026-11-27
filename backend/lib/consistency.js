/**
 * 資料一致性檢查與修正（管理員面板的「資料檢查」）。
 *
 * 寫入路徑已經盡量保證一致（lib/roster.js、lib/coins.js、lib/plates.js 都是兩邊一起寫），
 * 這裡處理的是**改版前留下的、或直接改資料庫造成的**不一致。每一類問題：
 *   · 說明是什麼、為什麼會壞事
 *   · 列出有問題的那幾筆
 *   · 能安全自動修的（例如班名副本、失效的指標）提供一鍵修正；
 *     需要人判斷的（例如學生的班級不存在，該搬去哪班？）只列出來
 *
 * ESG 餘額對帳要讀每位學生的全部總帳，量比較大，所以另外一班一班做（checkBalances）。
 */
const { db, admin } = require('../config/firebase');
const { COL, ROLES, COIN_HOLDER_ROLES } = require('../config/schema');
const { classLabel, commitInChunks } = require('./roster');
const { ledgerEntry } = require('./coins');
const { today } = require('./dates');

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const del = () => admin.firestore.FieldValue.delete();

async function loadAll() {
  const [users, classes, devices, index] = await Promise.all([
    db.collection(COL.users).get(),
    db.collection(COL.classes).get(),
    db.collection(COL.devices).get(),
    db.collection(COL.accountIndex).get(),
  ]);
  return {
    users: new Map(users.docs.map((d) => [d.id, { id: d.id, ref: d.ref, ...d.data() }])),
    classes: new Map(classes.docs.map((d) => [d.id, { id: d.id, ref: d.ref, ...d.data() }])),
    devices: devices.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() })),
    index: index.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() })),
  };
}

const who = (u) => `${u.displayName || u.id}${u.account ? `（${u.account}）` : ''}`;

/**
 * 每一類檢查：find 回傳 [{ text, fix?: { ref, data } | { ref, delete:true } }]。
 * 有 fix 的才會被「修正」動到。
 */
const CHECKS = [
  {
    type: 'user_class_missing',
    label: '帳號的班級不存在',
    why: '學生註冊、稱重、餐盤都靠 classId 找班級；班級被刪或打錯時，這些人在任何班的名冊上都看不到。',
    find: ({ users, classes }) => [...users.values()]
      .filter((u) => u.classId && !classes.has(u.classId) && u.role !== ROLES.ADMIN)
      .map((u) => ({ text: `${who(u)}：classId ${u.classId} 不存在（請到帳號編輯改班級）`, userId: u.id })),
  },
  {
    type: 'user_class_copy',
    label: '帳號上的年級／班名與班級不一致',
    why: '帳號上存了一份年級與班名（註冊比對與畫面顯示用），改過班名後沒同步就會對不上。',
    find: ({ users, classes }) => [...users.values()]
      .filter((u) => u.classId && classes.has(u.classId) && u.role !== ROLES.ADMIN)
      .filter((u) => {
        const c = classes.get(u.classId);
        return (u.grade || null) !== (c.grade || null) || (u.className || null) !== (c.name || null);
      })
      .map((u) => {
        const c = classes.get(u.classId);
        return {
          text: `${who(u)}：帳號上是「${u.grade || '?'} / ${u.className || '?'}」，班級是「${c.grade} / ${c.name}」`,
          fix: { ref: u.ref, data: { grade: c.grade || null, className: c.name || null, schoolId: c.schoolId || null } },
        };
      }),
  },
  {
    type: 'leader_invalid',
    label: '午餐長指向的人已不是本班學生',
    why: '午餐長轉班、改了角色或被刪除後，班級上的指標還留著；實際上沒有人能替這班稱重。',
    find: ({ users, classes }) => [...classes.values()]
      .filter((c) => c.lunchLeaderUserId)
      .filter((c) => {
        const u = users.get(c.lunchLeaderUserId);
        return !u || u.role !== ROLES.STUDENT || u.classId !== c.id;
      })
      .map((c) => ({
        text: `${classLabel(c.grade, c.name)}：午餐長 ${users.has(c.lunchLeaderUserId) ? who(users.get(c.lunchLeaderUserId)) : c.lunchLeaderUserId + '（已不存在）'}`,
        fix: { ref: c.ref, data: { lunchLeaderUserId: null, updatedAt: serverTime() } },
      })),
  },
  {
    type: 'teacher_invalid',
    label: '導師指向的人已不是這班的老師',
    why: '導師換班、改角色或被刪除後，班級上的導師指標還留著，名冊與實際權限對不上。',
    find: ({ users, classes }) => [...classes.values()]
      .filter((c) => c.teacherUserId)
      .filter((c) => {
        const u = users.get(c.teacherUserId);
        return !u || u.role !== ROLES.TEACHER || u.classId !== c.id;
      })
      .map((c) => ({
        text: `${classLabel(c.grade, c.name)}：導師 ${users.has(c.teacherUserId) ? who(users.get(c.teacherUserId)) : c.teacherUserId + '（已不存在）'}`,
        fix: { ref: c.ref, data: { teacherUserId: null, updatedAt: serverTime() } },
      })),
  },
  {
    type: 'parent_link',
    label: '家長與學生的綁定只剩一邊',
    why: '家長身上記著綁哪位學生、學生身上記著家長是誰；只剩一邊時，簽到加幣、註冊檢查會互相矛盾。',
    find: ({ users }) => {
      const out = [];
      for (const p of users.values()) {
        if (p.role !== ROLES.PARENT || !p.boundStudentId) continue;
        const s = users.get(p.boundStudentId);
        if (!s || s.role !== ROLES.STUDENT) {
          out.push({ text: `家長 ${who(p)}：綁定的學生已不存在或不是學生，解除綁定`, fix: { ref: p.ref, data: { boundStudentId: null, studentBinding: del() } } });
        } else if (!s.parentUserId) {
          out.push({ text: `學生 ${who(s)}：家長 ${who(p)} 綁了他，但學生身上沒有記，補上`, fix: { ref: s.ref, data: { parentUserId: p.id } } });
        }
      }
      for (const s of users.values()) {
        if (s.role !== ROLES.STUDENT || !s.parentUserId) continue;
        const p = users.get(s.parentUserId);
        if (!p || p.role !== ROLES.PARENT || p.boundStudentId !== s.id) {
          out.push({ text: `學生 ${who(s)}：記著的家長已不存在或沒有綁他，清掉`, fix: { ref: s.ref, data: { parentUserId: null, parentName: del() } } });
        }
      }
      return out;
    },
  },
  {
    type: 'account_index',
    label: '帳號登入索引不一致',
    why: '登入與「帳號不可重複」都靠這張索引；少了一筆就登不進去，多了一筆就讓那個帳號名稱永遠不能再用。',
    find: ({ users, index }) => {
      const out = [];
      const byKey = new Map(index.map((i) => [i.id, i]));
      for (const u of users.values()) {
        if (!u.account) continue;
        const key = String(u.account).toLowerCase();
        const i = byKey.get(key);
        if (!i) {
          out.push({ text: `${who(u)}：沒有登入索引，補上`, fix: { ref: db.collection(COL.accountIndex).doc(key), data: { userId: u.id, role: u.role, createdAt: serverTime() } } });
        } else if (i.userId !== u.id && users.has(i.userId)) {
          out.push({ text: `${who(u)}：帳號名稱「${u.account}」被 ${who(users.get(i.userId))} 佔用（兩個帳號同名，請手動處理）` });
        } else if (i.userId !== u.id) {
          out.push({ text: `${who(u)}：索引指向已不存在的帳號，改指回他`, fix: { ref: i.ref, data: { userId: u.id, role: u.role } } });
        }
      }
      for (const i of index) {
        if (!users.has(i.userId)) {
          const owner = [...users.values()].find((u) => [u.account, u.email].filter(Boolean).map((v) => String(v).toLowerCase()).includes(i.id));
          if (!owner) out.push({ text: `索引「${i.id}」指向已刪除的帳號，移除（這個名稱才能再用）`, fix: { ref: i.ref, delete: true } });
        }
      }
      return out;
    },
  },
  {
    type: 'device_class_missing',
    label: '稱重模組綁定的班級不存在',
    why: '這台秤的讀數不會出現在任何班的稱重畫面上。',
    find: ({ devices, classes }) => devices
      .filter((d) => d.classId && !classes.has(d.classId))
      .map((d) => ({
        text: `裝置 ${d.id}：綁定的 ${d.classId} 不存在，解除綁定`,
        fix: { ref: d.ref, data: { classId: null, className: null, updatedAt: serverTime() } },
      })),
  },
  {
    type: 'non_student_coins',
    label: '不是學生卻有 ESG 餘額',
    why: '只有學生有幣系統。改角色前的餘額留在帳上，英雄榜與商城都不會用到，但對帳時會讓人困惑。',
    find: ({ users }) => [...users.values()]
      .filter((u) => !COIN_HOLDER_ROLES.includes(u.role) && Number(u.esgCoin || 0) !== 0)
      .map((u) => ({ text: `${who(u)}（${u.role}）：餘額 ${u.esgCoin}（只列出，不自動清除）` })),
  },
];

/** 執行全部檢查。 */
async function scan() {
  const data = await loadAll();
  const groups = CHECKS.map((c) => {
    const items = c.find(data);
    return {
      type: c.type, label: c.label, why: c.why,
      count: items.length,
      fixable: items.filter((i) => i.fix).length,
      items: items.slice(0, 50).map((i) => ({ text: i.text, fixable: Boolean(i.fix), userId: i.userId || null })),
    };
  });
  return { checkedAt: new Date().toISOString(), groups, total: groups.reduce((a, g) => a + g.count, 0) };
}

/** 修正某一類（只動有 fix 的項目）。 */
async function fix(type) {
  const check = CHECKS.find((c) => c.type === type);
  if (!check) throw Object.assign(new Error(`未知的檢查項目 ${type}`), { status: 400 });
  const items = check.find(await loadAll()).filter((i) => i.fix);
  const deletes = items.filter((i) => i.fix.delete);
  const sets = items.filter((i) => !i.fix.delete).map((i) => i.fix);
  for (let i = 0; i < deletes.length; i += 450) {
    const batch = db.batch();
    deletes.slice(i, i + 450).forEach((d) => batch.delete(d.fix.ref));
    await batch.commit();
  }
  await commitInChunks(sets);
  return { type, fixed: items.length };
}

// ── ESG 餘額對帳（一班一班做）──────────────────────────────────────

/** 某班每位學生：帳上餘額 vs 總帳加總。 */
async function checkBalances(classId) {
  const studentsSnap = await db.collection(COL.users)
    .where('classId', '==', classId).where('role', '==', ROLES.STUDENT).get();
  const rows = [];
  for (const d of studentsSnap.docs) {
    const tx = await db.collection(COL.coinTx).where('ownerId', '==', d.id).select('amount', 'ownerType').get();
    const sum = tx.docs.filter((t) => t.data().ownerType === 'user')
      .reduce((a, t) => a + Number(t.data().amount || 0), 0);
    const balance = Number(d.data().esgCoin || 0);
    rows.push({ userId: d.id, displayName: d.data().displayName || '', seatNo: d.data().seatNo || '', balance, ledgerSum: sum, diff: balance - sum });
  }
  const mismatched = rows.filter((r) => Math.abs(r.diff) > 1e-9);
  return { classId, checked: rows.length, mismatched };
}

/**
 * 修正：補一筆「對帳」分錄讓總帳加總等於餘額，**餘額不動**。
 *
 * 為什麼不是反過來把餘額改成總帳加總：差額多半來自改版前直接寫進餘額、沒記總帳的幣
 * （例如測試帳號的期初餘額），那些幣學生真的拿到也可能已經花了；
 * 改餘額等於憑空收回或發放。補分錄則只是把漏記的帳記上，學生看到的數字不變。
 */
async function fixBalances(classId, by) {
  const { mismatched } = await checkBalances(classId);
  const batch = db.batch();
  mismatched.forEach((r) => {
    batch.set(db.collection(COL.coinTx).doc(), ledgerEntry({
      ownerId: r.userId, amount: r.diff, source: 'admin',
      reason: '對帳補登（餘額與總帳的差額，多半是改版前未記帳的期初餘額）',
      refType: 'reconcile', date: today(), by,
    }));
  });
  if (mismatched.length) await batch.commit();
  return { classId, fixed: mismatched.length };
}

module.exports = { scan, fix, checkBalances, fixBalances, CHECKS };
