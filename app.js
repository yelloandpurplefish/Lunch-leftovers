// ======================
// 食安守護者 Demo
// ======================

// 全域變數與 API_BASE_URL 由 firebase-config.js 定義

// 顯示頂部錯誤橫幅
function showErrorBanner(message) {
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = message;
  document.body.prepend(banner);
}

// 從 localStorage 還原登入狀態
async function restoreSession() {
  const token = localStorage.getItem('token');
  if (!token) {
    showAuthForm();
    return;
  }

  idToken = token;
  try {
    await loadUserData();
    showLoggedInState();
  } catch (error) {
    console.error('載入使用者資料失敗:', error);
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    idToken = null;
    currentUser = null;
    showAuthForm();
  }
}

// 切換登入/註冊標籤
function switchTab(tab) {
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const tabs = document.querySelectorAll('.auth-tab');

  tabs.forEach(t => t.classList.remove('active'));

  if (tab === 'login') {
    loginForm.classList.remove('hidden');
    registerForm.classList.add('hidden');
    tabs[0].classList.add('active');
  } else {
    loginForm.classList.add('hidden');
    registerForm.classList.remove('hidden');
    tabs[1].classList.add('active');
    syncRegisterFields();
  }
}

function getSelectedRegisterRole() {
  const selected = document.querySelector('input[name="registerRole"]:checked');
  return selected ? selected.value : 'student';
}

function syncRegisterFields() {
  const parentFields = document.getElementById('parentRegisterFields');
  const studentFields = document.getElementById('studentRegisterFields');
  const accountLabel = document.getElementById('registerAccountLabel');
  const emailGroup = document.getElementById('registerEmailGroup');
  if (!parentFields || !studentFields) return;

  const isParent = getSelectedRegisterRole() === 'parent';
  parentFields.classList.toggle('hidden', !isParent);
  studentFields.classList.toggle('hidden', isParent);

  // 學生用學校給的帳號登入、家長用 Email 登入
  if (accountLabel) accountLabel.textContent = isParent ? '你的 Email（登入用）：' : '登入帳號：';
  if (emailGroup) emailGroup.classList.toggle('hidden', isParent);

  const accountInput = document.getElementById('registerAccount');
  if (accountInput) {
    accountInput.placeholder = isParent ? '例如：parent@example.com' : '例如：stu302-02';
  }
  const verifyResult = document.getElementById('verifyStudentResult');
  if (verifyResult) verifyResult.textContent = '';
}

/** 家長註冊前的友善驗證：先確認孩子四項資料對不對，再送註冊。 */
async function verifyStudentBinding() {
  const result = document.getElementById('verifyStudentResult');
  const btn = document.getElementById('verifyStudentBtn');
  if (!result) return;

  const payload = {
    studentGrade: (document.getElementById('parentStudentGrade').value || '').trim(),
    studentClass: (document.getElementById('parentStudentClass').value || '').trim(),
    studentSeat: (document.getElementById('parentStudentSeat').value || '').trim(),
    studentAccount: (document.getElementById('parentStudentAccount').value || '').trim()
  };

  if (!payload.studentGrade || !payload.studentClass || !payload.studentSeat || !payload.studentAccount) {
    result.className = 'verify-result error';
    result.textContent = '請先填寫孩子的年級、班級、座號與帳號';
    return;
  }

  btn.disabled = true;
  btn.textContent = '驗證中...';
  result.className = 'verify-result';
  result.textContent = '';

  try {
    const response = await fetch(`${API_BASE_URL}/auth/verify-student`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    result.className = 'verify-result ' + (data.verified ? 'ok' : 'error');
    result.textContent = (data.verified ? '✅ ' : '⚠️ ') + (data.message || '驗證失敗');
  } catch (error) {
    result.className = 'verify-result error';
    result.textContent = '驗證失敗：' + (error.message || '請稍後再試');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 先驗證孩子資料';
  }
}

// 處理登入
async function handleLogin() {
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  const errorElement = document.getElementById('loginError');
  const loginBtn = document.querySelector('#loginForm .auth-btn');

  if (!email || !password) {
    errorElement.textContent = '請填寫所有欄位';
    return;
  }

  // 設置載入狀態
  loginBtn.disabled = true;
  loginBtn.textContent = '登入中...';
  errorElement.textContent = '';

  try {
    const response = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: email, password })
    });

    const data = await response.json().catch(() => ({ success: false, message: '伺服器回應錯誤' }));

    if (data.success) {
      idToken = data.token;
      currentUser = data.userData;
      localStorage.setItem('token', idToken);
      localStorage.setItem('user', JSON.stringify(currentUser));
      errorElement.textContent = '';
      await loadUserData();
      showLoggedInState();
    } else {
      errorElement.textContent = data.message || '登入失敗';
    }
  } catch (error) {
    console.error('登入失敗:', error);
    errorElement.textContent = '登入失敗，請稍後再試';
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = '登入';
  }
}

