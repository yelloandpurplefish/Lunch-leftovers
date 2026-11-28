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

// ============================================================
// 登入狀態與刷新
// ============================================================
//
// 進入 App 只有一條路 enterApp()：重新整理頁面、登入、註冊都走這裡。
// 以前登入後會停在「歡迎回來，按開始使用」，重新整理也要再按一次才有資料——拿掉了。
//
// 刷新分兩層：
//   refreshLive()  每 60 秒更新會變的小塊（餘額、今日午餐、本班結果、孩子狀況、午餐長紀錄、
//                  管理員總覽）。只在分頁在前景、15 分鐘內有操作、而且沒在輸入時才跑，
//                  不會把使用者正在填的東西蓋掉。
//   refreshAll()   右上角 🔄、分頁切回來超過 5 分鐘、跨過午夜時，整頁重新載入。
// 登出與登入過期一律走 logout()：停掉所有計時器，清掉畫面上屬於上一個人的資料。

const LIVE_REFRESH_MS = 60 * 1000;
const STALE_AFTER_MS = 5 * 60 * 1000;
let liveRefreshTimer = null;
let refreshing = false;
let lastFullRefreshAt = 0;
let lastRefreshAt = 0;
let currentDay = null;

const todayKey = () => new Date().toLocaleDateString('sv');

// 從 localStorage 還原登入狀態
async function restoreSession() {
  const token = localStorage.getItem('token');
  if (!token) {
    showAuthForm();
    return;
  }
  idToken = token;
  await enterApp();
}

/** 登入、註冊、重新整理後進入 App：讀自己的資料 → 依身分開區塊 → 載入資料 → 開始定時更新。 */
async function enterApp() {
  try {
    await loadUserData();
  } catch (error) {
    // 連不上伺服器不代表登入失效：token 留著，重新整理就能再試
    showAuthForm('連不到伺服器，請確認網路後重新整理頁面');
    return;
  }
  if (!currentUser) return;          // 登入已過期：apiRequest 已經處理（logout）
  showLoggedInState();
  await refreshAll({ quiet: true });
  startLiveRefresh();
}

// 舊名稱：測試與舊的按鈕還會呼叫
async function startApp() {
  return enterApp();
}

/** 右上角 🔄 與「分頁切回來很久」用：整頁重新載入。 */
async function refreshAll({ quiet = false } = {}) {
  if (!currentUser || refreshing) return;
  refreshing = true;
  setRefreshing(true);
  try {
    await loadUserData();
    if (!currentUser) return;
    applyRoleView();
    const tasks = [loadTodayMenu(), loadRoleData()];
    if (currentUser.role !== 'technician' && currentUser.role !== 'parent') tasks.push(loadLotteryAnnouncement());
    await Promise.all(tasks);
    lastFullRefreshAt = Date.now();
    currentDay = todayKey();
    markRefreshed();
    if (!quiet) toast('已更新到最新資料');
  } catch (error) {
    toast('更新失敗：' + (error.message || '請稍後再試'), false);
  } finally {
    refreshing = false;
    setRefreshing(false);
  }
}

/** 每 60 秒：只更新會變、而且不會打斷操作的部分。 */
async function refreshLive() {
  if (!currentUser || refreshing) return;
  refreshing = true;
  try {
    const before = viewTags(currentUser).join();
    await loadUserData();
    if (!currentUser) return;
    // 身分變了（例如剛被指定為午餐長）就整個重排，不必等使用者重新整理
    if (viewTags(currentUser).join() !== before) {
      applyRoleView();
      await loadRoleData();
    } else {
      const role = currentUser.role;
      const tasks = [];
      if (role === 'student') tasks.push(loadPlateToday());
      if (viewTags(currentUser).includes('lunch_leader')) tasks.push(loadRecordToday());
      if (role === 'teacher') tasks.push(loadClassPlates());
      if (role === 'parent') tasks.push(loadChildStatus());
      if (role === 'admin' && typeof refreshAdminLive === 'function') tasks.push(refreshAdminLive());
      await Promise.allSettled(tasks);
    }
    markRefreshed();
  } finally {
    refreshing = false;
  }
}

/** 正在輸入或開著帳號面板時不自動更新，免得把填到一半的東西蓋掉。 */
function userIsEditing() {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'button') return true;
  return typeof adminState !== 'undefined' && Boolean(adminState.drawerUserId);
}

function startLiveRefresh() {
  stopLiveRefresh();
  currentDay = todayKey();
  liveRefreshTimer = setInterval(() => {
    if (!currentUser || document.hidden) return;
    // 跨過午夜：「今天」變了，整頁重來（菜單、今日午餐、稱重都是以日期為準）
    if (todayKey() !== currentDay) {
      const dateInput = document.getElementById('teacherPlateDate');
      if (dateInput && dateInput.value === currentDay) dateInput.value = todayKey();
      refreshAll({ quiet: true });
      return;
    }
    if (Date.now() - lastInteractionAt > SCALE_IDLE_MS || userIsEditing()) return;
    refreshLive();
  }, LIVE_REFRESH_MS);
}

function stopLiveRefresh() {
  if (liveRefreshTimer) clearInterval(liveRefreshTimer);
  liveRefreshTimer = null;
}

// 分頁切回來：離開很久就整頁更新，短暫離開只更新會變的部分
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !currentUser || userIsEditing()) return;
  if (Date.now() - lastFullRefreshAt > STALE_AFTER_MS) refreshAll({ quiet: true });
  else if (Date.now() - lastRefreshAt > 20 * 1000) refreshLive();
});

function setRefreshing(on) {
  const btn = document.getElementById('refreshBtn');
  if (btn) {
    btn.classList.toggle('spinning', on);
    btn.disabled = on;
  }
}

function markRefreshed() {
  lastRefreshAt = Date.now();
  const el = document.getElementById('lastRefreshed');
  if (el) el.textContent = '更新於 ' + new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
}

/** 登出或登入過期：停掉所有計時器、清掉屬於這個人的畫面，回到登入。 */
function logout(message) {
  stopLiveRefresh();
  stopScalePolling();
  stopSupportPolling();
  if (typeof resetAdminState === 'function') resetAdminState();
  currentUser = null;
  idToken = null;
  esgCoin = 0;
  recordSession = null;
  try {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  } catch (error) { /* 無痕模式寫不進去也沒關係 */ }
  clearUserContent();
  applyRoleView();        // 沒有使用者 → 所有區塊與底部導覽都收起來
  showAuthForm(message);
}

/**
 * 換人登入時，上一個人的資料不能留在畫面上（就算是藏著的）——
 * 共用的教室電腦上，下一個人打開開發者工具就看得到。
 */
function clearUserContent() {
    const ids = ['plateResult', 'plateRecent', 'plateTiers', 'classPlateList', 'classPlateSummary',
        'childStatus', 'weighQueue', 'recordStatus', 'recordSummary', 'supportDishList', 'supportMeta',
        'heroBoardList', 'heroMine', 'trendChart', 'trendStats', 'shopList', 'menuToday', 'intakePanel',
        'surveyDisplay', 'parentSignInResult', 'techDeviceList', 'techHealth', 'lastRefreshed'];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    });
    ['esgcoin'].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = '0'; });
    ['loginPassword', 'parentComment', 'surveyReason'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) { el.value = ''; el.readOnly = false; }
    });
    const banner = document.getElementById('globalAnnouncement');
    if (banner) banner.classList.add('hidden');
    const signIn = document.getElementById('parentSignInBtn');
    if (signIn) { signIn.disabled = false; signIn.textContent = '今日簽到（孩子 +1 ESG）'; }
}

/** 右下角的短暫提示，取代會擋住畫面的 alert。ok 沒給時由訊息內容判斷。 */
function toast(message, ok) {
    const text = String(message == null ? '' : message);
    // 「請填寫…」「至少 5 個字」這類提醒也算要注意的，用提醒色
    const isOk = ok === undefined ? !/失敗|錯誤|不足|無法|不能|^請|至少|⚠️|❌|⏰/.test(text) : ok;
    let box = document.getElementById('appToast');
    if (!box) {
        box = document.createElement('div');
        box.id = 'appToast';
        box.className = 'toast';
        box.setAttribute('role', 'status');
        box.setAttribute('aria-live', 'polite');
        document.body.appendChild(box);
    }
    box.textContent = text;
    box.className = 'toast show ' + (isOk ? 'ok' : 'error');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { box.className = 'toast'; }, isOk ? 2800 : 5200);
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
      await enterApp();
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
      await enterApp();
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
function handleLogout() {
  logout();
}

// 載入使用者資料
async function loadUserData() {
  try {
    const data = await apiRequest('/user/profile', 'GET');

    if (data.success) {
      esgCoin = data.userData.esgCoin || 0;

      // 同步前端 currentUser。isLunchLeader 由後端依班級名冊判斷：
      // 午餐長不是角色，是附加在學生帳號上的身分。
      currentUser = {
        uid: data.userData.userId,
        email: data.userData.email,
        displayName: data.userData.displayName,
        role: data.userData.role,
        classId: data.userData.classId || null,
        className: data.userData.className || null,
        isLunchLeader: Boolean(data.userData.isLunchLeader),
        studentBinding: data.userData.studentBinding || null
      };
      localStorage.setItem('user', JSON.stringify(currentUser));

      updateUI();
    } else if (idToken) {
      // 登入過期時 apiRequest 已經登出（idToken 變成 null），那是預期的，不必記錯誤
      console.error('載入使用者資料失敗:', data.message);
    }
  } catch (error) {
    console.error('載入使用者資料失敗:', error);
    throw error;
  }
}

// 顯示登入表單（未登入時畫面上只有登入區）
function showAuthForm(message) {
  const auth = document.getElementById('authSection');
  if (auth) auth.classList.remove('hidden');
  const chip = document.getElementById('userChip');
  if (chip) chip.classList.add('hidden');
  const err = document.getElementById('loginError');
  if (err) err.textContent = message || '';
  window.scrollTo({ top: 0, behavior: 'auto' });
}

// 顯示已登入狀態：登入區收起，右上角顯示使用者與登出
function showLoggedInState() {
  const auth = document.getElementById('authSection');
  if (auth) auth.classList.add('hidden');
  const chip = document.getElementById('userChip');
  if (chip) chip.classList.remove('hidden');
  updateUI();
  applyRoleView();
}

// 更新 UI（餘額與右上角的名字）
function updateUI() {
  const ec = document.getElementById('esgcoin');
  if (ec) ec.textContent = esgCoin;
  const name = document.getElementById('userDisplayName');
  if (name && currentUser) name.textContent = currentUser.displayName || currentUser.email || '使用者';
}

// ── 今日菜單（兩欄）────────────────────────────────────────────
/**
 * 左欄是真正的 daily_menu（由每月菜單同步寫入），右欄是依個人體位的建議攝取。
 * 體位分類與建議熱量都由後端算好，前端只負責呈現——判定界線是會被
 * 主管機關更新的數據，不該散落在瀏覽器裡。
 */
