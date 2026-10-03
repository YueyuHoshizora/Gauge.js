# Gauge.js 訂閱額度儀表板 PWA 企劃書 v1.1

一句話：一個自架網頁（程式名稱 **Gauge.js**），登入多家 AI 訂閱帳號（Antigravity、Codex、Claude、Grok），定期查詢各家剩餘額度，以 PWA 推播通知「額度偏低」與「額度已恢復」。

### 基本資料

| 欄位 | 內容 |
|---|---|
| 程式名稱 | **Gauge.js** |
| 程式語言 | **TypeScript**（全專案，含前端） |
| 後端執行環境 | Node.js **≥ 22**（ESM、原生 fetch；`node:sqlite` 免旗標需 ≥ 22.13，見假設 9） |
| 資料儲存 | **本地 SQLite**（內建 `node:sqlite`，資料檔 `data/gauge.db`） |
| 遠端倉庫 | https://github.com/YueyuHoshizora/Gauge.js.git |
| 介紹網址 | https://gauge.js-package.xyz（GitHub Pages + CNAME 已就位，尚無 index.html，見假設 8） |
| 託管平台 | **Replit**（暫定；本機執行亦可，見 2.6 與假設 10） |
| 授權 | Apache-2.0 |

結構：〇 概述 → 一 需求 → 二 供應商整合規格 → 三 架構 → 四 資料模型 → 五 API → 六 排程與推播 → 七 PWA → 八 安全 → 九 風險 → 十 里程碑與 Gate → 十一 已知假設。全程以「執行 Agent」泛指實作方，不綁定特定工具。

---

## 〇、專案概述

### 目標
- 一個 Node.js 服務（**TypeScript 撰寫、最低執行版本 Node.js v22**），提供 Gauge.js 網頁介面管理多個訂閱帳號。
- 四家供應商全數支援：**Antigravity、Codex、Claude、Grok**。
- 每家帳號在**本網頁內直接登入**（OAuth 流程內建），**不讀取、不依賴本機 CLI 的已登入憑證**（使用者裁示）。
- 查詢剩餘額度並顯示恢復時間；額度觸及門檻或恢復時，透過 Web Push 推播到裝置。

### 範圍外
- 不做額度「代打／代理轉發」，只做查詢與通知。
- 不做帳號池輪替、自動切換帳號。
- 不處理付款、方案升降級。

### 硬性要求
| 編號 | 要求 |
|---|---|
| R1 | 程式語言 TypeScript；後端 Node.js ≥ 22（使用 ESM、原生 fetch） |
| R2 | 支援 Antigravity、Codex、Claude、Grok 四家 |
| R3 | 網頁內建各家登入（OAuth），不得改讀本機 CLI 憑證檔 |
| R4 | PWA：可安裝、可離線開殼、支援 Web Push 推播 |
| R5 | 推播兩類事件：額度剩餘低於門檻、額度恢復 |
| R6 | 可同時管理多個帳號（同一家可多個） |
| R7 | 佈景主題 10 款（白到黑全涵蓋），可手動切換並記住偏好，預設跟隨系統 |
| R8 | 多國語系 i18n：暫支援英文、中文（繁體）、日文；可即時切換、偏好記住、缺字回退 |

---

## 一、需求總表

