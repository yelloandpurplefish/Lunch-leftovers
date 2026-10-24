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

// 只顯示登入區：主要內容與底部導覽列一律收起來
function showAuthOnly() {
  const authView = document.getElementById('authView');
  const appContent = document.getElementById('appContent');
  const bottomNav = document.getElementById('bottomNav');

  if (authView) authView.classList.remove('hidden');
  if (appContent) appContent.classList.add('hidden');
  if (bottomNav) {
    bottomNav.classList.add('hidden');
    bottomNav.classList.remove('visible');
  }
}

// 顯示登入表單
function showAuthForm() {
  document.getElementById('authContainer').classList.remove('hidden');
  document.getElementById('loggedInContainer').classList.add('hidden');
}

// 顯示已登入狀態（仍停留在登入區，按「開始使用」才進入主要內容）
function showLoggedInState() {
  document.getElementById('authContainer').classList.add('hidden');
  document.getElementById('loggedInContainer').classList.remove('hidden');
  showAuthOnly();

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

function syncRolePanels() {
    const parentCard = document.getElementById('parentSignIn');
    if (!parentCard) return;

    if (currentUser && currentUser.role === 'parent') {
        parentCard.classList.remove('hidden');
    } else {
        parentCard.classList.add('hidden');
    }
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

// 底部導覽列顯示/隱藏
window.addEventListener('scroll', function() {
    const bottomNav = document.querySelector('.bottom-nav');
    if (!bottomNav) return;
    
    const scrollPosition = window.innerHeight + window.scrollY;
    const pageHeight = document.documentElement.scrollHeight;
    
    // 當滾動到距離底部 150px 以內時顯示，避免遮擋內容
    if (pageHeight - scrollPosition < 150) {
        bottomNav.classList.add('visible');
    } else {
        bottomNav.classList.remove('visible');
    }
});

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

    // 隱藏影片區
    document.querySelector(".video").style.display = "none";

    // 顯示首頁
    document.getElementById("home").classList.remove("hidden");

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
    loadPendingTasks,
    verifyTask: (el) => verifyTask(el)
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
    if (event.target && event.target.name === 'registerRole') {
        syncRegisterFields();
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