async function loadTodayMenu() {
    const list = document.getElementById('menuToday');
    const panel = document.getElementById('intakePanel');
    if (!list || !panel) return;

    try {
        const data = await apiRequest('/menu/today', 'GET');
        if (!data.success) {
            list.innerHTML = '<p class="field-hint">菜單載入失敗</p>';
            panel.innerHTML = '';
            return;
        }
        renderTodayMenu(data);
        renderIntake(data.intake || {});
        fillSurveyDishes(data);
    } catch (error) {
        list.innerHTML = '<p class="field-hint">菜單載入失敗：'
            + escapeText(error.message || '請稍後再試') + '</p>';
        panel.innerHTML = '';
    }
}

/**
 * 問卷的菜色下拉由當日菜單產生。
 *
 * 原本是寫死的五道菜，和資料庫裡的菜單無關——學生只能評分根本沒吃到的菜，
 * 廚房收到的回饋也對不上。後端會再驗一次菜名是否屬於當天的菜單
 * （見 taskController.submitSurvey），前端這裡只負責讓人選得對。
 */
function fillSurveyDishes(data) {
    const selects = ['favoriteFood', 'hateFood']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
    if (!selects.length) return;

    const submit = document.querySelector('[data-action="submitSurvey"]');
    const reason = document.getElementById('surveyReason');
    const hint = document.getElementById('surveyMenuHint');
    const dishes = (data && data.dishes) || [];
    const open = Boolean(data && data.served) && dishes.length > 0;

    selects.forEach((sel) => {
        const keep = sel.value;                 // 重新載入時盡量保住使用者已選的
        sel.innerHTML = open
            ? dishes.map((d) =>
                `<option value="${escapeAttr(d.name)}">`
                + `${escapeText(d.label)}　${escapeText(d.name)}</option>`).join('')
            : '<option value="">今天沒有菜色</option>';
        sel.disabled = !open;
        if (open && keep && dishes.some((d) => d.name === keep)) sel.value = keep;
    });

    // 不供餐就不該讓人送出：後端也會擋，但先在這裡講清楚原因
    if (submit) submit.disabled = !open;
    if (reason) reason.disabled = !open;
    if (hint) {
        hint.textContent = open
            ? `選項來自 ${data.date} 的菜單，共 ${dishes.length} 道`
            : `${(data && data.date) || '今天'} 沒有供餐`
                + ((data && data.note) ? `（${data.note}）` : '')
                + '，今天不需要填問卷。';
    }
}

const SLOT_ICON = {
    staple: '🍚', main: '🍗', side1: '🥘', side2: '🍳', veg: '🥬', soup: '🥣',
};

function renderTodayMenu(data) {
    const box = document.getElementById('menuToday');
    if (!box) return;

    if (!data.served) {
        // 不供餐不是錯誤：段考、校外教學本來就沒有午餐
        box.innerHTML = '<p class="menu-empty">🚫 今天不供餐'
            + (data.note ? '<br><span class="field-hint">' + escapeText(data.note) + '</span>' : '')
            + '</p>';
        return;
    }

    box.innerHTML = '<ul class="menu-list">'
        + (data.dishes || []).map((d) => `
            <li>
                <span class="menu-slot">${escapeText(d.label)}</span>
                <span class="menu-dish">${SLOT_ICON[d.slot] || '🍽️'} ${escapeText(d.name)}</span>
                ${d.portionG ? `<span class="menu-portion">${d.portionG} g</span>` : ''}
            </li>`).join('')
        + '</ul>'
        + (data.note ? '<p class="field-hint">' + escapeText(data.note) + '</p>' : '');
}

/** 體位 → 顏色語意。過輕與過重都是「要注意」，不分好壞。 */
const INTAKE_CLASS = { 過輕: 'low', 正常: 'ok', 過重: 'high' };

function renderIntake(intake) {
    const box = document.getElementById('intakePanel');
    if (!box) return;

    // 沒有個人體位時仍顯示基準值，但要說清楚這不是個人化的建議
    if (!intake.category || intake.kcal == null) {
        const why = {
            no_data: '還沒有身高體重資料，請老師或管理員同步名冊',
            no_binding: '這個家長帳號還沒綁定學生',
            not_applicable: '這個身份沒有個人建議值',
        }[intake.source] || '還沒有體位資料';

        box.innerHTML = (intake.normalKcal != null
            ? `<p class="intake-kcal"><span class="intake-n">${intake.normalKcal}</span>
                 <span class="intake-unit">kcal</span></p>
               <p class="intake-cat">全校基準</p>`
            : '')
            + '<p class="field-hint">' + escapeText(why) + '</p>';
        return;
    }

    const cls = INTAKE_CLASS[intake.category] || 'ok';
    const who = intake.forName ? escapeText(intake.forName) + ' 的' : '你的';
    const diff = intake.normalKcal != null ? intake.kcal - intake.normalKcal : 0;

    box.innerHTML = `
        <p class="intake-kcal">
            <span class="intake-n">${intake.kcal}</span>
            <span class="intake-unit">kcal</span>
        </p>
        <p class="intake-cat ${cls}">體位：${escapeText(intake.category)}</p>
        ${diff !== 0 ? `<p class="field-hint">
            比基準 ${intake.normalKcal} kcal ${diff > 0 ? '多' : '少'} ${Math.abs(diff)}
        </p>` : ''}
        <p class="field-hint">
            ${who} BMI ${intake.bmi}
            ${intake.source === 'table'
                ? `（依 ${intake.age} 歲${intake.gender === 'female' ? '女' : '男'}生的建議值判定）`
                : '（查無年齡或性別，使用全校共用界線估算）'}
        </p>
        <p class="field-hint">這是**一餐**的建議量，不是一整天。</p>`;
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

  // 登入過期或帳號被停用：不讓每個區塊各自顯示「Token 無效」，直接回到登入畫面
  if (idToken && (response.status === 401 || (response.status === 403 && data.message === '此帳號已被停用'))) {
    logout(response.status === 401 ? '登入已過期，請重新登入' : data.message);
  }

  return data;
}

// 註：底部導覽改為「登入後常駐」（見 applyRoleView）。
// 原本綁在 scroll 事件上、只有滑到距底部 150px 才滑出，
// 使用者平常根本看不到導覽列，改掉。



// ============================================================
// 個人英雄榜
// ============================================================
//
// 排的是這段期間「獲得」的 ESG 幣（花掉不會掉名次），
// 同一列附上各來源（拍餐盤、家長簽到、管理員調整），看得出幣是從哪裡來的。

async function loadHeroBoard() {
    const tbody = document.getElementById('heroBoardList');
    if (!tbody) return;
    const period = (document.getElementById('heroPeriod') || {}).value || 'week';
    const within = (document.getElementById('heroWithin') || {}).value || 'school';
    const mineBox = document.getElementById('heroMine');

    try {
        const data = await apiRequest(`/leaderboard?period=${period}&within=${within}`, 'GET');
        if (!data.success) {
            tbody.innerHTML = '<tr><td colspan="4">載入失敗</td></tr>';
            return;
        }
        if (!data.rows.length) {
            tbody.innerHTML = '<tr><td colspan="4">這段期間還沒有人獲得幣</td></tr>';
            if (mineBox) mineBox.innerHTML = '';
            return;
        }

        const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : r);
        const names = data.sources || {};
        const sources = (s) => Object.entries(s)
            .filter(([, n]) => n > 0).map(([k, n]) => `${escapeText(names[k] || k)} ${n}`).join('、') || '—';
        tbody.innerHTML = data.rows.map((r) => `
            <tr class="${r.me ? 'my-rank-row' : ''}">
                <td>${medal(r.rank)}</td>
                <td>${escapeText(r.displayName)}${r.className ? `<small>　${escapeText(r.className)}</small>` : ''}</td>
                <td>${r.ESG}</td>
                <td><small>${sources(r.bySource || {})}</small></td>
            </tr>
        `).join('');

        if (mineBox) {
            mineBox.innerHTML = data.me
                ? `<p>你目前第 <strong>${data.me.rank}</strong> 名／共 ${data.total} 人　·　`
                  + `這段期間獲得 ESG ${data.me.ESG}</p>`
                : '<p class="field-hint">你這段期間還沒有獲得幣，先把自己那份吃完吧。</p>';
        }
    } catch (error) {
        tbody.innerHTML = '<tr><td colspan="4">載入失敗</td></tr>';
    }
}


// ============================================================
// 從 Google 試算表同步學生名冊
// ============================================================
//
// 真正的抓取在後端做，不在瀏覽器：試算表的存取密鑰只存在後端的環境變數裡，
// 放到前端等於公開它。這裡只負責按按鈕與呈現報告。

let syncRunning = false;

async function runStudentSync(dryRun) {
    if (syncRunning) return;
    const result = document.getElementById('syncStudentsResult');
    const report = document.getElementById('syncStudentsReport');
    const buttons = document.querySelectorAll('[data-action="syncStudents"], [data-action="syncStudentsDryRun"]');

    if (!dryRun && !confirm('確定要寫入嗎？建議先按「試算」確認欄位與班級都對得上。')) return;

    syncRunning = true;
    buttons.forEach((b) => { b.disabled = true; });
    if (result) {
        result.className = 'verify-result';
        result.textContent = dryRun ? '試算中…' : '同步中…（名冊較大時需要數十秒）';
    }
    if (report) report.innerHTML = '';

    try {
        const data = await apiRequest('/admin/sync/students', 'POST', { dryRun });
        if (!data.success) {
            if (result) {
                result.className = 'verify-result error';
                result.textContent = '⚠️ ' + (data.message || '同步失敗');
            }
            return;
        }
        if (result) {
            result.className = 'verify-result ok';
            result.textContent = (dryRun ? '🧪 ' : '✅ ') + data.message;
        }
        renderSyncReport(data);
        if (!dryRun) await loadAdminHome();
    } catch (error) {
        if (result) {
            result.className = 'verify-result error';
            result.textContent = '同步失敗：' + (error.message || '請稍後再試');
        }
    } finally {
        syncRunning = false;
        buttons.forEach((b) => { b.disabled = false; });
    }
}

// 用 function 宣告而不是 const：檔案裡其餘的動作處理函式都是這個形式，
// 而且 const 宣告的只存在於詞法作用域，從 window 取不到。
function syncStudents() { return runStudentSync(false); }
function syncStudentsDryRun() { return runStudentSync(true); }

/**
 * 同步報告。
 *
 * 錯誤列放最前面且永遠展開：那是管理員唯一需要動手處理的部分，
 * 成功的幾十筆反而只要知道數量就好。
 */