| 面向 | 需求 |
|---|---|
| 帳號管理 | 新增／編輯／刪除；每帳號綁定供應商、顯示名稱、監測時間（固定 10 選項，見 2.5）、推播門檻 |
| 登入 | 四家各自的 OAuth 流程，由伺服器起始、瀏覽器完成、回導換 token |
| 額度查詢 | 依排程自動查詢；也可手動立即查詢；顯示各時窗剩餘百分比與恢復倒數 |
| 推播 | 低額度預警、額度恢復、（額外）憑證過期提醒 |
| 介面 | 帳號卡片列表、每時窗進度條、恢復倒數、最近趨勢、錯誤狀態、佈景主題 10 款（白→黑，規格見七） |
| 多語系 | UI 文案 i18n（en、zh-TW、ja）；切換即時生效並記住偏好；日期／時間／數字以 `Intl` 依語系格式化；缺字回退 zh-TW → en |
| 專案文件 | 倉庫需齊備四份：`AGENTS.md`（專案撰寫規範）、`CLAUDE.md`（引用 AGENTS.md ＋ 資安強化）、`PLAN.md`（匯入本企劃書全文）、`SECURITY.md`（英文撰寫、詳細安全政策）——驗收見 Gate D |
| 部署 | 託管平台暫定 Replit（雲端、自帶 HTTPS）；亦可本機執行（預設綁 127.0.0.1）。雲端模式強制存取 PIN，登入介接策略見 2.6 |

---

## 二、供應商整合規格

> 以下端點經官方文件與多個開源實作交叉查證（來源摘要見第十一節）。四家皆為公開客戶端 OAuth（PKCE 或公開 client secret），無須自行申請開發者憑證。
>
> **登入介接原則（使用者裁示）：優先以設備綁定碼（device code）對接，避免不必要的 callback；各家用途、可行性與替代路徑見 2.6。**

### 2.1 Claude（Anthropic）

**登入（OAuth 授權碼 + PKCE S256）**
- 授權端點：`https://claude.ai/oauth/authorize`
- 參數：`client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e`、`response_type=code`、`redirect_uri=http://localhost:{本服務埠}/callback`（loopback，埠任意）、`scope=user:profile user:inference`、`code_challenge`、`code_challenge_method=S256`、`state`、`code=true`
- Token 端點：`POST https://console.anthropic.com/v1/oauth/token`（JSON body）；備用別名 `https://platform.claude.com/v1/oauth/token`（兩者皆有實作採用，實作時先主後備）
  - 換碼：`{grant_type:"authorization_code", code, client_id, code_verifier, redirect_uri}`
  - 刷新：`{grant_type:"refresh_token", refresh_token, client_id}`
- 生命週期：access token 約 8 小時；**refresh token 會輪替**，每次刷新必須立即覆寫保存最新者。

**額度查詢**
- `GET https://api.anthropic.com/api/oauth/usage`
- Headers：`Authorization: Bearer <access>`、`anthropic-beta: oauth-2025-04-20`（缺此 header 會 401）
- 回應：`five_hour{utilization, resets_at}`、`seven_day{utilization, resets_at}`；`utilization` 為 0–100 的已用百分比，剩餘 = 100 − utilization。
- ⚠️ 此端點限流嚴格，429 可能持續 30 分鐘以上：**預設監測時間 5 分鐘，<5 分鐘選項預設隱藏（見 2.5）**；遇 429 指數退避並沿用上次資料標示「資料為 X 分鐘前」。

### 2.2 Codex（OpenAI / ChatGPT）

**登入（OAuth 授權碼 + PKCE S256）**
- 授權端點：`https://auth.openai.com/oauth/authorize`
- 參數：`client_id=app_EMoamEEZ73f0CkXaXp7hrann`（Codex CLI 官方公開客戶端）、`redirect_uri=http://localhost:1455/auth/callback`（**埠固定 1455，不可改**）、`scope=openid profile email offline_access chatgpt_api`、`code_challenge`、`code_challenge_method=S256`、`state`
- Token 端點：`POST https://auth.openai.com/oauth/token`（PKCE 公開客戶端，無 secret）
- 回導處理：**Codex 登入期間於 127.0.0.1:1455 起臨時監聽**（路徑 `/auth/callback`），換碼後關閉並 302 回主介面；埠被占用時明確報錯（提示關閉正在跑的 codex 或改用其他機器登入）。