// 處理註冊
async function handleRegister() {
  const name = document.getElementById('registerName').value;
  const accountInput = document.getElementById('registerAccount');
  const account = accountInput ? accountInput.value.trim() : '';
  const emailInput = document.getElementById('registerEmail');
  const email = emailInput ? emailInput.value.trim() : '';
  const password = document.getElementById('registerPassword').value;
  const confirmPassword = document.getElementById('registerConfirmPassword').value;
  const role = getSelectedRegisterRole();
  const studentGrade = document.getElementById('parentStudentGrade');
  const studentClass = document.getElementById('parentStudentClass');
  const studentSeat = document.getElementById('parentStudentSeat');
  const studentAccount = document.getElementById('parentStudentAccount');
  const errorElement = document.getElementById('registerError');
  const registerBtn = document.querySelector('#registerForm .auth-btn');

  if (!name || !account || !password || !confirmPassword) {
    errorElement.textContent = '請填寫姓名、帳號與密碼';
    return;
  }

  if (password.length < 6) {
    errorElement.textContent = '密碼至少需要 6 個字元';
    return;
  }

  if (password !== confirmPassword) {
    errorElement.textContent = '兩次輸入的密碼不一致';
    return;
  }

  if (role === 'parent') {
    const gradeValue = studentGrade ? studentGrade.value.trim() : '';
    const classValue = studentClass ? studentClass.value.trim() : '';
    const seatValue = studentSeat ? studentSeat.value.trim() : '';
    const accountValue = studentAccount ? studentAccount.value.trim() : '';

    if (!gradeValue || !classValue || !seatValue || !accountValue) {
      errorElement.textContent = '家長註冊需填寫孩子的年級、班級、座號與帳號';
      return;
    }
  } else {
    const grade = (document.getElementById('registerGrade').value || '').trim();
    const className = (document.getElementById('registerClassName').value || '').trim();
    const seatNo = (document.getElementById('registerSeatNo').value || '').trim();
    if (!grade || !className || !seatNo) {
      errorElement.textContent = '學生註冊需填寫年級、班級與座號';
      return;
    }
  }

  // 設置載入狀態
  registerBtn.disabled = true;
  registerBtn.textContent = '註冊中...';
  errorElement.textContent = '';

  try {
    // 呼叫後端註冊 API
    console.log('開始註冊，API:', `${API_BASE_URL}/auth/register`);
    const response = await fetch(`${API_BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account,
        email: email || null,
        password,
        displayName: name,
        role,
        // 學生：自己的名冊資料
        grade: (document.getElementById('registerGrade') || {}).value || '',
        className: (document.getElementById('registerClassName') || {}).value || '',
        seatNo: (document.getElementById('registerSeatNo') || {}).value || '',
        // 家長：孩子的名冊資料（四項需與學生一致才會綁定）
        studentGrade: studentGrade ? studentGrade.value.trim() : '',
        studentClass: studentClass ? studentClass.value.trim() : '',
        studentSeat: studentSeat ? studentSeat.value.trim() : '',
        studentAccount: studentAccount ? studentAccount.value.trim() : ''
      })
    });

    const data = await response.json().catch(() => ({ success: false, message: '伺服器回應錯誤' }));

    console.log('註冊 API 回應:', data);

    if (data.success) {
      idToken = data.token;
      currentUser = data.userData;
      localStorage.setItem('token', idToken);
      localStorage.setItem('user', JSON.stringify(currentUser));
      errorElement.textContent = '';
      await loadUserData();
      showLoggedInState();
    } else {
      errorElement.textContent = data.message || '註冊失敗';
    }
  } catch (error) {
    console.error('註冊失敗:', error);
    errorElement.textContent = '註冊失敗：' + (error.message || '請稍後再試');
  } finally {
    registerBtn.disabled = false;
    registerBtn.textContent = '註冊';
  }
}

// 處理登出
async function handleLogout() {
  try {
    currentUser = null;
    idToken = null;
    eCoin = 0;
    sCoin = 0;
    score = 0;
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    showAuthForm();
  } catch (error) {
    console.error('登出失敗:', error);
  }
}

// 載入使用者資料
async function loadUserData() {
  try {
    const data = await apiRequest('/user/profile', 'GET');

    if (data.success) {
      eCoin = data.userData.eCoin || 0;
      sCoin = data.userData.sCoin || 0;
      score = data.userData.score || 0;

      // 同步前端 currentUser
      currentUser = {
        uid: data.userData.userId,
        email: data.userData.email,
        displayName: data.userData.displayName,
        role: data.userData.role,
        studentBinding: data.userData.studentBinding || null
      };
      localStorage.setItem('user', JSON.stringify(currentUser));

      updateUI();
    } else {
      console.error('載入使用者資料失敗:', data.message);
    }
  } catch (error) {
    console.error('載入使用者資料失敗:', error);
    throw error;
  }
}

// 顯示登入表單
function showAuthForm() {
  document.getElementById('authContainer').classList.remove('hidden');
  document.getElementById('loggedInContainer').classList.add('hidden');

  // 未登入不顯示任何內容：把所有內容區塊與底部導覽收起來，並把登入區叫回來
  const video = document.querySelector('.video');
  if (video) video.style.display = '';
  document.querySelectorAll('section.page, .teacher-panel').forEach((el) => el.classList.add('hidden'));
  const nav = document.getElementById('bottomNav');
  if (nav) nav.classList.remove('visible');
  window.scrollTo({ top: 0, behavior: 'auto' });
}

// 顯示已登入狀態
function showLoggedInState() {
  document.getElementById('authContainer').classList.add('hidden');
  document.getElementById('loggedInContainer').classList.remove('hidden');

  const displayName = currentUser.displayName || currentUser.email || '使用者';
  document.getElementById('userDisplayName').textContent = displayName;
  updateLoggedInStats();
  syncRolePanels();

  applyRoleView();
}

// 更新已登入狀態的統計數據
function updateLoggedInStats() {
  document.getElementById('userECoin').textContent = eCoin;
  document.getElementById('userSCoin').textContent = sCoin;
  document.getElementById('userScore').textContent = score;
}

// 更新 UI
function updateUI() {
  document.getElementById('ecoin').textContent = eCoin;
  document.getElementById('scoin').textContent = sCoin;
  document.getElementById('score').textContent = score;
  updateLoggedInStats();
}

// 舊版在 #home 裡放了一張家長簽到卡片，但 #home 對家長是隱藏的，那張卡片
// 永遠顯示不出來，已移除。家長的簽到入口統一在 #parentZone，
// 可見性由 applyRoleView() 一處決定，這裡不再需要另外同步。
function syncRolePanels() {
    applyRoleView();
}

// 獲取錯誤訊息
function getErrorMessage(errorCode) {
  const errorMessages = {
    'auth/invalid-email': 'Email 格式不正確',
    'auth/user-disabled': '此帳號已被停用',
    'auth/user-not-found': '找不到此帳號',
    'auth/wrong-password': '密碼錯誤',
    'auth/email-already-in-use': '此 Email 已被註冊',
    'auth/weak-password': '密碼強度不足',
    'auth/too-many-requests': '請求過於頻繁，請稍後再試'
  };
  return errorMessages[errorCode] || '發生錯誤，請稍後再試';
}

// 獲取有效的 JWT Token
function getValidIdToken() {
  if (!idToken) {
    throw new Error('使用者尚未登入');
  }
  return idToken;
}

// API 請求輔助函數
async function apiRequest(endpoint, method = 'GET', body = null) {
  const token = getValidIdToken();
  
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const options = {
    method,
    headers
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
  
  // 解析回應，後端會在 body 中回傳 success/message
  const data = await response.json().catch(() => ({ 
    success: false, 
    message: '無法解析伺服器回應' 
  }));

  return data;
}

// 註：底部導覽改為「登入後常駐」（見 applyRoleView）。
// 原本綁在 scroll 事件上、只有滑到距底部 150px 才滑出，
// 使用者平常根本看不到導覽列，改掉。



// ============================================================
// 個人英雄榜
// ============================================================
//
// 一列就看得到 E幣、S幣與種樹數。分成三張榜輪流切換的話，
// 學生很難建立「我吃得好 → 營養夠 → 少浪費 → 種了樹」這條因果，
// 而那正是這個榜要傳達的事。

/** 樹的數字很小（每人每餐約 0.008 棵），固定顯示到小數第 3 位才看得出變化。 */
function formatTrees(v) {
    const n = Number(v || 0);
    if (n === 0) return '0';
    return n >= 1 ? n.toFixed(2) : n.toFixed(3);
}

async function loadHeroBoard() {
    const tbody = document.getElementById('heroBoardList');
    if (!tbody) return;
    const period = (document.getElementById('heroPeriod') || {}).value || 'week';
    const within = (document.getElementById('heroWithin') || {}).value || 'school';
    const sort = (document.getElementById('heroSort') || {}).value || 'trees';
    const mineBox = document.getElementById('heroMine');

    try {
        const data = await apiRequest(
            `/leaderboard/heroes?period=${period}&within=${within}&sort=${sort}`, 'GET');
        if (!data.success) {
            tbody.innerHTML = '<tr><td colspan="5">載入失敗</td></tr>';
            return;
        }
        if (!data.rows.length) {
            tbody.innerHTML = '<tr><td colspan="5">這段期間還沒有人獲得幣</td></tr>';
            if (mineBox) mineBox.innerHTML = '';
            return;
        }

        const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : r);
        tbody.innerHTML = data.rows.map((r) => `
            <tr class="${r.me ? 'my-rank-row' : ''}">
                <td>${medal(r.rank)}</td>
                <td>${r.displayName}${r.className ? `<small>　${r.className}</small>` : ''}</td>
                <td>${r.E}</td>
                <td>${r.S}</td>
                <td>${formatTrees(r.trees)}</td>
            </tr>
        `).join('');

        if (mineBox) {
            mineBox.innerHTML = data.me
                ? `<p>你目前第 <strong>${data.me.rank}</strong> 名／共 ${data.total} 人　·　`
                  + `這段期間 E幣 ${data.me.E}、S幣 ${data.me.S}　·　`
                  + `🌳 累計種下 <strong>${formatTrees(data.me.treesLifetime)}</strong> 棵樹</p>`
                : '<p class="field-hint">你這段期間還沒有獲得幣，先把自己那份吃完吧。</p>';
        }
    } catch (error) {
        tbody.innerHTML = '<tr><td colspan="5">載入失敗</td></tr>';
    }
}

// ============================================================
// 開發者面板：發幣公式參數
// ============================================================

let coinRulesState = { values: null, defaults: null };

/** 參數說明：光看 kProtein 這種鍵名沒人知道要填什麼，一律附中文與單位。 */
const RULE_LABELS = {
    'energy.kProtein': ['每公克蛋白質 → E幣', '幣/g'],
    'energy.kFiber': ['每公克膳食纖維 → E幣', '幣/g'],
    'sdg.co2PerKgWaste': ['每公斤廚餘的碳排', 'kgCO2e/kg'],
    'sdg.treeAnnualCo2Kg': ['每棵樹每年吸收的 CO2', 'kg/年'],
    'sdg.sCoinPerTree': ['每棵樹 → S幣（放大常數）', '幣/棵'],
    'sdg.schoolBaselineWindow': ['全校歷史平均取最近幾場', '場'],
    'sdg.fallbackSchoolWastePerCapitaG': ['歷史不足時的起步基準', 'g/人/餐'],
    'sdg.minSchoolSamples': ['低於幾場就用起步基準', '場'],
};

function ruleInput(path, value, def) {
    const [label, unit] = RULE_LABELS[path] || [path, ''];
    const changed = Number(value) !== Number(def);
    return `
        <label class="rule-row ${changed ? 'changed' : ''}">
            <span class="rule-label">${label}</span>
            <input type="number" step="any" data-rule="${path}" value="${value}">
            <span class="rule-unit">${unit}</span>
            <span class="rule-default">預設 ${def}</span>
        </label>`;
}

function renderCoinRules() {
    const box = document.getElementById('coinRulesForm');
    if (!box || !coinRulesState.values) return;
    const v = coinRulesState.values;
    const d = coinRulesState.defaults;

    const scalar = Object.keys(RULE_LABELS).map((path) => {
        const [g, k] = path.split('.');
        return ruleInput(path, v[g][k], d[g][k]);
    }).join('');

    const cats = Object.keys(d.nutrition.byCategory);
    const nutrition = cats.map((cat) => {
        const cur = v.nutrition.byCategory[cat] || {};
        const def = d.nutrition.byCategory[cat] || {};
        return `
            <tr>
                <td>${cat}</td>
                <td><input type="number" step="any" data-nutrition="${cat}.proteinPerKg"
                           value="${cur.proteinPerKg}"><small>預設 ${def.proteinPerKg}</small></td>
                <td><input type="number" step="any" data-nutrition="${cat}.fiberPerKg"
                           value="${cur.fiberPerKg}"><small>預設 ${def.fiberPerKg}</small></td>
            </tr>`;
    }).join('');

    box.innerHTML = `
        <div class="rule-group">${scalar}</div>
        <h4>每公斤食物的營養含量（菜品可個別覆寫，沒填才用這裡的分類預設）</h4>
        <table class="rule-table">
            <thead><tr><th>分類</th><th>蛋白質 g/kg</th><th>膳食纖維 g/kg</th></tr></thead>
            <tbody>${nutrition}</tbody>
        </table>`;
}

function renderRulesPreview(preview) {
    const box = document.getElementById('coinRulesPreview');
    if (!box || !preview) return;
    box.innerHTML = `
        <p class="field-hint">以 ${preview.servings} 人份示範菜單試算：${(preview.menu || []).join('、')}</p>
        <table class="rule-table">
            <thead><tr><th>情境</th><th>人均攝取</th><th>E幣</th><th>S幣</th><th>全班種樹</th></tr></thead>
            <tbody>${(preview.scenarios || []).map((s) => `
                <tr>
                    <td>${s.label}</td>
                    <td>${s.perCapita.eatenG} g<small>　蛋白 ${s.perCapita.proteinG}／纖維 ${s.perCapita.fiberG}</small></td>
                    <td>${s.E}</td>
                    <td>${s.S}</td>
                    <td>${formatTrees(s.treesClass)} 棵</td>
                </tr>`).join('')}
            </tbody>
        </table>`;
}

/** 從表單讀回使用者填的值，組成後端要的巢狀結構。 */
function collectCoinRules() {
    const values = { energy: {}, sdg: {}, nutrition: { byCategory: {} } };
    document.querySelectorAll('#coinRulesForm input[data-rule]').forEach((el) => {
        const [g, k] = el.dataset.rule.split('.');
        values[g][k] = Number(el.value);
    });
    document.querySelectorAll('#coinRulesForm input[data-nutrition]').forEach((el) => {
        const [cat, field] = el.dataset.nutrition.split('.');
        values.nutrition.byCategory[cat] = values.nutrition.byCategory[cat] || {};
        values.nutrition.byCategory[cat][field] = Number(el.value);
    });
    return values;
}

async function loadCoinRules() {
    const box = document.getElementById('coinRulesForm');
    if (!box) return;
    try {
        const data = await apiRequest('/admin/coin-rules', 'GET');
        if (!data.success) {
            box.innerHTML = `<p>${data.message || '載入失敗'}</p>`;
            return;
        }
        coinRulesState = { values: data.values, defaults: data.defaults };
        renderCoinRules();
        renderRulesPreview(data.preview);
    } catch (error) {
        box.innerHTML = '<p>載入失敗</p>';
    }
}

async function previewCoinRules() {
    const result = document.getElementById('coinRulesResult');
    try {
        const data = await apiRequest('/admin/coin-rules/preview', 'POST',
            { values: collectCoinRules() });
        if (!data.success) {
            if (result) result.textContent = data.message || '試算失敗';
            return;
        }
        renderRulesPreview(data.preview);
        if (result) result.textContent = '這是試算結果，尚未儲存。';
    } catch (error) {
        if (result) result.textContent = '試算失敗：' + (error.message || '請稍後再試');
    }
}

async function saveCoinRules() {
    const result = document.getElementById('coinRulesResult');
    if (!confirm('確定儲存？這會影響之後每一次結算的發幣量（已結算的紀錄不會重算）。')) return;
    try {
        const data = await apiRequest('/admin/coin-rules', 'PUT',
            { values: collectCoinRules() });
        if (!data.success) {
            if (result) result.textContent = data.message || '儲存失敗';
            return;
        }
        coinRulesState = { values: data.values, defaults: data.defaults };
        renderCoinRules();
        renderRulesPreview(data.preview);
        if (result) result.textContent = data.message;
    } catch (error) {
        if (result) result.textContent = '儲存失敗：' + (error.message || '請稍後再試');
    }
}

async function resetCoinRules() {
    if (!confirm('還原成出廠預設值？目前的自訂參數會被清除。')) return;
    const result = document.getElementById('coinRulesResult');
    try {
        const data = await apiRequest('/admin/coin-rules', 'PUT', { values: {} });
        if (!data.success) {
            if (result) result.textContent = data.message || '還原失敗';
            return;
        }
        coinRulesState = { values: data.values, defaults: data.defaults };
        renderCoinRules();
        renderRulesPreview(data.preview);
        if (result) result.textContent = '已還原為出廠預設值。';
    } catch (error) {
        if (result) result.textContent = '還原失敗：' + (error.message || '請稍後再試');
    }
}

// 載入班級排行榜
async function loadClassRanking() {
    try {
        const data = await apiRequest('/leaderboard', 'GET');
        const tbody = document.getElementById('classRankingList');
        if (!tbody) return;

        if (!data.success) {
            tbody.innerHTML = `<tr><td colspan="3">載入失敗</td></tr>`;
            return;
        }

        const rows = data.leaderboard.map(student => `
            <tr>
                <td>${student.rank}</td>
                <td>${student.displayName}</td>
                <td>${student.score}</td>
            </tr>
        `).join('');

        tbody.innerHTML = rows;

        if (data.myRank) {
            tbody.innerHTML += `
                <tr class="my-rank-row">
                    <td>⭐</td>
                    <td>你</td>
                    <td>${data.myRank.rank} 名（${data.myRank.score}）</td>
                </tr>
            `;
        }
    } catch (error) {
        console.error('載入班級排行榜失敗:', error);
    }
}

function scrollToSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (section) {
        section.scrollIntoView({ behavior: 'smooth' });
    }
}

// 開始使用
async function startApp(){
    if (!currentUser) {
        alert('請先登入');
        return;
    }

    // 更新排行榜顯示使用者名字
    const displayName = currentUser.displayName || currentUser.email || '你';
    const rankUserCell = document.querySelector("#ranking tr:nth-child(4) td:nth-child(2)");
    if (rankUserCell) {
        rankUserCell.textContent = displayName;
    }

    // 隱藏登入區
    document.querySelector(".video").style.display = "none";

    // 依角色開啟該看的區塊（applyRoleView 會處理 hidden 與底部導覽）
    applyRoleView();

    // 載入最新資料
    await loadUserData();

    // 載入商城商品
    await loadShopItems();

    // 載入班級排行榜
    await loadClassRanking();

    // 載入全站大獎公告
    await loadLotteryAnnouncement();

    // 依角色載入該看的資料（教師檢查清單 / 午餐長紀錄 / 家長孩子狀況…）
    applyRoleView();
    await loadRoleData();
}

async function loadShopItems() {
    try {
        const data = await apiRequest('/exchange/items?limit=3', 'GET');
        const container = document.getElementById('shopList');
        if (!container) return;

        if (!data.success || !data.items || data.items.length === 0) {
            container.innerHTML = '<p>目前沒有可兌換的商品</p>';
            return;
        }

        const visibleItems = data.items.filter(item => item.costType !== 'G');

        container.innerHTML = visibleItems.map(item => {
            const coinName = { E: 'E幣', S: 'S幣' }[item.costType] || item.costType;
            const stockText = item.stock === null || item.stock === undefined
                ? '剩餘：無限'
                : `剩餘：${item.stock}`;

            return `
                <div class="gift">
                    <h3>${item.name}</h3>
                    <p>${item.description || ''}</p>
                    <p>需要：${item.cost} ${coinName}</p>
                    <p class="stock">${stockText}</p>
                    <button data-action="buyItem" data-item-id="${item.itemId}" data-cost-type="${item.costType}" data-name="${item.name}">兌換</button>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('載入商城失敗:', error);
        const container = document.getElementById('shopList');
        if (container) container.innerHTML = '<p>載入商城失敗</p>';
    }
}

async function buyItem(el){
    try {
        const itemId = el.dataset.itemId;
        const costType = el.dataset.costType;
        const name = el.dataset.name;

        const data = await apiRequest('/exchange/redeem', 'POST', { itemId });

        if (data.success) {
            if (data.remainingCoin !== undefined) {
                if (costType === 'E') {
                    eCoin = data.remainingCoin;
                } else if (costType === 'S') {
                    sCoin = data.remainingCoin;
                }
            }
            updateUI();
            await loadShopItems();
            alert("🎉 成功兌換：" + name);
        } else {
            alert(data.message || '兌換失敗');
        }
    } catch (error) {
        console.error('兌換失敗:', error);
        alert('兌換失敗，請稍後再試');
    }
}

function displaySurveyResult(favorite, hate) {
    const display = document.getElementById('surveyDisplay');
    if (!display) return;

    const today = new Date().toLocaleDateString('zh-TW');
    display.innerHTML = `
        <h3>📝 本次問卷結果（${today}）</h3>
        <p><strong>最喜歡：</strong> ${favorite}</p>
        <p><strong>最不喜歡：</strong> ${hate}</p>
    `;
}

async function submitSurvey(){
    try {
        let favorite = document.getElementById("favoriteFood").value;
        let hate = document.getElementById("hateFood").value;

        const data = await apiRequest('/task/submit-survey', 'POST', { favoriteFood: favorite, hateFood: hate });

        if (data.success) {
            displaySurveyResult(favorite, hate);
            alert(
                "✅ 問卷已送出！\n\n" +
                "最喜歡：" + favorite + "\n" +
                "最不喜歡：" + hate + "\n\n" +
                "⏰ 24小時後可再次送出"
            );
        } else {
            if (data.hoursRemaining) {
                alert(
                    "⏰ 尚未達到送出時間！\n\n" +
                    "距離下次送出還需 " + data.hoursRemaining + " 小時"
                );
            } else {
                alert(data.message || '問卷送出失敗');
            }
        }
    } catch (error) {
        console.error('提交問卷失敗:', error);
        alert('問卷送出失敗，請稍後再試');
    }
}
// 家長簽到
async function parentSignIn() {
    const result = document.getElementById('parentSignInResult');
    const btn = document.getElementById('parentSignInBtn');
    if (btn) { btn.disabled = true; btn.textContent = '簽到中...'; }
    try {
        const data = await apiRequest('/parent/sign-in', 'POST', {});
        if (result) {
            result.className = 'verify-result ' + (data.success ? 'ok' : 'error');
            result.textContent = (data.success ? '✅ ' : '⚠️ ') + (data.message || '');
        }
        if (btn) {
            btn.textContent = data.success ? '今天已簽到 ✅' : '今日簽到（孩子 +1 S幣）';
            btn.disabled = Boolean(data.success);
        }
        await loadChildStatus();
    } catch (error) {
        if (result) {
            result.className = 'verify-result error';
            result.textContent = '簽到失敗：' + (error.message || '請稍後再試');
        }
        if (btn) { btn.disabled = false; btn.textContent = '今日簽到（孩子 +1 S幣）'; }
    }
}

function skipIntro() {
    const intro = document.getElementById('introVideo');
    if (intro) {
        intro.classList.add('hidden');
        // 停止影片播放
        const iframe = intro.querySelector('iframe');
        if (iframe) {
            iframe.src = '';
        }
    }
    localStorage.setItem('lunchIntroSkipped', 'true');
}

function openLottery(){
    document.getElementById("lotteryModal").style.display = "block";
    document.getElementById("lotteryResult").innerHTML = "";
    const effectsDiv = document.getElementById("lotteryEffects");
    if (effectsDiv) effectsDiv.innerHTML = "";
}

function closeLottery(){
    document.getElementById("lotteryModal").style.display = "none";
    const effectsDiv = document.getElementById("lotteryEffects");
    if (effectsDiv) effectsDiv.innerHTML = "";
}

async function spinLottery(){
    if(eCoin < 10){
        alert("❌ E幣不足！需要 10 E幣進行抽獎");
        return;
    }

    const resultDiv = document.getElementById("lotteryResult");
    const effectsDiv = document.getElementById("lotteryEffects");
    resultDiv.innerHTML = "<div class='spinning'>🎰 抽獎中...</div>";
    if (effectsDiv) effectsDiv.innerHTML = "";

    try {
        const data = await apiRequest('/lottery/spin', 'POST');

        if (!data.success) {
            await loadUserData();
            alert(data.message || '❌ 抽獎失敗');
            resultDiv.innerHTML = '';
            return;
        }

        const prizeType = data.prize.type;
        const prize = data.prize.name;
        const prizeValue = data.prize.value;

        const typeLabel = prizeType === 'grand' ? '大獎' : prizeType === 'rare' ? '稀有獎' : '小獎';

        if (effectsDiv) effectsDiv.innerHTML = "";

        if (prizeType === 'small') {
            resultDiv.innerHTML = `
                <div class="prize-result" style="position: relative; padding-top: 60px;">
                    <div class="lottery-congrats" style="top: 0; color: #ff6b00;">🎉 恭喜中獎</div>
                    <div class="prize-name" style="margin-top: 20px;">${prize}</div>
                    <div class="prize-type">${typeLabel}</div>
                    <div class="prize-value">價值：${prizeValue} E幣</div>
                    <div class="prize-balance">E幣餘額：${data.remainingECoin}</div>
                </div>
            `;
        } else if (prizeType === 'rare') {
            if (effectsDiv) {
                effectsDiv.innerHTML = `
                    <div class="meteor" style="top: 0; right: 0; animation: meteorFall 1.2s ease-in forwards;"></div>
                    <div class="impact" style="bottom: 30px; right: 40px; animation-delay: 1.1s;"></div>
                `;
            }
            resultDiv.innerHTML = `
                <div class="prize-result">
                    <div class="prize-name">${prize}</div>
                    <div class="prize-type">${typeLabel}！</div>
                    <div class="prize-value">價值：${prizeValue} E幣</div>
                    <div class="prize-balance">E幣餘額：${data.remainingECoin}</div>
                </div>
            `;
        } else if (prizeType === 'grand') {
            if (effectsDiv) {
                effectsDiv.innerHTML = `
                    <div class="light-pillar" style="height: 0;"></div>
                    <div class="impact" style="top: 80%; left: 50%; transform: translateX(-50%); width: 120px; height: 120px; background: radial-gradient(circle, rgba(0,170,255,0.8) 0%, transparent 70%); animation: impactFlash 1.5s ease-out forwards;"></div>
                `;
            }
            resultDiv.innerHTML = `
                <div class="prize-result">
                    <div class="prize-name" style="font-size: 26px; color: #00aaff; text-shadow: 0 0 20px #00aaff;">${prize}</div>
                    <div class="prize-type" style="font-size: 20px;">✨ ${typeLabel} ✨</div>
                    <div class="prize-value">價值：${prizeValue} E幣</div>
                    <div class="prize-balance">E幣餘額：${data.remainingECoin}</div>
                </div>
            `;
            loadLotteryAnnouncement();
        }

        // 同步 E幣餘額（僅扣除抽獎成本，不返還獎品價值）
        eCoin = data.remainingECoin;
        updateUI();

    } catch (error) {
        console.error('抽獎失敗:', error);
        alert('❌ 抽獎失敗，請稍後再試');
        resultDiv.innerHTML = '';
    }
}

// 載入並顯示全站大獎公告
async function loadLotteryAnnouncement() {
    try {
        const data = await apiRequest('/lottery/announcement', 'GET');
        const banner = document.getElementById('globalAnnouncement');
        if (!banner || !data.success || !data.announcement) return;

        banner.innerHTML = `🎊 恭喜 <strong>${data.announcement.displayName}</strong> 抽到 <strong>${data.announcement.prizeName}</strong>！全站慶祝！ 🎊`;
        banner.classList.remove('hidden');
        banner.classList.add('global-announcement');
    } catch (error) {
        console.error('載入大獎公告失敗:', error);
    }
}

// 大獎特效 - 彩帶效果
function createConfetti(){
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
    for(let i = 0; i < 50; i++){
        const confetti = document.createElement('div');
        confetti.className = 'confetti';
        confetti.style.left = Math.random() * 100 + '%';
        confetti.style.top = '-10px';
        confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        confetti.style.animationDuration = (Math.random() * 2 + 2) + 's';
        document.querySelector('.lottery-content').appendChild(confetti);

        setTimeout(() => {
            confetti.remove();
        }, 4000);
    }
}

// ======================
// 事件綁定（取代 HTML 內聯 onclick，符合嚴格 CSP）
// ======================



// ============================================================
// 角色與頁面路由
// ============================================================

const ROLE_LABEL = {
    student: '學生',
    lunch_leader: '午餐長',
    parent: '家長',
    teacher: '老師',
    technician: '技術員',
    admin: '管理員'
};

/** 依角色顯示／隱藏底部導覽與各專區，避免出現點了沒權限的按鈕。 */
function applyRoleView() {
    const role = (currentUser && currentUser.role) || 'student';

    document.querySelectorAll('#bottomNav button[data-roles]').forEach((btn) => {
        const allowed = btn.dataset.roles.split(',');
        btn.classList.toggle('hidden', !allowed.includes(role));
    });

    // 各專區：只有對應角色看得到
    // 每個區塊由誰看得到。未登入時 currentUser 為 null，全部都會被關掉。
    const panels = [
        ['home', ['student', 'lunch_leader', 'teacher', 'admin']],
        ['ranking', ['student', 'lunch_leader', 'teacher', 'admin']],
        ['trend', ['student', 'lunch_leader', 'teacher', 'admin']],
        ['shop', ['student', 'admin']],
        ['survey', ['student', 'lunch_leader', 'admin']],
        ['leader', ['lunch_leader', 'admin']],
        ['teacher', ['teacher', 'admin']],
        ['adminZone', ['admin']],
        ['parentZone', ['parent']],
        ['techZone', ['technician', 'admin']],
        ['supportTaskCard', ['student', 'lunch_leader', 'teacher', 'admin']]
    ];
    const signedIn = Boolean(currentUser);
    panels.forEach(([id, allowed]) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !signedIn || !allowed.includes(role));
    });

    // 底部導覽只在登入後出現（原本綁在 scroll 事件上，平時整條藏在畫面外）
    const nav = document.getElementById('bottomNav');
    if (nav) nav.classList.toggle('visible', signedIn);

    // 兌換與抽獎只有學生能用（午餐長只累積不消耗）。
    // 注意：問卷區塊在 HTML 上巢狀於 #shop 內，所以不能整段隱藏 #shop，
    // 只收起「兌換清單」與「抽獎入口」這兩個真正會消耗幣的入口。
    const canSpend = ['student', 'admin'].includes(role);
    const shopList = document.getElementById('shopList');
    const lotteryBtn = document.querySelector('.lottery-btn');
    if (shopList) shopList.classList.toggle('hidden', !canSpend);
    if (lotteryBtn) lotteryBtn.classList.toggle('hidden', !canSpend);

    const shopHeader = document.querySelector('.shop-header h2');
    if (shopHeader) {
        shopHeader.textContent = canSpend ? '🎁 獎勵兌換商城' : '🎁 獎勵兌換商城（午餐長不開放）';
    }

    const roleTag = document.getElementById('userRoleTag');
    if (roleTag) roleTag.textContent = ROLE_LABEL[role] || role;

    applyRoleOrder(role);
    if (!signedIn) stopSupportPolling();     // 登出後不該繼續打 API
}