function renderSyncReport(data) {
    const box = document.getElementById('syncStudentsReport');
    if (!box) return;
    const s = data.summary || {};
    const src = data.source || {};

    const tile = (label, n, cls) =>
        `<div class="sync-tile ${cls || ''}"><span class="sync-n">${n}</span><span>${label}</span></div>`;

    const errorRows = (data.errors || []).map((e) => `
        <tr>
            <td class="num">${e.row}</td>
            <td>${escapeText(e.name || '')}</td>
            <td>${escapeText(e.reason)}</td>
        </tr>`).join('');

    const createdRows = (data.created || []).map((c) => `
        <tr>
            <td class="num">${c.row}</td>
            <td>${escapeText(c.name)}</td>
            <td>${escapeText(c.account)}</td>
            <td class="num">${c.bmi == null ? '—' : c.bmi}</td>
        </tr>`).join('');

    const updatedRows = (data.updated || []).map((u) => `
        <tr>
            <td class="num">${u.row}</td>
            <td>${escapeText(u.name)}</td>
            <td>${escapeText((u.changed || []).join('、'))}</td>
            <td class="num">${u.bmi == null ? '—' : u.bmi}</td>
        </tr>`).join('');

    const missingRows = (data.notInSheet || []).map((m) => `
        <tr>
            <td>${escapeText(m.name)}</td>
            <td>${escapeText(m.className || '')}</td>
            <td>${escapeText(m.account || '')}</td>
        </tr>`).join('');

    box.innerHTML = `
        <p class="field-hint">
            來源：${escapeText(src.sheet || '—')}　共 ${src.rows || 0} 列
            匯出於 ${src.exportedAt ? new Date(src.exportedAt).toLocaleString('zh-TW') : '—'}
            ${data.dryRun ? '　<strong>（試算，未寫入）</strong>' : ''}
        </p>

        <div class="sync-tiles">
            ${tile('新增', s.created || 0, 'ok')}
            ${tile('更新', s.updated || 0, 'ok')}
            ${tile('未變', s.unchanged || 0)}
            ${tile('待處理', s.errors || 0, (s.errors || 0) > 0 ? 'bad' : '')}
            ${tile('表中沒有', s.notInSheet || 0)}
        </div>

        ${errorRows ? `
        <details open class="sync-details bad">
            <summary>需要處理的 ${s.errors} 列</summary>
            <div class="table-scroll">
            <table><thead><tr><th>列</th><th>姓名</th><th>原因</th></tr></thead>
            <tbody>${errorRows}</tbody></table>
            </div>
        </details>` : ''}

        ${createdRows ? `
        <details class="sync-details">
            <summary>新增的 ${s.created} 人</summary>
            <div class="table-scroll">
            <table><thead><tr><th>列</th><th>姓名</th><th>帳號（學號）</th><th>BMI</th></tr></thead>
            <tbody>${createdRows}</tbody></table>
            </div>
            <p class="field-hint">
                這些帳號沒有密碼，目前無法用帳密登入——之後改用 Google 登入後才會啟用。
            </p>
        </details>` : ''}

        ${updatedRows ? `
        <details class="sync-details">
            <summary>更新的 ${s.updated} 人</summary>
            <div class="table-scroll">
            <table><thead><tr><th>列</th><th>姓名</th><th>變動欄位</th><th>BMI</th></tr></thead>
            <tbody>${updatedRows}</tbody></table>
            </div>
        </details>` : ''}

        ${missingRows ? `
        <details class="sync-details">
            <summary>資料庫有、試算表沒有的 ${s.notInSheet} 人（未變動）</summary>
            <div class="table-scroll">
            <table><thead><tr><th>姓名</th><th>班級</th><th>帳號</th></tr></thead>
            <tbody>${missingRows}</tbody></table>
            </div>
            <p class="field-hint">
                可能是轉學、畢業，也可能只是這次匯出不完整。同步不會自動停用他們，
                確認後請到下方的帳號管理處理。
            </p>
        </details>` : ''}
    `;
}

/** 名冊內容來自試算表，當成純文字處理，不讓它變成 HTML。 */
/**
 * 放進 HTML 屬性值的字串。escapeText 是給節點內容用的，
 * 屬性還得處理引號，否則菜名裡一個雙引號就能跳出 value="..."。
 */
/**
 * 把 data-bar-width / data-bar-height 的百分比套到元素上。
 *
 * 為什麼不直接寫 style="width:37%"：CSP 的 style-src 'self' 會讓
 * HTML 裡的 style 屬性被瀏覽器丟掉（不報錯，只是沒效果——實測算繪寬度
 * 會變成父層寬度）。改用 CSSOM 設定則不受限制，所以把數值先放進
 * data- 屬性，插入 DOM 後再呼叫這支套用。
 */
function applyBarSizes(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-bar-width]').forEach((el) => {
        el.style.width = el.dataset.barWidth + '%';
    });
    scope.querySelectorAll('[data-bar-height]').forEach((el) => {
        el.style.height = el.dataset.barHeight + '%';
    });
}

