// ======================
// 食安守護者 Demo
// ======================

// 等待 Firebase 配置載入完成
if (typeof auth === 'undefined') {
  console.error('Firebase 未正確載入，請檢查 firebase-config.js');
  // 延遲初始化，等待 firebase-config.js 執行
  setTimeout(() => {
    if (typeof auth === 'undefined') {
      console.error('Firebase 仍未載入，請檢查 Firebase SDK 配置');
    }
  }, 1000);
}

// 初始化時檢查登入狀態
auth.onAuthStateChanged(async (user) => {
  if (user) {
    currentUser = user;
    idToken = await user.getIdToken();
    await loadUserData();
    showLoggedInState();
  } else {
    currentUser = null;
    idToken = null;
    showAuthForm();
  }
});

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

  if (!email || !password) {
    errorElement.textContent = '請填寫所有欄位';
    return;
  }

  try {
    const userCredential = await auth.signInWithEmailAndPassword(email, password);
    idToken = await userCredential.user.getIdToken();
    errorElement.textContent = '';
  } catch (error) {
    errorElement.textContent = getErrorMessage(error.code);
  }
}

// 處理註冊
async function handleRegister() {
  const name = document.getElementById('registerName').value;
  const email = document.getElementById('registerEmail').value;
  const password = document.getElementById('registerPassword').value;
  const confirmPassword = document.getElementById('registerConfirmPassword').value;
  const errorElement = document.getElementById('registerError');

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

  try {
    // 使用 Firebase Auth 註冊
    const userCredential = await auth.createUserWithEmailAndPassword(email, password);
    
    // 更新使用者顯示名稱
    await userCredential.user.updateProfile({ displayName: name });
    
    // 在 Firestore 建立使用者文件
    const userRef = doc(db, 'users', userCredential.user.uid);
    await setDoc(userRef, {
      userId: userCredential.user.uid,
      email: email,
      displayName: name,
      eCoin: 0,
      sCoin: 0,
      score: 0,
      createdAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
      isActive: true
    });
    
    // 自動登入
    idToken = await userCredential.user.getIdToken();
    errorElement.textContent = '';
  } catch (error) {
    errorElement.textContent = getErrorMessage(error.code);
  }
}

// 處理登出
async function handleLogout() {
  try {
    await auth.signOut();
    currentUser = null;
    idToken = null;
    eCoin = 0;
    sCoin = 0;
    score = 0;
    showAuthForm();
  } catch (error) {
    console.error('登出失敗:', error);
  }
}

