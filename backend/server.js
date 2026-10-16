const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const express = require("express");
const ffmpegPath = require("ffmpeg-static");
const multer = require("multer");

const projectRoot = path.resolve(__dirname, "..");
const frontendRoot = path.join(projectRoot, "frontend");

require("dotenv").config({
  path: path.join(projectRoot, ".env"),
});

const app = express();
const port = Number(process.env.PORT || 3000);
const appUrl = `http://localhost:${port}`;
const chunkSeconds = Number(process.env.TRANSCRIPTION_CHUNK_SECONDS || 25);
const huggingFaceModel = process.env.HUGGINGFACE_MODEL || "openai/whisper-large-v3";
const huggingFaceApiBase =
  process.env.HUGGINGFACE_API_BASE || "https://router.huggingface.co/hf-inference/models";
const tmpRoot = path.join(projectRoot, "tmp");
const uploadRoot = path.join(tmpRoot, "uploads");

fs.mkdirSync(uploadRoot, { recursive: true });

const upload = multer({
  dest: uploadRoot,
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_BYTES || 1024 * 1024 * 1024),
  },
});

app.use(express.static(frontendRoot));

app.get("/api/health", (req, res) => {
  const hfToken = getHuggingFaceToken();

  res.json({
    ok: true,
    provider: "huggingface",
    model: huggingFaceModel,
    hasHuggingFaceKey: Boolean(hfToken),
    huggingFaceKeyFormat: getHuggingFaceKeyFormat(hfToken),
    hasFfmpeg: Boolean(ffmpegPath),
  });
});

app.post("/api/transcribe", upload.single("video"), async (req, res) => {
  const keyValidation = validateHuggingFaceKey();
  if (!keyValidation.ok) {
    await cleanupUpload(req.file);
    res.status(500).json({ error: keyValidation.message });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: "Upload a video file first." });
    return;
  }

  const requestId = crypto.randomUUID();
  const workDir = path.join(tmpRoot, requestId);
  const curseWords = parseCurseWords(req.body.curseWords);

  try {
    await fsp.mkdir(workDir, { recursive: true });
    const inputPath = path.join(workDir, sanitizeFileName(req.file.originalname || "video"));
    await fsp.rename(req.file.path, inputPath);

    const chunks = await createAudioChunks(inputPath, workDir);
    const transcription = await transcribeChunks(chunks);
    const curseHits = findCurseHits(transcription.words, curseWords);

    res.json({
      text: transcription.text,
      words: transcription.words,
      curseHits,
      duration: transcription.duration,
      language: transcription.language,
      timestampPrecision: transcription.timestampPrecision,
      usage: transcription.usage,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: getPublicErrorMessage(error),
    });
  } finally {
    await safeRemove(workDir);
    await cleanupUpload(req.file);
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    res.status(400).json({ error: error.message });
    return;
  }

  next(error);
});

if (process.env.NODE_ENV !== "test") {
  const server = app.listen(port, () => {
    console.log(`CleanCut running at ${appUrl}`);
    openBrowser(appUrl);
  });

  server.on("error", async (error) => {
    if (error.code === "EADDRINUSE") {
      const isCleanCut = await isCleanCutServer(appUrl);
      if (isCleanCut) {
        console.log(`CleanCut is already running at ${appUrl}`);
        openBrowser(appUrl);
        process.exit(0);
      }

      console.error(`Port ${port} is already in use by another app. Set PORT=3001 in .env and run npm start again.`);
      process.exit(1);
    }

    console.error(error);
    process.exit(1);
  });
}

async function createAudioChunks(inputPath, workDir) {
  const chunkPattern = path.join(workDir, "chunk-%03d.mp3");
  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k",
    "-f",
    "segment",
    "-segment_time",
    String(chunkSeconds),
    "-reset_timestamps",
    "1",
    chunkPattern,
  ]);

  const files = await fsp.readdir(workDir);
  const chunks = files
    .filter((file) => /^chunk-\d+\.mp3$/.test(file))
    .sort()
    .map((file, index) => ({
      path: path.join(workDir, file),
      offset: index * chunkSeconds,
    }));

  if (!chunks.length) {
    throw new Error("No audio track was found in the uploaded video.");
  }

  return chunks;
}

async function transcribeChunks(chunks) {
  const combined = {
    duration: 0,
    language: "",
    textParts: [],
    timestampPrecision: "word",
    usage: [],
    words: [],
  };

  for (const chunk of chunks) {
    const result = await transcribeChunkWithHuggingFace(chunk.path);

    if (result.timestampPrecision === "segment") {
      combined.timestampPrecision = "segment";
    }

    combined.textParts.push((result.text || "").trim());
    combined.language ||= result.language || "";
    combined.duration = Math.max(combined.duration, chunk.offset + Number(result.duration || 0));
    if (result.usage) {
      combined.usage.push(result.usage);
    }

    const words = extractTimestampedWords(result);
    words.forEach((item) => {
      const start = Number(item.start);
      const end = Number(item.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return;
      }

      const globalEnd = roundSeconds(end + chunk.offset);
      combined.duration = Math.max(combined.duration, globalEnd);
      combined.words.push({
        word: String(item.word || "").trim(),
        start: roundSeconds(start + chunk.offset),
        end: globalEnd,
      });
    });
  }

  return {
    duration: roundSeconds(combined.duration),
    language: combined.language,
    timestampPrecision: combined.timestampPrecision,
    text: combined.textParts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
    usage: combined.usage,
    words: combined.words,
  };
}