function escapeAttr(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeText(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


// ============================================================
// 從 Google 試算表同步每月菜單
// ============================================================

let menuSyncRunning = false;

async function runMenuSync(dryRun) {
    if (menuSyncRunning) return;
    const result = document.getElementById('syncMenusResult');
    const report = document.getElementById('syncMenusReport');
    const buttons = document.querySelectorAll('[data-action="syncMenus"], [data-action="syncMenusDryRun"]');
    const month = (document.getElementById('menuSyncMonth') || {}).value || '';
    const createMissingDishes = Boolean((document.getElementById('menuCreateDishes') || {}).checked);

    if (!dryRun && !confirm(
        '確定要寫入嗎？建議先按「試算」確認日期、星期與菜名都對得上。'
        + (createMissingDishes ? '\n\n注意：勾選了「一併建立菜色」，查不到的菜名會被建立成新菜色。' : ''))) {
        return;
    }

    menuSyncRunning = true;
    buttons.forEach((b) => { b.disabled = true; });
    if (result) {
        result.className = 'verify-result';
        result.textContent = dryRun ? '試算中…' : '同步中…';
    }
    if (report) report.innerHTML = '';

    try {
        const data = await apiRequest('/admin/sync/menus', 'POST',
            { month, dryRun, createMissingDishes });
        if (!data.success) {
            if (result) {
                result.className = 'verify-result error';
                result.textContent = '⚠️ ' + (data.message || '同步失敗');
            }
            return;
        }
        if (result) {
            result.className = 'verify-result ok';
            result.textContent = (dryRun ? '🧪 ' : '✅ ') + data.message;
        }
        renderMenuReport(data);
    } catch (error) {
        if (result) {
            result.className = 'verify-result error';
            result.textContent = '同步失敗：' + (error.message || '請稍後再試');
        }
    } finally {
        menuSyncRunning = false;
        buttons.forEach((b) => { b.disabled = false; });
    }
}

function syncMenus() { return runMenuSync(false); }
function syncMenusDryRun() { return runMenuSync(true); }

/** 商城關閉時要讓學生看得到原因，並且不要留著一顆按了會失敗的按鈕。 */
function applyShopState(enabled, reason) {
    const notice = document.getElementById('shopClosed');
    if (notice) {
        notice.classList.toggle('hidden', enabled !== false);
        if (enabled === false) {
            notice.innerHTML = '🚧 ' + escapeText(reason || '商城暫停開放中');
        }
    }
    document.querySelectorAll('[data-action="buyItem"]').forEach((b) => {
        b.disabled = enabled === false;
        if (enabled === false) b.title = reason || '商城暫停開放中';
    });
}

// ── 管理員：商城開關 ──────────────────────────────────────────
async function loadShopState() {
    const toggle = document.getElementById('shopToggle');
    if (!toggle) return;
    try {
        const data = await apiRequest('/admin/shop', 'GET');
        if (!data.success) return;
        renderShopAdmin(data.shop || {});
    } catch (error) {
        const meta = document.getElementById('shopToggleMeta');
        if (meta) meta.textContent = '讀取失敗：' + (error.message || '請稍後再試');
    }
}

function renderShopAdmin(shop) {
    const toggle = document.getElementById('shopToggle');
    const msg = document.getElementById('shopMessage');
    const meta = document.getElementById('shopToggleMeta');
    if (!toggle) return;

    toggle.checked = shop.adminEnabled !== false;
    if (msg && shop.message) msg.value = shop.message;

    if (meta) {
        const bits = [];
        bits.push(shop.enabled ? '目前狀態：開張中' : '目前狀態：已關閉');
        // 環境變數鎖住時要明講，否則面板上勾了卻沒反應會像是壞了
        if (shop.lockedByEnv) {
            bits.push('⚠️ 這個環境的 SHOP_ENABLED=false，面板打開也不會生效');
        }
        if (shop.updatedBy) bits.push('最後變更：' + shop.updatedBy);
        meta.textContent = bits.join('　·　');
    }
}

async function saveShopState() {
    const toggle = document.getElementById('shopToggle');
    const msg = document.getElementById('shopMessage');
    const result = document.getElementById('shopToggleResult');
    if (!toggle) return;

    if (result) {
        result.className = 'verify-result';
        result.textContent = '儲存中…';
    }
    try {
        const data = await apiRequest('/admin/shop', 'PUT', {
            enabled: toggle.checked,
            message: msg ? msg.value : '',
        });
        if (result) {
            result.className = 'verify-result ' + (data.success ? 'ok' : 'error');
            result.textContent = (data.success ? '✅ ' : '⚠️ ') + (data.message || '');
        }
        if (data.shop) renderShopAdmin(data.shop);
    } catch (error) {
        if (result) {
            result.className = 'verify-result error';
            result.textContent = '儲存失敗：' + (error.message || '請稍後再試');
        }
    }
}


// ══════════════════════════════════════════════════════════════════
//  依序稱重（午餐長）
// ══════════════════════════════════════════════════════════════════
//
//  一個班級一台秤，一桶一桶放上去。介面要做到三件事：
//   1. 清楚指出「現在該放哪一桶」——不然六道菜很容易漏或重複
//   2. 秤上的重量要即時看得到，放上去沒反應時人才知道是秤的問題
//   3. 每一筆都要能看出是量測、手動輸入，還是宣告吃光

let weighPollTimer = null;

async function loadWeighQueue() {
    const box = document.getElementById('weighQueue');
    if (!box) return;
    try {
        const data = await apiRequest('/record/weigh-queue', 'GET');
        if (!data.success) {
            box.innerHTML = `<p class="field-hint">${escapeText(data.message || '尚未開始今日紀錄')}</p>`;
            stopScalePolling();
            return;
        }
        if (data.status === 'none') {
            // 還沒開始：不輪詢秤，也不顯示即時讀數
            box.innerHTML = `<p class="field-hint">${data.menuReady
                ? '按「開始今日紀錄」後，這裡會依序列出要量的菜。'
                : '今天沒有菜單（或不供餐），不需要稱重。'}</p>`;
            stopScalePolling();
            const live = document.getElementById('scaleLive');
            if (live) live.classList.add('hidden');
            return;
        }
        renderWeighQueue(data);
        // 量完最後一道時「完成今日紀錄」按鈕要跟著出現，不必等重新整理
        if (recordSession) {
            recordSession.progress = data.progress;
            recordSession.status = data.status;
            renderRecordSummary();
        }
        // 已結算就不需要即時讀數了
        if (data.status === 'done') stopScalePolling();
        else startScalePolling();
    } catch (error) {
        box.innerHTML = `<p class="field-hint">稱重清單載入失敗：${escapeText(error.message || '')}</p>`;
    }
}

function renderWeighQueue(data) {
    const box = document.getElementById('weighQueue');
    if (!box) return;
    const queue = data.queue || [];
    const prog = data.progress || {};

    if (!queue.length) {
        box.innerHTML = '<p class="field-hint">今天的菜單還沒設定，無法稱重。</p>';
        return;
    }

    // 皮重沒設好就先別讓人開始量——量了也算不出剩餘量
    const blocked = (data.blocked || []).filter(Boolean);
    const blockHtml = blocked.length
        ? `<div class="weigh-block">⚠️ ${blocked.map(escapeText).join('<br>')}
             <br><span class="field-hint">請管理員到「桶型扣重」設定後再量</span></div>`
        : '';

    // 下一個要量的：第一個還沒量的
    const nextSlot = (queue.find((q) => !q.weighed) || {}).slot || null;

    const rows = queue.map((q) => {
        const isNext = q.slot === nextSlot;
        const cls = ['weigh-row'];
        if (q.weighed) cls.push('done');
        if (isNext) cls.push('next');
        return `
        <div class="${cls.join(' ')}">
            <div class="weigh-main">
                <span class="weigh-bucket">${escapeText(q.bucketLabel)}</span>
                <span class="weigh-dish">${escapeText(q.slotLabel)}　${escapeText(q.dishName)}</span>
            </div>
            <div class="weigh-value">
                ${q.weighed
                    ? `<strong>${q.leftoverG}</strong> g`
                    : `<span class="weigh-pending">待量</span>`}
                ${q.tareG != null ? `<span class="weigh-tare">皮重 ${q.tareG} g</span>` : ''}
            </div>
            <div class="weigh-actions">
                ${isNext && !blocked.length ? `
                    <button data-action="weighDish" data-slot="${escapeAttr(q.slot)}">
                        ⚖️ 讀取並記錄
                    </button>
                    <button data-action="weighEmptied" data-slot="${escapeAttr(q.slot)}"
                            class="secondary-btn">吃光了</button>` : ''}
                ${q.weighed && !blocked.length ? `
                    <button data-action="weighDish" data-slot="${escapeAttr(q.slot)}"
                            class="secondary-btn">重量一次</button>` : ''}
            </div>
        </div>`;
    }).join('');

    const doneNote = data.status === 'done'
        ? '　✅ 今天已完成紀錄'
        : (prog.allDone ? '　✅ 都量完了，可以按下方「完成今日紀錄」' : '');
    box.innerHTML = `
        ${blockHtml}
        <p class="weigh-progress">
            進度 <strong>${prog.done || 0}</strong> / ${prog.total || 0}${doneNote}
        </p>
        <div class="weigh-list">${rows}</div>
        <p class="field-hint">
            「重量一次」會覆蓋原本那筆。秤故障時可以請管理員改用手動輸入。
        </p>`;
}

// ── 讀數輪詢什麼時候該打 API ───────────────────────────────────
//
// 每次輪詢後端要讀 4–5 份文件（驗證、場次、秤、最新讀數），
// 原本只要今天開始紀錄，頁面開著就整天每 2 秒打一次——結算後、切到背景都不停，
// 一個頁面每小時約 8,000 次讀取。現在只在「有人正在看稱重區」時才打：
//   · 分頁在前景
//   · 稱重區在畫面上（沒被角色檢視藏起來，也沒捲到別處）
//   · 15 分鐘內有人操作過（點、按鍵、捲動）
// 計時器照跑但不打 API，條件一恢復，下一拍（≤ 2 秒）就自動更新。
// 已結算則完全停止。
const SCALE_IDLE_MS = 15 * 60 * 1000;
let lastInteractionAt = Date.now();
let weighPanelOnScreen = true;
let weighPanelObserver = null;
['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((type) => {
    document.addEventListener(type, () => { lastInteractionAt = Date.now(); }, { passive: true });
});
window.addEventListener('scroll', () => { lastInteractionAt = Date.now(); }, { passive: true });

function watchWeighPanel() {
    const panel = document.getElementById('recordPanel');
    if (weighPanelObserver || !panel || typeof IntersectionObserver === 'undefined') return;
    weighPanelObserver = new IntersectionObserver((entries) => {
        weighPanelOnScreen = entries.some((e) => e.isIntersecting);
    });
    weighPanelObserver.observe(panel);
}

/** 現在該暫停輪詢的原因；null 代表該打。 */
function scalePollPausedReason() {
    if (document.hidden) return 'background';
    const panel = document.getElementById('recordPanel');
    if (!panel || panel.closest('.hidden')) return 'hidden';
    if (!weighPanelOnScreen) return 'offscreen';
    if (Date.now() - lastInteractionAt > SCALE_IDLE_MS) return 'idle';
    return null;
}

/** 秤的即時讀數。放上桶子後這裡要看得到數字在變，才知道秤是活的。 */
async function pollScale() {
    const box = document.getElementById('scaleLive');
    const val = document.getElementById('scaleLiveValue');
    const st = document.getElementById('scaleLiveState');
    if (!box || !val) return;
    const paused = scalePollPausedReason();
    if (paused) {
        if (paused === 'idle' && st) {
            st.textContent = '15 分鐘沒有操作，已暫停更新讀數；點一下畫面就恢復';
            st.className = 'scale-live-state warn';
        }
        return;
    }
    try {
        const data = await apiRequest('/record/weigh-queue', 'GET');
        if (!data.success) return;
        if (data.status === 'done') {
            stopScalePolling();
            if (st) {
                st.textContent = '今天已結算，不再更新讀數';
                st.className = 'scale-live-state ok';
            }
            return;
        }
        const s = data.scale || {};
        box.classList.remove('hidden');
        val.textContent = s.netG != null ? Math.round(s.netG) : '—';
        const label = {
            ok: '穩定', unstable: '還在晃，等一下', no_load: '秤上沒有東西',
            offline: '秤離線', overload: '超出量程', disabled: '未綁定秤',
        }[s.state] || s.state || '';
        st.textContent = label + (s.note ? `（${s.note}）` : '');
        st.className = 'scale-live-state ' + (s.state === 'ok' ? 'ok' : 'warn');
    } catch (error) {
        if (st) st.textContent = '讀不到秤的狀態';
    }
}

function startScalePolling() {
    if (weighPollTimer) return;
    watchWeighPanel();
    pollScale();
    // 2 秒一次：放上桶子到讀數穩定大約就這個量級，再快只是多打 API
    weighPollTimer = setInterval(pollScale, 2000);
}

function stopScalePolling() {
    if (!weighPollTimer) return;
    clearInterval(weighPollTimer);
    weighPollTimer = null;
}

async function weighDish(el) {
    const slot = el && el.dataset ? el.dataset.slot : null;
    if (!slot) return;
    el.disabled = true;
    const original = el.textContent;
    el.textContent = '讀取中…';
    try {
        const data = await apiRequest('/record/weigh', 'POST', { slot });
        if (!data.success) {
            toast(data.message || '稱重失敗');
        } else {
            let msg = data.message;
            if ((data.warnings || []).length) msg += '\n\n⚠️ ' + data.warnings.join('\n');
            toast(msg);
        }
        await loadWeighQueue();
    } catch (error) {
        toast('稱重失敗：' + (error.message || '請稍後再試'));
    } finally {
        el.disabled = false;
        el.textContent = original;
    }
}

async function weighEmptied(el) {
    const slot = el && el.dataset ? el.dataset.slot : null;
    if (!slot) return;
    if (!confirm('確定這道菜全部吃完、完全沒有剩？會記為 0 g。')) return;
    try {
        const data = await apiRequest('/record/weigh', 'POST', { slot, emptied: true });
        if (!data.success) toast(data.message || '記錄失敗');
        await loadWeighQueue();
    } catch (error) {
        toast('記錄失敗：' + (error.message || '請稍後再試'));
    }
}

// ══════════════════════════════════════════════════════════════════
//  桶型皮重（管理員）
// ══════════════════════════════════════════════════════════════════

let bucketTareState = { types: [], tares: {}, meta: {}, devices: [], range: [0, 20000] };

async function loadBucketTare() {
    const rows = document.getElementById('tareRows');
    if (!rows) return;
    try {
        const data = await apiRequest('/admin/bucket-tare', 'GET');
        if (!data.success) {
            rows.innerHTML = `<p class="field-hint">${escapeText(data.message || '載入失敗')}</p>`;
            return;
        }
        bucketTareState = data;
        renderTareDevices(data.devices || []);
        renderTareRows(data);
    } catch (error) {
        rows.innerHTML = `<p class="field-hint">載入失敗：${escapeText(error.message || '')}</p>`;
    }
}

function renderTareDevices(devices) {
    const sel = document.getElementById('tareDevice');
    if (!sel) return;
    const keep = sel.value;
    if (!devices.length) {
        sel.innerHTML = '<option value="">（沒有已註冊的秤）</option>';
        return;
    }
    // 在線的排前面：要量皮重就得用在線的那台
    sel.innerHTML = devices.map((d) => {
        const name = d.label ? `${d.deviceId}（${d.label}）` : d.deviceId;
        const cls = d.className ? `　${d.className} 班` : '';
        const state = d.online ? '🟢 在線' : '⚪ 離線';
        return `<option value="${escapeAttr(d.deviceId)}" ${d.online ? '' : 'data-offline="1"'}>`
            + `${escapeText(name)}${escapeText(cls)}　${state}</option>`;
    }).join('');
    const stillThere = devices.some((d) => d.deviceId === keep);
    if (keep && stillThere) sel.value = keep;
}

function renderTareRows(data) {
    const box = document.getElementById('tareRows');
    if (!box) return;
    box.innerHTML = (data.types || []).map((ty) => {
        const v = (data.tares || {})[ty.id];
        const m = (data.meta || {})[ty.id];
        const info = m
            ? `${m.method === 'measured' ? '量測' : '手動'}`
              + (m.measuredWith ? `　用 ${escapeText(m.measuredWith)}` : '')
              + (m.updatedBy ? `　by ${escapeText(m.updatedBy)}` : '')
            : '尚未設定';
        return `
        <div class="tare-row ${v == null ? 'unset' : ''}">
            <div class="tare-label">
                <strong>${escapeText(ty.label)}</strong>
                <span class="field-hint">${(ty.slots || []).map(escapeText).join('、')}</span>
            </div>
            <div class="tare-input">
                <input type="number" step="1" min="0" id="tare-${escapeAttr(ty.id)}"
                       value="${v == null ? '' : v}" placeholder="未設定">
                <span>g</span>
            </div>
            <div class="tare-actions">
                <button data-action="measureTare" data-bucket-type="${escapeAttr(ty.id)}">
                    ⚖️ 量測
                </button>
                <button data-action="saveTare" data-bucket-type="${escapeAttr(ty.id)}"
                        class="secondary-btn">儲存</button>
            </div>
            <p class="field-hint tare-meta">${info}</p>
        </div>`;
    }).join('');
}

function tareResult(ok, message) {
    const el = document.getElementById('tareResult');
    if (!el) return;
    el.className = 'verify-result ' + (ok ? 'ok' : 'error');
    el.textContent = (ok ? '✅ ' : '⚠️ ') + message;
}

async function measureTare(el) {
    const bucketType = el && el.dataset ? el.dataset.bucketType : null;
    const sel = document.getElementById('tareDevice');
    const deviceId = sel ? sel.value : '';
    if (!bucketType) return;
    if (!deviceId) return tareResult(false, '請先選一台秤');

    const opt = sel.options[sel.selectedIndex];
    if (opt && opt.dataset.offline === '1'
        && !confirm('這台秤目前顯示離線，量到的可能是舊讀數。還是要量嗎？')) {
        return;
    }
    if (!confirm('請確認那台秤上放的是**空桶**，然後按確定。')) return;

    tareResult(true, '量測中…');
    try {
        const data = await apiRequest('/admin/bucket-tare/measure', 'POST',
            { deviceId, bucketType });
        tareResult(Boolean(data.success), data.message || '');
        if (data.success) await loadBucketTare();
    } catch (error) {
        tareResult(false, '量測失敗：' + (error.message || '請稍後再試'));
    }
}

async function saveTare(el) {
    const bucketType = el && el.dataset ? el.dataset.bucketType : null;
    if (!bucketType) return;
    const input = document.getElementById('tare-' + bucketType);
    if (!input || input.value === '') return tareResult(false, '請先填入皮重');
    try {
        const data = await apiRequest('/admin/bucket-tare', 'PUT',
            { bucketType, tareG: Number(input.value) });
        tareResult(Boolean(data.success), data.message || '');
        if (data.success) await loadBucketTare();
    } catch (error) {
        tareResult(false, '儲存失敗：' + (error.message || '請稍後再試'));
    }
}


// ══════════════════════════════════════════════════════════════════
//  刪除（班級／帳號／稱重模組）
// ══════════════════════════════════════════════════════════════════
//
//  後端只在「沒有任何依賴資料」時才真的刪，否則回 409 並附上每一種
//  依賴的筆數（見 backend/lib/deletion.js）。前端的責任是把那串原因
//  原樣顯示出來——管理員才知道是要先搬學生、還是該改用「停用」。

/** 把後端回的依賴清單整理成可讀的提示。 */
function describeDeps(data) {
    const deps = (data && data.dependencies) || [];
    if (!deps.length) return data && data.message ? data.message : '無法刪除';
    return (data.message || '無法刪除') + '\n\n'
        + deps.map((d) => `· ${d.label}：${d.count} 筆`).join('\n');
}

async function deleteDeviceRow(el) {
    const deviceId = el.dataset.deviceId;
    if (!deviceId) return;
    if (!confirm(`確定刪除稱重模組「${deviceId}」？\n\n`
        + '燒進韌體的 token 會立刻失效，那台秤就連不上了。\n'
        + '歷史讀數預設會保留。')) return;
    // 讀數是現場排查的依據，所以要不要一起刪另外問一次
    const purge = confirm('要連同這台的歷史讀數一起刪除嗎？\n\n'
        + '確定＝一起刪（不可復原）\n取消＝只刪裝置，保留讀數');
    el.disabled = true;
    try {
        const data = await apiRequest(
            `/tech/devices/${encodeURIComponent(deviceId)}?purgeReadings=${purge}`, 'DELETE');
        toast(data.success ? '✅ ' + data.message : '⚠️ ' + (data.message || '刪除失敗'));
        if (data.success) await loadDevices();
    } catch (error) {
        toast('刪除失敗：' + (error.message || '請稍後再試'));
    } finally {
        el.disabled = false;
    }
}

function renderMenuReport(data) {
    const box = document.getElementById('syncMenusReport');
    if (!box) return;
    const s = data.summary || {};
    const src = data.source || {};

    const tile = (label, n, cls) =>
        `<div class="sync-tile ${cls || ''}"><span class="sync-n">${n}</span><span>${label}</span></div>`;

    const dayRows = (list) => list.map((d) => `
        <tr>
            <td>${escapeText(d.date)}</td>
            <td>${escapeText((d.dishes || []).join('、'))}</td>
        </tr>`).join('');

    const errorRows = (data.errors || []).map((e) => `
        <tr>
            <td class="num">${e.row}</td>
            <td>${escapeText(e.date || '')}</td>
            <td>${escapeText(e.reason)}</td>
        </tr>`).join('');

    const closedRows = (data.closed || []).map((c) => `
        <tr><td>${escapeText(c.date)}</td><td>${escapeText(c.note || '')}</td></tr>`).join('');

    const dishRows = (data.newDishes || []).map((d) => `
        <tr>
            <td>${escapeText(d.name)}</td>
            <td>${escapeText(d.category)}</td>
            <td class="num">${d.portionG} g</td>
        </tr>`).join('');

    box.innerHTML = `
        <p class="field-hint">
            來源：${escapeText(src.sheet || '—')}　共 ${src.rows || 0} 列
            ${src.month ? `　月份 ${escapeText(src.month)}` : '　（整張表）'}
            ${src.timeZone ? `　時區 ${escapeText(src.timeZone)}` : ''}
            ${data.dryRun ? '　<strong>（試算，未寫入）</strong>' : ''}
        </p>

        <div class="sync-tiles">
            ${tile('新增', s.created || 0, 'ok')}
            ${tile('更新', s.updated || 0, 'ok')}
            ${tile('未變', s.unchanged || 0)}
            ${tile('不供餐', s.closed || 0)}
            ${tile('待處理', s.errors || 0, (s.errors || 0) > 0 ? 'bad' : '')}
        </div>

        ${errorRows ? `
        <details open class="sync-details bad">
            <summary>需要處理的 ${s.errors} 列</summary>
            <div class="table-scroll">
            <table><thead><tr><th>列</th><th>日期</th><th>原因</th></tr></thead>
            <tbody>${errorRows}</tbody></table>
            </div>
        </details>` : ''}

        ${dishRows ? `
        <details open class="sync-details">
            <summary>新建立的 ${s.newDishes} 道菜色</summary>
            <div class="table-scroll">
            <table><thead><tr><th>菜名</th><th>分類</th><th>每人份量</th></tr></thead>
            <tbody>${dishRows}</tbody></table>
            </div>
            <p class="field-hint">
                份量是分類預設，會直接影響供應量與剩食比例——請到菜色管理複核。
            </p>
        </details>` : ''}

        ${(data.created || []).length ? `
        <details class="sync-details">
            <summary>新增的 ${s.created} 天</summary>
            <div class="table-scroll">
            <table><thead><tr><th>日期</th><th>菜色</th></tr></thead>
            <tbody>${dayRows(data.created)}</tbody></table>
            </div>
        </details>` : ''}

        ${(data.updated || []).length ? `
        <details class="sync-details">
            <summary>更新的 ${s.updated} 天</summary>
            <div class="table-scroll">
            <table><thead><tr><th>日期</th><th>菜色</th></tr></thead>
            <tbody>${dayRows(data.updated)}</tbody></table>
            </div>
        </details>` : ''}

        ${closedRows ? `
        <details class="sync-details">
            <summary>不供餐的 ${s.closed} 天</summary>
            <div class="table-scroll">
            <table><thead><tr><th>日期</th><th>備註</th></tr></thead>
            <tbody>${closedRows}</tbody></table>
            </div>
        </details>` : ''}
    `;
}

// ============================================================
// 管理員面板：可調參數（拍餐盤的 ESG 幣、建議攝取）
// ============================================================

let coinRulesState = { values: null, defaults: null };

/** 參數說明：光看鍵名沒人知道要填什麼，一律附中文與單位。 */
const RULE_LABELS = {
    'plate.rewards.clean': ['光盤（剩 0–3%）', 'ESG'],
    'plate.rewards.little': ['剩一點（4–20%）', 'ESG'],
    'plate.rewards.half': ['剩不少（21–49%）', 'ESG'],
    'plate.rewards.most': ['剩一半以上（50% 以上）', 'ESG'],
    'intake.normalKcal': ['體位正常的建議熱量（一餐）', 'kcal'],
    'intake.adjustKcal': ['過重往下／過輕往上調整', 'kcal'],
    'intake.fallbackUnderweightBmi': ['查無年齡性別時的過輕界線', 'BMI'],
    'intake.fallbackOverweightBmi': ['查無年齡性別時的過重界線', 'BMI'],
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
        // 取不到就退回預設值，否則面板會整塊炸掉
        const at = (obj) => path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
        const cur = at(v);
        const def = at(d);
        return ruleInput(path, cur === undefined ? def : cur, def);
    }).join('');

    box.innerHTML = `<div class="rule-group">${scalar}</div>`;
}

