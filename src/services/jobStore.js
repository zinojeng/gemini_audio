import { randomUUID } from "crypto";

const jobs = new Map();
const streams = new Map();

function getOrCreateStreamSet(jobId) {
  let set = streams.get(jobId);
  if (!set) {
    set = new Set();
    streams.set(jobId, set);
  }
  return set;
}

function emitToStream(res, type, payload) {
  res.write(`event:${type}\n`);
  res.write(`data:${JSON.stringify(payload)}\n\n`);
}

function broadcast(jobId, type, payload) {
  const set = streams.get(jobId);
  if (!set || set.size === 0) {
    return;
  }
  const serialized = `event:${type}\ndata:${JSON.stringify(payload)}\n\n`;
  set.forEach((res) => {
    res.write(serialized);
  });
}

function closeStreams(jobId) {
  const set = streams.get(jobId);
  if (!set) {
    return;
  }
  set.forEach((res) => {
    res.write("event:close\ndata:{}\n\n");
    res.end();
  });
  set.clear();
  streams.delete(jobId);
}

export function createJob() {
  const jobId = randomUUID();
  jobs.set(jobId, {
    status: "pending",
    createdAt: Date.now(),
    progress: null,
  });
  return jobId;
}

export function hasJob(jobId) {
  return jobs.has(jobId);
}

export function setJobStatus(jobId, status, metadata = {}) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }
  job.status = status;
  job.statusMetadata = { ...metadata, timestamp: Date.now() };
}

export function updateJobProgress(jobId, progress) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }
  const enriched = {
    ...progress,
    timestamp: Date.now(),
  };
  job.progress = enriched;
  broadcast(jobId, "progress", enriched);
}

export function completeJob(jobId, metadata = {}) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }
  job.status = "completed";
  job.completedAt = Date.now();
  job.resultMetadata = metadata;
  broadcast(jobId, "completed", metadata);
  closeStreams(jobId);
  jobs.delete(jobId);
}

export function failJob(jobId, error) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }
  job.status = "failed";
  job.error = {
    message: error?.message || "Unknown transcription failure",
    timestamp: Date.now(),
  };
  broadcast(jobId, "job-error", job.error);
  closeStreams(jobId);
  jobs.delete(jobId);
}

export function attachJobStream(jobId, res) {
  const job = jobs.get(jobId);
  if (!job) {
    return false;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 5000\n\n");

  if (job.progress) {
    emitToStream(res, "progress", job.progress);
  }

  if (job.status === "completed") {
    emitToStream(res, "completed", job.resultMetadata ?? {});
    res.end();
    return true;
  }

  if (job.status === "failed") {
    emitToStream(res, "job-error", job.error ?? {});
    res.end();
    return true;
  }

  const listeners = getOrCreateStreamSet(jobId);
  listeners.add(res);
  res.on("close", () => {
    listeners.delete(res);
    if (listeners.size === 0 && !jobs.has(jobId)) {
      streams.delete(jobId);
    }
  });

  return true;
}
export function removeJob(jobId) {
  jobs.delete(jobId);
  closeStreams(jobId);
}
