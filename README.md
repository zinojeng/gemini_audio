# Gemini Audio Transcriber

瀏覽器介面讓使用者上傳音訊並透過 Google Gemini 2.5 Pro / Flash 轉錄為文字，支援純文字、Markdown 與 SRT 輸出，並可選用 Gemini 2.5 Pro 進一步優化稿件。

## 功能特色
- 上傳常見音訊格式（wav、mp3、m4a 等），後端暫存於磁碟並送至 Gemini 轉錄。
- 可在 Gemini 2.5 Pro 與 Gemini 2.5 Flash 間選擇轉錄模型。
- 支援輸出格式：純文字、Markdown、SRT（內含時間碼，若模型無法提供則產生近似時間碼）。
- 以 Gemini 2.5 Pro 自動優化標點與語句，可依需求關閉。
- 前端提供複製與下載按鈕，便於取得結果。
- 偵測單檔超過 24MB 時，自動以 ffmpeg 切分為多段再逐段轉錄，最高支援約 150MB 檔案。
- 介面顯示「上傳 → 轉錄 → 優化/格式化」進度，長音檔分段轉錄時會同步更新段落完成率。

## 使用前準備
1. 申請並取得 Google AI Studio / Gemini API 金鑰。
2. 安裝相依套件（包含隨附的 ffmpeg 執行檔）：
   ```bash
   npm install
   ```

## 開發與啟動
```bash
npm run start
```
伺服器預設埠號為 `3000`，啟動後於瀏覽器開啟 `http://localhost:3000`。

> 若需即時重新載入，可自行改用 `npm run dev`，並先全域或本地安裝 nodemon。

## API 介面
### `POST /api/jobs`
建立轉錄任務並回傳任務代碼。

回傳內容：
- `jobId`：後續轉錄與進度追蹤所需的識別碼。

### `GET /api/jobs/:jobId/events`
Server-Sent Events (SSE) 管道，持續推送轉錄進度。事件種類：
- `progress`：內含 `phase`、`message`、`completedChunks` 等資訊。
- `job-error`：轉錄失敗時的錯誤訊息。
- `completed`：伺服器完成所有流程並即將回傳結果。

### `POST /api/transcribe`
Multipart form fields:
- `apiKey`：Gemini API 金鑰（必填）。
- `model`：`gemini-2.5-pro` 或 `gemini-2.5-flash`（選填，預設 Pro）。
- `optimize`：`true` / `false`，是否使用 Gemini 2.5 Pro 優化文字。
- `outputFormats`：JSON 字串陣列，例如 `["text","markdown","srt"]`（至少一項）。
- `audio`：音訊檔案（必填）。
- `jobId`：`POST /api/jobs` 取得的識別碼（必填）。

回傳內容：
- `fileName`：原始檔案名稱。
- `model`：實際使用的轉錄模型。
- `rawTranscript`：Gemini 直接轉錄結果。
- `optimizedTranscript`：若啟用優化則回傳優化後文本，否則為 `null`。
- `outputs`：依勾選格式回傳對應內容。

## 注意事項
- 伺服器不儲存金鑰、音訊或轉錄結果，僅將請求轉送至 Gemini API。
- 上傳音訊會暫存在 `uploads/`，處理完畢後自動刪除；多段切分資料會存於系統暫存資料夾並於轉錄結束清除。
- SRT 格式若模型無法提供有效時間碼，將使用字數推估生成漸進時間碼，適合快速預覽；正式字幕建議再行調整。
- 確認當前專案目錄可寫入與執行 `npm install` 及啟動腳本。
