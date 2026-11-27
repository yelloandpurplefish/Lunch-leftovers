// ============================================================
// 管理員專區（任何班級、任何角色都能操作）
// ============================================================
//
// 設計：先找到班級或帳號，再對它操作。不再一次把全校的班級與帳號列成一長串——
// 學校一大，那種清單既找不到人、也會讓每次開頁都讀幾千筆資料。
//
//   總覽     今天各班稱重與拍餐盤的進度，點班級直接進去
//   班級     左邊選班 → 右邊是這班的全部：導師、午餐長、這天的稱重（含秤連不上時的手動輸入）、
//            學生名冊與餐盤結果（可以直接更正）
//   帳號     搜尋或依角色瀏覽 → 點一個人打開操作面板，依角色顯示能做的事
//   設定／同步  發幣額度與建議攝取、商城、桶型皮重；Google 試算表同步
//   資料檢查  一致性檢查與 ESG 餘額對帳
//
// 本檔依賴 app.js 的 apiRequest、escapeText、escapeAttr、ACTION_HANDLERS（同一個全域範圍）。

const adminState = {
    tab: 'overview',
    classes: [],
    classId: null,
    date: null,
    detail: null,
    teachers: null,
    users: { q: '', role: '', pages: [null], page: 0 },
    drawerUserId: null,
    drawerData: null,
};

const todayStr = () => new Date().toLocaleDateString('sv');
const $id = (id) => document.getElementById(id);

/** 右下角的短暫提示。操作結果用這個，不用一直跳 alert。 */
function notify(message, ok = true) {
    let box = $id('adminToast');
    if (!box) {
        box = document.createElement('div');
        box.id = 'adminToast';
        box.className = 'toast';
        box.setAttribute('role', 'status');
        document.body.appendChild(box);
    }
    box.textContent = (ok ? '✅ ' : '⚠️ ') + message;
    box.className = 'toast show ' + (ok ? 'ok' : 'error');
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => { box.className = 'toast'; }, ok ? 2600 : 5000);
}

/** 呼叫 API，失敗就提示並回 null。成功時提示後端的訊息（若有）。 */
async function adminCall(method, path, body, { quiet = false } = {}) {
    try {
        const data = await apiRequest(path, method, body);
        if (!data.success) {
            notify(describeDeps(data), false);
            return null;
        }
        if (!quiet && data.message) notify(data.message, true);
        return data;
    } catch (error) {
        notify('操作失敗：' + (error.message || '請稍後再試'), false);
        return null;
    }
}

const opt = (value, label, selected) =>
    `<option value="${escapeAttr(value)}" ${selected ? 'selected' : ''}>${escapeText(label)}</option>`;

const PLATE_LEVELS = [['clean', '光盤'], ['little', '剩一點'], ['half', '剩不少'], ['most', '剩一半以上']];

/** 更正用的下拉：選了就送出，所以第一個是不動作的提示，最後是「清除」。 */
function plateLevelOptions() {
    return [['', '— 更正 —'], ...PLATE_LEVELS, ['__clear', '清除（可重拍）']].map(([v, l]) => opt(v, l)).join('');
}

// ── 分頁 ─────────────────────────────────────────────────────────

async function loadAdminHome() {
    await loadAdminOverviewPane();
}

async function adminTab(el) {
    const tab = el.dataset.tab;
    adminState.tab = tab;
    document.querySelectorAll('.admin-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.admin-pane').forEach((p) => p.classList.toggle('hidden', p.id !== 'adminPane-' + tab));
    if (tab === 'overview') await loadAdminOverviewPane();
    if (tab === 'classes') {
        await loadClassPicker();
        if (adminState.classId) await loadClassDetail();
    }
    if (tab === 'users') {
        await ensureClassList();
        syncNewUserFields();
    }
    if (tab === 'settings') {
        await loadCoinRules();
        await loadShopState();
        await loadBucketTare();
    }
    if (tab === 'health') {
        await ensureClassList();
        const sel = $id('balanceClass');
        if (sel && !sel.options.length) {
            sel.innerHTML = adminState.classes.map((c) => opt(c.classId, c.label)).join('');
        }
    }
}

function showTab(tab) {
    const btn = document.querySelector(`.admin-tab[data-tab="${tab}"]`);
    return btn ? adminTab(btn) : null;
}

// ── 總覽 ─────────────────────────────────────────────────────────

const WEIGH_LABEL = { none: '未開始', measuring: '稱重中', done: '已完成' };

async function loadAdminOverviewPane() {
    const box = $id('adminOverview');
    if (!box) return;
    const data = await adminCall('GET', '/admin/overview', null, { quiet: true });
    if (!data) { box.innerHTML = '<p class="field-hint">載入失敗</p>'; return; }
    const t = data.totals;
    const roles = Object.entries(data.usersByRole || {})
        .map(([r, n]) => `<div class="stat"><span class="stat-n">${n}</span><span>${escapeText((data.roleLabels || {})[r] || r)}</span></div>`).join('');

    const byGrade = new Map();
    data.classes.forEach((c) => {
        const g = c.grade || '其他';
        if (!byGrade.has(g)) byGrade.set(g, []);
        byGrade.get(g).push(c);
    });

    box.innerHTML = `
        <p class="field-hint">${escapeText(data.date)} 的狀況</p>
        <div class="stat-row">
            <div class="stat"><span class="stat-n">${t.weighed}<small>/${t.classes}</small></span><span>班已完成稱重</span></div>
            <div class="stat"><span class="stat-n">${t.plates}<small>/${t.students}</small></span><span>位學生拍了餐盤</span></div>
            ${roles}
        </div>
        <h4 class="section-title">各班今天</h4>
        ${[...byGrade.entries()].map(([g, list]) => `
            <div class="picker-group">
                <h5>${escapeText(g)} 年級</h5>
                <div class="chip-grid">
                    ${list.map((c) => `
                        <button class="class-chip" data-action="openClassFromOverview" data-class-id="${escapeAttr(c.classId)}">
                            <strong>${escapeText(c.label)}</strong>
                            <span class="dot dot-${escapeAttr(c.weighing)}">${WEIGH_LABEL[c.weighing] || c.weighing}</span>
                            <span class="chip-sub">餐盤 ${c.plates}/${c.students}</span>
                        </button>`).join('')}
                </div>
            </div>`).join('') || '<p class="field-hint">還沒有任何班級，到「班級」新增。</p>'}`;
}

