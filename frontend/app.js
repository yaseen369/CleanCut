const elements = {
  addHitsButton: document.querySelector("#addHitsButton"),
  addRangeButton: document.querySelector("#addRangeButton"),
  beepMode: document.querySelector("#beepMode"),
  browseButton: document.querySelector("#browseButton"),
  censoredPreview: document.querySelector("#censoredPreview"),
  currentTime: document.querySelector("#currentTime"),
  curseHitEmpty: document.querySelector("#curseHitEmpty"),
  curseHitList: document.querySelector("#curseHitList"),
  curseWords: document.querySelector("#curseWords"),
  downloadLink: document.querySelector("#downloadLink"),
  dropZone: document.querySelector("#dropZone"),
  duration: document.querySelector("#duration"),
  exportButton: document.querySelector("#exportButton"),
  exportProgress: document.querySelector("#exportProgress"),
  exportStatus: document.querySelector("#exportStatus"),
  forwardButton: document.querySelector("#forwardButton"),
  markButton: document.querySelector("#markButton"),
  muteMode: document.querySelector("#muteMode"),
  originalPreview: document.querySelector("#originalPreview"),
  parseTranscriptButton: document.querySelector("#parseTranscriptButton"),
  playButton: document.querySelector("#playButton"),
  progressWrap: document.querySelector("#progressWrap"),
  rangeEmpty: document.querySelector("#rangeEmpty"),
  rangeList: document.querySelector("#rangeList"),
  recordingCanvas: document.querySelector("#recordingCanvas"),
  rewindButton: document.querySelector("#rewindButton"),
  sampleTranscriptButton: document.querySelector("#sampleTranscriptButton"),
  statusPill: document.querySelector("#statusPill"),
  statusText: document.querySelector("#statusText"),
  toneSlider: document.querySelector("#toneSlider"),
  toneValue: document.querySelector("#toneValue"),
  transcribeButton: document.querySelector("#transcribeButton"),
  transcribeProgress: document.querySelector("#transcribeProgress"),
  transcribeStatus: document.querySelector("#transcribeStatus"),
  transcriptInput: document.querySelector("#transcriptInput"),
  transcriptOutput: document.querySelector("#transcriptOutput"),
  video: document.querySelector("#video"),
  videoEmpty: document.querySelector("#videoEmpty"),
  videoInput: document.querySelector("#videoInput"),
};

const state = {
  audioContext: null,
  beepGain: null,
  beepOscillator: null,
  curseHits: [],
  currentObjectUrl: null,
  exportUrl: null,
  isRecording: false,
  isTranscribing: false,
  mode: "mute",
  outputGain: null,
  previewMode: "censored",
  ranges: [],
  recorderDestination: null,
  renderFrameId: null,
  sourceNode: null,
  transcription: null,
  videoFile: null,
};

function initialize() {
  bindEvents();
  updateControls();
  updateTimeDisplay();
  renderRanges();
  renderCurseHits();
  monitorPlayback();
  refreshIcons();
}

