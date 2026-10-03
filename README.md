# Gauge.js

自架 AI 訂閱額度儀表板：Antigravity、Codex、Claude、Grok 多帳號監測，PWA 安裝與低額度／恢復／憑證過期推播。TypeScript、ESM、Node 原生 HTTP / SQLite / Web Push；執行期零第三方套件。

[專案介紹](https://gauge.js-package.xyz) 是 GitHub Pages 靜態頁，**不是儀表板或 API**。真正儀表板由 Node 服務的 `public/index.html` 提供。保留既有 CNAME 與 Apache-2.0 LICENSE。

## 本機啟動

最低 **Node.js 22.13.0**（`node:sqlite` 免實驗旗標）；建議使用仍受維護的 Node LTS。22.0–22.12 不屬本專案支援執行版本。建置期需要 npm、TypeScript 與 `@types/node`，後兩者僅開發依賴。

```sh
npm install
npm run build
npm start
```

開啟 `http://localhost:8787`。`npm run dev` 用於開發；`npm test` 執行專案測試。不要把上述命令視為已通過的驗收證據。環境設定範例見 `.env.example`；服務讀取程序環境，不應假設自動載入 `.env`。可用 Node 的 `--env-file=.env` 選項啟動編譯後入口，或在 shell／平台設定環境變數。

## 設定

| 環境變數 | 預設／規則 |
| --- | --- |
| `PORT` | `8787`；平台提供埠時以平台值為準 |
| `HOST` | 本機 `127.0.0.1`；雲端 `0.0.0.0` |
| `GAUGE_CLOUD` | `1` 明確啟用雲端；Replit 環境亦可自動識別 |
| `GAUGE_PIN` | 雲端必填，至少 8 字元；本機可選但建議設定長且隨機的值 |
| `GAUGE_ORIGIN` | 雲端必須有明確 HTTPS origin，例如 `https://your-app.replit.app`；有效 Replit 開發網域可自動推導。不要加入路徑、查詢或多個 origin |
| `GAUGE_DATA_DIR` | `data`；保存 SQLite、VAPID 與備份等敏感資料 |
| `VAPID_SUBJECT` | `mailto:gauge@localhost`；部署時改成有效聯絡信箱或 HTTPS 聯絡網址 |

雲端不可關閉 PIN。PIN 以 `Authorization: Bearer …` 傳送；前端僅在 sessionStorage 保持解鎖，不應置於 URL、localStorage、Git 或日誌。PIN 不會從 API 回傳。這是**單使用者共用金鑰**而非多租戶登入；知道 PIN 的人能操作全部帳號。公開靜態外殼不代表敏感 API 可公開讀取。

## Replit / HTTPS 部署

1. 匯入倉庫，選擇提供 **Node ≥22.13** 的執行環境；`.replit` 的 run/build 設定不保證平台實際 Node 版本，請先檢查 `node --version`。
2. 在 Secrets 設定 `GAUGE_CLOUD=1`、長隨機 `GAUGE_PIN`、`GAUGE_ORIGIN=https://實際公開網域`、有效 `VAPID_SUBJECT`，以及有持久磁碟支援時的 `GAUGE_DATA_DIR`。不要把 Secrets 寫入 `.replit`。
3. 安裝並建置，執行 `npm start`；讓平台把 HTTPS 公開埠代理到 `$PORT`，服務綁定 `0.0.0.0`。正式網域與開發預覽網域不同時需更新 origin 後重啟。
4. 確認未解鎖 API 被拒絕、錯誤 origin 被拒絕、PIN 不出現在回應或日誌，才登入真實帳號。

HTTPS 由平台／反向代理終止；Gauge 不自行簽發憑證。非 Replit 平台也應明確設定 cloud、PIN、HTTPS origin 與持久目錄，只允許可信反代連入服務埠。不要直接將本機未保護服務暴露到公網。

**休眠不是持續監測**：Replit 方案、部署類型、持久磁碟與網域政策可能變動，必須依當前平台條款確認。睡眠或關機期間沒有排程或推播；醒來只能補查目前額度，不能重建已錯過的低額度事件。使用符合需求的 always-on 部署；若平台允許，可用外部定時 HTTPS 探測喚醒，但不保證不中斷、也不能規避平台限制。介面資料時間與服務可用性比「頁面還能離線開啟」更可靠。

Replit 工作區／部署檔案系統**不保證永久或跨部署持久**。自動備份若在同一磁碟也會一起遺失。正式部署前驗證磁碟持久性，並定期將加密備份匯出到自己控制的外部儲存。

## 各家登入與額度注意事項

全部透過網頁開始登入，不讀取 CLI 憑證檔。憑證保存在伺服器 SQLite，不在前端。登入交易短期存於記憶體，重啟需重新開始。

- **Grok**：優先設備碼；在 `accounts.x.ai` 或 `auth.x.ai` 驗證頁輸入顯示代碼，等待伺服器輪詢。有效期遵循上游 `expires_in`（實測 30 分鐘）。若選本機回導備援，使用 `127.0.0.1:56121`；埠衝突不影響設備碼。
- **Codex**：優先設備碼（帳號或組織可能需允許設備碼登入）；本機回導固定 `localhost:1455/auth/callback`，埠已被 CLI 占用時關閉占用程序或改用設備碼，不能任意改埠。
- **Claude**：沒有可用的消費者設備碼 grant。雲端使用官方代碼頁後貼回完整帶 state 的回導資訊；官方頁是否提供所需代碼／state 仍須以真實帳號確認，不可繞過 state 檢查。可使用本機 `/callback` 流程。用量端點容易 429，預設 5 分鐘；進階短間隔不會增加額度精度，可能遭長時間限流。refresh token 會輪替。
- **Antigravity**：Google 設備碼流程不能取得所需 `cloud-platform` scope。雲端授權後瀏覽器可能跳到無法連線的 `127.0.0.1`；**保留完整網址（含 code 和 state）貼回儀表板**，不需要在手機啟動本機服務。本機可用 `/oauth2callback`。Gemini REQUESTS 桶為權威資料；其他模型共享池只能視為近似值。

協定以目前上游實作為準，不照抄已變動的範例：Codex 使用[官方設備碼協定](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs)、[目前登入 scope](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs)（`api.connectors.read api.connectors.invoke`，非舊 `chatgpt_api`），額度支援 `primary_window`／`secondary_window` 與舊格式。Grok 端點依[公開 OIDC metadata](https://auth.x.ai/.well-known/openid-configuration)；部分帳號無直接剩餘百分比時，替代池明確標為近似，不把缺失資料當成零。Claude 貼回需保留 `code#state` 或含 state 的完整網址；Google 保留完整回導網址。僅增加 TypeScript 與 `@types/node` 作為開發工具，執行期仍為零 npm 套件依賴。

**Loopback 指的是瀏覽器所在裝置，不是雲端伺服器**。本機 callback 必須在跑服務的電腦瀏覽器完成；手機不能替另一台電腦接收 localhost 回導。雲端不註冊本機 callback，使用設備碼／貼回方式。不要把回導網址貼到 issue、聊天或日誌；授權碼亦屬敏感資料。供應商公開客戶端與非正式額度端點可能改版；錯誤不得用假額度掩蓋。Codex 帳號 ID、Claude 貼回頁行為及各家 refresh 輪替皆需要真實帳號驗證。

### 已連結但無額度：Gemini 與 Grok

- **Gemini / 現有 `antigravity` 帳號**：目前 Google OAuth 仍使用企劃書指定的 Gemini CLI 公開客戶端，並非新版 Antigravity OAuth 整合。[Google 已於 2026-06-18 停止個人／Google AI Pro／Ultra 帳號使用此路徑](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals)。實測 OAuth 成功，但 `loadCodeAssist` 回 `UNSUPPORTED_CLIENT`，額度請求回 `403 SUBSCRIPTION_REQUIRED`。介面會顯示 `GOOGLE_CONSUMER_UNSUPPORTED`，重新登入不能解決；需要另外完成新版 Antigravity 整合，不能僅更改名稱或假裝已有額度。受支援的 Code Assist Standard／Enterprise 不應被誤判為消費者停用；查詢會先取得 quota project。
- **Grok**：實測 OAuth 成功，兩種 billing 格式皆 HTTP 200，但缺少 `creditUsagePercent` 且可用分母為 0，無法得出剩餘百分比。有效週期但未提供用量時顯示 `GROK_QUOTA_UNAVAILABLE`；這不代表憑證失效、不代表沒有訂閱，也不能當成剩餘 100%。[官方 Grok Build billing 實作](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs)將百分比視為可選；[其他整合的已知限制](https://github.com/steipete/CodexBar/blob/main/docs/grok.md)亦記錄此情況。現有 OAuth REST 路徑無法提供這個帳號的真實額度，請在官方介面查看；未加入瀏覽器 cookies／WKE 讀取或未驗證的替代來源。
- 診斷修正已通過建置、38 項測試、真實帳號查詢與桌面瀏覽器錯誤顯示驗證；**不是兩家額度已恢復的宣告**。更新後重新載入頁面，讓 PWA 靜態快取切換至新版。

## 排程與 PWA

每帳號間隔：30 秒、1／2／5／10／15／30 分鐘、1／2／5 小時。預設 Claude／Codex／Antigravity 5 分鐘、Grok 10 分鐘；Claude 短於 5 分鐘選項需進階模式。排程有單飛、±10% 抖動與 429/5xx 指數退避（上限 30 分鐘），每帳號保留最近 200 筆趨勢。預設低額度 20%、恢復 90%、同事件冷卻 6 小時，可調整。

推播需使用者允許通知並完成裝置訂閱；關閉分頁不等於停止伺服器監測。PWA 需要 HTTPS 或 localhost；手機使用 `http://192.168.x.x` 不具安全上下文，請使用可信 HTTPS 反代／Tailscale HTTPS 網域。iOS/iPadOS 依瀏覽器與 OS 支援可能需加入主畫面後才可訂閱。Web Push 交付受平台、網路與裝置省電影響，不是即時保證。

離線只快取介面外殼，不快取 API／token；離線頁不是即時額度。可切換三語（繁中、英文、日文）與十款白到黑主題；預設跟隨系統，偏好留在瀏覽器。

## 備份與還原

SQLite 使用 WAL，資料目錄與所有 DB/WAL/SHM 檔都要限制存取（DB 0600）。備份含 refresh token、推播訂閱與 VAPID 私鑰；使用加密儲存、限定存取與合理保留期限，**絕不可提交到 Git**。

啟動會產生 SQLite 一致性備份；採原生 SQLite backup API，Node 22.13 無該 API 時以 `VACUUM INTO` 匯出一致快照，不是直接複製運行中的主 DB。

```sh
npm run backup -- /secure/external-location/gauge-backup.db
```

指定一個不存在的輸出檔案；備份成功後另行安全匯出。保留多個版本，定期在隔離環境測試還原；同一磁碟上的備份無法抵抗磁碟遺失。

還原：停止所有 Gauge 程序，將現有資料目錄移到安全位置留作回復，建立受限資料目錄，把備份放回 `$GAUGE_DATA_DIR/gauge.db` 並設 0600；不要混用舊 `gauge.db-wal` / `gauge.db-shm`。以相容版本啟動，檢查帳號、設定、VAPID 公鑰與真實額度查詢。若輪替後的 refresh token 已被舊備份取代，帳號可能必須重新登入；VAPID 金鑰不相同時，裝置需重新訂閱。不要對運行中的資料庫手改 schema。PIN／origin 是環境配置，還原時須另行恢復。

## 驗收狀態與手動關卡

原始要求全文見 [PLAN.md](PLAN.md)，工作規範見 [AGENTS.md](AGENTS.md)，安全政策見 [SECURITY.md](SECURITY.md)。以下區分實測證據與未完成的外部驗收，**不宣稱已部署或所有 Gate 完成**。

已完成的本機驗證：

- 建置成功；Node **22.13.1** 執行 **32 個測試，全數通過**，涵蓋 OAuth 狀態／過期／取消、額度解析、憑證輪替競態、Retry-After 與退避界限、SQLite 持久化與備份、HTTP/PIN 安全及 RFC 8291 Appendix A 精確向量。
- 實際啟動 Node 22.13.1 服務；Edge 瀏覽器驗證 PIN、帳號新增／編輯／刪除、10 種間隔與 Claude 進階限制、三語／十主題與偏好保存、系統明暗切換、390px 介面與離線重新載入。Service Worker 僅快取外殼，API 未進快取；瀏覽器 manifest／installability 檢查無錯誤，未以此代稱已安裝。
- 真實桌面 Edge 訂閱與 VAPID 推播：測試推播送出 **1**、失敗 **0**，Service Worker 實際收到通知；合成額度跨越閾值後各收到一則低額度／恢復通知，同窗口重複跨越未再產生事件。驗證後已取消測試訂閱。
- 實際向官方 Codex 與 Grok 取得設備碼並取消交易；Grok 驗證網址為 `accounts.x.ai`、有效期 1,800 秒。這只證明登入起始協定可用，**不代表真實帳號登入成功**。
- Node 22 的一致性備份匯出成功，測試驗證還原後帳號／新憑證／偏好可讀；介紹頁已在本機瀏覽器開啟，`PLAN.md` 與原企劃逐位元組一致。UI 額度與通知閾值 smoke 使用隔離資料庫／合成資料，不是供應商實際額度。

仍需使用自己的帳號與部署環境完成：

- Gate A：在目標部署環境重跑建置、初始化、CRUD／持久化與排程。
- Gate B：四家真實登入與可讀額度；每家兩輪 refresh 後新 token 已保存；實際 429／401；Replit 上的設備碼及零 callback 貼回流程。
- Gate C：目標手機／OS 的訂閱、推播及關閉分頁後送達；本機桌面證據不能替代所有平台。
- Gate D：四帳號 24 小時監測、實際 PWA 安裝、完整 WCAG AA／三語逐頁檢查、部署磁碟與外部備份還原演練、Pages 正式網域確認。推送 main／部署須另行授權。

## License

Apache-2.0；見 [LICENSE](LICENSE)。