// ============================================================
// 角色化區塊排序
// ============================================================
//
// 原本所有角色看到的順序都一樣（首頁→排行→趨勢→兌換→問卷→紀錄→…），
// 但不同身分的高頻操作差很多：
//   · 午餐長幾乎只做「紀錄」，卻要捲過四個區塊才看得到
//   · 家長只做「簽到」
//   · 學生才是真的以首頁與兌換為主
// 把最常用的排在最前面，少一次捲動就少一次摩擦。
//
// 這裡直接搬 DOM 節點而不是用 CSS order：
// 一來 #app 不是 flex 容器，二來搬節點連鍵盤 Tab 順序與螢幕閱讀器
// 的閱讀順序一起修正，純視覺的 order 做不到這件事。

const ROLE_PANEL_ORDER = {
    // 午餐長：紀錄 →（紀錄完最常接著找別班補菜）支援 → 其餘
    lunch_leader: ['leader', 'supportTaskCard', 'home', 'ranking', 'trend', 'survey'],
    // 老師：逐生檢查是每天的固定動作
    teacher: ['teacher', 'home', 'supportTaskCard', 'ranking', 'trend'],
    // 學生：看自己的幣與午餐狀況，然後才是兌換
    student: ['home', 'supportTaskCard', 'shop', 'ranking', 'trend', 'survey'],
    parent: ['parentZone'],
    technician: ['techZone'],
    admin: ['adminZone', 'leader', 'teacher', 'supportTaskCard', 'techZone',
            'home', 'ranking', 'trend', 'shop', 'survey'],
};