async function openClassFromOverview(el) {
    adminState.classId = el.dataset.classId;
    await showTab('classes');
}

// ── 班級：清單 ────────────────────────────────────────────────────

async function ensureClassList(force = false) {
    if (adminState.classes.length && !force) return adminState.classes;
    const data = await adminCall('GET', '/admin/classes', null, { quiet: true });
    adminState.classes = data ? data.classes : [];
    const fill = (id, withEmpty) => {
        const sel = $id(id);
        if (!sel) return;
        const keep = sel.value;
        sel.innerHTML = (withEmpty ? opt('', '（不指定）') : '')
            + adminState.classes.map((c) => opt(c.classId, c.label)).join('');
        if (keep) sel.value = keep;
    };
    fill('newUserClass', true);
    fill('balanceClass', false);
    return adminState.classes;
}

async function loadClassPicker() {
    await ensureClassList(true);
    renderClassPicker();
}

function renderClassPicker() {
    const box = $id('classPickerList');
    if (!box) return;
    const q = (($id('classFilter') || {}).value || '').trim().toLowerCase();
    const list = adminState.classes.filter((c) => !q
        || c.label.toLowerCase().includes(q) || c.classId.toLowerCase().includes(q) || String(c.name).toLowerCase().includes(q));
    if (!list.length) {
        box.innerHTML = `<p class="field-hint">${adminState.classes.length ? '沒有符合的班級' : '還沒有任何班級，按「＋ 新增」建立。'}</p>`;
        return;
    }
    const byGrade = new Map();
    list.forEach((c) => {
        const g = c.grade || '其他';
        if (!byGrade.has(g)) byGrade.set(g, []);
        byGrade.get(g).push(c);
    });
    box.innerHTML = [...byGrade.entries()].map(([g, cs]) => `
        <div class="picker-group">
            <h5>${escapeText(g)} 年級</h5>
            <div class="chip-grid compact">
                ${cs.map((c) => `
                    <button class="class-chip ${c.classId === adminState.classId ? 'active' : ''}"
                            data-action="selectClass" data-class-id="${escapeAttr(c.classId)}">
                        <strong>${escapeText(c.label)}</strong>
                        <span class="chip-sub">${c.registered}/${c.headcount} 人${c.hasLeader ? '' : ' · 無午餐長'}</span>
                    </button>`).join('')}
            </div>
        </div>`).join('');
}

function filterClassPicker() { renderClassPicker(); }