/** 從表單讀回使用者填的值，組成後端要的巢狀結構。 */
function collectCoinRules() {
    const values = {};
    document.querySelectorAll('#coinRulesForm input[data-rule]').forEach((el) => {
        const keys = el.dataset.rule.split('.');
        let node = values;
        keys.slice(0, -1).forEach((k) => { node[k] = node[k] || {}; node = node[k]; });
        node[keys[keys.length - 1]] = Number(el.value);
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
    } catch (error) {
        box.innerHTML = '<p>載入失敗</p>';
    }
}

async function saveCoinRules() {
    const result = document.getElementById('coinRulesResult');
    if (!confirm('確定儲存？之後的餐盤結果就用新的額度（已發出的幣不會重算）。')) return;
    try {
        const data = await apiRequest('/admin/coin-rules', 'PUT',
            { values: collectCoinRules() });
        if (!data.success) {
            if (result) result.textContent = data.message || '儲存失敗';
            return;
        }
        coinRulesState = { values: data.values, defaults: data.defaults };
        renderCoinRules();
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
        if (result) result.textContent = '已還原為出廠預設值。';
    } catch (error) {
        if (result) result.textContent = '還原失敗：' + (error.message || '請稍後再試');
    }
}

/**
 * 底部導覽標出「現在看到的是哪一區」。
 * 以畫面上方三分之一那條線落在哪個區塊為準；用 requestAnimationFrame 合併捲動事件。
 */
let navSpyQueued = false;
function updateActiveNav() {
    navSpyQueued = false;
    const nav = document.getElementById('bottomNav');
    if (!nav || !currentUser) return;
    const line = window.innerHeight * 0.33;
    let active = null;
    nav.querySelectorAll('button[data-arg]').forEach((btn) => {
        if (btn.classList.contains('hidden')) return;
        const el = document.getElementById(btn.dataset.arg);
        if (!el || el.closest('.hidden')) return;
        const r = el.getBoundingClientRect();
        if (r.top <= line && r.bottom > line) active = btn;
    });
    nav.querySelectorAll('button[data-arg]').forEach((btn) => btn.classList.toggle('active', btn === active));
}
window.addEventListener('scroll', () => {
    if (navSpyQueued) return;
    navSpyQueued = true;
    requestAnimationFrame(updateActiveNav);
}, { passive: true });

function scrollToSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (section) {
        section.scrollIntoView({ behavior: 'smooth' });
    }
}

