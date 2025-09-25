const form = document.querySelector("#transcription-form");
const apiKeyInput = document.querySelector("#apiKey");
const modelSelect = document.querySelector("#model");
const audioInput = document.querySelector("#audio");
const optimizeInput = document.querySelector("#optimize");
const agendaInput = document.querySelector("#agenda");
const resultsSection = document.querySelector("#results");
const resultSummary = document.querySelector("#result-summary");
const outputContainer = document.querySelector("#output-container");
const template = document.querySelector("#output-template");

const progressSection = document.querySelector("#progress");
const progressDetail = document.querySelector("#progress-detail");
const progressBarFill = document.querySelector(".progress-bar__fill");
const progressSteps = {
  prepare: document.querySelector('.progress-step[data-step="prepare"]'),
  upload: document.querySelector('.progress-step[data-step="upload"]'),
  transcribe: document.querySelector('.progress-step[data-step="transcribe"]'),
  finalize: document.querySelector('.progress-step[data-step="finalize"]'),
};

const FORMAT_LABELS = {
  text: "純文字",
  notes: "中文筆記",
  markdown: "Markdown",
  srt: "SRT",
};

const PROGRESS_WIDTH = {
  base: 6,
  uploadStart: 12,
  uploadDone: 74,
  transcribeStart: 74,
  transcribeEnd: 88,
  optimizeEnd: 92,
  formatEnd: 98,
  final: 100,
};
const TRANSCRIBE_SPAN = PROGRESS_WIDTH.transcribeEnd - PROGRESS_WIDTH.transcribeStart;
const FORMAT_SPAN = PROGRESS_WIDTH.formatEnd - PROGRESS_WIDTH.optimizeEnd;

let currentJobId = null;
let jobEventSource = null;
let transcribeTicker = null;
let uploadMarkedComplete = false;
const transcribeState = { total: 0, done: 0 };
const formatState = { total: 0, done: 0 };

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!apiKeyInput.value.trim()) {
    alert("請輸入 Gemini API Key");
    return;
  }

  const file = audioInput.files?.[0];
  if (!file) {
    alert("請選擇音訊檔案");
    return;
  }

  const selectedFormats = Array.from(
    document.querySelectorAll('input[name="format"]:checked'),
    (input) => input.value
  );

  if (!selectedFormats.length) {
    alert("請至少選擇一種輸出格式");
    return;
  }

  const submitButton = form.querySelector("button[type='submit']");
  submitButton.disabled = true;
  submitButton.textContent = "轉錄中...";

  resetProgress();
  formatState.total = selectedFormats.length;
  formatState.done = 0;

  try {
    currentJobId = await createJob();
  } catch (error) {
    submitButton.disabled = false;
    submitButton.textContent = "開始轉錄";
    markProgressError(error.message || "無法建立轉錄任務");
    renderError(error.message || "無法建立轉錄任務");
    return;
  }

  openJobStream(currentJobId);

  const formData = new FormData();
  formData.append("jobId", currentJobId);
  formData.append("apiKey", apiKeyInput.value.trim());
  formData.append("model", modelSelect.value);
  formData.append("optimize", optimizeInput.checked ? "true" : "false");
  formData.append("agenda", agendaInput?.value.trim() || "");
  formData.append("outputFormats", JSON.stringify(selectedFormats));
  formData.append("audio", file, file.name);

  try {
    const payload = await sendTranscriptionRequest(formData);

    stopTranscribeTicker();
    closeJobStream();

    setStepState("transcribe", "done");
    setStepState("finalize", "done");
    setProgressDetail("轉錄完成");
    if (progressBarFill) {
      progressBarFill.style.width = `${PROGRESS_WIDTH.final}%`;
    }

    renderResults(payload, selectedFormats);
  } catch (error) {
    console.error(error);
    stopTranscribeTicker();
    closeJobStream();
    markProgressError(error.message);
    renderError(error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "開始轉錄";
    currentJobId = null;
  }
});

