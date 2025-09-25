import { GoogleGenerativeAI } from "@google/generative-ai";
import { promises as fs } from "fs";
import { buildApproximateSrt } from "../utils/srtFormatter.js";
import { stripCodeFences } from "../utils/text.js";
import { splitAudioFile, removeDirectory } from "../utils/audioChunker.js";

const SUPPORTED_MODELS = new Set(["gemini-2.5-pro", "gemini-2.5-flash"]);
const SUPPORTED_FORMATS = new Set(["text", "notes", "markdown", "srt"]);
const INLINE_AUDIO_BYTES_THRESHOLD = 24 * 1024 * 1024;

const TRANSCRIPTION_PROMPT = [
  "Transcribe the audio content verbatim.",
  "Return plain text only without speaker labels, timestamps, or commentary.",
  "Maintain the original language detected in the audio.",
].join(" ");

const OPTIMIZATION_PROMPT = [
  "Improve the readability of the transcript while preserving meaning.",
  "Fix obvious punctuation, apply sentence casing, and remove filler words when safe.",
  "Do not summarise or omit important information.",
  "Return plain text only.",
].join(" ");

const MARKDOWN_PROMPT = [
  "Rewrite the transcript as clean Markdown.",
  "Use paragraphs and lists when it improves readability, but avoid fabricating headings.",
  "Do not add content that is not present in the transcript.",
].join(" ");

const SRT_PROMPT = [
  "Convert the transcript into SubRip (SRT) format with realistic timestamps.",
  "If exact timings are unknown, estimate steadily increasing timestamps.",
  "Return valid SRT text only.",
].join(" ");

function buildNotesPrompt(transcript, agenda) {
  const agendaBlock = agenda
    ? `以下是使用者提供的議程，請依照議程順序分段整理：\n${agenda}`
    : "使用者未提供議程，請依內容合理分段，同時保持清楚層級。";

  return [
    "你是一位中文逐字稿整理專家，請依照以下指示整理稿件。",
    "儘可能保留的演講者內容，並作修飾潤稿，階層或重點化（粗體或底線或斜線）。",
    "more detail summary in 筆記。但儘可能保留的演講者內容，並作修飾潤稿，階層或重點化（粗體或底線或斜線）。",
    "根據使用者給予的 agenda 來分段整理。",
    "need more clear detailed comprehensive summary for speaker said。",
    "not 完整呈現演講內容，請修正。",
    "不是 summary ，是整理 speaker 內容，revised , 但儘可能完整呈現, 修飾潤稿，階層或重點化（粗體或底線或斜線）。",
    agendaBlock,
    "請輸出為繁體中文 Markdown，使用條列、階層、標題與粗體／斜體／底線強調關鍵重點，避免新增額外結語或註解。",
    "逐字稿如下：",
    transcript,
  ].join("\n\n");
}

function normaliseFormats(formats) {
  if (!Array.isArray(formats)) {
    return [];
  }

  const unique = new Set();
  formats.forEach((format) => {
    if (typeof format === "string" && SUPPORTED_FORMATS.has(format)) {
      unique.add(format);
    }
  });

  return Array.from(unique);
}

function ensureModel(model) {
  if (SUPPORTED_MODELS.has(model)) {
    return model;
  }

  return "gemini-2.5-pro";
}

function bufferToBase64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

async function runTranscriptionRequest(transcriptionModel, buffer, mimeType) {
  const requestPayload = [
    {
      inlineData: {
        data: bufferToBase64(buffer),
        mimeType,
      },
    },
    { text: TRANSCRIPTION_PROMPT },
  ];

  const transcription = await transcriptionModel.generateContent(requestPayload);
  return transcription.response.text().trim();
}

async function optimiseTranscript(model, transcript) {
  const response = await model.generateContent([
    { text: `${OPTIMIZATION_PROMPT}\n\nTranscript:\n${transcript}` },
  ]);

  return response.response.text().trim();
}

async function toMarkdown(model, transcript) {
  const response = await model.generateContent([
    { text: `${MARKDOWN_PROMPT}\n\nTranscript:\n${transcript}` },
  ]);

  return response.response.text().trim();
}

async function toSrt(model, transcript) {
  const response = await model.generateContent([
    { text: `${SRT_PROMPT}\n\nTranscript:\n${transcript}` },
  ]);

  const raw = response.response.text().trim();
  const cleaned = stripCodeFences(raw);
  return cleaned.includes("-->") ? cleaned : raw;
}

async function toChineseNotes(model, transcript, agenda) {
  const response = await model.generateContent([
    { text: buildNotesPrompt(transcript, agenda) },
  ]);

  const raw = response.response.text().trim();
  return stripCodeFences(raw);
}