async function selectClass(el) {
    adminState.classId = el.dataset.classId;
    renderClassPicker();
    await loadClassDetail();
    const detail = $id('classDetail');
    if (detail && window.innerWidth < 900) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleNewClass() {
    const f = $id('newClassForm');
    if (f) f.classList.toggle('hidden');
}

async function createClass() {
    const payload = {
        grade: ($id('newClassGrade').value || '').trim(),
        name: ($id('newClassName').value || '').trim(),
        headcount: Number($id('newClassHeadcount').value),
    };
    const result = $id('newClassResult');
    if (!payload.grade || !payload.name || !payload.headcount) {
        result.className = 'verify-result error';
        result.textContent = '請填寫年級、班級名稱與人數';
        return;
    }
    const data = await adminCall('POST', '/admin/classes', payload);
    result.className = 'verify-result ' + (data ? 'ok' : 'error');
    result.textContent = data ? data.message : '';
    if (!data) return;
    ['newClassGrade', 'newClassName', 'newClassHeadcount'].forEach((id) => { $id(id).value = ''; });
    adminState.classId = data.class.classId;
    await loadClassPicker();
    await loadClassDetail();
}

// ── 班級：一個班的全部 ──────────────────────────────────────────

async function loadClassDetail() {
    const box = $id('classDetail');
    if (!box || !adminState.classId) return;
    if (!adminState.date) adminState.date = todayStr();
    const data = await adminCall('GET',
        `/admin/classes/${encodeURIComponent(adminState.classId)}?date=${adminState.date}`, null, { quiet: true });
    if (!data) { box.innerHTML = '<p class="field-hint">載入失敗</p>'; return; }
    adminState.detail = data;
    if (!adminState.teachers) {
        const t = await adminCall('GET', '/admin/users?role=teacher&limit=50', null, { quiet: true });
        adminState.teachers = t ? t.users : [];
    }
    renderClassDetail(data);
    await loadClassWeighing();
}

function renderClassDetail(d) {
    const box = $id('classDetail');
    const c = d.class;
    const ps = d.plateSummary;
    const teacherOpts = (adminState.teachers || [])
        .map((t) => opt(t.userId, `${t.displayName}（${t.account || ''}）`, d.teacher && d.teacher.userId === t.userId)).join('');
    const studentOpts = d.students.filter((s) => s.isActive)
        .map((s) => opt(s.userId, `${s.seatNo || '--'} ${s.displayName}`, d.lunchLeader && d.lunchLeader.userId === s.userId)).join('');

    box.innerHTML = `
        <header class="detail-head">
            <div>
                <h3>${escapeText(c.label)}</h3>
                <code class="row-id" title="綁定裝置、同步名冊時要用的 classId">${escapeText(c.classId)}</code>
                <span class="field-hint">${escapeText(c.grade)} 年級 · 人數 ${c.headcount} · 已註冊 ${d.students.length}</span>
            </div>
            <div class="detail-actions">
                <button class="secondary-btn small" data-action="toggleClassEdit">編輯</button>
                <button class="danger-btn small" data-action="deleteClass">刪除</button>
            </div>
        </header>

        <div id="classEditForm" class="inline-form hidden">
            <label>年級 <input type="text" id="editClassGrade" value="${escapeAttr(c.grade)}"></label>
            <label>班級名稱 <input type="text" id="editClassName" value="${escapeAttr(c.name)}"></label>
            <label>人數 <input type="number" id="editClassHeadcount" min="1" value="${c.headcount}"></label>
            <button data-action="saveClassEdit">儲存</button>
            <p class="field-hint">改年級或班名時，班上每個人帳號上的班名會一起更新。</p>
        </div>

        <div class="kv-grid">
            <div class="kv">
                <span class="kv-label">導師</span>
                <span class="kv-value">${d.teacher ? escapeText(d.teacher.displayName) + (d.teacher.account ? `<small>（${escapeText(d.teacher.account)}）</small>` : '') : '<em>未指定</em>'}</span>
                <div class="kv-actions">
                    <select id="classTeacherPick">${opt('', '選擇老師…')}${teacherOpts}</select>
                    <button class="small" data-action="setClassTeacher">設為導師</button>
                    ${d.teacher ? '<button class="secondary-btn small" data-action="clearClassTeacher">清除</button>' : ''}
                </div>
            </div>
            <div class="kv">
                <span class="kv-label">午餐長</span>
                <span class="kv-value">${d.lunchLeader ? escapeText(d.lunchLeader.displayName) + (d.lunchLeader.account ? `<small>（${escapeText(d.lunchLeader.account)}）</small>` : '') : '<em>未指定</em>'}</span>
                <div class="kv-actions">
                    <select id="classLeaderPick">${opt('', '選擇本班學生…')}${studentOpts}</select>
                    <button class="small" data-action="setClassLeader">設為午餐長</button>
                    ${d.lunchLeader ? '<button class="secondary-btn small" data-action="clearClassLeader">清除</button>' : ''}
                </div>
            </div>
        </div>

        <div class="date-bar">
            <label>日期 <input type="date" id="classDate" value="${escapeAttr(d.date)}" max="${todayStr()}" data-change="changeClassDate"></label>
            <span class="field-hint">稱重與餐盤都看這一天；可以補登過去的日期。</span>
        </div>

        <section class="detail-block">
            <h4>⚖️ 全班剩食紀錄（稱重）</h4>
            <div id="adminWeighBox"><p class="field-hint">載入中...</p></div>
        </section>

        <section class="detail-block">
            <h4>📷 餐盤結果 <small>${ps.scanned}/${ps.total} 人已有結果</small></h4>
            <div class="stat-row compact">
                ${[['clean', '光盤'], ['little', '剩一點'], ['half', '剩不少'], ['most', '剩一半以上']].map(([lv, l]) => `
                    <div class="stat stat-${lv}"><span class="stat-n">${ps.byLevel[lv] || 0}</span><span>${l}</span></div>`).join('')}
            </div>
            <p class="field-hint">辨識錯了或模型沒接上時，直接在名冊的「餐盤」欄選結果；幣會自動補或收回差額。</p>
        </section>

        <section class="detail-block">
            <h4>👥 學生名冊 <small>${d.students.length} 人</small></h4>
            <div class="table-scroll"><table class="data-table roster-table">
                <thead><tr><th>座號</th><th>姓名</th><th>帳號</th><th class="num">ESG</th><th>餐盤（${escapeText(d.date.slice(5))}）</th><th></th></tr></thead>
                <tbody>${d.students.map((s) => `
                    <tr class="${s.isActive ? '' : 'inactive'}">
                        <td>${escapeText(s.seatNo || '—')}</td>
                        <td>${escapeText(s.displayName)}${s.isLunchLeader ? ' <span class="badge badge-leader">午餐長</span>' : ''}${s.isActive ? '' : ' <span class="badge badge-muted">停用</span>'}</td>
                        <td>${escapeText(s.account || '')}</td>
                        <td class="num">${s.esgCoin}</td>
                        <td>
                            ${plateBadge(s.plate)}${s.plate ? ` <small>${s.plate.leftoverPct}%</small>` : ''}
                            <select class="mini-select" data-change="quickPlate" data-user-id="${escapeAttr(s.userId)}" aria-label="更正餐盤結果">${plateLevelOptions()}</select>
                        </td>
                        <td><button class="secondary-btn small" data-action="openUser" data-user-id="${escapeAttr(s.userId)}">管理</button></td>
                    </tr>`).join('') || '<tr><td colspan="6">這個班級還沒有學生</td></tr>'}
                </tbody>
            </table></div>

            <details class="inline-details">
                <summary>＋ 在這班新增學生</summary>
                <div class="inline-form">
                    <label>帳號 <input type="text" id="addStudentAccount" placeholder="例如 stu302-05"></label>
                    <label>姓名 <input type="text" id="addStudentName"></label>
                    <label>座號 <input type="text" id="addStudentSeat" placeholder="05"></label>
                    <label>密碼 <input type="text" id="addStudentPassword" placeholder="至少 6 個字元"></label>
                    <button data-action="addStudentToClass">建立</button>
                </div>
            </details>
        </section>

        ${d.others.length ? `
        <section class="detail-block">
            <h4>其他掛在這班的帳號</h4>
            <ul class="plain-list">${d.others.map((u) => `
                <li>${escapeText(u.displayName)} <span class="badge badge-muted">${escapeText(u.roleLabel)}</span>
                    <button class="secondary-btn small" data-action="openUser" data-user-id="${escapeAttr(u.userId)}">管理</button></li>`).join('')}
            </ul>
        </section>` : ''}`;
}

async function changeClassDate(el) {
    adminState.date = el.value || todayStr();
    await loadClassDetail();
}

function toggleClassEdit() {
    const f = $id('classEditForm');
    if (f) f.classList.toggle('hidden');
}

async function saveClassEdit() {
    const data = await adminCall('PATCH', `/admin/classes/${encodeURIComponent(adminState.classId)}`, {
        grade: $id('editClassGrade').value,
        name: $id('editClassName').value,
        headcount: Number($id('editClassHeadcount').value),
    });
    if (data) { await loadClassPicker(); await loadClassDetail(); }
}

async function deleteClass() {
    const c = adminState.detail && adminState.detail.class;
    if (!c || !confirm(`確定刪除「${c.label}」（${c.classId}）？\n只有在這個班沒有任何學生與歷史紀錄時才刪得掉。`)) return;
    const data = await adminCall('DELETE', `/admin/classes/${encodeURIComponent(c.classId)}`);
    if (!data) return;
    adminState.classId = null;
    $id('classDetail').innerHTML = '<p class="empty-state">從班級清單選一個班</p>';
    await loadClassPicker();
}

async function setClassTeacher() {
    const userId = $id('classTeacherPick').value;
    if (!userId) return notify('請先選一位老師', false);
    if (await adminCall('POST', `/admin/classes/${encodeURIComponent(adminState.classId)}/teacher`, { userId })) {
        adminState.teachers = null;
        await loadClassDetail();
    }
}

async function clearClassTeacher() {
    if (!confirm('確定清除這班的導師？')) return;
    if (await adminCall('DELETE', `/admin/classes/${encodeURIComponent(adminState.classId)}/teacher`)) await loadClassDetail();
}

async function setClassLeader() {
    const userId = $id('classLeaderPick').value;
    if (!userId) return notify('請先選一位學生', false);
    if (await adminCall('POST', `/admin/classes/${encodeURIComponent(adminState.classId)}/lunch-leader`, { userId })) {
        await loadClassPicker();
        await loadClassDetail();
    }
}

async function clearClassLeader() {
    if (!confirm('確定清除這班的午餐長？清除後這班只有導師與管理員能稱重。')) return;
    if (await adminCall('DELETE', `/admin/classes/${encodeURIComponent(adminState.classId)}/lunch-leader`)) {
        await loadClassPicker();
        await loadClassDetail();
    }
}

async function addStudentToClass() {
    const data = await adminCall('POST', '/admin/users', {
        role: 'student',
        classId: adminState.classId,
        account: ($id('addStudentAccount').value || '').trim(),
        displayName: ($id('addStudentName').value || '').trim(),
        seatNo: ($id('addStudentSeat').value || '').trim(),
        password: $id('addStudentPassword').value || '',
    });
    if (data) { await loadClassPicker(); await loadClassDetail(); }
}

/** 名冊上直接更正某位學生這天的餐盤結果。 */
async function quickPlate(el) {
    const level = el.value;
    const userId = el.dataset.userId;
    if (!level) return;
    const date = adminState.date || todayStr();
    let data;
    if (level === '__clear') {
        if (!confirm(`清除 ${date} 的結果？會收回當初發的幣，學生可以重拍（當天才有意義）。`)) { el.value = ''; return; }
        data = await adminCall('DELETE', `/admin/users/${encodeURIComponent(userId)}/plates/${date}`);
    } else {
        data = await adminCall('PUT', `/admin/users/${encodeURIComponent(userId)}/plates/${date}`, { level, note: '管理員在班級名冊更正' });
    }
    el.value = '';
    if (data) await loadClassDetail();
}

// ── 班級：稱重（任何班、任何日期；秤連不上時手動輸入）──────────────

const SCALE_LABEL = {
    ok: '穩定', unstable: '還在晃', no_load: '秤上沒有東西', offline: '秤離線', overload: '超出量程', disabled: '這班沒有綁秤',
};

async function loadClassWeighing() {
    const box = $id('adminWeighBox');
    if (!box) return;
    const q = `classId=${encodeURIComponent(adminState.classId)}&date=${adminState.date}`;
    const data = await adminCall('GET', `/record/weigh-queue?${q}`, null, { quiet: true });
    if (!data) { box.innerHTML = '<p class="field-hint">載入失敗</p>'; return; }

    if (data.status === 'none') {
        box.innerHTML = data.menuReady
            ? `<p class="field-hint">這天還沒開始紀錄。</p>
               <button class="small" data-action="adminStartWeigh">開始這天的紀錄</button>`
            : '<p class="field-hint">這天沒有菜單（或不供餐），不需要稱重。</p>';
        return;
    }

    const s = data.scale || {};
    const blocked = (data.blocked || []).filter(Boolean);
    const p = data.progress || {};
    const summary = adminState.detail && adminState.detail.weighing;
    box.innerHTML = `
        <p class="field-hint">
            狀態：<strong>${WEIGH_LABEL[data.status] || data.status}</strong>　進度 ${p.done}/${p.total}
            　秤：${escapeText(SCALE_LABEL[s.state] || s.state || '—')}${s.netG != null ? `（${Math.round(s.netG)} g）` : ''}
            ${s.state !== 'ok' ? '　<strong>秤讀不到時，用「手動」填秤上讀數（含桶）</strong>' : ''}
        </p>
        ${blocked.length ? `<div class="weigh-block">⚠️ ${blocked.map(escapeText).join('<br>')}<br><span class="field-hint">到「設定 → 桶型扣重」設定後再量</span></div>` : ''}
        <div class="table-scroll"><table class="data-table stack-sm">
            <thead><tr><th>菜色</th><th>桶型</th><th class="num">剩餘</th><th>記錄</th></tr></thead>
            <tbody>${data.queue.map((d) => `
                <tr class="${d.weighed ? 'done' : ''}">
                    <td>${escapeText(d.slotLabel)}　${escapeText(d.dishName)}</td>
                    <td>${escapeText(d.bucketLabel)}${d.tareG != null ? `<small>（皮重 ${d.tareG} g）</small>` : ''}</td>
                    <td class="num">${d.weighed ? `<strong>${d.leftoverG}</strong> g` : '<span class="weigh-pending">待量</span>'}</td>
                    <td class="weigh-ops">
                        <button class="small" data-action="adminWeighScale" data-slot="${escapeAttr(d.slot)}" ${blocked.length ? 'disabled' : ''}>讀秤</button>
                        <input type="number" class="mini-input" min="0" step="1" placeholder="讀數 g" id="manual-${escapeAttr(d.slot)}" aria-label="秤上讀數（含桶）">
                        <button class="secondary-btn small" data-action="adminWeighManual" data-slot="${escapeAttr(d.slot)}" ${blocked.length ? 'disabled' : ''}>手動</button>
                        <button class="secondary-btn small" data-action="adminWeighEmptied" data-slot="${escapeAttr(d.slot)}">吃光</button>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table></div>
        <div class="card-actions">
            ${p.allDone && data.status !== 'done' ? '<button class="small" data-action="adminFinalizeWeigh">完成這天的紀錄</button>' : ''}
            ${data.status === 'done' && summary && summary.totalG != null ? `<span class="field-hint">全班剩食 <strong>${Math.round(summary.totalG)}</strong> g</span>` : ''}
            <button class="danger-btn small" data-action="adminResetWeigh">重設這天</button>
        </div>`;
}

const weighBody = (extra) => ({ classId: adminState.classId, date: adminState.date, ...extra });

async function adminStartWeigh() {
    if (await adminCall('POST', '/record/start', weighBody({}))) await loadClassDetail();
}

async function adminWeighScale(el) {
    if (await adminCall('POST', '/record/weigh', weighBody({ slot: el.dataset.slot }))) await loadClassDetail();
}

async function adminWeighManual(el) {
    const input = $id('manual-' + el.dataset.slot);
    const v = input ? input.value : '';
    if (v === '') return notify('請先填秤上讀數（含桶，公克）', false);
    if (await adminCall('POST', '/record/weigh', weighBody({ slot: el.dataset.slot, netG: Number(v) }))) await loadClassDetail();
}

async function adminWeighEmptied(el) {
    if (await adminCall('POST', '/record/weigh', weighBody({ slot: el.dataset.slot, emptied: true }))) await loadClassDetail();
}

async function adminFinalizeWeigh() {
    if (await adminCall('POST', '/record/finalize', weighBody({}))) await loadClassDetail();
}

async function adminResetWeigh() {
    if (!confirm(`確定清除這班 ${adminState.date} 的稱重紀錄？量過的資料會全部刪掉。`)) return;
    const q = `classId=${encodeURIComponent(adminState.classId)}&date=${adminState.date}`;
    if (await adminCall('DELETE', `/record/session?${q}`)) await loadClassDetail();
}

// ── 帳號：搜尋與瀏覽 ─────────────────────────────────────────────

async function searchUsers() {
    adminState.users = {
        q: (($id('userSearch') || {}).value || '').trim(),
        role: ($id('userRoleFilter') || {}).value || '',
        pages: [null],
        page: 0,
    };
    await loadUserPage();
}

async function userPage(el) {
    const st = adminState.users;
    st.page = Math.max(0, st.page + Number(el.dataset.step));
    await loadUserPage();
}

async function loadUserPage() {
    const box = $id('userResults');
    const st = adminState.users;
    if (!box) return;
    if (!st.q && !st.role) {
        box.innerHTML = '<p class="field-hint">輸入關鍵字搜尋，或選一個角色瀏覽。</p>';
        return;
    }
    const params = new URLSearchParams();
    if (st.q) params.set('q', st.q);
    if (st.role) params.set('role', st.role);
    if (!st.q && st.pages[st.page]) params.set('after', st.pages[st.page]);
    const data = await adminCall('GET', '/admin/users?' + params.toString(), null, { quiet: true });
    if (!data) return;
    if (data.next) st.pages[st.page + 1] = data.next;

    const head = data.mode === 'search'
        ? `找到 ${data.users.length} 筆${data.truncated ? '（只顯示前 30 筆，請輸入更完整的關鍵字）' : ''}`
        : `共 ${data.total} 筆，第 ${st.page + 1} 頁`;
    box.innerHTML = `
        <p class="field-hint">${head}</p>
        ${data.users.length ? `
        <div class="table-scroll"><table class="data-table">
            <thead><tr><th>姓名</th><th>角色</th><th>帳號</th><th>班級</th><th class="num">ESG</th><th></th></tr></thead>
            <tbody>${data.users.map((u) => `
                <tr class="${u.isActive ? '' : 'inactive'}">
                    <td>${escapeText(u.displayName)}${u.isActive ? '' : ' <span class="badge badge-muted">停用</span>'}</td>
                    <td>${escapeText(u.roleLabel)}</td>
                    <td>${escapeText(u.account || u.email || '')}</td>
                    <td>${escapeText(u.classLabel || '—')}${u.seatNo ? ` <small>${escapeText(u.seatNo)} 號</small>` : ''}</td>
                    <td class="num">${u.esgCoin == null ? '—' : u.esgCoin}</td>
                    <td><button class="secondary-btn small" data-action="openUser" data-user-id="${escapeAttr(u.userId)}">管理</button></td>
                </tr>`).join('')}
            </tbody>
        </table></div>` : '<p class="field-hint">沒有符合的帳號</p>'}
        ${data.mode === 'list' ? `
        <div class="pager">
            <button class="secondary-btn small" data-action="userPage" data-step="-1" ${st.page === 0 ? 'disabled' : ''}>上一頁</button>
            <button class="secondary-btn small" data-action="userPage" data-step="1" ${data.next ? '' : 'disabled'}>下一頁</button>
        </div>` : ''}`;
}

function toggleNewUser() {
    const f = $id('newUserForm');
    if (f) f.classList.toggle('hidden');
    syncNewUserFields();
}

/** 學生要班級＋座號；老師可選班級；技術員與管理員都不需要。 */
function syncNewUserFields() {
    const role = ($id('newUserRole') || {}).value || 'student';
    const cls = $id('newUserClassField');
    const seat = $id('newUserSeatField');
    if (cls) cls.classList.toggle('hidden', !['student', 'teacher'].includes(role));
    if (seat) seat.classList.toggle('hidden', role !== 'student');
}

async function createUserByAdmin() {
    const role = $id('newUserRole').value;
    const result = $id('newUserResult');
    const data = await adminCall('POST', '/admin/users', {
        role,
        account: ($id('newUserAccount').value || '').trim(),
        displayName: ($id('newUserName').value || '').trim(),
        password: $id('newUserPassword').value || '',
        classId: ['student', 'teacher'].includes(role) ? $id('newUserClass').value || undefined : undefined,
        seatNo: role === 'student' ? ($id('newUserSeat').value || '').trim() : undefined,
    });
    result.className = 'verify-result ' + (data ? 'ok' : 'error');
    result.textContent = data ? data.message : '';
    if (!data) return;
    ['newUserAccount', 'newUserName', 'newUserPassword', 'newUserSeat'].forEach((id) => { $id(id).value = ''; });
    if (role === 'teacher') adminState.teachers = null;
    await openUserById(data.user.userId);
}

// ── 帳號操作面板（依角色）─────────────────────────────────────────

async function openUser(el) {
    await openUserById(el.dataset.userId);
}

async function openUserById(userId) {
    adminState.drawerUserId = userId;
    $id('userDrawer').classList.remove('hidden');
    document.body.classList.add('drawer-open');
    $id('userDrawerBody').innerHTML = '<p class="field-hint">載入中...</p>';
    await ensureClassList();
    await loadUserDrawer();
}

function closeUserDrawer() {
    adminState.drawerUserId = null;
    $id('userDrawer').classList.add('hidden');
    document.body.classList.remove('drawer-open');
}

// Esc 關閉面板
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && adminState.drawerUserId) closeUserDrawer();
});

async function loadUserDrawer() {
    const id = adminState.drawerUserId;
    if (!id) return;
    const data = await adminCall('GET', `/admin/users/${encodeURIComponent(id)}`, null, { quiet: true });
    if (!data) { closeUserDrawer(); return; }
    renderUserDrawer(data);
}

/** 抽屜裡的操作做完後：面板、班級名冊、搜尋結果都要跟著更新。 */
async function afterUserChange() {
    await loadUserDrawer();
    if (adminState.tab === 'classes' && adminState.classId) await loadClassDetail();
    if (adminState.tab === 'users') await loadUserPage();
}

function renderUserDrawer(d) {
    adminState.drawerData = d;
    const u = d.user;
    const roleOpts = [['student', '學生'], ['teacher', '老師'], ['technician', '技術員'], ['admin', '管理員']]
        .map(([v, l]) => opt(v, l, u.role === v)).join('');
    const classOpts = opt('', '（沒有班級）') + adminState.classes.map((c) => opt(c.classId, c.label, c.classId === u.classId)).join('');
    const canMove = ['student', 'teacher'].includes(u.role);

    let roleSections = '';
    if (u.role === 'student') {
        roleSections += `
        <section class="drawer-section">
            <h4>💰 ESG 幣 <span class="big-number">${u.esgCoin}</span></h4>
            <div class="inline-form">
                <label>調整 <input type="number" id="coinDelta" step="1" placeholder="+10 或 -5"></label>
                <label class="grow">原因 <input type="text" id="coinReason" maxlength="100" placeholder="會記在總帳上"></label>
                <button class="small" data-action="adjustUserCoins">調整</button>
            </div>
            ${(d.ledger || []).length ? `
            <div class="table-scroll"><table class="data-table compact">
                <thead><tr><th>日期</th><th>內容</th><th class="num">ESG</th></tr></thead>
                <tbody>${d.ledger.map((t) => `
                    <tr><td>${escapeText(t.date || '')}</td>
                        <td>${escapeText(t.reason || '')}${t.source ? ` <small>${escapeText(t.source)}</small>` : ''}</td>
                        <td class="num ${t.amount < 0 ? 'neg' : 'pos'}">${t.amount > 0 ? '+' : ''}${t.amount}</td></tr>`).join('')}
                </tbody>
            </table></div>` : '<p class="field-hint">還沒有任何幣的紀錄</p>'}
        </section>

        <section class="drawer-section">
            <h4>📷 餐盤紀錄（近 14 天）</h4>
            ${(d.plates || []).length ? `
            <div class="table-scroll"><table class="data-table compact">
                <thead><tr><th>日期</th><th>結果</th><th class="num">ESG</th><th>更正</th></tr></thead>
                <tbody>${d.plates.map((p) => `
                    <tr><td>${escapeText(p.date)}</td>
                        <td>${plateBadge(p)} <small>${p.leftoverPct}%${p.source === 'admin' ? ' · 已更正' : ''}</small></td>
                        <td class="num">${p.coinsAwarded}</td>
                        <td><select class="mini-select" data-change="drawerPlate" data-date="${escapeAttr(p.date)}">${plateLevelOptions()}</select></td></tr>`).join('')}
                </tbody>
            </table></div>` : '<p class="field-hint">近 14 天沒有餐盤紀錄</p>'}
            <div class="inline-form">
                <label>補登日期 <input type="date" id="plateAddDate" max="${todayStr()}" value="${todayStr()}"></label>
                <label>結果 <select id="plateAddLevel">${PLATE_LEVELS.map(([v, l]) => opt(v, l)).join('')}</select></label>
                <label class="grow">原因 <input type="text" id="plateAddNote" maxlength="100" placeholder="例如：秤／相機故障，老師口頭確認"></label>
                <button class="small" data-action="addPlateResult">標記</button>
            </div>
        </section>

        <section class="drawer-section">
            <h4>🍳 午餐長</h4>
            ${u.isLunchLeader
                ? `<p>是 ${escapeText((d.class && d.class.label) || '')}的午餐長。</p><button class="secondary-btn small" data-action="drawerClearLeader">取消午餐長</button>`
                : (u.classId ? `<button class="small" data-action="drawerSetLeader">設為本班午餐長</button>` : '<p class="field-hint">先指定班級才能當午餐長</p>')}
        </section>

        <section class="drawer-section">
            <h4>👨‍👩‍👧 家長</h4>
            ${(d.parents || []).length ? d.parents.map((p) => `
                <p>${escapeText(p.displayName)} <small>${escapeText(p.account || '')}</small>
                   <button class="secondary-btn small" data-action="openUser" data-user-id="${escapeAttr(p.userId)}">管理家長</button></p>`).join('')
                : '<p class="field-hint">還沒有綁定家長（家長自行註冊時會驗證孩子資料）</p>'}
        </section>`;
    }

    if (u.role === 'parent') {
        const s = d.boundStudent;
        roleSections += `
        <section class="drawer-section">
            <h4>🧒 綁定的孩子</h4>
            ${s ? (s.missing ? '<p class="field-hint">綁定的學生已不存在，請重新綁定</p>'
                : `<p>${escapeText(s.displayName)} <small>${escapeText(s.classLabel || '')} ${escapeText(s.seatNo || '')} 號 · ${escapeText(s.account || '')}</small>
                    <button class="secondary-btn small" data-action="openUser" data-user-id="${escapeAttr(s.userId)}">管理孩子</button></p>`)
                : '<p class="field-hint">還沒有綁定</p>'}
            <div class="inline-form">
                <label class="grow">改綁學生帳號 <input type="text" id="bindStudentAccount" placeholder="例如 stu302-02"></label>
                <button class="small" data-action="bindParentStudent">綁定</button>
                ${s ? '<button class="secondary-btn small" data-action="unbindParentStudent">解除綁定</button>' : ''}
            </div>
            <p class="field-hint">一位學生只能綁一位家長；學生已經被別人綁定時要先解除那邊。</p>
        </section>`;
    }

    if (u.role === 'teacher') {
        roleSections += `
        <section class="drawer-section">
            <h4>👩‍🏫 導師</h4>
            <p>${(d.homeroomOf || []).length ? '目前是 ' + d.homeroomOf.map((c) => escapeText(c.label)).join('、') + ' 的導師' : '目前不是任何班的導師'}</p>
            <div class="inline-form">
                <label class="grow">設為導師 <select id="homeroomPick">${adminState.classes.map((c) => opt(c.classId, c.label, c.classId === u.classId)).join('')}</select></label>
                <button class="small" data-action="drawerSetHomeroom">設定</button>
            </div>
            <p class="field-hint">一位老師只當一個班的導師；設定新班級時原本帶的班會自動清掉。</p>
        </section>`;
    }

    $id('userDrawerBody').innerHTML = `
        <header class="drawer-head">
            <h3 id="userDrawerTitle">${escapeText(u.displayName)}</h3>
            <p>
                <span class="badge">${escapeText(u.roleLabel)}</span>
                ${u.isLunchLeader ? '<span class="badge badge-leader">午餐長</span>' : ''}
                ${u.isActive ? '' : '<span class="badge badge-muted">停用中</span>'}
            </p>
            <p class="field-hint">${escapeText(u.account || u.email || '')}${d.class ? ' · ' + escapeText(d.class.label || d.class.classId) : ''}${u.seatNo ? ' ' + escapeText(u.seatNo) + ' 號' : ''}
                ${d.class && d.class.missing ? '　<strong>⚠️ 班級不存在，請重新指定</strong>' : ''}</p>
        </header>

        <section class="drawer-section">
            <h4>基本資料</h4>
            <div class="inline-form">
                <label class="grow">姓名 <input type="text" id="editUserName" value="${escapeAttr(u.displayName)}"></label>
                ${u.role === 'parent' ? '' : `<label>角色 <select id="editUserRole">${roleOpts}</select></label>`}
                ${canMove || u.role === 'student' ? `<label>班級 <select id="editUserClass">${classOpts}</select></label>` : ''}
                ${u.role === 'student' ? `<label>座號 <input type="text" id="editUserSeat" value="${escapeAttr(u.seatNo || '')}" size="4"></label>` : ''}
                <button class="small" data-action="saveUserBasics">儲存</button>
            </div>
            <div class="inline-form">
                <label class="grow">新密碼 <input type="text" id="editUserPassword" placeholder="至少 6 個字元"></label>
                <button class="secondary-btn small" data-action="resetUserPassword">重設密碼</button>
            </div>
            <div class="card-actions">
                <button class="secondary-btn small" data-action="toggleDrawerUserActive" data-active="${u.isActive ? 'false' : 'true'}">${u.isActive ? '停用帳號' : '啟用帳號'}</button>
                <button class="danger-btn small" data-action="deleteDrawerUser">刪除帳號</button>
            </div>
        </section>
        ${roleSections}
        <p class="field-hint">最後登入：${d.lastLoginAt ? new Date(d.lastLoginAt).toLocaleString('zh-TW') : '—'}</p>`;
}

const drawerUrl = (suffix = '') => `/admin/users/${encodeURIComponent(adminState.drawerUserId)}${suffix}`;

async function saveUserBasics() {
    const body = { displayName: ($id('editUserName').value || '').trim() };
    if ($id('editUserRole')) body.role = $id('editUserRole').value;
    if ($id('editUserClass')) body.classId = $id('editUserClass').value || null;
    if ($id('editUserSeat')) body.seatNo = ($id('editUserSeat').value || '').trim();
    if (await adminCall('PATCH', drawerUrl(), body)) {
        adminState.teachers = null;
        await ensureClassList(true);
        await afterUserChange();
    }
}

async function resetUserPassword() {
    const password = $id('editUserPassword').value || '';
    if (password.length < 6) return notify('密碼至少需要 6 個字元', false);
    if (await adminCall('PATCH', drawerUrl(), { password })) $id('editUserPassword').value = '';
}

async function toggleDrawerUserActive(el) {
    const isActive = el.dataset.active === 'true';
    if (!confirm(isActive ? '確定啟用這個帳號？' : '確定停用這個帳號？停用後無法登入，但資料都會保留。')) return;
    if (await adminCall('PATCH', drawerUrl(), { isActive })) await afterUserChange();
}

async function deleteDrawerUser() {
    if (!confirm('確定刪除這個帳號？\n\n有活動紀錄（幣的總帳、餐盤…）的帳號刪不掉，那種情況請改用「停用」。')) return;
    if (await adminCall('DELETE', drawerUrl())) {
        closeUserDrawer();
        if (adminState.tab === 'classes' && adminState.classId) await loadClassDetail();
        if (adminState.tab === 'users') await loadUserPage();
    }
}

async function adjustUserCoins() {
    const amount = Number($id('coinDelta').value);
    const reason = ($id('coinReason').value || '').trim();
    if (!amount) return notify('請填調整量（正數加、負數扣）', false);
    if (!reason) return notify('請寫下原因，會記在總帳上', false);
    if (await adminCall('POST', drawerUrl('/coins'), { amount, reason })) await afterUserChange();
}

async function drawerPlate(el) {
    const level = el.value;
    if (!level) return;
    const date = el.dataset.date;
    let ok;
    if (level === '__clear') {
        ok = confirm(`清除 ${date} 的結果？會收回當初發的幣。`)
            && await adminCall('DELETE', drawerUrl(`/plates/${date}`));
    } else {
        ok = await adminCall('PUT', drawerUrl(`/plates/${date}`), { level, note: '管理員在帳號面板更正' });
    }
    el.value = '';
    if (ok) await afterUserChange();
}

async function addPlateResult() {
    const date = $id('plateAddDate').value;
    const level = $id('plateAddLevel').value;
    if (!date || !level) return notify('請選日期與結果', false);
    if (await adminCall('PUT', drawerUrl(`/plates/${date}`), { level, note: ($id('plateAddNote').value || '').trim() })) {
        await afterUserChange();
    }
}

async function drawerSetLeader() {
    const cid = adminState.drawerData && adminState.drawerData.user.classId;
    if (!cid) return notify('這位學生沒有班級', false);
    if (await adminCall('POST', `/admin/classes/${encodeURIComponent(cid)}/lunch-leader`, { userId: adminState.drawerUserId })) {
        await ensureClassList(true);
        await afterUserChange();
    }
}

async function drawerClearLeader() {
    const cid = adminState.drawerData && adminState.drawerData.user.classId;
    if (!cid || !confirm('確定取消這位學生的午餐長？')) return;
    if (await adminCall('DELETE', `/admin/classes/${encodeURIComponent(cid)}/lunch-leader`)) {
        await ensureClassList(true);
        await afterUserChange();
    }
}

async function bindParentStudent() {
    const studentAccount = ($id('bindStudentAccount').value || '').trim();
    if (!studentAccount) return notify('請填學生帳號', false);
    if (await adminCall('PUT', drawerUrl('/binding'), { studentAccount })) await afterUserChange();
}

async function unbindParentStudent() {
    if (!confirm('確定解除綁定？家長之後簽到就不會幫孩子加幣。')) return;
    if (await adminCall('DELETE', drawerUrl('/binding'))) await afterUserChange();
}

async function drawerSetHomeroom() {
    const classId = $id('homeroomPick').value;
    if (!classId) return;
    if (await adminCall('POST', `/admin/classes/${encodeURIComponent(classId)}/teacher`, { userId: adminState.drawerUserId })) {
        adminState.teachers = null;
        await afterUserChange();
    }
}

// ── 資料檢查 ─────────────────────────────────────────────────────

async function runConsistency() {
    const box = $id('consistencyResult');
    if (!box) return;
    box.innerHTML = '<p class="field-hint">檢查中…</p>';
    const data = await adminCall('GET', '/admin/consistency', null, { quiet: true });
    if (!data) { box.innerHTML = ''; return; }
    if (!data.total) {
        box.innerHTML = '<p class="verify-result ok">✅ 沒有發現不一致的資料</p>';
        return;
    }
    box.innerHTML = `
        <p class="field-hint">共 ${data.total} 筆需要注意（${new Date(data.checkedAt).toLocaleTimeString('zh-TW')}）</p>
        ${data.groups.filter((g) => g.count).map((g) => `
            <details class="health-group" open>
                <summary>
                    <strong>${escapeText(g.label)}</strong> <span class="badge">${g.count}</span>
                    ${g.fixable ? `<button class="small" data-action="fixConsistency" data-type="${escapeAttr(g.type)}">修正 ${g.fixable} 筆</button>` : '<span class="field-hint">需要人工處理</span>'}
                </summary>
                <p class="field-hint">${escapeText(g.why)}</p>
                <ul class="plain-list">${g.items.map((i) => `
                    <li>${i.fixable ? '🔧' : '👀'} ${escapeText(i.text)}
                        ${i.userId ? `<button class="secondary-btn small" data-action="openUser" data-user-id="${escapeAttr(i.userId)}">管理</button>` : ''}</li>`).join('')}
                </ul>
                ${g.count > g.items.length ? `<p class="field-hint">（只列出前 ${g.items.length} 筆）</p>` : ''}
            </details>`).join('')}`;
}

async function fixConsistency(el) {
    if (!confirm('確定修正這一類的問題？')) return;
    const data = await adminCall('POST', '/admin/consistency/fix', { type: el.dataset.type }, { quiet: true });
    if (data) notify(`已修正 ${data.fixed} 筆`);
    await runConsistency();
}

async function checkBalances() {
    const box = $id('balanceResult');
    const classId = ($id('balanceClass') || {}).value;
    if (!box || !classId) return;
    box.innerHTML = '<p class="field-hint">核對中…</p>';
    const data = await adminCall('GET', `/admin/consistency/balances?classId=${encodeURIComponent(classId)}`, null, { quiet: true });
    if (!data) { box.innerHTML = ''; return; }
    if (!data.mismatched.length) {
        box.innerHTML = `<p class="verify-result ok">✅ ${data.checked} 位學生的餘額都與總帳一致</p>`;
        return;
    }
    box.innerHTML = `
        <p class="field-hint">${data.checked} 位學生中有 ${data.mismatched.length} 位對不上</p>
        <div class="table-scroll"><table class="data-table compact">
            <thead><tr><th>座號</th><th>姓名</th><th class="num">餘額</th><th class="num">總帳加總</th><th class="num">差額</th></tr></thead>
            <tbody>${data.mismatched.map((r) => `
                <tr><td>${escapeText(r.seatNo || '—')}</td><td>${escapeText(r.displayName)}</td>
                    <td class="num">${r.balance}</td><td class="num">${r.ledgerSum}</td><td class="num">${r.diff > 0 ? '+' : ''}${r.diff}</td></tr>`).join('')}
            </tbody>
        </table></div>
        <button class="small" data-action="fixBalances">補登對帳分錄（餘額不動）</button>`;
}

async function fixBalances() {
    const classId = ($id('balanceClass') || {}).value;
    if (!classId || !confirm('為每位對不上的學生補一筆「對帳」分錄，讓總帳加總等於餘額。學生看到的餘額不會變。')) return;
    const data = await adminCall('POST', '/admin/consistency/balances/fix', { classId }, { quiet: true });
    if (data) notify(`已補登 ${data.fixed} 筆對帳分錄`);
    await checkBalances();
}

// ── 註冊到 app.js 的事件委派 ─────────────────────────────────────
Object.assign(ACTION_HANDLERS, {
    adminTab: (el) => adminTab(el),
    openClassFromOverview: (el) => openClassFromOverview(el),
    selectClass: (el) => selectClass(el),
    filterClassPicker: () => filterClassPicker(),
    toggleNewClass: () => toggleNewClass(),
    createClass: () => createClass(),
    changeClassDate: (el) => changeClassDate(el),
    toggleClassEdit: () => toggleClassEdit(),
    saveClassEdit: () => saveClassEdit(),
    deleteClass: () => deleteClass(),
    setClassTeacher: () => setClassTeacher(),
    clearClassTeacher: () => clearClassTeacher(),
    setClassLeader: () => setClassLeader(),
    clearClassLeader: () => clearClassLeader(),
    addStudentToClass: () => addStudentToClass(),
    quickPlate: (el) => quickPlate(el),
    adminStartWeigh: () => adminStartWeigh(),
    adminWeighScale: (el) => adminWeighScale(el),
    adminWeighManual: (el) => adminWeighManual(el),
    adminWeighEmptied: (el) => adminWeighEmptied(el),
    adminFinalizeWeigh: () => adminFinalizeWeigh(),
    adminResetWeigh: () => adminResetWeigh(),
    searchUsers: () => searchUsers(),
    userPage: (el) => userPage(el),
    toggleNewUser: () => toggleNewUser(),
    syncNewUserFields: () => syncNewUserFields(),
    createUserByAdmin: () => createUserByAdmin(),
    openUser: (el) => openUser(el),
    closeUserDrawer: () => closeUserDrawer(),
    saveUserBasics: () => saveUserBasics(),
    resetUserPassword: () => resetUserPassword(),
    toggleDrawerUserActive: (el) => toggleDrawerUserActive(el),
    deleteDrawerUser: () => deleteDrawerUser(),
    adjustUserCoins: () => adjustUserCoins(),
    drawerPlate: (el) => drawerPlate(el),
    addPlateResult: () => addPlateResult(),
    drawerSetLeader: () => drawerSetLeader(),
    drawerClearLeader: () => drawerClearLeader(),
    bindParentStudent: () => bindParentStudent(),
    unbindParentStudent: () => unbindParentStudent(),
    drawerSetHomeroom: () => drawerSetHomeroom(),
    runConsistency: () => runConsistency(),
    fixConsistency: (el) => fixConsistency(el),
    checkBalances: () => checkBalances(),
    fixBalances: () => fixBalances(),
});
