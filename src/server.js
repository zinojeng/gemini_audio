import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { promises as fsPromises } from "fs";
import { fileURLToPath } from "url";
import { transcribeAudio } from "./services/transcription.js";
import {
  createJob,
  hasJob,
  attachJobStream,
  updateJobProgress,
  completeJob,
  failJob,
  setJobStatus,
} from "./services/jobStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const uploadsDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const timestamp = Date.now();
      const safeName = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_");
      cb(null, `${timestamp}-${safeName}`);
    },
  }),
  limits: {
    fileSize: 150 * 1024 * 1024,
  },
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "../public")));

app.post("/api/jobs", (_req, res) => {
  const jobId = createJob();
  res.json({ jobId });
});

app.get("/api/jobs/:jobId/events", (req, res) => {
  const { jobId } = req.params;
  if (!hasJob(jobId)) {
    return res.status(404).end();
  }

  attachJobStream(jobId, res);
});

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.body?.apiKey) {
      return res.status(400).json({ error: "Missing Gemini API key" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Audio file is required" });
    }

    const jobId = req.body.jobId;
    if (!jobId || !hasJob(jobId)) {
      return res.status(400).json({ error: "Invalid or missing jobId" });
    }

    const model = req.body.model || "gemini-2.5-pro";
    const optimize = req.body.optimize === "true";
    const outputFormatsRaw = req.body.outputFormats || "[]";

    let outputFormats;
    try {
      outputFormats = JSON.parse(outputFormatsRaw);
    } catch (_error) {
      return res.status(400).json({ error: "Invalid outputFormats payload" });
    }

    setJobStatus(jobId, "processing");
    updateJobProgress(jobId, {
      phase: "upload",
      status: "received",
      fileName: req.file.originalname,
    });

    const result = await transcribeAudio({
      apiKey: req.body.apiKey,
      model,
      optimize,
      outputFormats,
      filePath: req.file.path,
      mimeType: req.file.mimetype,
      originalFileName: req.file.originalname,
      agenda: req.body.agenda,
      onProgress: (progress) => updateJobProgress(jobId, progress),
    });

    completeJob(jobId, { fileName: result.fileName, model: result.model });
    return res.json(result);
  } catch (error) {
    console.error("/api/transcribe failed", error);
    const jobId = req.body?.jobId;
    if (jobId && hasJob(jobId)) {
      failJob(jobId, error);
    }
    const status = error?.response?.status || 500;
    return res.status(status).json({
      error: error?.message || "Unexpected server error",
    });
  }
  finally {
    if (req.file?.path) {
      fsPromises.unlink(req.file.path).catch(() => {});
    }
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "上傳檔案超過 150MB 限制，請先分割或壓縮後再試。",
      });
    }

    return res.status(400).json({ error: `檔案上傳失敗 (${err.code})` });
  }

  console.error("Unhandled server error", err);
  return res.status(500).json({ error: "Unexpected server error" });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Gemini audio transcription server listening on http://localhost:${PORT}`);
});

// Node.js 預設請求逾時為 2 分鐘，長音檔轉錄會超過此時間限制，需調整。
server.requestTimeout = 1000 * 60 * 30; // 30 分鐘
server.headersTimeout = 1000 * 60 * 31; // 稍長於 requestTimeout 以避免提前關閉