**額度查詢**
- 主：`GET https://chatgpt.com/backend-api/wham/usage`
- 備：同 base 的 `/backend-api/codex/usage`、非預設 base 的 `/api/codex/usage`（依實測依序退讓）
- Headers：`Authorization: Bearer <access>`、`ChatGPT-Account-Id: <account_id>`
- 回應：
  - `rate_limit.primary` / `rate_limit.secondary`：`used_percent`、`window_minutes`、`resets_at`（Unix 秒）→ 兩個時窗（5 小時／週）
  - `credits.balance`（美元餘額，可能無）、`plan_type`、`email`、`limit_reached`
- `account_id` 來源：Token 回應或 id_token 宣告（**列為實作期驗證項**，若無則退用 ChatGPT-Account-Id 省略測試）。

### 2.3 Grok（xAI）

**登入（OAuth 授權碼 + PKCE，或裝置碼）**
- 發現文件：`https://auth.x.ai/.well-known/openid-configuration` → 授權 `https://auth.x.ai/oauth2/authorize`、Token `https://auth.x.ai/oauth2/token`、裝置碼 `https://auth.x.ai/oauth2/device/code`（RFC 8628）
- 參數：`client_id=b1a00492-073a-47ea-816f-4c329264a828`（Grok CLI 公開客戶端）、`scope=openid profile email offline_access grok-cli:access api:access`、`redirect_uri=http://127.0.0.1:56121/callback`、`code_challenge` S256、`state`、`nonce`
- 兩種模式：
  1. **裝置碼（預設）**：介面顯示驗證網址 + 代碼，輪詢 token 端點——不佔埠、可遠端／手機完成，最穩。
  2. 回導模式：127.0.0.1:56121 臨時監聽（與社群工具同埠慣例）。
- 生命週期：token 約 7 天；`grant_type=refresh_token`（form-urlencoded，帶 client_id）自動續期。

**額度查詢**
- 主：`GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`
  - Headers：`Authorization: Bearer <access>`、`x-xai-token-auth: xai-grok-cli`、`Accept: application/json`
- 身分／方案：`GET https://cli-chat-proxy.grok.com/v1/settings` → `subscription_tier_display`
- 回應（欄位根層與 `config` 下皆有實作案例，**兩處皆讀**）：
  - `creditUsagePercent`（週池已用 %）；備用 `onDemandUsed.val / onDemandCap.val`
  - 週期重設：`currentPeriod.end` → 備用 `billingPeriodEnd`
- 額度語意：SuperGrok 週度點數池（`creditUsagePercent` 已用 → 剩餘 = 100 − 已用）。

### 2.4 Antigravity（Google Code Assist）

**登入（Google OAuth 授權碼，機密客戶端）**
- Client：`client_id=681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com`、`client_secret=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`（gemini-cli 開源碼內建之「已安裝應用程式」憑據，官方明言非機密）
- 授權端點：`https://accounts.google.com/o/oauth2/v2/auth`
- Scope：`https://www.googleapis.com/auth/cloud-platform`、`userinfo.email`、`userinfo.profile`
- Redirect：`http://127.0.0.1:{本服務埠}/oauth2callback`（loopback 堞可變）；`access_type=offline`、`prompt=consent` 取得 refresh_token
- Token 端點：`POST https://oauth2.googleapis.com/token`（含 client_secret）

**額度查詢**
- `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`，`Authorization: Bearer <access>`，body `{}`
  - 回應：`buckets[] { modelId, tokenType:"REQUESTS", remainingFraction(0–1), resetTime }` ——**每帳號權威的 Gemini REQUESTS 額度**
- 補充（best-effort，失敗不影響主資料）：
  - `POST .../v1internal:loadCodeAssist` → 方案層級、信箱、綁定專案
  - `POST .../v1internal:fetchAvailableModels` → 各 provider 池剩餘（GOOGLE 池共用；**ANTHROPIC 與 OPENAI 模型共用同一 Vertex 池**），供 Claude／GPT 類模型的近似額度
- 額度節奏：免費版週刷新；Pro／Ultra 五小時刷新加週上限——以 API 回傳 `resetTime` 為準，不寫死。
- ⚠️ 非 Google 模型需帶 Antigravity 標頭（`Client-Metadata: {"ideType":"ANTIGRAVITY",...}`）才會回應；Gemini 桶查詢不受影響。