function bindEvents() {
  elements.browseButton.addEventListener("click", () => elements.videoInput.click());
  elements.videoInput.addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (file) {
      loadVideo(file);
    }
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add("dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove("dragging");
    });
  });

  elements.dropZone.addEventListener("drop", (event) => {
    const [file] = [...event.dataTransfer.files].filter((item) => item.type.startsWith("video/"));
    if (file) {
      loadVideo(file);
    } else {
      setStatus("Drop a video file", "idle");
    }
  });

  elements.video.addEventListener("loadedmetadata", () => {
    elements.videoEmpty.classList.add("hidden");
    setStatus("Video ready", "ready");
    updateControls();
    updateTimeDisplay();
  });

  elements.video.addEventListener("timeupdate", updateTimeDisplay);
  elements.video.addEventListener("play", () => {
    ensureAudioGraph();
    setPlayIcon("pause");
  });
  elements.video.addEventListener("pause", () => setPlayIcon("play"));
  elements.video.addEventListener("ended", () => setPlayIcon("play"));

  elements.playButton.addEventListener("click", async () => {
    await ensureAudioGraph();
    if (elements.video.paused) {
      await elements.video.play();
    } else {
      elements.video.pause();
    }
  });

  elements.rewindButton.addEventListener("click", () => seekBy(-5));
  elements.forwardButton.addEventListener("click", () => seekBy(5));
  elements.markButton.addEventListener("click", () => addRangeAroundPlayhead());
  elements.addRangeButton.addEventListener("click", () => addRangeAroundPlayhead());

  elements.originalPreview.addEventListener("click", () => setPreviewMode("original"));
  elements.censoredPreview.addEventListener("click", () => setPreviewMode("censored"));
  elements.muteMode.addEventListener("click", () => setMode("mute"));
  elements.beepMode.addEventListener("click", () => setMode("beep"));

  elements.toneSlider.addEventListener("input", () => {
    elements.toneValue.textContent = `${elements.toneSlider.value} Hz`;
    if (state.beepOscillator) {
      state.beepOscillator.frequency.setTargetAtTime(
        Number(elements.toneSlider.value),
        state.audioContext.currentTime,
        0.01,
      );
    }
  });

  elements.rangeList.addEventListener("change", handleRangeFieldChange);
  elements.rangeList.addEventListener("input", handleRangeLabelInput);
  elements.rangeList.addEventListener("click", handleRangeClick);

  elements.curseHitList.addEventListener("click", handleCurseHitClick);
  elements.addHitsButton.addEventListener("click", replaceRangesWithCurseHits);

  elements.parseTranscriptButton.addEventListener("click", parseTranscript);
  elements.sampleTranscriptButton.addEventListener("click", insertSampleTranscript);
  elements.transcribeButton.addEventListener("click", transcribeVideo);
  elements.exportButton.addEventListener("click", exportCensoredVideo);
}

function loadVideo(file) {
  if (state.currentObjectUrl) {
    URL.revokeObjectURL(state.currentObjectUrl);
  }

  state.videoFile = file;
  state.currentObjectUrl = URL.createObjectURL(file);
  state.ranges = [];
  state.curseHits = [];
  state.transcription = null;

  elements.video.src = state.currentObjectUrl;
  elements.video.load();
  elements.downloadLink.hidden = true;
  elements.progressWrap.hidden = true;
  elements.transcribeProgress.hidden = true;
  elements.transcriptOutput.value = "";

  renderRanges();
  renderCurseHits();
  setStatus("Loading video", "idle");
  updateControls();
}

async function ensureAudioGraph() {
  if (!state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioContextClass();
    state.sourceNode = state.audioContext.createMediaElementSource(elements.video);
    state.outputGain = state.audioContext.createGain();
    state.beepGain = state.audioContext.createGain();
    state.beepOscillator = state.audioContext.createOscillator();
    state.recorderDestination = state.audioContext.createMediaStreamDestination();

    state.outputGain.gain.value = 1;
    state.beepGain.gain.value = 0;
    state.beepOscillator.type = "sine";
    state.beepOscillator.frequency.value = Number(elements.toneSlider.value);

    state.sourceNode.connect(state.outputGain);
    state.outputGain.connect(state.audioContext.destination);
    state.outputGain.connect(state.recorderDestination);

    state.beepOscillator.connect(state.beepGain);
    state.beepGain.connect(state.audioContext.destination);
    state.beepGain.connect(state.recorderDestination);
    state.beepOscillator.start();
  }

  if (state.audioContext.state === "suspended") {
    await state.audioContext.resume();
  }
}

function monitorPlayback() {
  updateCensorAudio();
  updateActiveRangeRows();
  updateActiveHitRows();
  requestAnimationFrame(monitorPlayback);
}

function updateCensorAudio() {
  if (!state.audioContext || !state.outputGain || !state.beepGain) {
    return;
  }

  const now = state.audioContext.currentTime;
  const activeRange = getActiveRange();
  const shouldCensor = Boolean(activeRange && (state.previewMode === "censored" || state.isRecording));
  const beepLevel = shouldCensor && state.mode === "beep" ? 0.075 : 0;
  const sourceLevel = shouldCensor ? 0 : 1;

  state.outputGain.gain.cancelScheduledValues(now);
  state.beepGain.gain.cancelScheduledValues(now);
  state.outputGain.gain.setTargetAtTime(sourceLevel, now, 0.012);
  state.beepGain.gain.setTargetAtTime(beepLevel, now, 0.012);
}

