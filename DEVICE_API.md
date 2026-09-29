# 稱重模組 API（ESP32 韌體對接文件）

伺服器：`https://<你的網域>/api/device`　　技術員後台：登入後的「📡 設備」分頁

韌體只需要實作 **三支端點**。所有換算（校正、盆體扣重）都在伺服器做，
**裝置只負責上傳原始值** —— 換盆、感測器漂移都改後台即可，不必重燒韌體。

---

## 認證

每個請求都要帶這兩個標頭：

```
X-Device-Id:    esp32-0001
X-Device-Token: <註冊時拿到的 40 字元 token>
```

（也接受 `Authorization: Device <token>`。）

- token 由技術員在後台註冊裝置時產生，**只會顯示一次**，之後資料庫只存 SHA-256 雜湊。
- token 外洩或裝置遺失 → 後台「換發憑證」，舊 token 立即失效。
- 裝置憑證**只能**打 `/api/device/*`，碰不到任何使用者資料。
- 連續驗證失敗會被記錄，技術員的機隊健康頁看得到。

---

## 1. `POST /api/device/hello` — 開機報到

每次開機（或重連 Wi-Fi 後）呼叫一次。

```jsonc
// 送出
{ "firmware": "v1.0.3", "mac": "AA:BB:CC:DD:EE:01", "resetReason": "POWERON" }

// 回應
{
  "ok": true,
  "serverTime": "2026-09-29T02:18:03.386Z",   // ESP32 沒有 RTC，用這個校時
  "serverDate": "2026-09-29",
  "config": {
    "classId": "cls-302", "className": "302",
    "bucketId": "soup",   "bucketLabel": "湯桶",
    "tareG": 1500,                // 盆體扣重
    "calibrationFactor": 210,     // 每公克幾個 raw
    "zeroOffset": 8000,           // 空秤時的 raw
    "sampleIntervalSec": 5,
    "heartbeatIntervalSec": 300,
    "uploadOnChangeGrams": 50,    // 變化超過這個克數才上傳，省電省流量
    "configVersion": 4
  },
  "needsProvisioning": false      // true = 還沒綁班級/桶別，建議亮黃燈提示現場人員
}
```

把 `configVersion` 存起來，心跳時帶上去比對。

---

## 2. `POST /api/device/heartbeat` — 定時心跳

建議 `heartbeatIntervalSec`（預設 300 秒）一次。

```jsonc
// 送出
{ "batteryPct": 87, "rssi": -62, "uptimeSec": 3600, "freeHeap": 142000,
  "queued": 0, "configVersion": 4 }

// 回應
{ "ok": true, "serverTime": "...", "configVersion": 5, "configChanged": true }
```

`configChanged: true` → 再打一次 `/hello` 取新設定。**不必重開機**。

---

## 3. `POST /api/device/measure` — 上傳讀數

```jsonc
// 送出（raw 與 grossG 擇一；建議送 raw，讓伺服器統一換算）
{
  "readingId": "42",        // 必填！裝置端遞增序號
  "raw": 501500,            // HX711 原始值
  "stable": true,           // 連續取樣是否穩定
  "samples": 10,
  "measuredAt": "2026-09-29T02:18:03Z",  // 選填，僅供參考
  "date": "2026-09-29",     // 選填，離線補傳時帶上當時日期
  "tempC": 27.5             // 選填，之後可做溫漂補償
}

// 回應
{ "ok": true, "readingId": "42",
  "grossG": 2350, "tareG": 1500, "netG": 850,   // 伺服器換算結果，可印到序列埠核對
  "outOfRange": false, "configVersion": 4, "linked": true }
```

### `readingId` 為什麼是必填

伺服器用 `裝置ID_readingId` 當文件 ID。**同一筆重傳會覆蓋，不會變成兩筆** ——
所以韌體可以無腦重試：網路斷了就存進 flash 佇列，連上再整批送，不必自己去重。

序號建議用 `開機次數 × 100000 + 本次開機的計數`，重開機也不會撞號。

### 伺服器怎麼換算

```
毛重 grossG = (raw − zeroOffset) / calibrationFactor
淨剩食 netG = grossG − tareG
```

- `|netG| ≤ 30g` 一律視為 0（磅秤雜訊，空盆不該顯示成「剩 12 克」）
- `netG` 超出 −200g ~ 60000g → 照收但標記 `outOfRange`，不進統計，技術員頁會看到
- `stable: false` 的讀數同樣會標記為需人工確認

### 錯誤

| 狀態 | 意思 | 韌體該怎麼做 |
|---|---|---|
| 400 | 缺 `readingId`、日期太舊（>3 天）、格式錯 | 丟掉這筆，不要無限重試 |
| 401 | 憑證錯誤 | 停止上傳、亮紅燈，等技術員處理 |
| 403 | 裝置已被停用 | 同上 |
| 429 | 上傳太頻繁（每分鐘 120 次上限） | 退避後重試，並拉長取樣間隔 |
| 5xx / 逾時 | 伺服器或網路問題 | 存進佇列，指數退避重試 |

---

## 建議的韌體主迴圈

```c
setup():
    連 Wi-Fi → POST /hello → 校時、存 config
    沒綁定(needsProvisioning) → 亮黃燈，仍可繼續上傳（伺服器會收但不進統計）

loop():
    每 sampleIntervalSec 取樣一次（HX711 取 10 筆中位數）
    重量變化 > uploadOnChangeGrams 且讀數穩定 → 排進上傳佇列
    佇列有東西且有網路 → POST /measure，成功才從佇列移除
    每 heartbeatIntervalSec → POST /heartbeat
    configChanged → 重新 /hello
```

**佇列請存在 flash（NVS 或 SPIFFS）而不是 RAM** —— 斷電就沒了的佇列等於沒有佇列。
校園 Wi-Fi 午餐時間最容易塞車，而那正是要上傳的時候。

---

## 技術員後台能做的事

| 功能 | 說明 |
|---|---|
| 批次註冊 | 一次產生多台（`esp32-0001`…），每台一組 token |
| 綁定 | 這台模組是哪一班的哪一個桶（同班同桶只能綁一台） |
| 空盆歸零 | 秤上放空盆 → 按一下，把目前毛重設成 `tareG` |
| 手動扣重 | 直接輸入已知盆重 |
| 校正 | 放已知砝碼，算出 `calibrationFactor` |
| 最近讀數 | 看 raw → 毛重 → 淨重，現場排查用 |
| 換發憑證 | 裝置遺失或維修回收後使用 |
| 停用 | 立即拒絕該裝置的所有請求 |
| 機隊健康 | 離線、低電量、未綁定、未校正、佇列積壓的裝置一次列出 |
