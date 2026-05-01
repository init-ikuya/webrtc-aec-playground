// ---- State ----
let audioCtx = null;
let playbackSource = null;
let gainNode = null;
let micStream = null;
let micSource = null;
let analyser = null;
let mediaRecorder = null;
let recordedChunks = [];
let animationId = null;
let rtActive = false;

// ---- DOM ----
const btnPlay = document.getElementById("btn-play");
const btnStop = document.getElementById("btn-stop");
const btnMic = document.getElementById("btn-mic");
const btnMicStop = document.getElementById("btn-mic-stop");
const btnRecord = document.getElementById("btn-record");
const btnRecordStop = document.getElementById("btn-record-stop");
const btnRtStart = document.getElementById("btn-rt-start");
const btnRtStop = document.getElementById("btn-rt-stop");
const openaiKeyInput = document.getElementById("openai-key");
const rtStatusEl = document.getElementById("rt-status");
const volumeSlider = document.getElementById("volume");
const volumeValue = document.getElementById("volume-value");
const waveformCanvas = document.getElementById("waveform");
const spectrumCanvas = document.getElementById("spectrum");
const envInfo = document.getElementById("env-info");
const trackSettings = document.getElementById("track-settings");
const recordingsDiv = document.getElementById("recordings");
const statusBadge = document.getElementById("status-badge");
const rmsDisplay = document.getElementById("rms-display");

// ---- Status ----
function setStatus(text, cls) {
  statusBadge.textContent = text;
  statusBadge.className = "badge" + (cls ? " " + cls : "");
}

// ---- Environment Info ----
function showEnvInfo() {
  const info = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory || "N/A",
    timestamp: new Date().toISOString(),
  };
  envInfo.textContent = JSON.stringify(info, null, 2);
}
showEnvInfo();

// ---- Audio Context ----
function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = parseFloat(volumeSlider.value);
    gainNode.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

// ---- Test Signal Generators ----
function createSweep(ctx, durationSec = 5) {
  const sampleRate = ctx.sampleRate;
  const length = sampleRate * durationSec;
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const startFreq = 20;
  const endFreq = 8000;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const freq = startFreq * Math.pow(endFreq / startFreq, t / durationSec);
    data[i] = Math.sin(2 * Math.PI * freq * t) * 0.8;
  }
  return buffer;
}

function createWhiteNoise(ctx, durationSec = 5) {
  const sampleRate = ctx.sampleRate;
  const length = sampleRate * durationSec;
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = (Math.random() * 2 - 1) * 0.5;
  }
  return buffer;
}

function createSpeechLike(ctx, durationSec = 5) {
  const sampleRate = ctx.sampleRate;
  const length = sampleRate * durationSec;
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const f0 = 150;
  const formants = [700, 1200, 2500];
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const pitch = f0 * (1 + 0.1 * Math.sin(2 * Math.PI * 3 * t));
    let sample = 0;
    const phase = (pitch * t) % 1;
    const glottal = phase < 0.4 ? Math.sin(Math.PI * phase / 0.4) : 0;
    for (const f of formants) {
      sample += glottal * Math.sin(2 * Math.PI * f * t) * 0.3;
    }
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * t);
    data[i] = sample * env * 0.5;
  }
  return buffer;
}

// ---- Playback ----
function startPlayback() {
  ensureAudioCtx();
  stopPlayback();

  const sourceType = document.querySelector('input[name="source"]:checked').value;
  let buffer;
  switch (sourceType) {
    case "sweep": buffer = createSweep(audioCtx); break;
    case "whitenoise": buffer = createWhiteNoise(audioCtx); break;
    case "speech": buffer = createSpeechLike(audioCtx); break;
  }

  playbackSource = audioCtx.createBufferSource();
  playbackSource.buffer = buffer;
  playbackSource.loop = true;
  playbackSource.connect(gainNode);
  playbackSource.start();

  btnPlay.disabled = true;
  btnStop.disabled = false;
  updateStatus();
}

function stopPlayback() {
  if (playbackSource) {
    playbackSource.stop();
    playbackSource.disconnect();
    playbackSource = null;
  }
  btnPlay.disabled = false;
  btnStop.disabled = true;
  updateStatus();
}