### 2.5 監測時間選項與供應商預設值

**監測時間固定選項（帳號選單僅列此 10 種）**：30 秒、1 分鐘、2 分鐘、5 分鐘、10 分鐘、15 分鐘、30 分鐘、1 小時、2 小時、5 小時。

| 供應商 | 預設監測時間 | 選項限制 | 額度資料粒度 |
|---|---|---|---|
| Claude | 5 分鐘 | <5 分鐘選項預設隱藏（usage 端點 429 嚴格，見 2.1）；進階設定可強制顯示並附警示 | 5 小時 + 7 天（已用 %、重設時間） |
| Codex | 5 分鐘 | 全選項可用 | 主／副時窗（已用 %、窗口分鐘、重設秒）+ credits |
| Grok | 10 分鐘 | 全選項可用 | 週點數池已用 % + 週期結束 |
| Antigravity | 5 分鐘 | 全選項可用 | 逐模型 REQUESTS 桶剩餘 + resetTime（＋共用池） |

- 全域預設監測時間（settings.defaultInterval）亦取自此 10 選項；各帳號可個別覆寫。
- 選擇 <1 分鐘的監測時間時介面顯示提醒：只會增加 API 呼叫與 429 風險。

### 2.6 登入介接策略：設備綁定碼為主、回導為輔（本機與 Replit 一致）

**原則（使用者裁示）：API 介接優先使用設備綁定碼（device code），避免不必要的 callback。** 伺服器取得 `user_code` 與 `verification_uri` 後於介面顯示並自動帶開驗證頁，由伺服器端輪詢換取 token（處理 `authorization_pending`／`slow_down`）；使用者在任何裝置輸入代碼即可完成，不佔埠、不受託管環境影響。

| 供應商 | 設備綁定碼 | 查證狀態 | 無裝置碼時的替代（零伺服器 callback） |
|---|---|---|---|
| Grok | ✅ 支援 | `auth.x.ai/oauth2/device/code`（RFC 8628，官方 CLI 即以此為 headless 登入） | —（本機另保留 loopback `:56121` 作備援） |
| Codex | ✅ 支援 | 平台裝置碼流程，驗證頁 `https://auth.openai.com/codex/device`（Codex CLI 官方裝置碼登入） | —（本機另保留 loopback `:1455` 作備援） |
| Claude | ❌ 無 | Anthropic 消費者 OAuth 尚無 device grant（官方 repo 仍為 feature request #20215／#22992） | 主機回導 `https://console.anthropic.com/oauth/code/callback` 取得代碼後**貼回本系統**（回呼頁是否顯示代碼，實作期驗證） |
| Antigravity | ❌ 無 | Google limited-input device flow **不允許 `cloud-platform` scope**（僅 openid/email/profile/Drive/YouTube） | 本機 loopback `/oauth2callback`；雲端貼回導網址（位址列 `127.0.0.1:.../oauth2callback?code=...` 貼回本系統） |

- **callback 盤點**：伺服器端僅在「本機模式」存在必要回導路由（`/callback`、`/oauth2callback`、`:1455/auth/callback`）；Replit 雲端模式**不註冊任何回導**，全部走裝置碼或貼代碼路徑。
- 裝置碼輪詢規格：起始 `interval` 依端點回傳、遇 `slow_down` +5 秒、`expired_token`／`access_denied` 即時反映於介面、逾時（`expires_in`）自動清理待處理登入。
- 帳號憑證（refresh token）保存在伺服器端，登入一次後雲端持續刷新，不依賴使用者裝置維持連線。
- 本機模式與雲端模式的介接路徑須可個別啟用，互不阻塞（如 Codex 埠 1455 衝突時仍可用裝置碼）。

---

## 三、系統架構