/** 底部導覽也跟著同一套優先順序，避免畫面順序與導覽順序不一致。 */
function applyNavOrder(order) {
    const nav = document.getElementById('bottomNav');
    if (!nav) return;
    const rank = new Map(order.map((id, i) => [id, i]));
    Array.from(nav.querySelectorAll('button[data-arg]'))
        .sort((a, b) => (rank.has(a.dataset.arg) ? rank.get(a.dataset.arg) : 99)
                      - (rank.has(b.dataset.arg) ? rank.get(b.dataset.arg) : 99))
        .forEach((btn) => nav.appendChild(btn));
}

function applyRoleOrder(role) {
    const order = ROLE_PANEL_ORDER[role];
    if (!order) return;
    const app = document.getElementById('app');
    const anchor = document.getElementById('globalAnnouncement');
    if (!app || !anchor) return;

    // 依序插到公告區塊之前：公告與抽獎彈窗是 fixed/modal，位置無所謂，
    // 但保持它們在最後可以避免每次重排都動到它們。
    order.forEach((id) => {
        const el = document.getElementById(id);
        if (el && el.parentElement === app) app.insertBefore(el, anchor);
    });
    applyNavOrder(order);
}

/** 依角色載入該看的資料。 */
async function loadRoleData() {
    const role = (currentUser && currentUser.role) || 'student';

    if (role === 'parent') {
        await loadChildStatus();
        return;
    }
    if (role === 'technician') {
        await loadDevices();
        return;   // 技術員只管硬體，不載入學生相關資料
    }
    if (role === 'admin') {
        await loadAdminOverview();
        await loadAdminClasses();
        await loadDevices();
        await loadCoinRules();
    }
    if (role === 'teacher' || role === 'admin') {
        await loadCheckRoster();
    }
    if (role === 'lunch_leader' || role === 'admin') {
        await loadRecordToday();
    }
    if (role === 'student' || role === 'lunch_leader') {
        await loadMyMealStatus();
    }
    await loadSupportDishes();
    if (role !== 'parent') {
        await loadHeroBoard();
        await loadTrend();
    }
}

// ============================================================
// 學生：今日午餐狀況（唯讀，吃完由老師確認）
// ============================================================

async function loadMyMealStatus() {
    const box = document.getElementById('myMealStatus');
    if (!box) return;
    try {
        const data = await apiRequest('/meal-check/mine?range=week', 'GET');
        if (!data.success) {
            box.innerHTML = '<p>無法載入用餐紀錄</p>';
            return;
        }
        const todayStr = new Date().toLocaleDateString('sv');
        const todayRow = (data.records || []).find((r) => r.date === todayStr);
        const state = !todayRow
            ? '<span class="status-pending">⏳ 老師尚未確認</span>'
            : todayRow.finished
                ? '<span class="status-ok">✅ 今天吃完了，已獲得 E幣 +1、S幣 +1</span>'
                : '<span class="status-warn">⚠️ 今天記錄為沒吃完</span>';

        box.innerHTML = `
            <p>${state}</p>
            <p class="field-hint">近 ${data.stats.days} 天吃完 ${data.stats.finishedDays} 天（${data.stats.rate}%）</p>
        `;
    } catch (error) {
        box.innerHTML = '<p>無法載入用餐紀錄</p>';
    }
}

// ============================================================
// 老師：每日逐生檢查「吃完他的部分」
// ============================================================

