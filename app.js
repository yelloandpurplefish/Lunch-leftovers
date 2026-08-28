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
      body: JSON.stringify({ email, password })
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
  const email = document.getElementById('registerEmail').value;
  const password = document.getElementById('registerPassword').value;
  const confirmPassword = document.getElementById('registerConfirmPassword').value;
  const errorElement = document.getElementById('registerError');
  const registerBtn = document.querySelector('#registerForm .auth-btn');

  if (!name || !email || !password || !confirmPassword) {
    errorElement.textContent = '請填寫所有欄位';
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
      body: JSON.stringify({ email, password, displayName: name })
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
    gCoin = 0;
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
      gCoin = data.userData.gCoin || 0;
      score = data.userData.score || 0;

      // 同步前端 currentUser
      currentUser = {
        uid: data.userData.userId,
        email: data.userData.email,
        displayName: data.userData.displayName,
        role: data.userData.role
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
}

// 顯示已登入狀態
function showLoggedInState() {
  document.getElementById('authContainer').classList.add('hidden');
  document.getElementById('loggedInContainer').classList.remove('hidden');

  const displayName = currentUser.displayName || currentUser.email || '使用者';
  document.getElementById('userDisplayName').textContent = displayName;
  updateLoggedInStats();

  const teacherPanel = document.getElementById('teacherPanel');
  if (teacherPanel) {
    if (currentUser && (currentUser.role === 'teacher' || currentUser.role === 'admin')) {
      teacherPanel.classList.remove('hidden');
    } else {
      teacherPanel.classList.add('hidden');
    }
  }
}

// 更新已登入狀態的統計數據
function updateLoggedInStats() {
  const userGCoinEl = document.getElementById('userGCoin');
  if (userGCoinEl) userGCoinEl.textContent = gCoin;
  document.getElementById('userECoin').textContent = eCoin;
  document.getElementById('userSCoin').textContent = sCoin;
  document.getElementById('userScore').textContent = score;
}

// 更新 UI
function updateUI() {
  document.getElementById('ecoin').textContent = eCoin;
  document.getElementById('scoin').textContent = sCoin;
  document.getElementById('gcoin').textContent = gCoin;
  document.getElementById('score').textContent = score;
  updateLoggedInStats();
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

// 老師載入待審核項目
async function loadPendingTasks() {
    try {
        const data = await apiRequest('/task/pending', 'GET');
        const container = document.getElementById('pendingList');
        if (!container) return;

        if (!data.success) {
            container.innerHTML = `<p>載入失敗：${data.message}</p>`;
            return;
        }

        if (!data.pending || data.pending.length === 0) {
            container.innerHTML = '<p>目前沒有待審核項目</p>';
            return;
        }

        const taskTypeNames = {
            light_disc: '光盤行動',
            leftover_reward: '剩食獎勵',
            survey: '今日問卷'
        };

        container.innerHTML = data.pending.map(item => {
            const taskName = taskTypeNames[item.taskType] || item.taskType;
            const rewardText = item.rewards && (item.rewards.eCoin || item.rewards.sCoin)
                ? `（E幣 +${item.rewards.eCoin || 0}, S幣 +${item.rewards.sCoin || 0}, 積分 +${item.rewards.score || 0}）`
                : '';
            let detailText = '';
            if (item.taskType === 'survey') {
                detailText = `最喜歡：${item.metadata.favoriteFood || ''} / 最不喜歡：${item.metadata.hateFood || ''}`;
            } else if (item.taskType === 'leftover_reward') {
                detailText = `剩食重量：${item.metadata.leftoverWeight || 0}g`;
            }

            return `
                <div class="pending-item" style="border: 1px solid #ddd; padding: 12px; margin-bottom: 10px; border-radius: 8px; background: #fff;">
                    <div><strong>${item.displayName}</strong> 申請了 <strong>${taskName}</strong> ${rewardText}</div>
                    <div style="font-size: 14px; color: #666; margin: 6px 0;">${detailText}</div>
                    <div style="margin-top: 8px;">
                        <button data-action="verifyTask" data-record-id="${item.recordId}" data-verify-action="approve" style="margin-right: 8px;">✅ 核准</button>
                        <button data-action="verifyTask" data-record-id="${item.recordId}" data-verify-action="reject">❌ 拒絕</button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('載入待審核項目失敗:', error);
    }
}

// 老師審核項目
async function verifyTask(el) {
    try {
        const recordId = el.dataset.recordId;
        const action = el.dataset.verifyAction;

        const data = await apiRequest('/task/verify', 'POST', { recordId, action });

        if (data.success) {
            alert(data.message);
            await loadPendingTasks();
            await loadUserData();
        } else {
            alert(data.message || '審核失敗');
        }
    } catch (error) {
        console.error('審核失敗:', error);
        alert('審核失敗，請稍後再試');
    }
}

// 滾動到指定區塊
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

    // 自動分析剩食
    setupFoodAnalysis();

    // 載入全站大獎公告
    await loadLotteryAnnouncement();

    // 載入支援任務狀態
    await loadSupportStatus();

    // 老師載入待審核項目
    if (currentUser && (currentUser.role === 'teacher' || currentUser.role === 'admin')) {
        await loadPendingTasks();
    }
}

// 完成任務
async function finishTask(){
    try {
        const data = await apiRequest('/task/complete-light-disc', 'POST');

        if (data.success) {
            eCoin += data.rewards.eCoin;
            sCoin += data.rewards.sCoin;
            gCoin += data.rewards.gCoin;
            score += data.rewards.score;
            updateUI();
            await loadSupportStatus();

            alert(
                "🎉 任務完成！\n\n" +
                "E幣 +" + data.rewards.eCoin + "\n" +
                "S幣 +" + data.rewards.sCoin + "\n" +
                "減碳存摺 +" + data.rewards.gCoin + "\n" +
                "積分 +" + data.rewards.score + "\n\n" +
                "⏰ 24小時後可再次領取"
            );
        } else {
            if (data.hoursRemaining) {
                alert(
                    "⏰ 尚未達到領取時間！\n\n" +
                    "距離下次領取還需 " + data.hoursRemaining + " 小時"
                );
            } else {
                alert(data.message || '任務完成失敗');
            }
        }
    } catch (error) {
        console.error('完成任務失敗:', error);
        alert('任務完成失敗，請稍後再試');
    }
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

        container.innerHTML = data.items.map(item => {
            const coinName = { E: 'E幣', S: 'S幣', G: '減碳存摺' }[item.costType] || item.costType;
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
            const coinFieldMap = { E: 'eCoin', S: 'sCoin', G: 'gCoin' };
            const coinField = coinFieldMap[costType];
            if (coinField && data.remainingCoin !== undefined) {
                window[coinField] = data.remainingCoin;
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
function analyzeFood(){

    const foods = [

        {
            name:"🍗 香酥雞腿",
            value:Number(document.getElementById("food1").value)
        },

        {
            name:"🥬 高麗菜",
            value:Number(document.getElementById("food2").value)
        },

        {
            name:"🥚 蒸蛋",
            value:Number(document.getElementById("food3").value)
        },

        {
            name:"🍎 蘋果",
            value:Number(document.getElementById("food4").value)
        },

        {
            name:"🥣 玉米濃湯",
            value:Number(document.getElementById("food5").value)
        }

    ];

    let most = foods[0];
    let least = foods[0];

    for(const food of foods){

        if(food.value > most.value){
            most = food;
        }

        if(food.value < least.value){
            least = food;
        }

    }

    document.getElementById("mostFood").innerHTML =
        "🥇 剩最多：" + most.name + "（" + most.value + " 克）";

    document.getElementById("leastFood").innerHTML =
        "🥗 剩最少：" + least.name + "（" + least.value + " 克）";

    // 繪製剩食長條圖
    renderFoodBarChart();

}

function renderFoodBarChart(){

    const container = document.getElementById("foodChartContainer");
    if(!container) return;

    const foods = [
        { name: "🍗 香酥雞腿", value: Number(document.getElementById("food1").value) || 0 },
        { name: "🥬 高麗菜", value: Number(document.getElementById("food2").value) || 0 },
        { name: "🥚 蒸蛋", value: Number(document.getElementById("food3").value) || 0 },
        { name: "🍎 蘋果", value: Number(document.getElementById("food4").value) || 0 },
        { name: "🥣 玉米濃湯", value: Number(document.getElementById("food5").value) || 0 }
    ];

    const max = Math.max(...foods.map(f => f.value), 1);

    container.style.flexDirection = 'column';
    container.style.alignItems = 'stretch';
    container.style.justifyContent = 'flex-start';
    container.style.height = 'auto';

    container.innerHTML = foods.map(food => {
        const width = Math.round((food.value / max) * 100);
        return `
            <div style="display: flex; align-items: center; margin-bottom: 12px;">
                <div style="width: 110px; font-size: 14px; text-align: right; padding-right: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${food.name}</div>
                <div style="flex: 1; background: #eee; border-radius: 6px; height: 24px; position: relative; overflow: hidden;">
                    <div style="width: ${width}%; height: 100%; background: linear-gradient(to right, #4caf50, #81c784); border-radius: 6px;"></div>
                </div>
                <div style="width: 50px; font-size: 14px; text-align: left; padding-left: 12px;">${food.value}g</div>
            </div>
        `;
    }).join('');

}

// 自動分析剩食：輸入改變時即更新最多/最少與長條圖
function setupFoodAnalysis(){
    const ids = ["food1", "food2", "food3", "food4", "food5"];

    ids.forEach(id => {
        const input = document.getElementById(id);
        if(input){
            input.addEventListener("input", analyzeFood);
        }
    });

    // 頁面載入時先分析一次
    analyzeFood();
}

async function calculateReward(){
    try {
        // 收集剩食分析資料
        const foodAnalysis = [
            { foodName: '🍗 香酥雞腿', leftoverGrams: Number(document.getElementById("food1").value) },
            { foodName: '🥬 高麗菜', leftoverGrams: Number(document.getElementById("food2").value) },
            { foodName: '🥚 蒸蛋', leftoverGrams: Number(document.getElementById("food3").value) },
            { foodName: '🍎 蘋果', leftoverGrams: Number(document.getElementById("food4").value) },
            { foodName: '🥣 玉米濃湯', leftoverGrams: Number(document.getElementById("food5").value) }
        ];

        const hasAnalysis = foodAnalysis.some(item => item.leftoverGrams > 0);
        if (!hasAnalysis) {
            alert(
                "❌ 請先填寫分析剩食資料！\n\n" +
                "需要在午餐長專區填寫各項菜色的剩食克數"
            );
            return;
        }

        const leftover = Number(document.getElementById("leftover").value);

        const data = await apiRequest('/task/claim-leftover-reward', 'POST', {
            leftoverWeight: leftover,
            foodAnalysis: foodAnalysis
        });

        if (data.success) {
            eCoin += data.rewards.eCoin;
            sCoin += data.rewards.sCoin;
            gCoin += data.rewards.gCoin;
            updateUI();

            alert(
                "🎉 今日獎勵已發放！\n\n" +
                "E幣 +" + data.rewards.eCoin + "\n" +
                "S幣 +" + data.rewards.sCoin + "\n" +
                "減碳存摺 +" + data.rewards.gCoin + "\n\n" +
                "⏰ 24小時後可再次領取"
            );
        } else {
            if (data.hoursRemaining) {
                alert(
                    "⏰ 尚未達到領取時間！\n\n" +
                    "距離下次領取還需 " + data.hoursRemaining + " 小時"
                );
            } else {
                alert(data.message || '獎勵發放失敗');
            }
        }
    } catch (error) {
        console.error('計算獎勵失敗:', error);
        alert('獎勵發放失敗，請稍後再試');
    }
}

// 家長簽到
async function parentSignIn() {
    const parentNameInput = document.getElementById('parentName');
    const parentName = parentNameInput ? parentNameInput.value.trim() : '';

    if (!parentName) {
        alert('請填寫家長姓名');
        return;
    }

    try {
        const data = await apiRequest('/user/parent-sign-in', 'POST', { parentName });

        if (data.success) {
            alert(`✅ 家長「${data.parentName}」簽到成功`);
            parentNameInput.value = '';
        } else {
            alert(data.message || '簽到失敗');
        }
    } catch (error) {
        console.error('家長簽到失敗:', error);
        alert('簽到失敗，請稍後再試');
    }
}

// 支援任務
function renderSupportClasses(containerId, data) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!data.unlocked) {
        container.innerHTML = `<p class="support-locked">🔒 ${data.message || '請先完成今日光盤行動'}</p>`;
        return;
    }

    if (!data.classes || data.classes.length === 0) {
        container.innerHTML = '<p>目前沒有可支援的班級</p>';
        return;
    }

    const rows = data.classes.map(c => `
        <div class="support-class-item">
            <div class="support-class-info">
                <strong>${c.className}</strong>
                <span>剩食 ${c.leftoverWeight}g</span>
            </div>
            ${c.completed
                ? '<span class="support-completed">今日已支援</span>'
                : `<button data-action="completeSupport" data-class-id="${c.classId}" data-class-name="${c.className}">前往支援</button>`
            }
        </div>
    `).join('');

    container.innerHTML = rows;
}

async function openSupportTask() {
    const intro = document.getElementById('supportIntro');
    const listView = document.getElementById('supportClassListView');

    if (intro) intro.classList.add('hidden');
    if (listView) listView.classList.remove('hidden');

    try {
        const data = await apiRequest('/task/support/list', 'GET');
        renderSupportClasses('supportClassListContainer', data);
    } catch (error) {
        console.error('開啟支援任務失敗:', error);
    }
}

function backSupportTask() {
    const intro = document.getElementById('supportIntro');
    const listView = document.getElementById('supportClassListView');

    if (intro) intro.classList.remove('hidden');
    if (listView) listView.classList.add('hidden');
}

async function loadSupportStatus() {
    try {
        const data = await apiRequest('/task/support/list', 'GET');
        const intro = document.getElementById('supportIntro');
        if (!intro) return;

        if (data.unlocked) {
            intro.innerHTML = `
                <p>完成自己的餐盤後，幫助其他班級分完剩食</p>
                <button data-action="openSupportTask">選擇支援班級</button>
            `;
        } else {
            intro.innerHTML = `
                <p class="support-locked">🔒 ${data.message || '請先完成今日光盤行動，即可開啟支援任務'}</p>
            `;
        }
    } catch (error) {
        console.error('載入支援任務狀態失敗:', error);
    }
}

async function completeSupport(classId, className) {
    try {
        const data = await apiRequest('/task/support/complete', 'POST', { classId });

        if (data.success) {
            alert(
                `🎉 成功支援 ${className}！\n\n` +
                `E幣 +${data.rewards.eCoin}\n` +
                `S幣 +${data.rewards.sCoin}\n` +
                `減碳存摺 +${data.rewards.gCoin}\n` +
                `積分 +${data.rewards.score}`
            );

            eCoin += data.rewards.eCoin;
            sCoin += data.rewards.sCoin;
            gCoin += data.rewards.gCoin || 0;
            score += data.rewards.score;
            updateUI();

            // 重新整理列表
            const listData = await apiRequest('/task/support/list', 'GET');
            renderSupportClasses('supportClassListContainer', listData);
        } else {
            alert(data.message || '支援失敗');
        }
    } catch (error) {
        console.error('支援任務失敗:', error);
        alert('支援失敗，請稍後再試');
    }
}

// 抽獎相關功能
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
    finishTask,
    parentSignIn,
    buyItem,
    submitSurvey,
    calculateReward,
    scrollToSection: (el) => scrollToSection(el.dataset.arg),
    openSupportTask,
    backSupportTask,
    completeSupport: (el) => completeSupport(el.dataset.classId, el.dataset.className),
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

// 頁面載入時嘗試恢復登入狀態
restoreSession();