```
[瀏覽器 PWA Gauge.js] ⇄ [Node.js 伺服器 (node:http)]
                  ├─ src/routes/    REST API + 靜態檔 + 登入介接（設備綁定碼為主）
                  ├─ src/providers/ claude | codex | grok | antigravity（統一 check() 介面）
                  ├─ src/i18n/      語系管理（public/locales/ en｜zh-TW｜ja 字典 JSON）
                  ├─ src/scheduler/ 每帳號排程、單飛去重、退避
                  ├─ src/push/      VAPID + Web Push（RFC 8291 aes128gcm，原生實作）
                  ├─ src/notify/    事件判定（低額度／恢復／憑證過期）＋冷卻去重
                  └─ src/store/     SQLite 儲存（node:sqlite → data/gauge.db）
```

- **語言與建置**：全專案 TypeScript。`tsc` 編譯 `src/` → `dist/`（後端）與 `public/js/`（前端），Node ≥ 22 執行 `dist/`；開發期依賴僅 `typescript`（devDependency），**執行期零第三方相依**。
  - 四家回應各定義型別介面，未知欄位以容錯讀取處理（多路徑取值），禁止以 `any` 敷衍。
- **依賴策略**：執行期僅用 Node 22 內建模組（`node:http`、`node:crypto`、`node:zlib`、`node:fs`、`node:sqlite`）——符合 R1 且免安裝執行期套件。
  - 推播加密自行實作 RFC 8291，並以 **RFC 8291 Appendix A 官方測試向量**驗證（聲稱完成前必須通過）。
  - **資料儲存為本地 SQLite**：採內建 `node:sqlite`（Node 22.13.0 起免旗標；22.5–22.12 需 `--experimental-sqlite` 啟動），維持執行期零第三方相依；資料檔 `data/gauge.db`（0600、WAL、Prepared Statement）。若實作期遇 API 缺口，再評估 `better-sqlite3`（會引入執行期相依，需同步更新 R1 與 Gate A，見假設 9）。
- **供應商介面統一**：`check(account) → { windows:[{key,label,usedPct,remainingPct,resetsAt}], meta:{plan,email}, raw }`；登入介面 `startLogin()/exchange()/refresh()`。新增第五家 = 新增一個模組。
- **多語系（i18n）**：字典 `public/locales/{en,zh-TW,ja}.json`（三語同 key 結構），渲染層以 `t(key, params)` 取字；語系解析順序＝使用者偏好（localStorage，預設值存 settings）→ 瀏覽器 `navigator.language` → zh-TW；缺字回退 zh-TW → en；日期／時間／數字一律 `Intl.*` 依當前語系格式化；程式碼內禁止寫死 UI 文案，新增語系＝新增一份字典檔。

---

## 四、資料模型（本地 SQLite：`data/gauge.db`，權限 0600）

資料表以下列邏輯結構落地為 SQL DDL：

```
accounts      id, provider, label, interval_sec, thresholds(low_pct, recover_pct),
              auth(type, access_token, refresh_token, expires_at, extra_json),
              last_windows_json, last_meta_json, fetched_at, error
samples       account_id, t, remaining_pct        # 每帳號保留最近 200 筆供趨勢圖
settings      key, value                          # defaultInterval、push、vapid、authPin、defaultLocale…
subscriptions endpoint(PK), p256dh, auth, created_at, user_agent
events        id, account_id, kind(low|recovered|auth_expired), title, body, at, dedupe_key
schema_migrations version, applied_at
```

- `PRAGMA journal_mode=WAL`、`busy_timeout` 設定、全部寫入使用 Prepared Statement；結構變更以 `schema_migrations` 版本管理，禁止手改生產資料檔。
- Token／refresh 欄位**不得**出現在任何 API 回應或日誌（查詢層遮蔽，不進回應 JSON）。

---

## 五、REST API 設計