async function loadCheckRoster() {
    const list = document.getElementById('checkRoster');
    const summaryBox = document.getElementById('checkSummary');
    if (!list) return;
    list.innerHTML = '<p>載入中...</p>';
    try {
        const data = await apiRequest('/meal-check/roster', 'GET');
        if (!data.success) {
            list.innerHTML = `<p>${data.message || '載入失敗'}</p>`;
            return;
        }
        renderCheckSummary(data.summary, data.className, data.date);

        if (!data.rows.length) {
            list.innerHTML = '<p>這個班級還沒有學生註冊</p>';
            return;
        }
        list.innerHTML = data.rows.map((r) => `
            <div class="check-row ${r.finished ? 'done' : ''}">
                <span class="check-seat">${r.seatNo || '--'}</span>
                <span class="check-name">${r.displayName}${r.role === 'lunch_leader' ? '（午餐長）' : ''}</span>
                <button data-action="toggleCheck"
                        data-student-id="${r.studentId}"
                        data-finished="${r.finished ? 'false' : 'true'}"
                        class="${r.finished ? 'check-btn done' : 'check-btn'}">
                    ${r.finished ? '✅ 已吃完' : '勾選吃完'}
                </button>
            </div>
        `).join('');
        if (summaryBox) summaryBox.dataset.className = data.className || '';
    } catch (error) {
        list.innerHTML = '<p>載入失敗，請稍後再試</p>';
    }
}

function renderCheckSummary(summary, className, date) {
    const box = document.getElementById('checkSummary');
    if (!box || !summary) return;
    box.innerHTML = `
        <p><strong>${className || ''} 班</strong>　${date || ''}</p>
        <p>已吃完 <strong>${summary.finished}</strong> / ${summary.total} 人
           （完成率 ${summary.finishedRate}%）　未勾選 ${summary.unchecked} 人</p>
    `;
}

async function toggleCheck(el) {
    const studentId = el.dataset.studentId;
    const finished = el.dataset.finished === 'true';
    el.disabled = true;
    try {
        const data = await apiRequest('/meal-check/toggle', 'POST', { studentId, finished });
        if (!data.success) {
            alert(data.message || '勾選失敗');
            return;
        }
        renderCheckSummary(data.summary);
        await loadCheckRoster();
    } catch (error) {
        alert('勾選失敗：' + (error.message || '請稍後再試'));
    } finally {
        el.disabled = false;
    }
}

async function finishAllChecks() {
    if (!confirm('確定把全班都標記為吃完？（已勾選的不會重複發幣）')) return;
    try {
        const data = await apiRequest('/meal-check/finish-all', 'POST', {});
        if (!data.success) {
            alert(data.message || '操作失敗');
            return;
        }
        alert(data.message);
        await loadCheckRoster();
    } catch (error) {
        alert('操作失敗：' + (error.message || '請稍後再試'));
    }
}

// ============================================================
// 午餐長：四桶剩食紀錄（拍照 → 辨識 → 確認 → 完成）
// ============================================================

let recordSession = null;

async function loadRecordToday() {
    const statusBox = document.getElementById('recordStatus');
    const startBtn = document.getElementById('startRecordBtn');
    if (!statusBox) return;

    // 辨識服務狀態：讓午餐長知道這次是真辨識還是預設估算
    try {
        const vs = await apiRequest('/record/vision-status', 'GET');
        const el = document.getElementById('recordVisionStatus');
        if (el) {
            const ok = vs.enabled && vs.ok;
            el.className = 'verify-result ' + (ok ? 'ok' : 'error');
            el.textContent = ok
                ? '✅ 影像辨識服務已連線' + (vs.calibrated ? '' : '（未載入磅秤校正，克數僅供粗估）')
                : '⚠️ ' + (vs.note || '辨識服務未啟動，將以預設估算代替');
        }
    } catch (error) { /* 狀態顯示失敗不影響紀錄流程 */ }

    try {
        const data = await apiRequest('/record/today', 'GET');
        if (data.status === 'none') {
            recordSession = null;
            statusBox.innerHTML = `<p>${data.message || '今日尚未開始紀錄'}</p>`;
            if (startBtn) startBtn.classList.toggle('hidden', !data.menuReady);
            document.getElementById('recordBuckets').innerHTML = '';
            document.getElementById('recordSummary').innerHTML = '';
            return;
        }
        recordSession = data.session;
        if (startBtn) startBtn.classList.add('hidden');
        statusBox.innerHTML = `<p>${recordSession.date}　供餐 ${recordSession.servings} 份　狀態：${recordSession.status === 'done' ? '已完成' : '進行中'}</p>`;
        renderRecordBuckets();
        renderRecordSummary();
    } catch (error) {
        statusBox.innerHTML = '<p>無法載入今日紀錄</p>';
    }
}

async function startRecord() {
    try {
        const data = await apiRequest('/record/start', 'POST', {});
        if (!data.success) {
            alert(data.message || '無法開始紀錄');
            return;
        }
        await loadRecordToday();
    } catch (error) {
        alert('無法開始紀錄：' + (error.message || '請稍後再試'));
    }
}

function renderRecordBuckets() {
    const box = document.getElementById('recordBuckets');
    if (!box || !recordSession) return;

    box.innerHTML = recordSession.buckets.map((b) => `
        <div class="bucket-card ${b.measured ? 'measured' : ''}">
            <h3>${b.label} ${b.measured ? (b.emptied ? '（已清空）' : '✅') : ''}</h3>
            ${b.measured && !b.emptied ? `<p class="field-hint">來源：${b.source === 'vision' ? '影像辨識' : b.source === 'manual' ? '人工輸入' : '預設估算'}　整桶信心 ${Math.round((b.bucketConfidence || 0) * 100)}%</p>` : ''}
            ${(b.warnings || []).map((w) => `<p class="bucket-warning">· ${w}</p>`).join('')}
            <div class="bucket-actions">
                <button data-action="captureBucket" data-bucket-id="${b.bucketId}">📷 ${b.measured ? '重拍' : '拍照辨識'}</button>
                <button data-action="markEmptied" data-bucket-id="${b.bucketId}" class="secondary-btn">此桶已清空</button>
            </div>
            ${b.measured && !b.emptied ? b.items.map((it) => `
                <div class="dish-row ${it.needsReview ? 'needs-review' : ''}">
                    <span class="dish-name">${it.dishName}${it.needsReview ? ' <small>需確認</small>' : ''}</span>
                    <input type="range" min="0" max="100" value="${Math.round(it.remainingRatio * 100)}"
                           data-bucket-id="${b.bucketId}" data-slot="${it.slot}" class="ratio-slider">
                    <span class="dish-value">剩 ${Math.round(it.remainingRatio * 100)}%　${Math.round(it.leftoverG)}g</span>
                </div>
            `).join('') : ''}
        </div>
    `).join('');

    const allMeasured = recordSession.buckets.every((b) => b.measured || b.emptied);
    box.innerHTML += allMeasured
        ? '<button data-action="finalizeRecord" class="auth-btn">完成今日紀錄並結算</button>'
        : '<p class="field-hint">四桶都辨識完才能結算。</p>';
}

function renderRecordSummary() {
    const box = document.getElementById('recordSummary');
    if (!box || !recordSession) return;
    const s = recordSession.summary;
    const r = recordSession.reduction;
    if (!s) { box.innerHTML = ''; return; }
    box.innerHTML = `
        <div class="record-summary">
            <p>今日彙總：廚餘 <strong>${Math.round(s.totalG)}</strong> g　耗損 <strong>${s.totalCost}</strong> 元　碳排 <strong>${s.totalCo2e}</strong> kgCO₂e</p>
            ${r ? `<p>減碳 <strong>${r.reducedCo2e}</strong> kgCO₂e → 班級幣已分給全班每位同學</p>` : ''}
        </div>
    `;
}

/** 壓縮後上傳，校園網路友善（長邊 1600px、JPEG 85%）。 */
function downscaleImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.85));
            };
            img.onerror = () => reject(new Error('影像讀取失敗'));
            img.src = reader.result;
        };
        reader.onerror = () => reject(new Error('檔案讀取失敗'));
        reader.readAsDataURL(file);
    });
}

function captureBucket(el) {
    const bucketId = el.dataset.bucketId;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        el.disabled = true;
        el.textContent = '辨識中...';
        try {
            const image = await downscaleImage(file);
            const data = await apiRequest(`/record/bucket/${bucketId}/measure`, 'POST', { image });
            if (!data.success) {
                alert(data.message || '辨識失敗');
                return;
            }
            if ((data.warnings || []).length) alert(data.warnings.join('\n'));
            await loadRecordToday();
            await refreshSupportAfterRecord();
        } catch (error) {
            alert('辨識失敗：' + (error.message || '請稍後再試'));
        } finally {
            el.disabled = false;
        }
    });
    input.click();
}

async function markEmptied(el) {
    const bucketId = el.dataset.bucketId;
    try {
        const data = await apiRequest(`/record/bucket/${bucketId}/measure`, 'POST', { emptied: true });
        if (!data.success) {
            alert(data.message || '操作失敗');
            return;
        }
        await loadRecordToday();
        await refreshSupportAfterRecord();
    } catch (error) {
        alert('操作失敗：' + (error.message || '請稍後再試'));
    }
}


/**
 * 紀錄動作之後刷新跨班支援。
 *
 * 午餐長剛把某道菜改成「剩 5%」的當下，最可能的下一個念頭就是
 * 「別班還有嗎、去哪裡補」。原本要等到「完成今日紀錄」才會重查，
 * 中間所有量測與微調都不會更新這張卡片，等於看的是舊資料。
 *
 * 若這次刷新**新出現**了缺貨，就把卡片帶到眼前並高亮一次；
 * 已經知道缺貨的則只靜默更新，不反覆打斷操作。
 */
async function refreshSupportAfterRecord() {
    const before = supportState.hasShortage;
    await loadSupportDishes({ silent: true });
    if (!supportState.hasShortage || before) return;

    const card = document.getElementById('supportTaskCard');
    if (!card || card.classList.contains('hidden')) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('just-updated');
    setTimeout(() => card.classList.remove('just-updated'), 2400);
}

/** 滑桿微調殘餘比例（放手才送出，避免每動一格就打一次 API）。 */
async function submitRatio(bucketId, slot, pct) {
    try {
        const data = await apiRequest(`/record/bucket/${bucketId}`, 'PATCH', {
            ratios: { [slot]: pct / 100 }
        });
        if (data.success) {
            recordSession = null;
            await loadRecordToday();
            await refreshSupportAfterRecord();
        }
    } catch (error) {
        console.error('微調失敗:', error);
    }
}