async function createJob() {
  const response = await fetch("/api/jobs", { method: "POST" });
  if (!response.ok) {
    throw new Error("無法建立轉錄任務，請稍後再試");
  }
  const payload = await response.json();
  if (!payload?.jobId) {
    throw new Error("建立轉錄任務失敗");
  }
  return payload.jobId;
}

function openJobStream(jobId) {
  closeJobStream();
  if (!jobId) {
    return;
  }

  const source = new EventSource(`/api/jobs/${jobId}/events`);
  source.addEventListener("progress", handleJobProgress);
  source.addEventListener("job-error", handleJobErrorEvent);
  source.addEventListener("completed", handleJobCompleted);
  source.onerror = () => {
    // SSE 連線失敗時保持靜默，XHR 仍會處理結果。
  };
  jobEventSource = source;
}

function closeJobStream() {
  if (jobEventSource) {
    jobEventSource.removeEventListener("progress", handleJobProgress);
    jobEventSource.removeEventListener("job-error", handleJobErrorEvent);
    jobEventSource.removeEventListener("completed", handleJobCompleted);
    jobEventSource.close();
    jobEventSource = null;
  }
}

function handleJobProgress(event) {
  const data = safeParseJSON(event.data);
  if (!data) {
    return;
  }

  if (data.phase === "transcribe") {
    handleTranscribeProgress(data);
    return;
  }

  if (data.phase === "optimize") {
    handleOptimizeProgress(data);
    return;
  }

  if (data.phase === "format") {
    handleFormatProgress(data);
    return;
  }

  if (data.phase === "finalize") {
    if (data.status === "done") {
      setStepState("finalize", "done");
      if (progressBarFill) {
        progressBarFill.style.width = `${PROGRESS_WIDTH.final}%`;
      }
      setProgressDetail(data.message || "轉錄完成");
    }
  }
}

function handleTranscribeProgress(data) {
  if (typeof data.totalChunks === "number") {
    transcribeState.total = data.totalChunks;
  }
  if (typeof data.completedChunks === "number") {
    transcribeState.done = data.completedChunks;
  }

  if (progressSteps.transcribe.dataset.state === "pending") {
    setStepState("transcribe", "active");
  }

  const total = Math.max(transcribeState.total, 1);
  const done = Math.min(transcribeState.done, total);

  if (progressBarFill) {
    const ratio = Math.min(done / total, 1);
    const width = PROGRESS_WIDTH.transcribeStart + Math.round(ratio * TRANSCRIBE_SPAN);
    progressBarFill.style.width = `${Math.min(width, PROGRESS_WIDTH.transcribeEnd)}%`;
  }

  stopTranscribeTicker();
  setProgressDetail(
    data.message || `Gemini 轉錄中：完成 ${done}/${total}`
  );

  if (data.status === "done") {
    setStepState("transcribe", "done");
    setStepState("finalize", "active");
    if (progressBarFill) {
      progressBarFill.style.width = `${PROGRESS_WIDTH.transcribeEnd}%`;
    }
  }
}

function handleOptimizeProgress(data) {
  if (!optimizeInput.checked) {
    return;
  }

  if (data.status === "start") {
    setProgressDetail(data.message || "優化文字中...");
    if (progressBarFill) {
      progressBarFill.style.width = `${PROGRESS_WIDTH.transcribeEnd + 2}%`;
    }
    return;
  }

  if (data.status === "done") {
    setProgressDetail(data.message || "優化完成");
    if (progressBarFill) {
      progressBarFill.style.width = `${PROGRESS_WIDTH.optimizeEnd}%`;
    }
  }
}

function handleFormatProgress(data) {
  if (!data?.format) {
    return;
  }

  if (data.status === "start") {
    setProgressDetail(data.message || `產出 ${FORMAT_LABELS[data.format] ?? data.format}`);
    return;
  }

  if (data.status === "done") {
    formatState.done = Math.min(formatState.done + 1, formatState.total || 1);
    const ratio = formatState.total ? formatState.done / formatState.total : 1;
    if (progressBarFill) {
      const width = PROGRESS_WIDTH.optimizeEnd + Math.round(ratio * FORMAT_SPAN);
      progressBarFill.style.width = `${Math.min(width, PROGRESS_WIDTH.formatEnd)}%`;
    }

    if (formatState.done >= formatState.total) {
      setProgressDetail(data.message || "所有格式已產出");
    }
  }
}