| Method | Path | 說明 |
|---|---|---|
| GET | `/api/status` | 全帳號最新額度、錯誤、上次查詢時間 |
| GET/POST | `/api/accounts` | 列表／新增（provider、label、interval、thresholds） |
| PATCH/DELETE | `/api/accounts/:id` | 編輯／刪除 |
| POST | `/api/accounts/:id/check` | 立即查詢 |
| POST | `/api/login/:provider/start` | 開始登入：**設備綁定碼為主**（回傳 `user_code`／`verification_uri`，伺服器端輪詢）；無裝置碼者回傳必要回導指示（見 2.6） |
| POST | `/api/login/:provider/complete` | 貼上代碼或回導網址完成登入（Claude／Antigravity 雲端零 callback 路徑） |
| GET | `/callback`、`/oauth2callback`、`:1455/auth/callback` | 各家回導（見二節） |
| GET | `/api/push/vapid-public-key` | 取 VAPID 公鑰 |
| POST/DELETE | `/api/push/subscribe` | 訂閱／解除訂閱（POST 訂閱、DELETE 解除） |
| POST | `/api/push/test` | 發送測試推播 |
| GET/PUT | `/api/settings` | 全域設定 |

- 供應商詢問一律由伺服器排程觸發；前端僅輪詢 `/api/status`（預設 30 秒）。

---

## 六、排程與推播規則

### 排程
- 每帳號獨立監測時間（固定 10 選項與供應商限制見 2.5），加 ±10% 抖動避免同步打 API。
- 單飛（in-flight 去重）：同一帳號上次未回不重複發起。
- 429/5xx：指數退避（1×→2×→4×，上限 30 分鐘），回復後恢復原間隔。
- Token 到期前 5 分鐘先 refresh，再查詢；refresh 失敗 → 標記 `auth_expired`。

### 通知事件與去重

| 事件 | 判定 | 預設門檻（可調） |
|---|---|---|
| 低額度 | 任一時窗 remainingPct 由「高於門檻」跌破門檻 | lowPct = 20% |
| 額度恢復 | 上次狀態為低／已用盡，本次 remainingPct ≥ 恢復門檻或 resetTime 已過且資料回正 | recoverPct = 90% |
| 憑證過期 | refresh 失敗或 401 | 固定 |

- 冷卻：同帳號＋同事件＋同時窗，6 小時內不重複發（可調）。
- 推播內容含：帳號標籤、供應商、時窗、剩餘 %、恢復倒數。

---

## 七、PWA 規格

- `manifest.webmanifest`：名稱「**Gauge.js**」（副標 訂閱額度儀表板）、`display: standalone`、theme 色、192／512 圖示（程式產生的 PNG，含 maskable）。
- **佈景主題 10 款（由白到黑）**：以 CSS custom properties ＋ `data-theme` 切換，預設跟隨系統（`prefers-color-scheme`），可手動鎖定並記住（localStorage；預設值存 settings）。

  | # | 主題 | 定位 | # | 主題 | 定位 |
  |---|---|---|---|---|---|
  | 1 | 純白 Pure | 最亮 | 6 | 月灰 Moonstone | 中灰 |
  | 2 | 雪白 Snow | 冷白 | 7 | 石墨 Graphite | 深灰偏亮 |
  | 3 | 象牙 Ivory | 暖白 | 8 | 鋼灰 Steel | 深灰 |
  | 4 | 霧白 Haze | 灰白 | 9 | 墨夜 Ink | 近黑 |
  | 5 | 銀灰 Silver | 淺灰 | 10 | 純黑 Void | 最暗 |

  - 每款定義一組 token：`background / surface / foreground / muted / border / accent`；額度狀態色（綠＝充足、黃＝偏低、紅＝耗盡）語意恆定、隨亮度微調。
  - `<meta name="theme-color">` 與 manifest `theme_color` 隨當前主題更新，表單控制項設 `color-scheme`，避免系統滾動條與輸入框在暗色下翻白。
- `sw.js`：
  - app shell 快取（stale-while-revalidate），離線可開
  - `push` 事件 → `showNotification`
  - `notificationclick` → 聚焦／開啟儀表板