async function transcribeChunkWithHuggingFace(chunkPath) {
  const audio = await fsp.readFile(chunkPath);
  const base64Audio = audio.toString("base64");

  try {
    const wordTimestampResult = await callHuggingFaceAsr(base64Audio, "word");
    if (Array.isArray(wordTimestampResult.chunks) && wordTimestampResult.chunks.length) {
      return {
        ...wordTimestampResult,
        timestampPrecision: "word",
      };
    }
  } catch (error) {
    if (!/return_timestamps|timestamp|400|word/i.test(error.message || "")) {
      throw error;
    }
  }

  const segmentTimestampResult = await callHuggingFaceAsr(base64Audio, true);
  return {
    ...segmentTimestampResult,
    timestampPrecision: "segment",
  };
}

async function callHuggingFaceAsr(base64Audio, returnTimestamps) {
  const token = getHuggingFaceToken();
  const response = await fetch(`${huggingFaceApiBase}/${huggingFaceModel}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: base64Audio,
      parameters: {
        return_timestamps: returnTimestamps,
        generation_parameters: {
          temperature: 0,
        },
      },
      options: {
        wait_for_model: true,
      },
    }),
  });

  const bodyText = await response.text();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = { error: bodyText };
  }

  if (!response.ok) {
    throw new Error(getHuggingFaceErrorMessage(response.status, body));
  }

  return body;
}

function extractTimestampedWords(result) {
  const chunks = Array.isArray(result.chunks) ? result.chunks : [];
  if (!chunks.length) {
    return [];
  }

  return chunks.flatMap((chunk) => {
    const timestamp = Array.isArray(chunk.timestamp) ? chunk.timestamp : [];
    const start = Number(timestamp[0]);
    const end = Number(timestamp[1]);
    const text = String(chunk.text || "").trim();

    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) {
      return [];
    }

    const words = text.match(/[\p{L}\p{N}']+/gu) || [];
    if (words.length <= 1) {
      return [{ word: text, start, end }];
    }

    const span = Math.max(0.05, end - start);
    const step = span / words.length;
    return words.map((word, index) => ({
      word,
      start: roundSeconds(start + step * index),
      end: roundSeconds(index === words.length - 1 ? end : start + step * (index + 1)),
    }));
  });
}

function getHuggingFaceToken() {
  const candidates = [
    process.env.HUGGINGFACE_API_KEY,
    process.env.HF_TOKEN,
    process.env.HUGGINGFACE_TOKEN,
    process.env.OPENAI_API_KEY?.startsWith("hf_") ? process.env.OPENAI_API_KEY : "",
  ];

  return String(candidates.find(Boolean) || "").trim();
}

function validateHuggingFaceKey() {
  const key = getHuggingFaceToken();

  if (!key) {
    return {
      ok: false,
      message:
        "HUGGINGFACE_API_KEY is missing. Put your hf_ token in .env before transcribing.",
    };
  }

  if (!key.startsWith("hf_")) {
    return {
      ok: false,
      message: "The Hugging Face token should start with hf_. Check HUGGINGFACE_API_KEY in .env.",
    };
  }

  return { ok: true };
}

function getHuggingFaceKeyFormat(key) {
  if (!key) {
    return "missing";
  }

  if (key.startsWith("hf_")) {
    return "hugging-face-token";
  }

  return "unknown";
}

function getPublicErrorMessage(error) {
  if (/401|unauthorized|invalid token|authorization/i.test(error?.message || "")) {
    return "Hugging Face rejected the API key. Replace HUGGINGFACE_API_KEY in .env with a valid hf_ token that has Inference Providers permission, then restart npm start.";
  }

  return error.message || "Video transcription failed.";
}

function getHuggingFaceErrorMessage(status, body) {
  const message = body?.error || body?.message || JSON.stringify(body);

  if (status === 401 || status === 403) {
    return `Hugging Face authorization failed (${status}). Check that your hf_ token has Inference Providers permission.`;
  }

  return `Hugging Face transcription failed (${status}). ${message}`;
}

function findCurseHits(words, curseWords) {
  const patterns = buildCursePatterns(curseWords);
  if (!patterns.length) {
    return [];
  }

  const normalizedWords = words.map((item, index) => ({
    ...item,
    index,
    normalized: normalizeWord(item.word),
  }));
  const hits = [];

  for (let index = 0; index < normalizedWords.length; index += 1) {
    for (const pattern of patterns) {
      const match = matchPatternAt(normalizedWords, index, pattern);
      if (!match) {
        continue;
      }

      hits.push({
        word: match.text,
        normalized: pattern.normalized,
        start: roundSeconds(match.first.start),
        end: roundSeconds(match.last.end),
        tokenCount: match.tokenCount,
      });
    }
  }

  return dedupeCurseHits(hits);
}

function parseCurseWords(value) {
  return String(value || "")
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);
}

function buildCursePatterns(curseWords) {
  return curseWords
    .map((phrase) => {
      const tokens = String(phrase)
        .split(/\s+/)
        .map(normalizeWord)
        .filter(Boolean);

      if (!tokens.length) {
        return null;
      }

      return {
        label: phrase.trim(),
        compact: tokens.join(""),
        normalized: tokens.join(" "),
        tokens,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.tokens.length - a.tokens.length || b.normalized.length - a.normalized.length);
}

function matchPatternAt(normalizedWords, index, pattern) {
  const currentWord = normalizedWords[index];
  if (!currentWord?.normalized) {
    return null;
  }

  if (pattern.tokens.length > 1 && currentWord.normalized === pattern.compact) {
    return {
      first: currentWord,
      last: currentWord,
      text: currentWord.word,
      tokenCount: pattern.tokens.length,
    };
  }

  const phraseWords = normalizedWords.slice(index, index + pattern.tokens.length);
  if (phraseWords.length !== pattern.tokens.length) {
    return null;
  }

  const matches = phraseWords.every((word, wordIndex) => word.normalized === pattern.tokens[wordIndex]);
  if (!matches) {
    return null;
  }

  return {
    first: phraseWords[0],
    last: phraseWords[phraseWords.length - 1],
    text: phraseWords.map((word) => word.word).join(" "),
    tokenCount: pattern.tokens.length,
  };
}

function dedupeCurseHits(hits) {
  const bestByTime = new Map();

  hits.forEach((hit) => {
    const key = `${hit.start}-${hit.end}`;
    const previous = bestByTime.get(key);
    if (!previous || hit.tokenCount > previous.tokenCount || hit.word.length > previous.word.length) {
      bestByTime.set(key, hit);
    }
  });

  return [...bestByTime.values()]
    .sort((a, b) => a.start - b.start || b.tokenCount - a.tokenCount)
    .filter((hit, index, sorted) => {
      const previous = sorted[index - 1];
      if (!previous) {
        return true;
      }

      const sameStart = Math.abs(previous.start - hit.start) < 0.001;
      const containedByPrevious = hit.end <= previous.end + 0.001;
      return !(sameStart && containedByPrevious && previous.tokenCount >= hit.tokenCount);
    })
    .map(({ tokenCount, ...hit }) => hit);
}

function normalizeWord(value) {
  const compact = String(value || "")
    .toLowerCase()
    .replace(/@/g, "a")
    .replace(/[!|1]/g, "i")
    .replace(/[$5]/g, "s")
    .replace(/0/g, "o")
    .replace(/3/g, "e")
    .replace(/\+/g, "t")
    .replace(/[^a-z0-9']/g, "")
    .replace(/^'+|'+$/g, "")
    .replace(/'/g, "");

  const obfuscatedWords = new Map([
    ["fk", "fuck"],
    ["fck", "fuck"],
    ["fuk", "fuck"],
    ["fuq", "fuck"],
    ["fkn", "fuckin"],
    ["fckin", "fuckin"],
    ["fcking", "fucking"],
    ["sht", "shit"],
    ["shyt", "shit"],
    ["btch", "bitch"],
    ["bch", "bitch"],
    ["azz", "ass"],
    ["azzhole", "asshole"],
    ["ahole", "asshole"],
    ["cnt", "cunt"],
    ["dmn", "damn"],
    ["gddamn", "goddamn"],
    ["gdamn", "goddamn"],
  ]);

  return obfuscatedWords.get(compact) || compact;
}

function roundSeconds(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function sanitizeFileName(value) {
  const extension = path.extname(value);
  const baseName = path.basename(value, extension).replace(/[^a-z0-9_-]+/gi, "-") || "video";
  return `${baseName.slice(0, 80)}${extension || ".mp4"}`;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("ffmpeg binary was not found."));
      return;
    }

    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg failed while extracting audio. ${lastLines(stderr)}`));
    });
  });
}

function lastLines(value) {
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-4)
    .join(" ");
}

async function isCleanCutServer(url) {
  try {
    const response = await fetch(`${url}/api/health`);
    const body = await response.json();
    return Boolean(response.ok && body.ok);
  } catch {
    return false;
  }
}

function openBrowser(url) {
  if (process.env.OPEN_BROWSER === "0") {
    return;
  }

  const command =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  child.on("error", () => {
    console.log(`Open ${url} in your browser.`);
  });
  child.unref();
}

async function cleanupUpload(file) {
  if (!file?.path) {
    return;
  }

  await fsp.rm(file.path, { force: true }).catch(() => {});
}

async function safeRemove(targetPath) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedTmp = path.resolve(tmpRoot);

  if (!resolvedTarget.startsWith(`${resolvedTmp}${path.sep}`)) {
    throw new Error(`Refusing to remove unexpected path: ${resolvedTarget}`);
  }

  await fsp.rm(resolvedTarget, { recursive: true, force: true }).catch(() => {});
}

module.exports = {
  findCurseHits,
};