function handleJobErrorEvent(event) {
  const payload = safeParseJSON(event.data) || {};
  closeJobStream();
  stopTranscribeTicker();
  markProgressError(payload.message || "轉錄失敗");
}

function handleJobCompleted(event) {
  const payload = safeParseJSON(event.data) || {};
  if (payload?.fileName) {
    setProgressDetail(`伺服器已完成處理：${payload.fileName}`);
  }
}

function sendTranscriptionRequest(formData) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/transcribe");
    xhr.responseType = "json";
    xhr.timeout = 0; // 0 代表不主動超時，改依伺服器回應為準

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        setProgressDetail("音訊上傳中...");
        return;
      }

      const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
      updateUploadProgress(percent);
      if (percent >= 100) {
        markUploadComplete();
      }
    };

    xhr.upload.onloadend = () => {
      markUploadComplete();
    };

    xhr.onreadystatechange = () => {
      if (xhr.readyState === XMLHttpRequest.HEADERS_RECEIVED) {
        markUploadComplete();
      }
    };

    xhr.onload = () => {
      stopTranscribeTicker();
      const payload = xhr.response ?? safeParseJSON(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        if (!payload) {
          reject(new Error("伺服器回傳格式不正確"));
          return;
        }
        resolve(payload);
      } else {
        const message = payload?.error || `轉錄失敗 (HTTP ${xhr.status})`;
        reject(new Error(message));
      }
    };

    xhr.onerror = () => {
      stopTranscribeTicker();
      reject(new Error("網路或伺服器連線失敗，請稍後再試"));
    };

    xhr.send(formData);
  });
}

function renderResults(payload, formats) {
  resultsSection.hidden = false;
  resultSummary.textContent = [
    payload.fileName ? `檔案：${payload.fileName}` : null,
    `模型：${payload.model}`,
    payload.optimizedTranscript ? "已啟用優化" : "未啟用優化",
  ]
    .filter(Boolean)
    .join(" • ");

  outputContainer.innerHTML = "";

  const outputs = payload.outputs ?? {};

  const blocks = [];

  if (formats.includes("notes") && outputs.notes) {
    blocks.push({
      title: FORMAT_LABELS.notes,
      value: outputs.notes,
      fileName: payload.fileName,
      format: "notes",
      suffix: "notes",
      open: true,
    });
  }

  if (payload.optimizedTranscript && payload.rawTranscript) {
    blocks.push({
      title: "原始轉錄稿（未優化）",
      value: payload.rawTranscript,
      fileName: payload.fileName,
      format: "raw",
      suffix: "raw",
    });
  }

  if (formats.includes("text") && outputs.text) {
    blocks.push({
      title: FORMAT_LABELS.text,
      value: outputs.text,
      fileName: payload.fileName,
      format: "text",
    });
  }

  ["markdown", "srt"].forEach((format) => {
    if (!formats.includes(format)) {
      return;
    }
    const value = outputs[format];
    if (!value) {
      return;
    }
    blocks.push({
      title: FORMAT_LABELS[format] ?? format,
      value,
      fileName: payload.fileName,
      format,
      suffix: format === "markdown" ? "markdown" : "",
    });
  });

  blocks.forEach((block, index) => {
    outputContainer.appendChild(
      createOutputNode({
        ...block,
        open: index === 0 ? block.open ?? true : block.open ?? false,
      })
    );
  });
}

function renderError(message) {
  resultsSection.hidden = false;
  resultSummary.textContent = `⚠️ ${message}`;
  outputContainer.innerHTML = "";
}