export async function transcribeAudio({
  apiKey,
  model,
  optimize,
  outputFormats,
  filePath,
  mimeType,
  originalFileName,
  onProgress,
  agenda,
}) {
  if (!apiKey) {
    throw new Error("A Gemini API key is required");
  }

  const selectedModel = ensureModel(model);
  const formats = normaliseFormats(outputFormats);

  if (!formats.length) {
    throw new Error("At least one output format must be selected");
  }

  if (!filePath) {
    throw new Error("Audio file path is required");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const transcriptionModel = genAI.getGenerativeModel({ model: selectedModel });

  const fileStats = await fs.stat(filePath);
  const cleanupTargets = [];
  let rawTranscript = "";
  const report = (progress) => {
    if (typeof onProgress === "function") {
      onProgress(progress);
    }
  };

  try {
    if (fileStats.size <= INLINE_AUDIO_BYTES_THRESHOLD) {
      const audioBuffer = await fs.readFile(filePath);
      report({
        phase: "transcribe",
        totalChunks: 1,
        completedChunks: 0,
        message: "正在轉錄音訊 (1 段)",
      });
      rawTranscript = await runTranscriptionRequest(
        transcriptionModel,
        audioBuffer,
        mimeType
      );
      report({
        phase: "transcribe",
        totalChunks: 1,
        completedChunks: 1,
        status: "done",
        message: "轉錄完成 (1/1)",
      });
    } else {
      const { chunkPaths, tempDir } = await splitAudioFile(filePath);
      cleanupTargets.push(tempDir);

      if (!chunkPaths.length) {
        throw new Error("Audio chunking failed to produce segments");
      }

      const chunkTranscripts = [];
      report({
        phase: "transcribe",
        totalChunks: chunkPaths.length,
        completedChunks: 0,
        message: `正在轉錄音訊 (共 ${chunkPaths.length} 段)`,
      });
      for (const chunkPath of chunkPaths) {
        const chunkBuffer = await fs.readFile(chunkPath);
        const chunkTranscript = await runTranscriptionRequest(
          transcriptionModel,
          chunkBuffer,
          "audio/wav"
        );
        if (chunkTranscript) {
          chunkTranscripts.push(chunkTranscript);
        }
        report({
          phase: "transcribe",
          totalChunks: chunkPaths.length,
          completedChunks: chunkTranscripts.length,
          message: `轉錄中：完成 ${chunkTranscripts.length}/${chunkPaths.length}`,
        });
      }

      rawTranscript = chunkTranscripts.join("\n\n").trim();
      report({
        phase: "transcribe",
        totalChunks: chunkPaths.length,
        completedChunks: chunkPaths.length,
        status: "done",
        message: `轉錄完成 (${chunkPaths.length}/${chunkPaths.length})`,
      });
    }
  } finally {
    await Promise.all(cleanupTargets.map((dir) => removeDirectory(dir)));
  }

  if (!rawTranscript) {
    throw new Error("Transcription returned empty result");
  }

  const agendaText = typeof agenda === "string" ? agenda.trim() : "";

  const needsProModel =
    optimize ||
    formats.includes("markdown") ||
    formats.includes("srt") ||
    formats.includes("notes");
  const proModel = needsProModel
    ? genAI.getGenerativeModel({ model: "gemini-2.5-pro" })
    : null;

  let improvedTranscript = rawTranscript;

  if (optimize && proModel) {
    report({ phase: "optimize", status: "start", message: "優化文字中" });
    improvedTranscript = await optimiseTranscript(proModel, rawTranscript);
    report({ phase: "optimize", status: "done", message: "優化完成" });
  }

  const outputs = {};

  await Promise.all(
    formats.map(async (format) => {
      report({ phase: "format", format, status: "start", message: `產出 ${format} 中` });
      if (format === "text") {
        outputs.text = improvedTranscript;
        report({ phase: "format", format, status: "done", message: `${format} 產出完成` });
        return;
      }

      if (format === "markdown") {
        if (proModel) {
          outputs.markdown = await toMarkdown(proModel, improvedTranscript);
        } else {
          outputs.markdown = improvedTranscript;
        }
        report({ phase: "format", format, status: "done", message: `${format} 產出完成` });
        return;
      }

      if (format === "notes") {
        if (!proModel) {
          throw new Error("中文筆記輸出需要 Gemini 2.5 Pro 模型");
        }
        outputs.notes = await toChineseNotes(proModel, rawTranscript, agendaText);
        report({ phase: "format", format, status: "done", message: `${format} 產出完成` });
        return;
      }

      if (format === "srt") {
        if (proModel) {
          const candidate = await toSrt(proModel, improvedTranscript);
          outputs.srt = candidate.includes("-->")
            ? candidate
            : buildApproximateSrt(improvedTranscript);
        } else {
          outputs.srt = buildApproximateSrt(improvedTranscript);
        }
        report({ phase: "format", format, status: "done", message: `${format} 產出完成` });
      }
    })
  );

  report({ phase: "finalize", status: "done", message: "轉錄完成" });

  return {
    fileName: originalFileName,
    model: selectedModel,
    rawTranscript,
    optimizedTranscript: optimize ? improvedTranscript : null,
    outputs,
  };
}