async function loadShopItems() {
    try {
        const data = await apiRequest('/exchange/items?limit=3', 'GET');
        const container = document.getElementById('shopList');
        if (!container) return;

        if (!data.success || !data.items || data.items.length === 0) {
            container.innerHTML = '<p>目前沒有可兌換的商品</p>';
            applyShopState(data.shopEnabled, data.shopClosedReason);
            return;
        }

        container.innerHTML = data.items.map(item => {
            const stockText = item.stock === null || item.stock === undefined
                ? '剩餘：無限'
                : `剩餘：${item.stock}`;

            return `
                <div class="gift">
                    <h3>${escapeText(item.name)}</h3>
                    <p>${escapeText(item.description || '')}</p>
                    <p>需要：${item.cost} ESG 幣</p>
                    <p class="stock">${stockText}</p>
                    <button data-action="buyItem" data-item-id="${escapeAttr(item.itemId)}" data-name="${escapeAttr(item.name)}">兌換</button>
                </div>
            `;
        }).join('');

        applyShopState(data.shopEnabled, data.shopClosedReason);
    } catch (error) {
        console.error('載入商城失敗:', error);
        const container = document.getElementById('shopList');
        if (container) container.innerHTML = '<p>載入商城失敗</p>';
    }
}

async function buyItem(el){
    try {
        const itemId = el.dataset.itemId;
        const name = el.dataset.name;

        const data = await apiRequest('/exchange/redeem', 'POST', { itemId });

        if (data.success) {
            if (data.remainingCoin !== undefined) {
                esgCoin = data.remainingCoin;
            }
            updateUI();
            await loadShopItems();
            toast("🎉 成功兌換：" + name);
        } else {
            toast(data.message || '兌換失敗');
            // 可能是剛剛被管理員關了商城：重抓一次就會顯示關閉提示並禁用按鈕
            if (data.shopClosed) await loadShopItems();
        }
    } catch (error) {
        console.error('兌換失敗:', error);
        toast('兌換失敗：' + (error.message || '請稍後再試'));
        await loadShopItems();
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
        const reasonBox = document.getElementById("surveyReason");
        const reason = reasonBox ? reasonBox.value.replace(/\s+/g, ' ').trim() : '';

        // 同樣只是省一趟往返，後端仍會再驗一次
        if (reason.length < 5) {
            toast('請填寫不喜歡的原因（至少 5 個字）');
            if (reasonBox) reasonBox.focus();
            return;
        }

        const data = await apiRequest('/task/submit-survey', 'POST',
            { favoriteFood: favorite, hateFood: hate, reason });

        if (data.success) {
            displaySurveyResult(favorite, hate);
            if (reasonBox) {
                reasonBox.value = '';
                const c = document.getElementById('surveyReasonCount');
                if (c) c.textContent = '0';
            }
            toast(
                "✅ 問卷已送出！\n\n" +
                "最喜歡：" + favorite + "\n" +
                "最不喜歡：" + hate + "\n" +
                "原因：" + reason + "\n\n" +
                "⏰ 24小時後可再次送出"
            );
        } else {
            if (data.hoursRemaining) {
                toast(
                    "⏰ 尚未達到送出時間！\n\n" +
                    "距離下次送出還需 " + data.hoursRemaining + " 小時"
                );
            } else {
                toast(data.message || '問卷送出失敗');
            }
        }
    } catch (error) {
        console.error('提交問卷失敗:', error);
        toast('問卷送出失敗，請稍後再試');
    }
}
// 家長簽到
async function parentSignIn() {
    const result = document.getElementById('parentSignInResult');
    const btn = document.getElementById('parentSignInBtn');
    const box = document.getElementById('parentComment');
    const comment = box ? box.value.replace(/\s+/g, ' ').trim() : '';

    // 前端先擋一次只是為了少跑一趟；真正的規則在後端，改掉這段也沒用
    if (comment.length < 5) {
        if (result) {
            result.className = 'verify-result error';
            result.textContent = '⚠️ 請先寫下今天想說的話（至少 5 個字），才能完成簽到';
        }
        if (box) box.focus();
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = '簽到中...'; }
    try {
        const data = await apiRequest('/parent/sign-in', 'POST', { comment });
        if (result) {
            result.className = 'verify-result ' + (data.success ? 'ok' : 'error');
            result.textContent = (data.success ? '✅ ' : '⚠️ ') + (data.message || '');
        }
        if (btn) {
            btn.textContent = data.success ? '今天已簽到 ✅' : '今日簽到（孩子 +1 ESG）';
            btn.disabled = Boolean(data.success);
        }
        // 成功後鎖住評論欄位，但保留內容——家長要看得到自己今天寫了什麼
        if (box && data.success) {
            box.value = data.comment || comment;
            box.readOnly = true;
        }
        await loadChildStatus();
    } catch (error) {
        if (result) {
            result.className = 'verify-result error';
            result.textContent = '簽到失敗：' + (error.message || '請稍後再試');
        }
        if (btn) { btn.disabled = false; btn.textContent = '今日簽到（孩子 +1 ESG）'; }
    }
}

/**
 * 收起開場影片並真正停止播放。
 *
 * 原本是 `iframe.src = ''`，但空字串會被當成**相對路徑**解析成目前的文件網址，
 * 於是 iframe 會改載 index.html —— 整個 app 在隱藏的 iframe 裡又跑一遍
 * （重複註冊事件、重複打 API、重複寫 localStorage）。
 * 直接把 iframe 移掉才是乾淨的停止：覆蓋層已經收起來，沒有留著它的理由。
 */
function closeIntro() {
    const intro = document.getElementById('introVideo');
    if (!intro) return;
    intro.classList.add('hidden');
    const iframe = intro.querySelector('iframe');
    if (iframe) iframe.remove();
}