function getActiveRange() {
  const time = elements.video.currentTime || 0;
  return state.ranges.find((range) => time >= range.start && time <= range.end);
}

function setPreviewMode(mode) {
  state.previewMode = mode;
  elements.originalPreview.classList.toggle("active", mode === "original");
  elements.censoredPreview.classList.toggle("active", mode === "censored");
  elements.originalPreview.setAttribute("aria-checked", String(mode === "original"));
  elements.censoredPreview.setAttribute("aria-checked", String(mode === "censored"));
  updateCensorAudio();
}

function setMode(mode) {
  state.mode = mode;
  elements.muteMode.classList.toggle("active", mode === "mute");
  elements.beepMode.classList.toggle("active", mode === "beep");
  elements.muteMode.setAttribute("aria-checked", String(mode === "mute"));
  elements.beepMode.setAttribute("aria-checked", String(mode === "beep"));
  updateCensorAudio();
}

function addRangeAroundPlayhead() {
  const center = elements.video.currentTime || 0;
  addRange({
    start: center - 0.25,
    end: center + 0.65,
    label: "marked",
  });
}

function addRange(range) {
  const duration = getVideoDuration();
  const start = clamp(Number(range.start) || 0, 0, duration || Number.MAX_SAFE_INTEGER);
  const fallbackEnd = start + 0.75;
  const end = clamp(Number(range.end) || fallbackEnd, start + 0.05, duration || start + 60);

  state.ranges.push({
    id: createId(),
    start,
    end,
    label: range.label || "word",
  });
  sortRanges();
  renderRanges();
  setStatus(`${state.ranges.length} censor range${state.ranges.length === 1 ? "" : "s"}`, "ready");
}

function renderRanges() {
  elements.rangeList.textContent = "";
  elements.rangeEmpty.classList.toggle("hidden", state.ranges.length > 0);

  state.ranges.forEach((range, index) => {
    const row = document.createElement("article");
    row.className = "range-row";
    row.dataset.id = range.id;
    row.setAttribute("aria-label", `Censor range ${index + 1}`);

    row.append(
      createRangeInput("Start", "start", formatInputTime(range.start)),
      createRangeInput("End", "end", formatInputTime(range.end)),
      createRangeInput("Word", "label", range.label),
      createRemoveButton(range.id),
    );

    elements.rangeList.append(row);
  });

  updateActiveRangeRows();
  refreshIcons();
}

function createRangeInput(labelText, field, value) {
  const label = document.createElement("label");
  const span = document.createElement("span");
  const input = document.createElement("input");

  span.textContent = labelText;
  input.value = value;
  input.dataset.field = field;
  input.autocomplete = "off";

  if (field !== "label") {
    input.inputMode = "decimal";
    input.placeholder = "00:00.000";
  }

  label.append(span, input);
  return label;
}

function createRemoveButton(id) {
  const button = document.createElement("button");
  button.className = "icon-button";
  button.type = "button";
  button.title = "Remove range";
  button.dataset.action = "remove";
  button.dataset.id = id;
  button.innerHTML = '<i data-lucide="trash-2"></i>';
  return button;
}

function handleRangeFieldChange(event) {
  const input = event.target;
  const field = input.dataset.field;
  if (!field || field === "label") {
    return;
  }

  const range = findRangeForElement(input);
  if (!range) {
    return;
  }

  const nextValue = parseTime(input.value);
  if (!Number.isFinite(nextValue)) {
    input.value = formatInputTime(range[field]);
    setStatus("Use times like 00:12.300", "idle");
    return;
  }

  range[field] = nextValue;
  if (range.end <= range.start) {
    range.end = range.start + 0.1;
  }

  const duration = getVideoDuration();
  if (duration) {
    range.start = clamp(range.start, 0, duration);
    range.end = clamp(range.end, range.start + 0.05, duration);
  }

  sortRanges();
  renderRanges();
}

function handleRangeLabelInput(event) {
  const input = event.target;
  if (input.dataset.field !== "label") {
    return;
  }

  const range = findRangeForElement(input);
  if (range) {
    range.label = input.value.trim() || "word";
  }
}

