import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const TARGET_SAMPLE_RATE = 16000;
const DEFAULT_SEGMENT_SECONDS = 600;

export async function splitAudioFile(inputPath, options = {}) {
  const segmentSeconds = options.segmentSeconds || DEFAULT_SEGMENT_SECONDS;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-audio-"));
  const outputPattern = path.join(tempDir, "chunk_%03d.wav");

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          "-ar",
          String(TARGET_SAMPLE_RATE),
          "-ac",
          "1",
          "-f",
          "segment",
          "-reset_timestamps",
          "1",
          "-segment_time",
          String(segmentSeconds),
        ])
        .output(outputPattern)
        .on("end", resolve)
        .on("error", (error) => reject(error))
        .run();
    });

    const files = await fs.readdir(tempDir);
    const chunkPaths = files
      .filter((file) => file.startsWith("chunk_") && file.endsWith(".wav"))
      .sort()
      .map((file) => path.join(tempDir, file));

    return { chunkPaths, tempDir };
  } catch (error) {
    await removeDirectory(tempDir);
    throw error;
  }
}

export async function removeDirectory(dirPath) {
  if (!dirPath) {
    return;
  }

  await fs.rm(dirPath, { recursive: true, force: true });
}