// 載入使用者資料
async function loadUserData() {
  try {
    if (!currentUser) return;
    
    const userRef = doc(db, 'users', currentUser.uid);
    const userDoc = await getDoc(userRef);
    
    if (userDoc.exists()) {
      const userData = userDoc.data();
      eCoin = userData.eCoin || 0;
      sCoin = userData.sCoin || 0;
      score = userData.score || 0;
      updateUI();
    } else {
      // 如果文件不存在，建立預設資料
      await setDoc(userRef, {
        userId: currentUser.uid,
        email: currentUser.email,
        displayName: currentUser.displayName,
        eCoin: 0,
        sCoin: 0,
        score: 0,
        createdAt: serverTimestamp(),
        lastLoginAt: serverTimestamp(),
        isActive: true
      });
      updateUI();
    }
  } catch (error) {
    console.error('載入使用者資料失敗:', error);
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
  document.getElementById('userDisplayName').textContent = currentUser.displayName;
  updateLoggedInStats();
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
  document.getElementById('myRankScore').textContent = score;
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

// API 請求輔助函數 (保留用於可能的後端 API)
async function apiRequest(endpoint, method = 'GET', body = null) {
  const headers = {
    'Authorization': `Bearer ${idToken}`,
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
  return await response.json();
}

// 更新使用者資料到 Firestore
async function updateUserData() {
  try {
    if (!currentUser) return;
    
    const userRef = doc(db, 'users', currentUser.uid);
    await updateDoc(userRef, {
      eCoin: eCoin,
      sCoin: sCoin,
      score: score,
      lastLoginAt: serverTimestamp()
    });
  } catch (error) {
    console.error('更新使用者資料失敗:', error);
  }
}

// 底部導覽列顯示/隱藏
window.addEventListener('scroll', function() {
    const bottomNav = document.querySelector('.bottom-nav');
    const scrollPosition = window.innerHeight + window.scrollY;
    const pageHeight = document.body.offsetHeight;
    
    // 當滾動到距離底部 100px 以內時顯示
    if (pageHeight - scrollPosition < 100) {
        bottomNav.style.transform = 'translateY(0)';
    } else {
        bottomNav.style.transform = 'translateY(100%)';
    }
});

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
    document.querySelector("#ranking tr:nth-child(4) td:nth-child(2)").textContent = currentUser.displayName;

    // 隱藏影片區
    document.querySelector(".video").style.display = "none";

    // 顯示首頁
    document.getElementById("home").classList.remove("hidden");

    // 載入最新資料
    await loadUserData();
}

// 完成任務
async function finishTask(){
    try {
        if (!currentUser) {
            alert('請先登入');
            return;
        }

        // 檢查是否已經在24小時內完成過任務
        const taskRecordsRef = collection(db, 'task_records');
        const q = query(
            taskRecordsRef,
            where('userId', '==', currentUser.uid),
            where('taskType', '==', 'light_disc'),
            orderBy('completedAt', 'desc'),
            limit(1)
        );
        const querySnapshot = await getDocs(q);
        
        const now = new Date();
        const cooldownTime = 24 * 60 * 60 * 1000; // 24小時
        
        if (!querySnapshot.empty) {
            const lastTask = querySnapshot.docs[0].data();
            const lastCompletedAt = lastTask.completedAt.toDate();
            const timeSinceLastTask = now - lastCompletedAt;
            
            if (timeSinceLastTask < cooldownTime) {
                const hoursRemaining = Math.ceil((cooldownTime - timeSinceLastTask) / (60 * 60 * 1000));
                alert(
                    "⏰ 尚未達到領取時間！\n\n" +
                    "距離下次領取還需 " + hoursRemaining + " 小時"
                );
                return;
            }
        }

        // 記錄任務完成
        const rewards = { eCoin: 10, sCoin: 5, score: 30 };
        await addDoc(collection(db, 'task_records'), {
            userId: currentUser.uid,
            taskType: 'light_disc',
            completedAt: serverTimestamp(),
            rewards: rewards,
            metadata: {}
        });

        // 更新使用者資料
        eCoin += rewards.eCoin;
        sCoin += rewards.sCoin;
        score += rewards.score;
        await updateUserData();
        updateUI();

        alert(
            "🎉 任務完成！\n\n" +
            "E幣 +" + rewards.eCoin + "\n" +
            "S幣 +" + rewards.sCoin + "\n" +
            "積分 +" + rewards.score + "\n\n" +
            "⏰ 24小時後可再次領取"
        );
    } catch (error) {
        console.error('完成任務失敗:', error);
        alert('任務完成失敗，請稍後再試');
    }
}
async function buyE(price, name){
    try {
        if (!currentUser) {
            alert('請先登入');
            return;
        }

        if (eCoin < price) {
            alert('E幣不足');
            return;
        }

        // 扣除 E幣
        eCoin -= price;
        await updateUserData();
        updateUI();

        // 記錄兌換
        await addDoc(collection(db, 'exchange_records'), {
            userId: currentUser.uid,
            itemName: name,
            itemType: 'E',
            cost: price,
            exchangedAt: serverTimestamp(),
            status: 'completed'
        });

        alert("🎉 成功兌換：" + name);
    } catch (error) {
        console.error('兌換失敗:', error);
        alert('兌換失敗，請稍後再試');
    }
}

async function buyS(price, name){
    try {
        if (!currentUser) {
            alert('請先登入');
            return;
        }

        if (sCoin < price) {
            alert('S幣不足');
            return;
        }

        // 扣除 S幣
        sCoin -= price;
        await updateUserData();
        updateUI();

        // 記錄兌換
        await addDoc(collection(db, 'exchange_records'), {
            userId: currentUser.uid,
            itemName: name,
            itemType: 'S',
            cost: price,
            exchangedAt: serverTimestamp(),
            status: 'completed'
        });

        alert("🎉 成功兌換：" + name);
    } catch (error) {
        console.error('兌換失敗:', error);
        alert('兌換失敗，請稍後再試');
    }
}
async function submitSurvey(){
    try {
        if (!currentUser) {
            alert('請先登入');
            return;
        }

        let favorite = document.getElementById("favoriteFood").value;
        let hate = document.getElementById("hateFood").value;

        // 檢查是否已經在24小時內提交過問卷
        const taskRecordsRef = collection(db, 'task_records');
        const q = query(
            taskRecordsRef,
            where('userId', '==', currentUser.uid),
            where('taskType', '==', 'survey'),
            orderBy('completedAt', 'desc'),
            limit(1)
        );
        const querySnapshot = await getDocs(q);
        
        const now = new Date();
        const cooldownTime = 24 * 60 * 60 * 1000; // 24小時
        
        if (!querySnapshot.empty) {
            const lastSurvey = querySnapshot.docs[0].data();
            const lastCompletedAt = lastSurvey.completedAt.toDate();
            const timeSinceLastSurvey = now - lastCompletedAt;
            
            if (timeSinceLastSurvey < cooldownTime) {
                const hoursRemaining = Math.ceil((cooldownTime - timeSinceLastSurvey) / (60 * 60 * 1000));
                alert(
                    "⏰ 尚未達到送出時間！\n\n" +
                    "距離下次送出還需 " + hoursRemaining + " 小時"
                );
                return;
            }
        }

        // 記錄問卷提交
        await addDoc(collection(db, 'task_records'), {
            userId: currentUser.uid,
            taskType: 'survey',
            completedAt: serverTimestamp(),
            rewards: { eCoin: 0, sCoin: 0, score: 0 },
            metadata: {
                favoriteFood: favorite,
                hateFood: hate
            }
        });

        alert(
            "✅ 問卷已送出！\n\n" +
            "最喜歡：" + favorite + "\n" +
            "最不喜歡：" + hate + "\n\n" +
            "⏰ 24小時後可再次送出"
        );
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

}
async function calculateReward(){
    try {
        if (!currentUser) {
            alert('請先登入');
            return;
        }

        // 檢查是否已填寫分析剩食資料
        const food1 = Number(document.getElementById("food1").value);
        const food2 = Number(document.getElementById("food2").value);
        const food3 = Number(document.getElementById("food3").value);
        const food4 = Number(document.getElementById("food4").value);
        const food5 = Number(document.getElementById("food5").value);

        if (food1 === 0 && food2 === 0 && food3 === 0 && food4 === 0 && food5 === 0) {
            alert(
                "❌ 請先填寫分析剩食資料！\n\n" +
                "需要在午餐長專區填寫各項菜色的剩食克數"
            );
            return;
        }

        // 檢查上次領取時間
        const taskRecordsRef = collection(db, 'task_records');
        const q = query(
            taskRecordsRef,
            where('userId', '==', currentUser.uid),
            where('taskType', '==', 'leftover_reward'),
            orderBy('completedAt', 'desc'),
            limit(1)
        );
        const querySnapshot = await getDocs(q);
        
        const now = new Date();
        const cooldownTime = 24 * 60 * 60 * 1000; // 24小時
        
        if (!querySnapshot.empty) {
            const lastReward = querySnapshot.docs[0].data();
            const lastCompletedAt = lastReward.completedAt.toDate();
            const timeSinceLastReward = now - lastCompletedAt;
            
            if (timeSinceLastReward < cooldownTime) {
                const hoursRemaining = Math.ceil((cooldownTime - timeSinceLastReward) / (60 * 60 * 1000));
                alert(
                    "⏰ 尚未達到領取時間！\n\n" +
                    "距離下次領取還需 " + hoursRemaining + " 小時"
                );
                return;
            }
        }

        let leftover = Number(document.getElementById("leftover").value);

        let addE = 0;
        let addS = 0;

        if(leftover <= 10){
            addE = 20;
            addS = 10;
        }else if(leftover <= 30){
            addE = 15;
            addS = 8;
        }else if(leftover <= 50){
            addE = 10;
            addS = 5;
        }else{
            addE = 5;
            addS = 2;
        }

        eCoin += addE;
        sCoin += addS;
        
        await updateUserData();
        updateUI();

        // 記錄剩食獎勵
        await addDoc(collection(db, 'task_records'), {
            userId: currentUser.uid,
            taskType: 'leftover_reward',
            completedAt: serverTimestamp(),
            rewards: { eCoin: addE, sCoin: addS, score: 0 },
            metadata: {
                leftoverWeight: leftover,
                foodAnalysis: {
                    food1, food2, food3, food4, food5
                }
            }
        });

        alert(
            "🎉 今日獎勵已發放！\n\n" +
            "E幣 +" + addE + "\n" +
            "S幣 +" + addS + "\n\n" +
            "⏰ 24小時後可再次領取"
        );
    } catch (error) {
        console.error('計算獎勵失敗:', error);
        alert('計算獎勵失敗，請稍後再試');
    }
}

// 抽獎相關功能
function openLottery(){
    document.getElementById("lotteryModal").style.display = "block";
    document.getElementById("lotteryResult").innerHTML = "";
}

function closeLottery(){
    document.getElementById("lotteryModal").style.display = "none";
}

function spinLottery(){
    if(eCoin < 10){
        alert("❌ E幣不足！需要 10 E幣進行抽獎");
        return;
    }

    eCoin -= 10;
    document.getElementById("ecoin").innerHTML = eCoin;

    const resultDiv = document.getElementById("lotteryResult");
    resultDiv.innerHTML = "<div class='spinning'>🎰 抽獎中...</div>";

    // 抽獎結果：大獎5%，普通30%，小獎65%
    const rand = Math.random() * 100;
    let prize, prizeType, prizeValue;

    if(rand < 5){
        // 大獎
        const grandPrizes = [
            {name: "🎁 豪華文具組", value: 60},
            {name: "🌟 特別獎勵包", value: 55},
            {name: "💎 稀有空氣清新劑", value: 50}
        ];
        const selected = grandPrizes[Math.floor(Math.random() * grandPrizes.length)];
        prize = selected.name;
        prizeValue = selected.value;
        prizeType = "grand";
    }else if(rand < 35){
        // 普通
        const normalPrizes = [
            {name: "📝 筆記本", value: 30},
            {name: "✏️ 鉛筆組", value: 25},
            {name: "📏 尺", value: 20},
            {name: "🔖 書籤", value: 15}
        ];
        const selected = normalPrizes[Math.floor(Math.random() * normalPrizes.length)];
        prize = selected.name;
        prizeValue = selected.value;
        prizeType = "normal";
    }else{
        // 小獎
        const smallPrizes = [
            {name: "🍬 糖果", value: 5},
            {name: "🧻 紙巾", value: 3},
            {name: "💧 飲用水", value: 2}
        ];
        const selected = smallPrizes[Math.floor(Math.random() * smallPrizes.length)];
        prize = selected.name;
        prizeValue = selected.value;
        prizeType = "small";
    }

    // 模擬抽獎動畫
    setTimeout(() => {
        let effectClass = "";
        if(prizeType === "grand"){
            effectClass = "grand-prize";
        }else if(prizeType === "normal"){
            effectClass = "normal-prize";
        }else{
            effectClass = "small-prize";
        }

        resultDiv.innerHTML = `
            <div class="prize-result ${effectClass}">
                <div class="prize-icon">${prizeType === "grand" ? "🎉" : prizeType === "normal" ? "🎁" : "🎊"}</div>
                <div class="prize-name">${prize}</div>
                <div class="prize-type">${prizeType === "grand" ? "大獎！" : prizeType === "normal" ? "普通獎" : "小獎"}</div>
                <div class="prize-value">價值：${prizeValue} E幣</div>
            </div>
        `;

        // 如果是大獎，添加特效
        if(prizeType === "grand"){
            createConfetti();
        }

        // 獎勵直接加到E幣
        eCoin += prizeValue;
        document.getElementById("ecoin").innerHTML = eCoin;

    }, 1500);
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