async function finalizeRecord() {
    if (!confirm('確定完成今日紀錄？完成後會計算減碳量並發放班級幣。')) return;
    try {
        const data = await apiRequest('/record/finalize', 'POST', {});
        if (!data.success) {
            alert(data.message || '結算失敗');
            return;
        }
        // 只丟兩個幣數看不出所以然，把「吃了多少」與「少浪費多少」攤開講
        const n = (data.nutrition && data.nutrition.perCapita) || {};
        const sdg = data.sdg || {};
        const sb = data.schoolBaseline || {};
        const baseNote = sb.source === 'history'
            ? `近 ${sb.samples} 場平均`
            : '起步基準（全校樣本還不夠）';
        alert(
            `${data.message}\n\n`
            + `【吃了什麼】人均吃下 ${n.eatenG || 0} g\n`
            + `  蛋白質 ${n.proteinG || 0} g、膳食纖維 ${n.fiberG || 0} g\n`
            + `  → E幣 +${data.classCoins.E}\n\n`
            + `【少浪費多少】本班人均廚餘 ${data.wastePerCapitaG || 0} g\n`
            + `  全校基準 ${sb.perCapitaG || 0} g（${baseNote}）\n`
            + `  少浪費 ${sdg.savedPerCapitaG || 0} g/人，減碳 ${sdg.co2ClassKg || 0} kgCO₂e\n`
            + `  → 相當於 ${formatTrees(sdg.treesClass)} 棵樹，S幣 +${data.classCoins.S}\n\n`
            + `已分給 ${data.sharedTo} 位同學`
        );
        await loadRecordToday();
        await loadUserData();
        await loadSupportDishes();
        await loadHeroBoard();
    } catch (error) {
        alert('結算失敗：' + (error.message || '請稍後再試'));
    }
}


// ============================================================
// 跨班支援：資料新鮮度與條件式輪詢
// ============================================================
//
// 跨班資料的本質是「別班此刻還剩多少」，而別班是**陸續**記錄的——
// 本班 12:10 記錄完時別班可能還沒開始。因此一次性載入必然會過期，
// 使用者卻看不出手上這份是什麼時候的，容易誤判「大家都沒了」。
//
// 但也不該無條件輪詢：本班沒有任何一道菜缺貨時，別班剩多少與我無關，
// 後端根本不會去查（見 supportController 的門檻設計）。
// 所以只在**真的有缺貨**時才輪詢，並且分頁切走就停。

const SUPPORT_POLL_MS = 30000;        // 午餐時段 30 秒一次，足夠即時又不擾民
let supportPollTimer = null;
let supportState = { hasShortage: false, awaitingHelp: 0, generatedAt: 0, loading: false };

function startSupportPolling() {
    if (supportPollTimer || document.hidden) return;
    supportPollTimer = setInterval(() => {
        if (document.hidden) return;      // 保險：分頁隱藏時不打 API
        loadSupportDishes({ silent: true });
    }, SUPPORT_POLL_MS);
}

function stopSupportPolling() {
    if (!supportPollTimer) return;
    clearInterval(supportPollTimer);
    supportPollTimer = null;
}

/** 依目前是否缺貨決定要不要繼續輪詢。 */
function syncSupportPolling() {
    if (supportState.hasShortage && currentUser) startSupportPolling();
    else stopSupportPolling();
}

// 分頁切回來時立刻補一次：使用者離開這段期間別班可能已經記錄了，
// 等下一次 30 秒週期才更新會讓他看到明顯過期的數字。
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopSupportPolling();
    } else if (supportState.hasShortage && currentUser) {
        loadSupportDishes({ silent: true });
        startSupportPolling();
    }
});

/** 把「幾分鐘前」講成人話；資料新鮮度要一眼看得懂。 */
function freshnessText(ts) {
    if (!ts) return '';
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 45) return '剛剛更新';
    if (sec < 3600) return `${Math.round(sec / 60)} 分鐘前更新`;
    return `${Math.round(sec / 3600)} 小時前更新`;
}

// ============================================================
// 跨班菜品剩餘量（本班某道菜不足時才顯示其他班）
// ============================================================

/**
 * 載入本班各菜品剩餘量（缺貨的會附上其他班狀況）。
 * @param {{silent?:boolean}} opts silent = 輪詢觸發，不要顯示「載入中」閃爍
 */
async function loadSupportDishes(opts) {
    const box = document.getElementById('supportDishList');
    if (!box) return;
    const silent = Boolean(opts && opts.silent === true);
    if (supportState.loading) return;          // 避免輪詢與手動點擊疊在一起
    supportState.loading = true;
    if (!silent) box.setAttribute('aria-busy', 'true');
    try {
        const data = await apiRequest('/support/dishes', 'GET');
        if (!data.success) {
            box.innerHTML = `<p>${data.message || '載入失敗'}</p>`;
            supportState.hasShortage = false;
            syncSupportPolling();
            return;
        }

        supportState.generatedAt = data.generatedAt || Date.now();
        const summary = data.summary || {};
        supportState.hasShortage = Number(summary.shortages || 0) > 0;
        supportState.awaitingHelp = Number(summary.awaitingHelp || 0);

        if (!data.dishes.length) {
            box.innerHTML = `<p>${data.message || '今天還沒有紀錄'}</p>`;
            renderSupportMeta();
            syncSupportPolling();
            return;
        }

        box.innerHTML = data.dishes.map((d) => `
            <div class="dish-status ${d.shortage ? 'shortage' : ''}">
                <div class="dish-status-head">
                    <span>${d.dishName}</span>
                    <span>剩 ${d.remainingPct}%（${d.leftoverG}g）</span>
                </div>
                <div class="dish-bar"><div class="dish-bar-fill" style="width:${Math.min(100, d.remainingPct)}%"></div></div>
                ${d.shortage ? (
                    (d.otherClasses && d.otherClasses.length)
                        ? `<p class="dish-help">🤝 這些班還有：${d.otherClasses.map((o) =>
                              // 對方也低於門檻時要講明，免得白跑一趟
                              `${o.className} 班 ${o.leftoverG}g${o.shortage ? '<span class="offer-warn">（他們也快沒了）</span>' : ''}`
                          ).join('、')}</p>`
                        : '<p class="field-hint">本班快吃完了，目前其他班也沒有剩——其他班陸續記錄後這裡會自動更新。</p>'
                ) : ''}
            </div>
        `).join('');
        renderSupportMeta();
        syncSupportPolling();
    } catch (error) {
        box.innerHTML = '<p>載入失敗</p>';
    } finally {
        supportState.loading = false;
        box.removeAttribute('aria-busy');
    }
}

/** 在卡片上顯示資料截至時間與輪詢狀態。 */
function renderSupportMeta() {
    const meta = document.getElementById('supportMeta');
    if (!meta) return;
    const parts = [freshnessText(supportState.generatedAt)];
    if (supportState.hasShortage) {
        parts.push(supportState.awaitingHelp > 0
            ? '正在等其他班記錄，每 30 秒自動更新'
            : '每 30 秒自動更新');
    }
    meta.textContent = parts.filter(Boolean).join('　·　');
}

// ============================================================
// 家長：簽到與孩子午餐狀況
// ============================================================

async function loadChildStatus() {
    const box = document.getElementById('childStatus');
    if (!box) return;
    try {
        const data = await apiRequest('/parent/child-status', 'GET');
        if (!data.success) {
            box.innerHTML = `<p>${data.message || '無法載入孩子資料'}</p>`;
            return;
        }
        const c = data.child;
        const state = data.todayFinished === null
            ? '<span class="status-pending">⏳ 老師今天還沒確認</span>'
            : data.todayFinished
                ? '<span class="status-ok">✅ 今天吃完了</span>'
                : '<span class="status-warn">⚠️ 今天沒有吃完</span>';

        box.innerHTML = `
            <p><strong>${c.displayName}</strong>　${c.grade} 年 ${c.className} 班 ${c.seatNo} 號</p>
            <p>${state}</p>
            <p>孩子目前 E幣 ${c.coins.E}、S幣 ${c.coins.S}</p>
            <p class="field-hint">近 ${data.stats.range}：有紀錄 ${data.stats.recordedDays} 天，吃完 ${data.stats.finishedDays} 天（${data.stats.finishedRate}%）</p>
            ${data.classDishesToday.length ? `<p class="field-hint">今天全班剩餘：${data.classDishesToday.map((d) => `${d.dishName} ${d.remainingPct}%`).join('、')}</p>` : ''}
        `;
        const btn = document.getElementById('parentSignInBtn');
        if (btn && data.signedInToday) {
            btn.disabled = true;
            btn.textContent = '今天已簽到 ✅';
        }
    } catch (error) {
        box.innerHTML = '<p>無法載入孩子資料</p>';
    }
}


// ============================================================
// 管理員 / 開發者：手動維護班級與帳號
// ============================================================

/** 依角色顯示班級與座號欄位（管理員帳號不需班級、老師不需座號）。 */
function syncAdminUserFields() {
    const role = (document.getElementById('adminUserRole') || {}).value || 'student';
    const classFields = document.getElementById('adminUserClassFields');
    const seatGroup = document.getElementById('adminUserSeatGroup');
    if (classFields) classFields.classList.toggle('hidden', role === 'admin');
    if (seatGroup) seatGroup.classList.toggle('hidden', !['student', 'lunch_leader'].includes(role));
}

async function loadAdminOverview() {
    const box = document.getElementById('adminOverview');
    if (!box) return;
    try {
        const data = await apiRequest('/admin/overview', 'GET');
        if (!data.success) { box.textContent = data.message || '載入失敗'; return; }
        const roles = Object.entries(data.usersByRole || {})
            .map(([r, n]) => `${ROLE_LABEL[r] || r} ${n}`).join('　');
        box.innerHTML = `
            <p><strong>${data.date}</strong>　班級 ${data.classes} 個　帳號 ${data.users} 個</p>
            <p>${roles}</p>
            <p>今日已紀錄 ${data.todaySessions.length} 班　吃完勾選 ${data.todayChecks.finished}/${data.todayChecks.total}</p>
        `;
    } catch (error) {
        box.textContent = '載入總覽失敗';
    }
}