function handleRangeClick(event) {
  const removeButton = event.target.closest("[data-action='remove']");
  if (removeButton) {
    state.ranges = state.ranges.filter((range) => range.id !== removeButton.dataset.id);
    renderRanges();
    setStatus(`${state.ranges.length} censor range${state.ranges.length === 1 ? "" : "s"}`, "ready");
    return;
  }

  const row = event.target.closest(".range-row");
  if (row && !event.target.matches("input, button")) {
    const range = state.ranges.find((item) => item.id === row.dataset.id);
    if (range) {
      elements.video.currentTime = range.start;
    }
  }
}

function findRangeForElement(element) {
  const row = element.closest(".range-row");
  return row ? state.ranges.find((range) => range.id === row.dataset.id) : null;
}

function parseTranscript() {
  const words = getCurseWords();
  const transcript = elements.transcriptInput.value.trim();

  if (!words.length) {
    setStatus("Add words to censor", "idle");
    return;
  }

  if (!transcript) {
    setStatus("Paste a timestamped transcript", "idle");
    return;
  }

  const wordPattern = new RegExp(`\\b(${words.map(escapeRegExp).join("|")})\\b`, "gi");
  const timeToken = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[\.,]\d+)?|\d+(?:[\.,]\d+)?`;
  const rangePattern = new RegExp(`(${timeToken})\\s*(?:-->|-|to)\\s*(${timeToken})`, "i");
  const nextRanges = [];

  transcript.split(/\r?\n/).forEach((line) => {
    const rangeMatch = line.match(rangePattern);
    if (!rangeMatch) {
      return;
    }

    const start = parseTime(rangeMatch[1]);
    const end = parseTime(rangeMatch[2]);
    const textAfterTime = line.slice(rangeMatch.index + rangeMatch[0].length);
    wordPattern.lastIndex = 0;
    const matches = [...textAfterTime.matchAll(wordPattern)].map((match) => match[1].toLowerCase());

    if (Number.isFinite(start) && Number.isFinite(end) && end > start && matches.length) {
      nextRanges.push({
        start: Math.max(0, start - 0.04),
        end: end + 0.04,
        label: [...new Set(matches)].join(", "),
      });
    }
  });

  if (!nextRanges.length) {
    setStatus("No timestamped curse words found", "idle");
    return;
  }

  nextRanges.forEach(addRange);
  setStatus(`Added ${nextRanges.length} range${nextRanges.length === 1 ? "" : "s"}`, "ready");
}

function insertSampleTranscript() {
  elements.transcriptInput.value = [
    "00:04.500 - 00:05.100 regular sentence",
    "00:08.200 - 00:08.640 damn",
    "00:14.000 --> 00:14.450 shit",
    "00:21.750 - 00:22.300 clean word",
  ].join("\n");
}

async function transcribeVideo() {
  if (!hasVideo() || state.isTranscribing) {
    return;
  }

  state.isTranscribing = true;
  elements.transcribeProgress.hidden = false;
  elements.transcribeStatus.textContent = "Uploading video for transcription";
  elements.transcriptOutput.value = "";
  state.curseHits = [];
  renderCurseHits();
  updateControls();
  setStatus("Transcribing video", "recording");

  const formData = new FormData();
  formData.append("video", state.videoFile, state.videoFile.name);
  formData.append("curseWords", elements.curseWords.value);

  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      body: formData,
    });
    const result = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(result?.error || "Transcription failed");
    }

    state.transcription = result;
    state.curseHits = result.curseHits || [];
    elements.transcriptOutput.value = result.text || "";
    renderCurseHits();

    if (state.curseHits.length) {
      replaceRangesWithCurseHits();
      setPreviewMode("censored");
    }

    const hitCount = state.curseHits.length;
    setStatus(`${hitCount} curse word time${hitCount === 1 ? "" : "s"} found`, "ready");
    elements.transcribeStatus.textContent = "Transcription complete";
  } catch (error) {
    setStatus("Transcription failed", "idle");
    elements.transcribeStatus.textContent = error.message;
  } finally {
    state.isTranscribing = false;
    updateControls();
  }
}

function renderCurseHits() {
  elements.curseHitList.textContent = "";
  elements.curseHitEmpty.classList.toggle("hidden", state.curseHits.length > 0);
  elements.addHitsButton.disabled = state.curseHits.length === 0 || state.isTranscribing;

  state.curseHits.forEach((hit, index) => {
    const row = document.createElement("article");
    row.className = "hit-row";
    row.dataset.index = String(index);

    const word = document.createElement("strong");
    word.textContent = hit.word;

    const time = document.createElement("span");
    time.className = "hit-time";
    time.textContent = `${formatTime(hit.start)} to ${formatTime(hit.end)}`;

    const exact = document.createElement("span");
    exact.className = "hit-exact";
    exact.textContent = `${hit.start.toFixed(3)}s`;

    const seekButton = document.createElement("button");
    seekButton.className = "icon-button";
    seekButton.type = "button";
    seekButton.title = "Jump to this word";
    seekButton.dataset.action = "seek-hit";
    seekButton.dataset.index = String(index);
    seekButton.innerHTML = '<i data-lucide="corner-down-right"></i>';

    row.append(word, time, exact, seekButton);
    elements.curseHitList.append(row);
  });

  refreshIcons();
}

function handleCurseHitClick(event) {
  const button = event.target.closest("[data-action='seek-hit']");
  const row = event.target.closest(".hit-row");
  const index = Number(button?.dataset.index ?? row?.dataset.index);
  const hit = state.curseHits[index];

  if (!hit) {
    return;
  }

  elements.video.currentTime = Math.max(0, hit.start - 0.35);
}

function replaceRangesWithCurseHits() {
  if (!state.curseHits.length) {
    return;
  }

  const duration = getVideoDuration();
  state.ranges = state.curseHits.map((hit) => {
    const start = clamp(hit.start - 0.05, 0, duration || Number.MAX_SAFE_INTEGER);
    const end = clamp(hit.end + 0.08, start + 0.05, duration || hit.end + 0.08);
    return {
      id: createId(),
      start,
      end,
      label: hit.word,
    };
  });

  sortRanges();
  renderRanges();
  setStatus(`${state.ranges.length} detected range${state.ranges.length === 1 ? "" : "s"} loaded`, "ready");
}

function updateActiveHitRows() {
  const time = elements.video.currentTime || 0;
  elements.curseHitList.querySelectorAll(".hit-row").forEach((row) => {
    const hit = state.curseHits[Number(row.dataset.index)];
    row.classList.toggle("active", Boolean(hit && time >= hit.start && time <= hit.end));
  });
}

async function exportCensoredVideo() {
  if (!hasVideo()) {
    return;
  }

  if (!HTMLCanvasElement.prototype.captureStream || !window.MediaRecorder) {
    setStatus("Recording export is not supported in this browser", "idle");
    return;
  }

  await ensureAudioGraph();

  const previousTime = elements.video.currentTime;
  const previousPaused = elements.video.paused;
  const canvas = elements.recordingCanvas;
  const context = canvas.getContext("2d");
  const width = elements.video.videoWidth || 1280;
  const height = elements.video.videoHeight || 720;

  canvas.width = width;
  canvas.height = height;

  const canvasStream = canvas.captureStream(30);
  const audioTracks = state.recorderDestination.stream.getAudioTracks();
  const mixedStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
  const mimeType = getSupportedMimeType();
  const chunks = [];

  const recorder = new MediaRecorder(mixedStream, mimeType ? { mimeType } : undefined);
  state.isRecording = true;
  updateControls();
  setStatus("Exporting video", "recording");
  elements.progressWrap.hidden = false;
  elements.downloadLink.hidden = true;
  elements.exportProgress.value = 0;
  elements.exportStatus.textContent = "Recording edited preview";

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  const finished = new Promise((resolve) => {
    recorder.addEventListener("stop", resolve, { once: true });
  });

  const drawFrame = () => {
    context.drawImage(elements.video, 0, 0, width, height);
    state.renderFrameId = requestAnimationFrame(drawFrame);
  };

  const stopRecording = () => {
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
  };

  const progressTimer = window.setInterval(() => {
    const duration = getVideoDuration() || 1;
    elements.exportProgress.value = Math.min(100, (elements.video.currentTime / duration) * 100);
  }, 150);

  try {
    elements.video.pause();
    await seekTo(0);
    drawFrame();
    recorder.start(250);
    elements.video.addEventListener("ended", stopRecording, { once: true });
    await elements.video.play();
    await finished;

    const blob = new Blob(chunks, { type: mimeType || "video/webm" });
    if (state.exportUrl) {
      URL.revokeObjectURL(state.exportUrl);
    }

    state.exportUrl = URL.createObjectURL(blob);
    elements.downloadLink.href = state.exportUrl;
    elements.downloadLink.download = buildExportFileName();
    elements.downloadLink.hidden = false;
    elements.exportProgress.value = 100;
    elements.exportStatus.textContent = "Export complete";
    setStatus("Export complete", "ready");
  } catch (error) {
    stopRecording();
    setStatus("Export failed", "idle");
    console.error(error);
  } finally {
    window.clearInterval(progressTimer);
    cancelAnimationFrame(state.renderFrameId);
    canvasStream.getTracks().forEach((track) => track.stop());
    state.isRecording = false;
    updateControls();
    elements.video.removeEventListener("ended", stopRecording);
    await seekTo(Math.min(previousTime, getVideoDuration() || previousTime));
    if (!previousPaused) {
      elements.video.play().catch(() => setPlayIcon("play"));
    }
  }
}

function getSupportedMimeType() {
  const options = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return options.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function buildExportFileName() {
  const name = state.videoFile?.name || "video";
  const baseName = name.replace(/\.[^.]+$/, "");
  return `${baseName}-censored.webm`;
}

function seekBy(delta) {
  const duration = getVideoDuration();
  elements.video.currentTime = clamp(elements.video.currentTime + delta, 0, duration || 0);
}

function seekTo(time) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        elements.video.removeEventListener("seeked", finish);
        resolve();
      }
    };

    elements.video.addEventListener("seeked", finish, { once: true });
    elements.video.currentTime = time;
    if (Math.abs(elements.video.currentTime - time) < 0.02) {
      requestAnimationFrame(finish);
    }
  });
}

function updateControls() {
  const enabled = hasVideo() && !state.isRecording && !state.isTranscribing;
  [
    elements.addRangeButton,
    elements.exportButton,
    elements.forwardButton,
    elements.markButton,
    elements.playButton,
    elements.rewindButton,
    elements.transcribeButton,
  ].forEach((button) => {
    button.disabled = !enabled;
  });

  elements.addHitsButton.disabled = state.curseHits.length === 0 || state.isTranscribing;
  elements.video.controls = !state.isRecording;
}

function updateTimeDisplay() {
  elements.currentTime.textContent = formatTime(elements.video.currentTime || 0);
  elements.duration.textContent = formatTime(getVideoDuration() || 0);
}

function updateActiveRangeRows() {
  const activeRange = getActiveRange();
  elements.rangeList.querySelectorAll(".range-row").forEach((row) => {
    row.classList.toggle("active", activeRange?.id === row.dataset.id);
  });
}

function setPlayIcon(icon) {
  elements.playButton.innerHTML = `<i data-lucide="${icon}"></i>`;
  refreshIcons();
}

function setStatus(message, tone) {
  elements.statusText.textContent = message;
  elements.statusPill.classList.toggle("ready", tone === "ready");
  elements.statusPill.classList.toggle("recording", tone === "recording");
}

function hasVideo() {
  return Boolean(state.videoFile && Number.isFinite(elements.video.duration) && elements.video.duration > 0);
}

function getVideoDuration() {
  return Number.isFinite(elements.video.duration) ? elements.video.duration : 0;
}

function sortRanges() {
  state.ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}

function getCurseWords() {
  return elements.curseWords.value
    .split(",")
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
}

function parseTime(value) {
  const normalized = String(value).trim().replace(",", ".");
  if (!normalized) {
    return Number.NaN;
  }

  if (!normalized.includes(":")) {
    return Number(normalized);
  }

  const parts = normalized.split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) {
    return Number.NaN;
  }

  return parts.reduce((total, part) => total * 60 + part, 0);
}

function formatTime(seconds) {
  const safeSeconds = Math.max(0, seconds || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${remainingSeconds.toFixed(3).padStart(6, "0")}`;
}

function formatInputTime(seconds) {
  return Number(seconds).toFixed(3);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createId() {
  return window.crypto?.randomUUID?.() || `range-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function refreshIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

initialize();