- Web Push：VAPID（ES256）＋ RFC 8291 `aes128gcm`；TTL 3600；訂閱以 endpoint 為主鍵去重。
- ⚠️ **安全上下文**：Service Worker 與 Push 需 HTTPS 或 localhost。**Replit 託管時自動具備 HTTPS（*.repl.co／*.repl.app），手機可直接訂閱推播**；本機模式限 localhost 或自備反代憑證（Tailscale 網域等），純 `http://192.168.x.x` 手機端無法訂閱——列入部署說明。

---

## 八、安全性

1. 本機模式預設綁 `127.0.0.1`；Replit 等雲端託管綁 `0.0.0.0`（依平台 `$PORT`）且**強制**存取 PIN（`Authorization` 前置檢查），不得關閉。
2. `data/gauge.db` 權限 0600（WAL／-wal／-shm 同目錄一併保護）；憑證不寫日誌、不出 API、不進前端。
3. OAuth 回導一律驗證 `state`；PKCE verifier 只存記憶體（流程結束即棄）。
4. 出站僅對四家官方網域發請求，禁止任意網址參數化。
5. 公開客戶端憑證（client_id/secret）屬各 CLI 已公開揭露者，不視為本專案機密。

---

## 九、風險與因應

| 風險 | 影響 | 因應 |
|---|---|---|
| 四家皆非正式公開的內部端點，改版即失效 | 查額失敗 | 供應商模組隔離、回應解析容錯（多路徑取值）、失敗顯示明確錯誤而非靜默 |
| Claude usage 端點 429 嚴格 | 暫時拿不到資料 | 5 分鐘下限、退避、顯示「上次資料時間」 |
| Codex 回導埠 1455 被佔用 | 無法登入 Codex | 報錯明確指引；其餘三家不受影響 |
| Refresh token 輪替（Claude 明確、其餘待驗） | 未覆寫則永久登出 | 所有 refresh 回應一律原子覆寫保存 |
| Grok 欄位根層／config 不一致 | 解析失敗 | 兩處皆讀＋回退值 |
| 手機推播需 HTTPS | 部署門檻 | 部署章節給反代／憑證指引；localhost 本機不受影響 |
| 登入流程無法以無帳號自動測試 | 驗證困難 | 各家換碼以「錯誤路徑可驗、成功路徑留手動驗證關卡」；推播加密以官方測試向量驗證 |
| 介紹網址現為 404（Pages 已啟用但無 index.html） | 介紹頁無法對外 | 列入 Phase 4 交付：README + `index.html` 介紹頁上線 |
| Replit 方案休眠時排程停止 | 額度資料過期、推播延遲或漏發 | 狀態列顯示「服務未喚醒」；always-on 方案或外部定時 ping 喚醒，列入部署說明 |
| Replit 磁碟非保證持久 | `data/gauge.db`（含 refresh token）遺失、須重新登入 | 啟動時以 SQLite backup API 自動匯出備份檔；README 說明匯出／還原流程 |
| 雲端託管下 loopback 回導失效 | 無法使用本機登入路徑 | 各家 fallback（裝置碼／主機回導／貼回導網址），見 2.6 |

---

## 十、里程碑與 Gate（逐關通過才進下一階段）

### Phase 1 — 骨架
TypeScript 專案初始化（`tsc` 建置流程、型別設定）、靜態檔與 REST API、SQLite 資料層（DDL＋`schema_migrations`）、排程器、四家模組（先以 mock check 實作）。
**Gate A**：`tsc` 建置零錯誤；`dist/` 在 Node 22 啟動；`data/gauge.db` 初始化完成，`/api/status`、帳號 CRUD、手動 check（mock）資料可持久化；執行期零第三方相依。

### Phase 2 — 四家真實整合
四家 OAuth 登入 + refresh + 真實額度查詢。
**Gate B**：四家各自完成一次真實登入並回傳可解讀的額度資料（逐家 checklist）；其中至少在 Replit 託管模式下完成——Grok、Codex 以**設備綁定碼**、Claude、Antigravity 以**零 callback 貼代碼**路徑（2.6）；refresh 覆寫經兩輪驗證；429／401 退避與錯誤顯示正確。