async function createClass() {
    const result = document.getElementById('adminClassResult');
    const payload = {
        grade: (document.getElementById('adminClassGrade').value || '').trim(),
        name: (document.getElementById('adminClassName').value || '').trim(),
        headcount: Number(document.getElementById('adminClassHeadcount').value)
    };
    if (!payload.grade || !payload.name || !payload.headcount) {
        result.className = 'verify-result error';
        result.textContent = '請填寫年級、班級名稱與人數';
        return;
    }
    try {
        const data = await apiRequest('/admin/classes', 'POST', payload);
        result.className = 'verify-result ' + (data.success ? 'ok' : 'error');
        result.textContent = (data.success ? '✅ ' : '⚠️ ') + (data.message || '');
        if (data.success) {
            document.getElementById('adminClassGrade').value = '';
            document.getElementById('adminClassName').value = '';
            document.getElementById('adminClassHeadcount').value = '';
            await loadAdminClasses();
            await loadAdminOverview();
        }
    } catch (error) {
        result.className = 'verify-result error';
        result.textContent = '建立失敗：' + (error.message || '請稍後再試');
    }
}

async function createUserByAdmin() {
    const result = document.getElementById('adminUserResult');
    const role = document.getElementById('adminUserRole').value;
    const payload = {
        role,
        account: (document.getElementById('adminUserAccount').value || '').trim(),
        displayName: (document.getElementById('adminUserName').value || '').trim(),
        password: document.getElementById('adminUserPassword').value || '',
        grade: (document.getElementById('adminUserGrade').value || '').trim(),
        className: (document.getElementById('adminUserClassName').value || '').trim(),
        seatNo: (document.getElementById('adminUserSeat').value || '').trim()
    };
    if (!payload.account || !payload.displayName || !payload.password) {
        result.className = 'verify-result error';
        result.textContent = '請填寫帳號、姓名與密碼';
        return;
    }
    try {
        const data = await apiRequest('/admin/users', 'POST', payload);
        result.className = 'verify-result ' + (data.success ? 'ok' : 'error');
        result.textContent = (data.success ? '✅ ' : '⚠️ ') + (data.message || '');
        if (data.success) {
            ['adminUserAccount', 'adminUserName', 'adminUserPassword', 'adminUserSeat']
                .forEach((id) => { document.getElementById(id).value = ''; });
            await loadAdminUsers();
            await loadAdminOverview();
        }
    } catch (error) {
        result.className = 'verify-result error';
        result.textContent = '建立失敗：' + (error.message || '請稍後再試');
    }
}