function createOutputNode({ title, value, fileName, format, suffix = "", open = false }) {
  const node = template.content.firstElementChild.cloneNode(true);
  const titleNode = node.querySelector(".output__title");
  const contentNode = node.querySelector(".output__content");
  const copyButton = node.querySelector(".copy-button");
  const downloadButton = node.querySelector(".download-button");

  titleNode.textContent = title;
  contentNode.textContent = value;
  node.open = open;

  copyButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      copyButton.textContent = "已複製";
      setTimeout(() => {
        copyButton.textContent = "複製";
      }, 1200);
    } catch (_err) {
      alert("複製失敗，請手動複製");
    }
  });

  downloadButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const blob = new Blob([value], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = buildFileName(fileName, format, suffix);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });

  return node;
}

function buildFileName(original, format, suffix = "") {
  const base = original?.split(".").slice(0, -1).join(".") || "transcript";
  const extension = {
    text: "txt",
    notes: "md",
    markdown: "md",
    srt: "srt",
  }[format] || "txt";

  const suffixPart = suffix ? `-${suffix}` : "";

  return `${base}${suffixPart}.${extension}`;
}

function resetProgress() {
  if (progressSection) {
    progressSection.hidden = false;
  }
  uploadMarkedComplete = false;
  transcribeState.total = 0;
  transcribeState.done = 0;
  formatState.done = 0;
  stopTranscribeTicker();
  progressBarFill?.classList.remove("progress-bar__fill--error");
  if (progressBarFill) {
    progressBarFill.style.width = `${PROGRESS_WIDTH.base}%`;
  }
  setProgressDetail("準備上傳中...");
  setStepState("prepare", "active");
  setStepState("upload", "pending");
  setStepState("transcribe", "pending");
  setStepState("finalize", "pending");
  resultsSection.hidden = true;
}

function setStepState(step, state) {
  const node = progressSteps[step];
  if (node) {
    node.dataset.state = state;
  }
}

function setProgressDetail(text) {
  if (progressDetail) {
    progressDetail.textContent = text;
  }
}

function updateUploadProgress(percent) {
  if (progressSteps.upload.dataset.state === "pending") {
    setStepState("upload", "active");
  }
  const scaled = Math.min(PROGRESS_WIDTH.uploadDone, Math.max(PROGRESS_WIDTH.uploadStart, Math.round((percent / 100) * PROGRESS_WIDTH.uploadDone)));
  if (progressBarFill) {
    progressBarFill.style.width = `${scaled}%`;
  }
  setProgressDetail(`音訊上傳中 ${percent}%`);
}

function markUploadComplete() {
  if (uploadMarkedComplete) {
    return;
  }
  uploadMarkedComplete = true;
  setStepState("prepare", "done");
  setStepState("upload", "done");
  setStepState("transcribe", "active");
  if (progressBarFill) {
    progressBarFill.style.width = `${PROGRESS_WIDTH.transcribeStart}%`;
  }
  stopTranscribeTicker();
  setProgressDetail("Gemini 轉錄中，請稍候");
  startTranscribeTicker();
}

function startTranscribeTicker() {
  if (transcribeTicker) {
    return;
  }
  let frame = 0;
  const base = "Gemini 轉錄中，請稍候";
  transcribeTicker = setInterval(() => {
    const dots = ".".repeat(frame % 4);
    setProgressDetail(`${base}${dots}`);
    frame += 1;
  }, 420);
}

function stopTranscribeTicker() {
  if (transcribeTicker) {
    clearInterval(transcribeTicker);
    transcribeTicker = null;
  }
}

function markProgressError(message) {
  const uploadState = progressSteps.upload.dataset.state;
  const failingStep = uploadMarkedComplete || uploadState === "done" ? "transcribe" : uploadState === "active" ? "upload" : "prepare";
  setStepState(failingStep, "error");
  if (!uploadMarkedComplete && failingStep !== "upload") {
    setStepState("upload", "pending");
  }
  setStepState("finalize", "pending");
  progressBarFill?.classList.add("progress-bar__fill--error");
  if (progressBarFill) {
    progressBarFill.style.width = `${PROGRESS_WIDTH.final}%`;
  }
  setProgressDetail(`⚠️ ${message}`);
}

function safeParseJSON(payload) {
  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch (_error) {
    return null;
  }
}