function skipIntro() {
    closeIntro();
    try {
        localStorage.setItem('lunchIntroSkipped', 'true');
    } catch (error) {
        // 無痕視窗或封鎖網站資料時會丟錯。記不住就記不住，
        // 下次重新看一次開場影片而已，不該讓「跳過」本身失敗。
        console.warn('無法記住已跳過開場影片:', error.message);
    }
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
    if(esgCoin < 40){
        toast("❌ ESG 幣不足！需要 40 ESG 幣進行抽獎");
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
            toast(data.message || '❌ 抽獎失敗');
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
                    <div class="prize-value">價值：${prizeValue} ESG</div>
                    <div class="prize-balance">ESG 餘額：${data.remainingCoin}</div>
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
                    <div class="prize-value">價值：${prizeValue} ESG</div>
                    <div class="prize-balance">ESG 餘額：${data.remainingCoin}</div>
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
                    <div class="prize-value">價值：${prizeValue} ESG</div>
                    <div class="prize-balance">ESG 餘額：${data.remainingCoin}</div>
                </div>
            `;
            loadLotteryAnnouncement();
        }

        // 同步 ESG 餘額（僅扣除抽獎成本，不返還獎品價值）
        esgCoin = data.remainingCoin;
        updateUI();

    } catch (error) {
        console.error('抽獎失敗:', error);
        toast('❌ 抽獎失敗，請稍後再試');
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
    parent: '家長',
    teacher: '老師',
    technician: '技術員',
    admin: '管理員'
};

/**
 * 這個人身上的「身分標籤」，決定看得到哪些區塊。
 *
 * 午餐長不是帳號角色，而是附加在學生帳號上的身分（後端 profile 的 isLunchLeader），
 * 所以學生兼午餐長同時有 student 與 lunch_leader 兩個標籤：
 * 學生的區塊全部保留，再多一個午餐長專區。
 */
function viewTags(user) {
    if (!user) return [];
    const tags = [user.role || 'student'];
    if (user.isLunchLeader) tags.push('lunch_leader');
    return tags;
}

/** 依身分顯示／隱藏底部導覽與各專區，避免出現點了沒權限的按鈕。 */
function applyRoleView() {
    const role = (currentUser && currentUser.role) || 'student';
    const tags = viewTags(currentUser);
    const sees = (allowed) => allowed.some((t) => tags.includes(t));

    document.querySelectorAll('#bottomNav button[data-roles]').forEach((btn) => {
        btn.classList.toggle('hidden', !sees(btn.dataset.roles.split(',')));
    });

    // 每個區塊由誰看得到。未登入時沒有任何標籤，全部都會被關掉。
    // 管理員不再看午餐長／老師專區：任何班的稱重與餐盤都在管理員專區的「班級」裡操作。
    const panels = [
        ['home', ['student', 'teacher', 'admin']],
        ['balanceStrip', ['student']],
        ['plateCard', ['student']],
        ['ranking', ['student', 'teacher', 'admin']],
        ['trend', ['student', 'teacher', 'admin']],
        ['shop', ['student']],
        ['survey', ['student']],
        ['leader', ['lunch_leader']],
        ['teacher', ['teacher']],
        ['adminZone', ['admin']],
        ['parentZone', ['parent']],
        ['techZone', ['technician', 'admin']],
        ['supportTaskCard', ['student', 'teacher', 'admin']]
    ];
    const signedIn = Boolean(currentUser);
    panels.forEach(([id, allowed]) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !signedIn || !sees(allowed));
    });

    // 底部導覽只在登入後出現（原本綁在 scroll 事件上，平時整條藏在畫面外）
    const nav = document.getElementById('bottomNav');
    if (nav) nav.classList.toggle('visible', signedIn);

    const roleTag = document.getElementById('userRoleTag');
    if (roleTag) {
        roleTag.textContent = (ROLE_LABEL[role] || role) + (tags.includes('lunch_leader') ? '・午餐長' : '');
    }

    applyRoleOrder(tags.includes('lunch_leader') ? 'lunch_leader' : role);
    if (!signedIn) stopSupportPolling();     // 登出後不該繼續打 API
    updateActiveNav();
}

// ============================================================
// 角色化區塊排序
// ============================================================
//
// 原本所有角色看到的順序都一樣（首頁→排行→趨勢→兌換→問卷→紀錄→…），
// 但不同身分的高頻操作差很多：
//   · 午餐長最急的是「紀錄」（午餐時間就要稱重），卻要捲過四個區塊才看得到
//   · 家長只做「簽到」
//   · 學生才是真的以首頁與兌換為主
// 把最常用的排在最前面，少一次捲動就少一次摩擦。
//
// 這裡直接搬 DOM 節點而不是用 CSS order：
// 一來 #app 不是 flex 容器，二來搬節點連鍵盤 Tab 順序與螢幕閱讀器
// 的閱讀順序一起修正，純視覺的 order 做不到這件事。

const ROLE_PANEL_ORDER = {
    // 學生兼午餐長：紀錄 →（紀錄完最常接著找別班補菜）支援 → 其餘學生區塊
    lunch_leader: ['leader', 'supportTaskCard', 'home', 'shop', 'ranking', 'trend', 'survey'],
    // 老師：先看本班今天的餐盤結果
    teacher: ['teacher', 'home', 'supportTaskCard', 'ranking', 'trend'],
    // 學生：看自己的幣與午餐狀況，然後才是兌換
    student: ['home', 'supportTaskCard', 'shop', 'ranking', 'trend', 'survey'],
    parent: ['parentZone'],
    technician: ['techZone'],
    admin: ['adminZone', 'techZone', 'home', 'supportTaskCard', 'ranking', 'trend'],
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

/** 依身分載入該看的資料。 */
async function loadRoleData() {
    const role = (currentUser && currentUser.role) || 'student';
    const isLeader = viewTags(currentUser).includes('lunch_leader');

    // 各區塊互不相依，一起載入：原本一個等一個，登入後要好幾秒才全部出來
    if (role === 'parent') return loadChildStatus();
    if (role === 'technician') return loadDevices();   // 技術員只管硬體，不載入學生相關資料

    const tasks = [loadSupportDishes(), loadHeroBoard(), loadTrend()];
    if (role === 'admin') tasks.push(refreshAdminActive(), loadDevices());
    if (role === 'teacher') tasks.push(loadClassPlates());
    if (isLeader) tasks.push(loadRecordToday().then(() => loadWeighQueue()));
    if (role === 'student') tasks.push(loadPlateToday(), loadShopItems());
    await Promise.all(tasks);
}

// ============================================================
// 老師：本班餐盤結果（唯讀）
// ============================================================
//
// 「今天吃得怎麼樣」以學生自己拍的餐盤為準，老師不再逐生勾選。
// 這裡只讓老師看得到全班狀況；辨識錯了由管理員更正。

/** 級距 → 顏色標記（光盤綠、剩一點淺綠、剩不少與一半以上橘）。 */
function plateBadge(scan) {
    if (!scan) return '<span class="badge badge-muted">還沒拍</span>';
    return `<span class="badge badge-${escapeAttr(scan.level)}">${escapeText(scan.label)}</span>`;
}

async function loadClassPlates() {
    const list = document.getElementById('classPlateList');
    const summary = document.getElementById('classPlateSummary');
    const dateInput = document.getElementById('teacherPlateDate');
    if (!list) return;
    if (dateInput && !dateInput.value) dateInput.value = new Date().toLocaleDateString('sv');
    const date = dateInput ? dateInput.value : '';
    try {
        const data = await apiRequest('/plate/class' + (date ? `?date=${encodeURIComponent(date)}` : ''), 'GET');
        if (!data.success) {
            list.innerHTML = `<p class="field-hint">${escapeText(data.message || '載入失敗')}</p>`;
            if (summary) summary.innerHTML = '';
            return;
        }
        const s = data.summary || {};
        const label = (lv) => ((data.tiers || []).find((t) => t.level === lv) || {}).label || lv;
        if (summary) {
            summary.innerHTML = `
                <div class="stat"><span class="stat-n">${s.scanned || 0}<small>/${s.total || 0}</small></span><span>已拍</span></div>
                ${['clean', 'little', 'half', 'most'].map((lv) => `
                <div class="stat stat-${lv}"><span class="stat-n">${s[lv] || 0}</span><span>${escapeText(label(lv))}</span></div>`).join('')}`;
        }
        if (!data.rows.length) {
            list.innerHTML = '<p class="field-hint">這個班級還沒有學生</p>';
            return;
        }
        list.innerHTML = `
            <div class="table-scroll"><table class="data-table">
                <thead><tr><th>座號</th><th>姓名</th><th>結果</th><th class="num">剩餘</th></tr></thead>
                <tbody>${data.rows.map((r) => `
                    <tr>
                        <td>${escapeText(r.seatNo || '—')}</td>
                        <td>${escapeText(r.displayName)}${r.isLunchLeader ? ' <span class="badge badge-leader">午餐長</span>' : ''}</td>
                        <td>${plateBadge(r.scan)}</td>
                        <td class="num">${r.scan ? r.scan.leftoverPct + '%' : '—'}</td>
                    </tr>`).join('')}
                </tbody>
            </table></div>`;
    } catch (error) {
        list.innerHTML = '<p class="field-hint">載入失敗，請稍後再試</p>';
    }
}

// ============================================================
// 午餐長：全班剩食紀錄（開始 → 依序稱重 → 完成）
// ============================================================
//
// 這是單純的紀錄：結算只彙總全班剩了多少，不發幣。
// 稱重清單與即時讀數見上方的「依序稱重」。

let recordSession = null;

async function loadRecordToday() {
    const statusBox = document.getElementById('recordStatus');
    const startBtn = document.getElementById('startRecordBtn');
    if (!statusBox) return;

    try {
        const data = await apiRequest('/record/today', 'GET');
        if (!data.success) {
            statusBox.innerHTML = `<p>${escapeText(data.message || '無法載入今日紀錄')}</p>`;
            if (startBtn) startBtn.classList.add('hidden');
            return;
        }
        if (data.status === 'none') {
            recordSession = null;
            statusBox.innerHTML = `<p>${escapeText(data.message || '今日尚未開始紀錄')}</p>`;
            if (startBtn) startBtn.classList.toggle('hidden', !data.menuReady);
            renderRecordSummary();
            return;
        }
        recordSession = data.session;
        if (startBtn) startBtn.classList.add('hidden');
        statusBox.innerHTML = `<p>${escapeText(recordSession.date)}　供餐 ${recordSession.servings} 份　`
            + `狀態：${recordSession.status === 'done' ? '已完成' : '進行中'}</p>`;
        renderRecordSummary();
    } catch (error) {
        statusBox.innerHTML = '<p>無法載入今日紀錄</p>';
    }
}

async function startRecord() {
    try {
        const data = await apiRequest('/record/start', 'POST', {});
        if (!data.success) {
            toast(data.message || '無法開始紀錄');
            return;
        }
        await loadRecordToday();
        await loadWeighQueue();
    } catch (error) {
        toast('無法開始紀錄：' + (error.message || '請稍後再試'));
    }
}

/** 量完就能結算；已結算的顯示當天全班剩多少。 */
function renderRecordSummary() {
    const box = document.getElementById('recordSummary');
    if (!box) return;
    const s = recordSession && recordSession.summary;
    const p = (recordSession && recordSession.progress) || {};

    if (!recordSession) { box.innerHTML = ''; return; }
    if (recordSession.status === 'done' && s) {
        box.innerHTML = `
            <div class="record-summary">
                <p>今日全班剩食 <strong>${Math.round(s.totalG)}</strong> g
                   （人均 ${recordSession.wastePerCapitaG == null ? '—' : recordSession.wastePerCapitaG} g）
                   耗損 <strong>${s.totalCost}</strong> 元　碳排 <strong>${s.totalCo2e}</strong> kgCO₂e</p>
            </div>`;
        return;
    }
    box.innerHTML = p.total > 0 && p.done === p.total
        ? '<button data-action="finalizeRecord" class="auth-btn">完成今日紀錄</button>'
        : '<p class="field-hint">每道菜都量完才能完成今日紀錄。</p>';
}

async function finalizeRecord() {
    if (!confirm('確定完成今日紀錄？')) return;
    try {
        const data = await apiRequest('/record/finalize', 'POST', {});
        if (!data.success) {
            toast(data.message || '完成紀錄失敗');
            return;
        }
        const s = data.summary || {};
        toast(`${data.message}\n\n全班剩食 ${Math.round(s.totalG || 0)} g（${data.servings} 份，人均 ${data.wastePerCapitaG} g）`);
        stopScalePolling();
        await loadRecordToday();
        await loadWeighQueue();
        await loadSupportDishes();
    } catch (error) {
        toast('完成紀錄失敗：' + (error.message || '請稍後再試'));
    }
}

/** 壓縮後再上傳，校園網路友善。長邊預設 1024px、JPEG 85%。 */
function downscaleImage(file, maxSide = 1024) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
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

// ============================================================
// 學生：今日午餐（拍自己的餐盤 → 剩多少 → 回饋與 ESG 幣）
// ============================================================
//
// 辨識在後端跑（模型端點見 backend/lib/plateModel.js）。照片只用來辨識，不會存下來。
// 一天只能拍一次；結果有誤請找管理員更正。

let plateState = { served: false, ready: false, scanned: false };

async function loadPlateToday() {
    const box = document.getElementById('plateResult');
    if (!box) return;
    try {
        const data = await apiRequest('/plate/today', 'GET');
        if (!data.success) {
            box.innerHTML = `<p class="field-hint">${escapeText(data.message || '載入失敗')}</p>`;
            return;
        }
        renderPlateTiers(data.tiers || []);
        renderPlateRecent(data.stats);
        renderPlate(data.scan, data);
    } catch (error) {
        box.innerHTML = '<p class="field-hint">載入失敗</p>';
    }
}

/** 四級與各自的 ESG 幣，拍之前就看得到規則。 */
function renderPlateTiers(tiers) {
    const box = document.getElementById('plateTiers');
    if (!box || !tiers.length) return;
    box.innerHTML = tiers.map((t) => `
        <div class="tier tier-${escapeAttr(t.level)}">
            <span class="tier-label">${escapeText(t.label)}</span>
            <span class="tier-range">${t.minPct}–${t.maxPct}%</span>
            <span class="tier-reward">+${t.reward}</span>
        </div>`).join('');
}

function renderPlateRecent(stats) {
    const el = document.getElementById('plateRecent');
    if (!el || !stats) return;
    el.textContent = stats.scannedDays
        ? `近 ${stats.days} 天拍了 ${stats.scannedDays} 天，光盤 ${stats.cleanDays} 天`
        : '';
}

function renderPlate(scan, ctx) {
    const box = document.getElementById('plateResult');
    const btn = document.getElementById('plateBtn');
    if (!box) return;
    plateState = {
        served: Boolean(ctx.served),
        ready: Boolean(ctx.model && ctx.model.ready),
        scanned: Boolean(scan),
    };

    let blocked = '';
    if (scan) blocked = '今天已經拍過了。結果有誤請找管理員更正。';
    else if (!ctx.served) blocked = '今天沒有供餐，不需要拍餐盤。';
    else if (!plateState.ready) blocked = `⚠️ ${(ctx.model && ctx.model.note) || '辨識模型尚未接上'}，暫時不能拍。`;

    if (btn) {
        btn.disabled = Boolean(blocked);
        btn.textContent = scan ? '✅ 今天已拍' : '📷 拍餐盤';
    }

    if (!scan) {
        box.innerHTML = `<p class="field-hint">${escapeText(blocked || '吃完後拍一張，看看今天剩多少。')}</p>`;
        return;
    }

    const f = scan.feedback || {};
    box.innerHTML = `
        <div class="plate-feedback ${escapeAttr(f.level || '')}">
            <p class="plate-title">${escapeText(f.title || '')}
                ${scan.coinsAwarded ? `<span class="plate-coins">ESG +${scan.coinsAwarded}</span>` : ''}</p>
            <p>${escapeText(f.message || '')}</p>
            <p class="field-hint">剩約 ${scan.leftoverPct}%（${escapeText(scan.label || '')}）
                ${scan.source === 'admin' ? '　管理員已更正' : ''}
                ${scan.stub ? '　<strong>（開發用假結果，模型尚未接上）</strong>' : ''}</p>
        </div>`;
}

function capturePlate(el) {
    if (!plateState.served || !plateState.ready || plateState.scanned) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        if (!confirm('一天只能拍一次，確定用這張照片嗎？')) return;
        el.disabled = true;
        el.textContent = '辨識中…';
        try {
            const image = await downscaleImage(file);
            const data = await apiRequest('/plate/scan', 'POST', { image });
            if (!data.success) {
                toast(data.message || '辨識失敗');
                await loadPlateToday();
                return;
            }
            renderPlate(data.scan, { served: true, model: data.model });
            await loadUserData();
            await loadPlateToday();
        } catch (error) {
            toast('辨識失敗：' + (error.message || '請稍後再試'));
            await loadPlateToday();
        }
    });
    input.click();
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

/**
 * 決定要不要繼續輪詢。
 *
 * 兩種情況需要持續更新：
 *   · 本班有菜缺貨 → 在等別班記錄出現
 *   · 正在紀錄中   → 跨班資訊現在是紀錄畫面的一部分，別班隨時在變
 * 其餘情況不輪詢，避免沒人在看的時候一直打 API。
 */
function isRecordingNow() {
    return Boolean(recordSession) && recordSession.status !== 'done';
}

function syncSupportPolling() {
    const needed = currentUser && (supportState.hasShortage || isRecordingNow());
    if (needed) startSupportPolling();
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
                    <span>${escapeText(d.dishName)}</span>
                    <span>剩 ${d.remainingPct}%（${d.leftoverG}g）</span>
                </div>
                <div class="dish-bar"><div class="dish-bar-fill" data-bar-width="${Math.min(100, d.remainingPct)}"></div></div>
                ${renderCrossClass(d)}
            </div>
        `).join('');
        applyBarSizes(box);
        renderSupportMeta();
        syncSupportPolling();
    } catch (error) {
        box.innerHTML = '<p>載入失敗</p>';
    } finally {
        supportState.loading = false;
        box.removeAttribute('aria-busy');
    }
}

