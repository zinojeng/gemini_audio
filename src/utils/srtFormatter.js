function toTimecode(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.floor((totalSeconds % 1) * 1000);

  const pad = (value, size) => String(value).padStart(size, "0");

  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(milliseconds, 3)}`;
}

function splitIntoChunks(text, maxWords = 18) {
  if (!text?.trim()) {
    return [];
  }

  const sentences = text
    .replace(/\s+/g, " ")
    .match(/[^.!?。！？\n]+[.!?。！？]?/g);

  if (!sentences) {
    return [text.trim()];
  }

  const chunks = [];

  sentences.forEach((sentence) => {
    const words = sentence.trim().split(/\s+/);
    if (words.length <= maxWords) {
      chunks.push(sentence.trim());
      return;
    }

    for (let i = 0; i < words.length; i += maxWords) {
      chunks.push(words.slice(i, i + maxWords).join(" "));
    }
  });

  return chunks;
}

function estimateDurationSeconds(chunk) {
  const wordCount = chunk.split(/\s+/).filter(Boolean).length;
  const charCount = chunk.replace(/\s+/g, "").length;

  const effectiveLength = Math.max(wordCount, Math.ceil(charCount / 6));
  return Math.max(3, Math.round(effectiveLength * 0.6));
}

export function buildApproximateSrt(transcript) {
  const chunks = splitIntoChunks(transcript);

  if (!chunks.length) {
    return "";
  }

  const entries = [];
  let cursor = 0;

  chunks.forEach((chunk, index) => {
    const duration = estimateDurationSeconds(chunk);
    const start = cursor;
    const end = cursor + duration;

    entries.push(
      `${index + 1}\n${toTimecode(start)} --> ${toTimecode(end)}\n${chunk.trim()}\n`
    );

    cursor = end;
  });

  return entries.join("\n").trim();
}