// ---- Microphone ----
async function startMic() {
  ensureAudioCtx();
  stopMic();

  const constraints = {
    audio: {
      echoCancellation: document.getElementById("echo-cancellation").checked,
      noiseSuppression: document.getElementById("noise-suppression").checked,
      autoGainControl: document.getElementById("auto-gain-control").checked,
    },
  };

  try {
    micStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    alert("Failed to get microphone: " + err.message);
    return;
  }

  micSource = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  micSource.connect(analyser);

  const audioTrack = micStream.getAudioTracks()[0];
  const settings = audioTrack.getSettings();
  const capabilities = audioTrack.getCapabilities ? audioTrack.getCapabilities() : "N/A";
  trackSettings.textContent = JSON.stringify({ settings, capabilities }, null, 2);

  btnMic.disabled = true;
  btnMicStop.disabled = false;
  btnRecord.disabled = false;
  updateStatus();
  startVisualization();
}

function stopMic() {
  stopRecording();
  stopVisualization();

  if (micSource) { micSource.disconnect(); micSource = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  analyser = null;
  trackSettings.textContent = "Mic not started";
  rmsDisplay.textContent = "-- dB";

  btnMic.disabled = false;
  btnMicStop.disabled = true;
  btnRecord.disabled = true;
  updateStatus();
}

// ---- Recording ----
function startRecording() {
  if (!micStream) return;

  recordedChunks = [];
  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: "audio/webm" });
    const url = URL.createObjectURL(blob);
    const ecEnabled = document.getElementById("echo-cancellation").checked;

    const entry = document.createElement("div");
    entry.className = "recording-entry";

    const label = document.createElement("span");
    label.textContent = `AEC:${ecEnabled ? "ON" : "OFF"} ${new Date().toLocaleTimeString()}`;

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = url;

    const dl = document.createElement("a");
    dl.href = url;
    dl.download = `aec-${ecEnabled ? "on" : "off"}-${Date.now()}.webm`;
    dl.textContent = "DL";

    entry.appendChild(label);
    entry.appendChild(audio);
    entry.appendChild(dl);
    recordingsDiv.prepend(entry);
    updateStatus();
  };

  mediaRecorder.start();
  btnRecord.disabled = true;
  btnRecordStop.disabled = false;
  updateStatus();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
  btnRecord.disabled = !micStream;
  btnRecordStop.disabled = true;
  updateStatus();
}

// ---- OpenAI Realtime ----
async function startRealtime() {
  const apiKey = openaiKeyInput.value.trim();
  if (!apiKey) {
    rtStatusEl.textContent = "Enter API key";
    rtStatusEl.className = "rt-status error";
    return;
  }

  const micConstraints = {
    echoCancellation: document.getElementById("echo-cancellation").checked,
    noiseSuppression: document.getElementById("noise-suppression").checked,
    autoGainControl: document.getElementById("auto-gain-control").checked,
  };

  btnRtStart.disabled = true;
  rtStatusEl.textContent = "Connecting...";
  rtStatusEl.className = "rt-status";

  try {
    await startRealtimeSession(apiKey, micConstraints);
    rtActive = true;
    btnRtStop.disabled = false;
    openaiKeyInput.value = "";
    updateStatus();
  } catch (err) {
    rtStatusEl.textContent = err.message;
    rtStatusEl.className = "rt-status error";
    btnRtStart.disabled = false;
    rtActive = false;
  }
}

function stopRealtime() {
  stopRealtimeSession();
  rtActive = false;
  btnRtStart.disabled = false;
  btnRtStop.disabled = true;
  rtStatusEl.textContent = "Disconnected";
  rtStatusEl.className = "rt-status";
  updateStatus();
}

// ---- Status ----
function updateStatus() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    setStatus("REC", "recording");
  } else if (rtActive) {
    setStatus("REALTIME", "active");
  } else if (micStream) {
    setStatus("LIVE", "active");
  } else if (playbackSource) {
    setStatus("PLAYING", "active");
  } else {
    setStatus("IDLE", "");
  }
  updateControlStates();
}

function updateControlStates() {
  const isPlaying = !!playbackSource;
  const isMicActive = !!micStream;

  // Disable source selection while playing
  document.querySelectorAll('input[name="source"]').forEach((r) => {
    r.disabled = isPlaying;
  });

  // Disable constraints while mic is active or realtime session is active
  const constraintsLocked = isMicActive || rtActive;
  document.getElementById("echo-cancellation").disabled = constraintsLocked;
  document.getElementById("noise-suppression").disabled = constraintsLocked;
  document.getElementById("auto-gain-control").disabled = constraintsLocked;

  // Disable realtime connect while mic is active (and vice versa)
  btnRtStart.disabled = rtActive || isMicActive;
  btnMic.disabled = isMicActive || rtActive;
  openaiKeyInput.disabled = rtActive;
}