### Phase 3 — PWA 與推播
Manifest、SW、圖示、VAPID、訂閱 API、事件判定與冷卻。
**Gate C**：以 RFC 8291 Appendix A 測試向量通過加密驗證；真機（或本機 Chrome）完成訂閱並收到「測試推播」；觸發低額度與恢復事件各一則（以可調門檻誘發）驗證去重。

### Phase 4 — 整合驗收
趨勢圖、錯誤狀態、安裝測試、部署說明、介紹頁。
**Gate D**：四帳號並列 24 小時無崩潰、資料持續更新；PWA 可安裝；10 款主題逐一切換無破版、暗色款對比度達 WCAG AA、跟隨系統與手動鎖定皆正常；三語（en／zh-TW／ja）逐頁抽查無缺字、切換即時生效且偏好重開後保留、日期與數字依語系格式化；README（本機與 Replit 啟動、HTTPS、休眠喚醒與備份還原、各供應商注意事項）與 `index.html` 介紹頁完成並推上 `main`（gauge.js-package.xyz 可正常開啟）；四份專案文件（`AGENTS.md`、`CLAUDE.md`、`PLAN.md`、`SECURITY.md`）依「專案文件」需求齊備。

---

## 十一、已知假設與未定項

1. 端點與公開客戶端憑證依 2026-09 查證（官方文件＋多個開源實作交叉），屬非正式 API，可能變動——已列入風險。
2. Claude token 端點兩別名（console／platform.claude.com）並存，實際以先主後備實測為準。
3. Codex `ChatGPT-Account-Id` 的取得欄位待實測（token 回應／id_token）。
4. Grok 帳號方案顯示取自 `/v1/settings`；其餘欄位根層與 `config` 雙讀。
5. Antigravity 的 Claude／GPT 池為「provider 池共用近似值」，權威值僅 Gemini REQUESTS 桶——介面須如實標示來源。
6. OAuth 成功路徑無法在無真實帳號的環境自動驗證，列為 Phase 2 手動關卡。
7. 監測時間固定 10 選項（30 秒～5 小時）為使用者指定；門檻、冷卻時間預設值可於設定頁調整。
8. 介紹網址 https://gauge.js-package.xyz 之 CNAME 已在倉庫內（GitHub Pages 已啟用），但目前無 `index.html` 回傳 404——介紹頁列為 Phase 4 交付。
9. TypeScript 僅為開發期依賴（`tsc` 編譯），執行期仍維持零第三方相依；編譯目標為 Node 22 可直接執行之 ESM。SQLite 採內建 `node:sqlite`：免旗標需 Node ≥ 22.13.0（22.5–22.12 以 `--experimental-sqlite` 啟動），該 API 現為 release candidate；若實作期遇 API 缺口改用 `better-sqlite3`，將引入執行期相依並同步更新 R1 與 Gate A。
10. 託管平台 Replit 為**暫定**（使用者裁示）；其方案限制（休眠、磁碟持久性、`$PORT` 綁定、自訂網域）以實作期為準，若更換平台需同步調整 2.6、八與九。

### 查證來源摘要
- Claude：Anthropic 連線器 OAuth 文件、Claude Code 成本／限制文件、多個 OAuth 反求解與 usage 查詢實作。
- Codex：Codex CLI 認證流程文件（auth.openai.com、client_id、1455 埠）、OpenUsage Codex provider 文件（wham/usage 欄位）。
- Grok：xAI OIDC 發現文件（auth.x.ai）、grok-build 官方認證文件、多個開源 xAI OAuth 實作（client_id、scope、billing 端點）。
- Antigravity：Antigravity 官方 plans／CLI `/usage` 文件、gemini-cli 開源 OAuth、agy-quota（retrieveUserQuota 端點與回應）。

---

開始執行。