async function loadAdminClasses() {
    const box = document.getElementById('adminClassList');
    if (!box) return;
    box.innerHTML = '<p>載入中...</p>';
    try {
        const data = await apiRequest('/admin/classes', 'GET');
        if (!data.success) { box.innerHTML = `<p>${data.message || '載入失敗'}</p>`; return; }
        if (!data.classes.length) { box.innerHTML = '<p>還沒有任何班級，請先新增。</p>'; return; }

        box.innerHTML = data.classes.map((c) => `
            <div class="admin-row">
                <div class="admin-row-main">
                    <strong>${c.grade} 年 ${c.name} 班</strong>
                    <span class="field-hint">人數 ${c.headcount}　已註冊 ${c.registered}　班級幣 E${c.classCoins.E}/S${c.classCoins.S}</span>
                    <span class="field-hint">導師：${c.teacher ? c.teacher.displayName : '未指定'}　午餐長：${c.lunchLeader ? c.lunchLeader.displayName : '未指定'}</span>
                </div>
                <div class="admin-row-actions">
                    <input type="text" placeholder="帳號" data-role="leader-account" data-class-id="${c.classId}" class="inline-input">
                    <button data-action="setLunchLeader" data-class-id="${c.classId}" class="check-btn">設為午餐長</button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        box.innerHTML = '<p>載入失敗</p>';
    }
}

async function setLunchLeader(el) {
    const classId = el.dataset.classId;
    const input = document.querySelector(`input[data-role="leader-account"][data-class-id="${classId}"]`);
    const account = input ? input.value.trim() : '';
    if (!account) { alert('請先填入要指派的學生帳號'); return; }
    try {
        const data = await apiRequest(`/admin/classes/${classId}/lunch-leader`, 'POST', { account });
        alert((data.success ? '✅ ' : '⚠️ ') + (data.message || ''));
        if (data.success) await loadAdminClasses();
    } catch (error) {
        alert('指派失敗：' + (error.message || '請稍後再試'));
    }
}

async function loadAdminUsers() {
    const box = document.getElementById('adminUserList');
    if (!box) return;
    const role = (document.getElementById('adminUserFilter') || {}).value || '';
    box.innerHTML = '<p>載入中...</p>';
    try {
        const data = await apiRequest('/admin/users' + (role ? `?role=${role}` : ''), 'GET');
        if (!data.success) { box.innerHTML = `<p>${data.message || '載入失敗'}</p>`; return; }
        if (!data.users.length) { box.innerHTML = '<p>沒有符合的帳號</p>'; return; }

        box.innerHTML = `<p class="field-hint">共 ${data.total} 個帳號</p>` + data.users.map((u) => `
            <div class="admin-row ${u.isActive ? '' : 'inactive'}">
                <div class="admin-row-main">
                    <strong>${u.displayName}</strong>
                    <span class="field-hint">${ROLE_LABEL[u.role] || u.role}　${u.account || u.email || ''}
                        ${u.className ? `　${u.grade}年${u.className}班 ${u.seatNo || ''}號` : ''}
                        ${u.coins ? `　E${u.coins.E}/S${u.coins.S}` : ''}
                        ${u.isActive ? '' : '　（已停用）'}</span>
                </div>
                <div class="admin-row-actions">
                    <button data-action="toggleUserActive" data-user-id="${u.userId}" data-active="${u.isActive ? 'false' : 'true'}" class="check-btn">
                        ${u.isActive ? '停用' : '啟用'}
                    </button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        box.innerHTML = '<p>載入失敗</p>';
    }
}

async function toggleUserActive(el) {
    const userId = el.dataset.userId;
    const isActive = el.dataset.active === 'true';
    if (!confirm(isActive ? '確定啟用這個帳號？' : '確定停用這個帳號？停用後無法登入。')) return;
    try {
        const data = await apiRequest(`/admin/users/${userId}`, 'PATCH', { isActive });
        if (!data.success) { alert(data.message || '操作失敗'); return; }
        await loadAdminUsers();
    } catch (error) {
        alert('操作失敗：' + (error.message || '請稍後再試'));
    }
}


/** 密碼欄位顯示/隱藏切換。 */
function togglePassword(el) {
    const input = document.getElementById(el.dataset.target);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el.textContent = show ? '🙈' : '👁';
    el.setAttribute('aria-label', show ? '隱藏密碼' : '顯示密碼');
}

// ============================================================
// 剩餘量變化（取代原本沒有資料來源的長條圖）
// ============================================================

async function loadTrend(el) {
    const scope = (el && el.dataset.scope) || 'class';
    const range = (el && el.dataset.range) || 'week';
    const box = document.getElementById('trendChart');
    const stats = document.getElementById('trendStats');
    if (!box) return;
    box.innerHTML = '<p>載入中...</p>';
    try {
        const data = await apiRequest(`/stats/leftover-trend?scope=${scope}&range=${range}`, 'GET');
        if (!data.success) {
            box.innerHTML = `<p>${data.message || '載入失敗'}</p>`;
            if (stats) stats.textContent = '';
            return;
        }
        renderTrendChart(data);
    } catch (error) {
        box.innerHTML = '<p>載入失敗</p>';
    }
}

function renderTrendChart(data) {
    const box = document.getElementById('trendChart');
    const stats = document.getElementById('trendStats');
    const points = data.points || [];
    const measured = points.filter((p) => p.leftoverG !== null);

    if (!measured.length) {
        box.innerHTML = '<p>這段期間還沒有量測紀錄</p>';
        if (stats) stats.textContent = '';
        return;
    }

    const max = Math.max.apply(null, measured.map((p) => p.leftoverG)) || 1;
    box.innerHTML = '<div class="trend-bars">' + points.map((p) => {
        const label = p.date.slice(5).replace('-', '/');
        if (p.leftoverG === null) {
            // 沒量測 ≠ 剩 0，畫成虛線佔位才不會誤導
            return `<div class="trend-col"><div class="trend-bar none" title="沒有量測"></div>
                    <span class="trend-x">${label}</span></div>`;
        }
        const h = Math.max(4, Math.round((p.leftoverG / max) * 100));
        return `<div class="trend-col">
                    <span class="trend-v">${Math.round(p.leftoverG)}</span>
                    <div class="trend-bar" style="height:${h}%" title="${p.remainingPct}%"></div>
                    <span class="trend-x">${label}</span>
                </div>`;
    }).join('') + '</div>';

    if (stats) {
        stats.textContent = `量測 ${data.stats.measuredDays} 天　平均 ${data.stats.avgLeftoverG} g`
            + (data.stats.bestDay ? `　最少：${data.stats.bestDay}` : '')
            + (data.stats.worstDay ? `　最多：${data.stats.worstDay}` : '');
    }
}


// ============================================================
// 技術員：稱重模組（ESP32）佈建與維護
// ============================================================

let techBuckets = [];

async function loadDevices() {
    const box = document.getElementById('techDeviceList');
    if (!box) return;
    box.innerHTML = '<p>載入中...</p>';
    try {
        const [list, health] = await Promise.all([
            apiRequest('/tech/devices', 'GET'),
            apiRequest('/tech/health', 'GET')
        ]);
        if (!list.success) { box.innerHTML = `<p>${list.message || '載入失敗'}</p>`; return; }
        techBuckets = list.buckets || [];
        renderFleetHealth(list.summary, health);

        if (!list.devices.length) {
            box.innerHTML = '<p>還沒有任何模組，先用上面的「註冊新模組」建立。</p>';
            return;
        }
        box.innerHTML = list.devices.map(renderDeviceCard).join('');
    } catch (error) {
        box.innerHTML = '<p>載入失敗</p>';
    }
}

function renderFleetHealth(summary, health) {
    const box = document.getElementById('techHealth');
    if (!box || !summary) return;
    const attention = (health && health.attention) || [];
    box.innerHTML = `
        <p><strong>共 ${summary.total} 台</strong>　上線 ${summary.online}　離線 ${summary.offline}
           　未綁定 ${summary.unprovisioned}　停用 ${summary.disabled}</p>
        <p>近 24 小時讀數 ${health ? health.readingsLast24h : '-'} 筆
           ${summary.lowBattery ? `　⚠️ 低電量 ${summary.lowBattery} 台` : ''}
           ${summary.withAuthFailures ? `　⚠️ 憑證失敗 ${summary.withAuthFailures} 台` : ''}</p>
        ${attention.length ? `<p class="dish-help">需要處理：${attention.map((a) =>
            `${a.deviceId}（${a.reasons.join('、')}）`).join('　')}</p>` : ''}
    `;
}

function renderDeviceCard(d) {
    const state = d.status === 'disabled' ? '⛔ 已停用'
        : d.online ? '🟢 上線'
        : d.lastSeenAt ? '🔴 離線' : '⚪ 從未連線';
    const bucketOptions = techBuckets.map((b) =>
        `<option value="${b.id}" ${d.bucketId === b.id ? 'selected' : ''}>${b.label}</option>`).join('');

    return `
        <div class="admin-row device-card ${d.provisioned ? '' : 'inactive'}">
            <div class="admin-row-main">
                <strong>${d.deviceId}</strong> ${state}
                <span class="field-hint">
                    ${d.provisioned ? `${d.className || d.classId} · ${d.bucketLabel}` : '⚠️ 尚未綁定班級／桶別'}
                    　扣重 ${d.tareG}g　係數 ${Math.round(d.calibrationFactor * 100) / 100}
                    ${d.batteryPct != null ? `　電量 ${d.batteryPct}%` : ''}
                    ${d.rssi != null ? `　訊號 ${d.rssi}dBm` : ''}
                    ${d.firmware ? `　韌體 ${d.firmware}` : ''}
                </span>
                <span class="field-hint">
                    ${d.lastSeenAt ? `最後上線 ${new Date(d.lastSeenAt).toLocaleString('zh-TW')}` : '尚未上線'}
                    　設定版本 v${d.configVersion}
                    ${d.authFailures ? `　⚠️ 憑證失敗 ${d.authFailures} 次` : ''}
                </span>
            </div>
            <div class="admin-row-actions device-actions">
                <input type="text" class="inline-input" placeholder="班級ID" value="${d.classId || ''}"
                       data-role="dev-class" data-device-id="${d.deviceId}">
                <select class="inline-input" data-role="dev-bucket" data-device-id="${d.deviceId}">
                    <option value="">未指定桶別</option>${bucketOptions}
                </select>
                <button data-action="bindDevice" data-device-id="${d.deviceId}" class="check-btn">綁定</button>
                <input type="number" class="inline-input" placeholder="盆重 g" data-role="dev-tare" data-device-id="${d.deviceId}">
                <button data-action="setTareManual" data-device-id="${d.deviceId}" class="check-btn">設扣重</button>
                <button data-action="setTareLatest" data-device-id="${d.deviceId}" class="check-btn">空盆歸零</button>
                <button data-action="showReadings" data-device-id="${d.deviceId}" class="check-btn">最近讀數</button>
            </div>
            <div class="device-readings hidden" id="readings-${d.deviceId}"></div>
        </div>
    `;
}

const devInput = (role, deviceId) =>
    document.querySelector(`[data-role="${role}"][data-device-id="${deviceId}"]`);

async function registerDevices() {
    const result = document.getElementById('techRegisterResult');
    const count = Number(document.getElementById('techRegisterCount').value) || 1;
    const prefix = (document.getElementById('techRegisterPrefix').value || 'esp32').trim();
    try {
        const data = await apiRequest('/tech/devices', 'POST', { count, prefix });
        if (!data.success) {
            result.className = 'verify-result error';
            result.textContent = '⚠️ ' + (data.message || '註冊失敗');
            return;
        }
        result.className = 'verify-result ok';
        // token 只會出現這一次，直接列出來讓技術員複製到燒錄工具
        result.innerHTML = `✅ ${data.message}　<strong>${data.warning}</strong><br>` +
            data.devices.map((x) => `<code>${x.deviceId}</code> → <code>${x.token}</code>`).join('<br>');
        await loadDevices();
    } catch (error) {
        result.className = 'verify-result error';
        result.textContent = '註冊失敗：' + (error.message || '請稍後再試');
    }
}

async function bindDevice(el) {
    const deviceId = el.dataset.deviceId;
    const classId = (devInput('dev-class', deviceId) || {}).value || '';
    const bucketId = (devInput('dev-bucket', deviceId) || {}).value || '';
    try {
        const data = await apiRequest(`/tech/devices/${deviceId}`, 'PATCH', {
            classId: classId.trim(),
            bucketId
        });
        alert((data.success ? '✅ ' : '⚠️ ') + (data.message || ''));
        if (data.success) await loadDevices();
    } catch (error) {
        alert('綁定失敗：' + (error.message || '請稍後再試'));
    }
}

async function setTareManual(el) {
    const deviceId = el.dataset.deviceId;
    const input = devInput('dev-tare', deviceId);
    const tareG = Number(input && input.value);
    if (!Number.isFinite(tareG) || tareG < 0) { alert('請先填入盆重（公克）'); return; }
    await submitTare(deviceId, { mode: 'manual', tareG });
}

async function setTareLatest(el) {
    if (!confirm('請確認秤上放的是「空盆」，系統會把目前讀數設為盆體扣重。')) return;
    await submitTare(el.dataset.deviceId, { mode: 'latest' });
}

async function submitTare(deviceId, payload) {
    try {
        const data = await apiRequest(`/tech/devices/${deviceId}/tare`, 'POST', payload);
        alert((data.success ? '✅ ' : '⚠️ ') + (data.message || ''));
        if (data.success) await loadDevices();
    } catch (error) {
        alert('設定扣重失敗：' + (error.message || '請稍後再試'));
    }
}

async function showReadings(el) {
    const deviceId = el.dataset.deviceId;
    const box = document.getElementById(`readings-${deviceId}`);
    if (!box) return;
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = '<p>載入中...</p>';
    try {
        const data = await apiRequest(`/tech/devices/${deviceId}/readings?limit=10`, 'GET');
        if (!data.success || !data.readings.length) {
            box.innerHTML = '<p class="field-hint">這台還沒有讀數</p>';
            return;
        }
        box.innerHTML = '<table class="reading-table"><tr><th>時間</th><th>原始值</th><th>毛重</th><th>淨重</th></tr>' +
            data.readings.map((r) => `
                <tr class="${r.outOfRange ? 'out-of-range' : ''}">
                    <td>${r.receivedAt ? new Date(r.receivedAt).toLocaleTimeString('zh-TW') : '-'}</td>
                    <td>${r.raw ?? '-'}</td>
                    <td>${r.grossG}g</td>
                    <td>${r.netG}g${r.stable === false ? '（不穩）' : ''}</td>
                </tr>`).join('') + '</table>';
    } catch (error) {
        box.innerHTML = '<p>載入失敗</p>';
    }
}

// data-action 對應的處理函數
const ACTION_HANDLERS = {
    switchTab: (el) => switchTab(el.dataset.arg),
    handleLogin,
    handleRegister,
    handleLogout,
    startApp,
    verifyStudentBinding,
    parentSignIn,
    buyItem,
    submitSurvey,
    skipIntro,
    scrollToSection: (el) => scrollToSection(el.dataset.arg),
    openLottery,
    closeLottery,
    spinLottery,
    // 老師：逐生檢查
    loadCheckRoster,
    toggleCheck: (el) => toggleCheck(el),
    finishAllChecks,
    // 午餐長：四桶紀錄
    startRecord,
    captureBucket: (el) => captureBucket(el),
    markEmptied: (el) => markEmptied(el),
    finalizeRecord,
    // 跨班菜品（包一層：data-action 會把按鈕元素當第一個參數傳進來，
    //           會被誤當成 opts，導致 silent 判斷讀到 HTMLElement）
    loadSupportDishes: () => loadSupportDishes(),
    togglePassword: (el) => togglePassword(el),
    // 技術員：稱重模組
    loadDevices,
    registerDevices,
    bindDevice: (el) => bindDevice(el),
    setTareManual: (el) => setTareManual(el),
    setTareLatest: (el) => setTareLatest(el),
    showReadings: (el) => showReadings(el),
    loadTrend: (el) => loadTrend(el),
    // 個人英雄榜
    loadHeroBoard: () => loadHeroBoard(),
    // 管理員：發幣公式參數
    loadCoinRules: () => loadCoinRules(),
    previewCoinRules: () => previewCoinRules(),
    saveCoinRules: () => saveCoinRules(),
    resetCoinRules: () => resetCoinRules(),
    // 管理員：手動維護班級與帳號
    createClass,
    createUserByAdmin,
    loadAdminClasses,
    loadAdminUsers,
    setLunchLeader: (el) => setLunchLeader(el),
    toggleUserActive: (el) => toggleUserActive(el)
};

// 使用事件委派，一次綁定處理所有 data-action 元素
document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;

    const handler = ACTION_HANDLERS[target.dataset.action];
    if (!handler) {
        console.warn('未知的 data-action:', target.dataset.action);
        return;
    }

    Promise.resolve(handler(target)).catch((error) => {
        console.error(`執行 ${target.dataset.action} 失敗:`, error);
    });
});

document.addEventListener('change', (event) => {
    // 下拉選單上的 data-action 必須走 change 而不是 click：
    // 點開選單就會觸發 click，那時值還沒改，拿到的是改之前的選項。
    const sel = event.target && event.target.closest
        ? event.target.closest('select[data-action]')
        : null;
    if (sel) {
        const handler = ACTION_HANDLERS[sel.dataset.action];
        if (handler) {
            Promise.resolve(handler(sel)).catch((error) => {
                console.error(`執行 ${sel.dataset.action} 失敗:`, error);
            });
        }
    }

    if (event.target && event.target.name === 'registerRole') {
        syncRegisterFields();
    }
    // 管理員新增帳號：角色改變時切換需要的欄位
    if (event.target && event.target.id === 'adminUserRole') {
        syncAdminUserFields();
    }
    // 午餐長微調殘餘比例：放手（change）才送出，不用每動一格就打 API
    if (event.target && event.target.classList.contains('ratio-slider')) {
        const el = event.target;
        submitRatio(el.dataset.bucketId, el.dataset.slot, Number(el.value));
    }
});

// 若已跳過開場影片，直接隱藏
if (localStorage.getItem('lunchIntroSkipped') === 'true') {
    const intro = document.getElementById('introVideo');
    if (intro) {
        intro.classList.add('hidden');
        const iframe = intro.querySelector('iframe');
        if (iframe) iframe.src = '';
    }
}

syncRegisterFields();

// 頁面載入時嘗試恢復登入狀態
restoreSession();