// ---- Canvas Resize ----
function resizeCanvases() {
  for (const c of [waveformCanvas, spectrumCanvas]) {
    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
  }
}
window.addEventListener("resize", resizeCanvases);

// ---- Visualization ----
function startVisualization() {
  if (!analyser) return;
  resizeCanvases();

  const waveCtx = waveformCanvas.getContext("2d");
  const specCtx = spectrumCanvas.getContext("2d");
  const bufferLength = analyser.frequencyBinCount;
  const timeData = new Uint8Array(bufferLength);
  const freqData = new Uint8Array(bufferLength);

  function draw() {
    animationId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(timeData);
    analyser.getByteFrequencyData(freqData);

    const dpr = window.devicePixelRatio || 1;

    // ---- Waveform ----
    const wW = waveformCanvas.width;
    const wH = waveformCanvas.height;
    waveCtx.fillStyle = "#1a1d27";
    waveCtx.fillRect(0, 0, wW, wH);

    // Grid lines
    waveCtx.strokeStyle = "#2a2d3a";
    waveCtx.lineWidth = 1;
    waveCtx.beginPath();
    waveCtx.moveTo(0, wH / 2);
    waveCtx.lineTo(wW, wH / 2);
    waveCtx.stroke();

    // Waveform line
    waveCtx.lineWidth = 1.5 * dpr;
    waveCtx.strokeStyle = "#22d3ee";
    waveCtx.beginPath();
    const sliceWidth = wW / bufferLength;
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = timeData[i] / 128.0;
      const y = (v * wH) / 2;
      if (i === 0) waveCtx.moveTo(x, y);
      else waveCtx.lineTo(x, y);
      x += sliceWidth;
    }
    waveCtx.stroke();

    // RMS
    let rms = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = (timeData[i] - 128) / 128;
      rms += v * v;
    }
    rms = Math.sqrt(rms / bufferLength);
    const dbLevel = 20 * Math.log10(Math.max(rms, 1e-10));
    rmsDisplay.textContent = `${dbLevel.toFixed(1)} dB`;

    // ---- Spectrum ----
    const sW = spectrumCanvas.width;
    const sH = spectrumCanvas.height;
    specCtx.fillStyle = "#1a1d27";
    specCtx.fillRect(0, 0, sW, sH);

    const barWidth = sW / bufferLength;
    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (freqData[i] / 255) * sH;
      const ratio = i / bufferLength;
      // Gradient: cyan → blue → purple
      const r = Math.floor(30 + ratio * 120);
      const g = Math.floor(200 - ratio * 150);
      const b = Math.floor(230 + ratio * 25);
      specCtx.fillStyle = `rgb(${r},${g},${b})`;
      specCtx.fillRect(i * barWidth, sH - barHeight, barWidth + 1, barHeight);
    }

    // Frequency labels
    specCtx.fillStyle = "#64748b";
    specCtx.font = `${11 * dpr}px monospace`;
    if (audioCtx) {
      const nyquist = audioCtx.sampleRate / 2;
      const freqs = [100, 500, 1000, 2000, 4000, 8000];
      for (const f of freqs) {
        if (f > nyquist) continue;
        const xPos = (f / nyquist) * sW;
        const label = f >= 1000 ? f / 1000 + "k" : String(f);
        specCtx.fillText(label, xPos + 2, sH - 6 * dpr);
      }
    }
  }

  draw();
}

function stopVisualization() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
}

// ---- Event Listeners ----
btnPlay.addEventListener("click", startPlayback);
btnStop.addEventListener("click", stopPlayback);
btnMic.addEventListener("click", startMic);
btnMicStop.addEventListener("click", stopMic);
btnRecord.addEventListener("click", startRecording);
btnRecordStop.addEventListener("click", stopRecording);
btnRtStart.addEventListener("click", startRealtime);
btnRtStop.addEventListener("click", stopRealtime);

volumeSlider.addEventListener("input", () => {
  const v = parseFloat(volumeSlider.value);
  volumeValue.textContent = v.toFixed(2);
  if (gainNode) gainNode.gain.value = v;
});