/**
 * 一道菜的跨班狀況。支援卡片與紀錄面板共用這一段。
 *
 * 常態顯示後要處理四種情況，而不是只有「缺貨且有人能幫」：
 *   本班缺 + 別班有   → 去哪一班拿（主要用途）
 *   本班缺 + 別班沒有 → 明說沒有，並告知會自動更新，免得一直重按
 *   本班有剩 + 別班缺 → 可以主動提供（這是舊版完全看不到的情況）
 *   都還有            → 只報個數字，不喧賓奪主
 */
function renderCrossClass(d) {
    const others = d.otherClasses || [];
    if (!others.length) {
        return d.shortage
            ? '<p class="field-hint">本班快吃完了，目前沒有其他班的紀錄——別班陸續記錄後會自動更新。</p>'
            : '<p class="field-hint">其他班今天還沒記錄這道菜。</p>';
    }

    // 對方也低於門檻時要講明，免得白跑一趟
    const label = (o) => `${o.className} 班 ${o.leftoverG}g`
        + (o.shortage ? '<span class="offer-warn">（他們也快沒了）</span>' : '');

    const offers = others.filter((o) => o.canOffer);
    if (d.shortage) {
        return offers.length
            ? `<p class="dish-help">🤝 去這些班拿：${offers.map(label).join('、')}</p>`
            : `<p class="field-hint">本班快吃完了，其他班也都只剩一點：`
              + `${others.map(label).join('、')}</p>`;
    }

    const needy = others.filter((o) => o.shortage);
    if (needy.length) {
        return `<p class="dish-share">💪 本班還有，這些班缺：`
             + `${needy.map((o) => `${o.className} 班只剩 ${o.leftoverG}g`).join('、')}</p>`;
    }
    return `<p class="dish-other">其他班：${others.map((o) =>
        `${o.className} 班 ${o.leftoverG}g`).join('、')}</p>`;
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
            box.innerHTML = `<p>${escapeText(data.message || '無法載入孩子資料')}</p>`;
            return;
        }
        const c = data.child;
        const p = data.todayPlate;
        const state = p
            ? `<span class="badge badge-${escapeAttr(p.level)}">${escapeText(p.label)}</span>　剩約 ${p.leftoverPct}%`
                + (p.coinsAwarded ? `，得到 ESG +${p.coinsAwarded}` : '')
            : '<span class="status-pending">⏳ 孩子今天還沒拍餐盤</span>';
        const s = data.stats || {};

        box.innerHTML = `
            <p><strong>${escapeText(c.displayName)}</strong>　${escapeText(c.className || '')} 班 ${escapeText(c.seatNo || '')} 號</p>
            <p>今天：${state}</p>
            <p>孩子目前 ESG 幣 ${c.coins.ESG}</p>
            <p class="field-hint">近 ${s.days || 7} 天拍了 ${s.scannedDays || 0} 天，光盤 ${s.cleanDays || 0} 天</p>
            ${data.classDishesToday.length ? `<p class="field-hint">今天全班剩餘：${data.classDishesToday.map((d) => `${escapeText(d.dishName)} ${d.remainingPct}%`).join('、')}</p>` : ''}
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
                    <div class="trend-bar" data-bar-height="${h}" title="${p.remainingPct}%"></div>
                    <span class="trend-x">${label}</span>
                </div>`;
    }).join('') + '</div>';
    // 長條高度是資料驅動的，插入 DOM 後才能用 CSSOM 套上去（見 applyBarSizes）
    applyBarSizes(box);

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
                <button data-action="deleteDeviceRow" data-device-id="${escapeAttr(d.deviceId)}"
                        class="danger-btn">刪除</button>
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
        toast((data.success ? '✅ ' : '⚠️ ') + (data.message || ''));
        if (data.success) await loadDevices();
    } catch (error) {
        toast('綁定失敗：' + (error.message || '請稍後再試'));
    }
}

async function setTareManual(el) {
    const deviceId = el.dataset.deviceId;
    const input = devInput('dev-tare', deviceId);
    const tareG = Number(input && input.value);
    if (!Number.isFinite(tareG) || tareG < 0) { toast('請先填入盆重（公克）'); return; }
    await submitTare(deviceId, { mode: 'manual', tareG });
}

async function setTareLatest(el) {
    if (!confirm('請確認秤上放的是「空盆」，系統會把目前讀數設為盆體扣重。')) return;
    await submitTare(el.dataset.deviceId, { mode: 'latest' });
}

async function submitTare(deviceId, payload) {
    try {
        const data = await apiRequest(`/tech/devices/${deviceId}/tare`, 'POST', payload);
        toast((data.success ? '✅ ' : '⚠️ ') + (data.message || ''));
        if (data.success) await loadDevices();
    } catch (error) {
        toast('設定扣重失敗：' + (error.message || '請稍後再試'));
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
        box.innerHTML = '<div class="table-scroll"><table class="reading-table">'
            + '<tr><th>時間</th><th>原始值</th><th>毛重</th><th>淨重</th></tr>' +
            data.readings.map((r) => `
                <tr class="${r.outOfRange ? 'out-of-range' : ''}">
                    <td>${r.receivedAt ? new Date(r.receivedAt).toLocaleTimeString('zh-TW') : '-'}</td>
                    <td>${r.raw ?? '-'}</td>
                    <td>${r.grossG}g</td>
                    <td>${r.netG}g${r.stable === false ? '（不穩）' : ''}</td>
                </tr>`).join('') + '</table></div>';
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
    refreshNow: () => refreshAll(),
    verifyStudentBinding,
    parentSignIn,
    buyItem,
    submitSurvey,
    skipIntro,
    scrollToSection: (el) => scrollToSection(el.dataset.arg),
    openLottery,
    closeLottery,
    spinLottery,
    // 老師：本班餐盤結果（唯讀）
    loadClassPlates: () => loadClassPlates(),
    // 午餐長：全班剩食紀錄
    startRecord,
    finalizeRecord,
    // 學生：拍餐盤
    capturePlate: (el) => capturePlate(el),
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
    // 管理員：從 Google 試算表同步名冊
    syncStudents: () => syncStudents(),
    syncStudentsDryRun: () => syncStudentsDryRun(),
    saveShopState: () => saveShopState(),
    deleteDeviceRow: (el) => deleteDeviceRow(el),
    loadWeighQueue: () => loadWeighQueue(),
    weighDish: (el) => weighDish(el),
    weighEmptied: (el) => weighEmptied(el),
    loadBucketTare: () => loadBucketTare(),
    measureTare: (el) => measureTare(el),
    saveTare: (el) => saveTare(el),
    syncMenus: () => syncMenus(),
    syncMenusDryRun: () => syncMenusDryRun(),
    // 管理員：可調參數
    loadCoinRules: () => loadCoinRules(),
    saveCoinRules: () => saveCoinRules(),
    resetCoinRules: () => resetCoinRules(),
    // 管理員的班級、帳號、資料檢查在 admin.js 補進來
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

// 兩個必填的長文字欄位即時顯示字數：使用者要看得到自己離門檻多遠，
// 而不是按下送出才被退回。
document.addEventListener('input', (event) => {
    const COUNTERS = {
        parentComment: 'parentCommentCount',
        surveyReason: 'surveyReasonCount',
    };
    const counterId = COUNTERS[event.target && event.target.id];
    if (!counterId) return;
    const el = document.getElementById(counterId);
    // 用與送出時相同的正規化，否則使用者看到的字數會跟實際送出的不一樣
    if (el) el.textContent = String(event.target.value.replace(/\s+/g, ' ').trim().length);
});

document.addEventListener('change', (event) => {
    // 下拉選單上的 data-action 必須走 change 而不是 click：
    // 點開選單就會觸發 click，那時值還沒改，拿到的是改之前的選項。
    const sel = event.target && event.target.closest
        ? event.target.closest('select[data-action]')
        : null;
    const changeEl = event.target && event.target.closest ? event.target.closest('[data-change]') : null;
    if (changeEl) runAction(changeEl.dataset.change, changeEl);
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
});

/** 用名稱執行一個 ACTION_HANDLERS 裡的動作（給 data-change / data-input / data-enter 共用）。 */
function runAction(name, el) {
    const handler = ACTION_HANDLERS[name];
    if (!handler) return;
    Promise.resolve(handler(el)).catch((error) => console.error(`執行 ${name} 失敗:`, error));
}

// 輸入時即時動作（例如班級清單篩選）
document.addEventListener('input', (event) => {
    const el = event.target && event.target.closest ? event.target.closest('[data-input]') : null;
    if (el) runAction(el.dataset.input, el);
});

// 在搜尋框按 Enter 等於按搜尋
document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const el = event.target && event.target.closest ? event.target.closest('[data-enter]') : null;
    if (!el) return;
    event.preventDefault();
    runAction(el.dataset.enter, el);
});

// 若已跳過開場影片，直接隱藏（連 iframe 都不要留，省掉一次 YouTube 載入）
try {
    if (localStorage.getItem('lunchIntroSkipped') === 'true') closeIntro();
} catch (error) {
    console.warn('讀不到開場影片的設定，照常播放:', error.message);
}

syncRegisterFields();

// 頁面載入時嘗試恢復登入狀態
restoreSession();