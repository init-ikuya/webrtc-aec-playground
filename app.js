// ---- State ----
let audioCtx = null;
let playbackSource = null;
let gainNode = null;
let refAnalyser = null; // analyser on playback signal (reference)
let micStream = null;
let micSource = null;
let analyser = null;
let mediaRecorder = null;
let recordedChunks = [];
let animationId = null;
let rtActive = false;

// Coherence estimation state (exponential moving average of cross/auto spectra)
const COHERENCE_ALPHA = 0.1; // smoothing factor
let sxx = null; // auto-spectrum of reference
let syy = null; // auto-spectrum of mic
let sxyRe = null; // cross-spectrum real part
let sxyIm = null; // cross-spectrum imaginary part

// Coherence time-series log
let coherenceLog = []; // { time, avgCoherence, erle }
let coherenceLogStart = null;

// ERLE state
let erleMicPowerAcc = 0; // accumulated mic power (AEC output)
let erleRefPowerAcc = 0; // accumulated reference power
let erleFrameCount = 0;

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
const coherenceCanvas = document.getElementById("coherence");
const envInfo = document.getElementById("env-info");
const trackSettings = document.getElementById("track-settings");
const recordingsDiv = document.getElementById("recordings");
const statusBadge = document.getElementById("status-badge");
const rmsDisplay = document.getElementById("rms-display");
const coherenceAvg = document.getElementById("coherence-avg");
const erleDisplay = document.getElementById("erle-display");
const spectrogramCanvas = document.getElementById("spectrogram");
const convergenceCanvas = document.getElementById("convergence");
const btnExportLog = document.getElementById("btn-export-log");
const btnApplyConstraints = document.getElementById("btn-apply-constraints");

// Spectrogram offscreen buffer
let spectrogramBuffer = null;
let spectrogramBufferCtx = null;

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

    // Reference analyser sits between gain and destination
    refAnalyser = audioCtx.createAnalyser();
    refAnalyser.fftSize = 2048;
    gainNode.connect(refAnalyser);
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

  // Reset coherence accumulators & logs
  resetCoherence();
  resetErle();
  resetCoherenceLog();

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
  coherenceAvg.textContent = "--";

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
    const session = await startRealtimeSession(apiKey, micConstraints);
    rtActive = true;
    btnRtStop.disabled = false;
    openaiKeyInput.value = "";

    // Set up visualization for the Realtime mic stream
    ensureAudioCtx();
    micStream = session.micStream;
    micSource = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    micSource.connect(analyser);
    resetCoherence();
    resetErle();
    resetCoherenceLog();
    startVisualization();

    updateStatus();
  } catch (err) {
    rtStatusEl.textContent = err.message;
    rtStatusEl.className = "rt-status error";
    btnRtStart.disabled = false;
    rtActive = false;
  }
}

function stopRealtime() {
  stopVisualization();
  if (micSource) { micSource.disconnect(); micSource = null; }
  analyser = null;
  micStream = null;
  stopRealtimeSession();
  rtActive = false;
  btnRtStart.disabled = false;
  btnRtStop.disabled = true;
  rtStatusEl.textContent = "Disconnected";
  rtStatusEl.className = "rt-status";
  rmsDisplay.textContent = "-- dB";
  coherenceAvg.textContent = "--";
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

  // Constraints are editable while mic is active (apply via button), locked during realtime
  document.getElementById("echo-cancellation").disabled = rtActive;
  document.getElementById("noise-suppression").disabled = rtActive;
  document.getElementById("auto-gain-control").disabled = rtActive;

  // Show apply button only when mic is active
  btnApplyConstraints.style.display = isMicActive ? "" : "none";

  // Disable realtime connect while mic is active (and vice versa)
  btnRtStart.disabled = rtActive || isMicActive;
  btnMic.disabled = isMicActive || rtActive;
  openaiKeyInput.disabled = rtActive;
}

// ---- Coherence ----
function resetCoherence() {
  const n = 1024; // frequencyBinCount for fftSize=2048
  sxx = new Float32Array(n);
  syy = new Float32Array(n);
  sxyRe = new Float32Array(n);
  sxyIm = new Float32Array(n);
}

// Estimate magnitude-squared coherence using exponentially weighted averages.
// AnalyserNode only gives us magnitude (not phase), so we approximate:
//   - Sxx and Syy from getFloatFrequencyData (power in dB → linear)
//   - For Sxy we use the geometric mean approximation:
//     |Sxy|^2 ≈ Sxx * Syy * coherence
// Since we can't get true cross-spectrum phase from AnalyserNode,
// we use a practical proxy: the ratio of the product of magnitudes
// to the individual powers, smoothed over time.
// This simplifies to tracking per-bin correlation of magnitude envelopes.
function computeCoherence(refFreqData, micFreqData) {
  if (!sxx) resetCoherence();
  const n = refFreqData.length;
  const alpha = COHERENCE_ALPHA;
  const coherence = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    // Convert dB to linear power
    const xPow = Math.pow(10, refFreqData[i] / 10);
    const yPow = Math.pow(10, micFreqData[i] / 10);
    const xyMag = Math.sqrt(xPow * yPow);

    // Exponential moving average
    sxx[i] = alpha * xPow + (1 - alpha) * sxx[i];
    syy[i] = alpha * yPow + (1 - alpha) * syy[i];
    sxyRe[i] = alpha * xyMag + (1 - alpha) * sxyRe[i];

    // MSC = |Sxy|^2 / (Sxx * Syy)
    const denom = sxx[i] * syy[i];
    if (denom > 1e-20) {
      coherence[i] = (sxyRe[i] * sxyRe[i]) / denom;
      coherence[i] = Math.min(coherence[i], 1.0);
    } else {
      coherence[i] = 0;
    }
  }
  return coherence;
}

// ---- ERLE ----
function resetErle() {
  erleMicPowerAcc = 0;
  erleRefPowerAcc = 0;
  erleFrameCount = 0;
}

function updateErle(refFreqData, micFreqData) {
  let refPower = 0;
  let micPower = 0;
  for (let i = 0; i < refFreqData.length; i++) {
    refPower += Math.pow(10, refFreqData[i] / 10);
    micPower += Math.pow(10, micFreqData[i] / 10);
  }
  erleRefPowerAcc += refPower;
  erleMicPowerAcc += micPower;
  erleFrameCount++;

  if (erleRefPowerAcc > 1e-20 && erleMicPowerAcc > 1e-20) {
    return 10 * Math.log10(erleRefPowerAcc / erleMicPowerAcc);
  }
  return null;
}

// ---- Coherence Log ----
function resetCoherenceLog() {
  coherenceLog = [];
  coherenceLogStart = null;
}

function logCoherence(avgCoherence, erle, extras) {
  if (!coherenceLogStart) coherenceLogStart = performance.now();
  const time = ((performance.now() - coherenceLogStart) / 1000).toFixed(2);
  coherenceLog.push({ time: parseFloat(time), avgCoherence, erle, ...extras });
}

function exportCoherenceLog() {
  if (coherenceLog.length === 0) {
    alert("No coherence data to export");
    return;
  }
  const header = "time_sec,avg_coherence,erle_dB,mic_rms_dB,ref_rms_dB,coherence_low,coherence_mid,coherence_high,aec_enabled\n";
  const rows = coherenceLog.map(
    (r) => [
      r.time,
      r.avgCoherence.toFixed(4),
      r.erle !== null ? r.erle.toFixed(2) : "",
      r.micRmsDb !== undefined ? r.micRmsDb.toFixed(2) : "",
      r.refRmsDb !== undefined ? r.refRmsDb.toFixed(2) : "",
      r.cohLow !== undefined ? r.cohLow.toFixed(4) : "",
      r.cohMid !== undefined ? r.cohMid.toFixed(4) : "",
      r.cohHigh !== undefined ? r.cohHigh.toFixed(4) : "",
      r.aecEnabled !== undefined ? (r.aecEnabled ? "1" : "0") : "",
    ].join(",")
  ).join("\n");
  const blob = new Blob([header + rows], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const ecEnabled = document.getElementById("echo-cancellation").checked;
  a.download = `coherence-log-aec-${ecEnabled ? "on" : "off"}-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- Apply Constraints (dynamic toggle) ----
async function applyConstraintsLive() {
  if (!micStream) return;
  const track = micStream.getAudioTracks()[0];
  if (!track) return;

  const newConstraints = {
    echoCancellation: document.getElementById("echo-cancellation").checked,
    noiseSuppression: document.getElementById("noise-suppression").checked,
    autoGainControl: document.getElementById("auto-gain-control").checked,
  };

  try {
    await track.applyConstraints(newConstraints);
    // Update displayed settings
    const settings = track.getSettings();
    const capabilities = track.getCapabilities ? track.getCapabilities() : "N/A";
    trackSettings.textContent = JSON.stringify({ settings, capabilities }, null, 2);
    // Reset coherence & ERLE for fresh measurement
    resetCoherence();
    resetErle();
    resetCoherenceLog();
  } catch (err) {
    alert("applyConstraints failed: " + err.message);
  }
}

// ---- Spectrogram color map (viridis-inspired) ----
function spectrogramColor(value) {
  const t = value / 255;
  const r = Math.floor(Math.min(255, Math.max(0, (t < 0.5 ? t * 2 * 80 : 80 + (t - 0.5) * 2 * 175))));
  const g = Math.floor(Math.min(255, Math.max(0, (t < 0.35 ? t * 2.86 * 20 : t < 0.7 ? 20 + (t - 0.35) * 2.86 * 200 : 220 + (t - 0.7) * 3.33 * 35))));
  const b = Math.floor(Math.min(255, Math.max(0, (t < 0.5 ? 40 + t * 2 * 140 : 180 - (t - 0.5) * 2 * 150))));
  return `rgb(${r},${g},${b})`;
}

// ---- Canvas Resize ----
function resizeCanvases() {
  for (const c of [waveformCanvas, spectrumCanvas, coherenceCanvas, spectrogramCanvas, convergenceCanvas]) {
    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
  }
  // Re-create spectrogram buffer when size changes
  initSpectrogramBuffer();
}

function initSpectrogramBuffer() {
  const w = spectrogramCanvas.width;
  const h = spectrogramCanvas.height;
  if (w === 0 || h === 0) return;
  spectrogramBuffer = document.createElement("canvas");
  spectrogramBuffer.width = w;
  spectrogramBuffer.height = h;
  spectrogramBufferCtx = spectrogramBuffer.getContext("2d");
  spectrogramBufferCtx.fillStyle = "#1a1d27";
  spectrogramBufferCtx.fillRect(0, 0, w, h);
}

window.addEventListener("resize", resizeCanvases);

// ---- Visualization ----
function startVisualization() {
  if (!analyser) return;
  resizeCanvases();

  const waveCtx = waveformCanvas.getContext("2d");
  const specCtx = spectrumCanvas.getContext("2d");
  const cohCtx = coherenceCanvas.getContext("2d");
  const bufferLength = analyser.frequencyBinCount;
  const timeData = new Uint8Array(bufferLength);
  const freqData = new Uint8Array(bufferLength);

  // Float frequency data for coherence (dB values)
  const micFloatFreq = new Float32Array(bufferLength);
  const refFloatFreq = new Float32Array(bufferLength);
  const refTimeData = new Uint8Array(bufferLength);

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

    waveCtx.strokeStyle = "#2a2d3a";
    waveCtx.lineWidth = 1;
    waveCtx.beginPath();
    waveCtx.moveTo(0, wH / 2);
    waveCtx.lineTo(wW, wH / 2);
    waveCtx.stroke();

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
      const r = Math.floor(30 + ratio * 120);
      const g = Math.floor(200 - ratio * 150);
      const b = Math.floor(230 + ratio * 25);
      specCtx.fillStyle = `rgb(${r},${g},${b})`;
      specCtx.fillRect(i * barWidth, sH - barHeight, barWidth + 1, barHeight);
    }

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

    // ---- Spectrogram (waterfall) ----
    const sgW = spectrogramCanvas.width;
    const sgH = spectrogramCanvas.height;
    if (sgW > 0 && sgH > 0 && spectrogramBufferCtx) {
      // Shift existing image 1px to the left
      const imgData = spectrogramBufferCtx.getImageData(1, 0, sgW - 1, sgH);
      spectrogramBufferCtx.putImageData(imgData, 0, 0);

      // Draw new column on the right edge
      const colHeight = sgH;
      for (let i = 0; i < bufferLength; i++) {
        const binY = Math.floor((1 - i / bufferLength) * colHeight);
        const binH = Math.max(1, Math.ceil(colHeight / bufferLength));
        spectrogramBufferCtx.fillStyle = spectrogramColor(freqData[i]);
        spectrogramBufferCtx.fillRect(sgW - 1, binY, 1, binH);
      }

      // Copy buffer to visible canvas
      const sgCtx = spectrogramCanvas.getContext("2d");
      sgCtx.drawImage(spectrogramBuffer, 0, 0);

      // Frequency labels overlay
      sgCtx.fillStyle = "rgba(100, 116, 139, 0.8)";
      sgCtx.font = `${11 * dpr}px monospace`;
      if (audioCtx) {
        const nyquist = audioCtx.sampleRate / 2;
        const freqs = [100, 500, 1000, 2000, 4000, 8000];
        for (const f of freqs) {
          if (f > nyquist) continue;
          const yPos = sgH * (1 - f / nyquist);
          const label = f >= 1000 ? f / 1000 + "k" : String(f);
          sgCtx.fillText(label, 4, yPos - 2);
        }
      }
    }

    // ---- Coherence ----
    const cW = coherenceCanvas.width;
    const cH = coherenceCanvas.height;
    cohCtx.fillStyle = "#1a1d27";
    cohCtx.fillRect(0, 0, cW, cH);

    if (refAnalyser && playbackSource) {
      // Get float frequency data from both analysers
      analyser.getFloatFrequencyData(micFloatFreq);
      refAnalyser.getFloatFrequencyData(refFloatFreq);

      const coherence = computeCoherence(refFloatFreq, micFloatFreq);

      // Draw grid lines at 0.25, 0.5, 0.75
      cohCtx.strokeStyle = "#2a2d3a";
      cohCtx.lineWidth = 1;
      for (const level of [0.25, 0.5, 0.75]) {
        const gy = cH * (1 - level);
        cohCtx.beginPath();
        cohCtx.moveTo(0, gy);
        cohCtx.lineTo(cW, gy);
        cohCtx.stroke();
      }

      // Y-axis labels
      cohCtx.fillStyle = "#475569";
      cohCtx.font = `${10 * dpr}px monospace`;
      cohCtx.fillText("1.0", 4, 12 * dpr);
      cohCtx.fillText("0.5", 4, cH * 0.5 + 4);
      cohCtx.fillText("0", 4, cH - 4);

      // Draw coherence curve
      cohCtx.lineWidth = 2 * dpr;
      cohCtx.strokeStyle = "#f59e0b"; // amber
      cohCtx.beginPath();
      const cohBarWidth = cW / coherence.length;
      for (let i = 0; i < coherence.length; i++) {
        const cx = i * cohBarWidth;
        const cy = cH * (1 - coherence[i]);
        if (i === 0) cohCtx.moveTo(cx, cy);
        else cohCtx.lineTo(cx, cy);
      }
      cohCtx.stroke();

      // Fill under curve with semi-transparent color
      cohCtx.lineTo(cW, cH);
      cohCtx.lineTo(0, cH);
      cohCtx.closePath();
      cohCtx.fillStyle = "rgba(245, 158, 11, 0.08)";
      cohCtx.fill();

      // Frequency labels
      cohCtx.fillStyle = "#64748b";
      cohCtx.font = `${11 * dpr}px monospace`;
      if (audioCtx) {
        const nyquist = audioCtx.sampleRate / 2;
        const freqs = [100, 500, 1000, 2000, 4000, 8000];
        for (const f of freqs) {
          if (f > nyquist) continue;
          const xPos = (f / nyquist) * cW;
          const label = f >= 1000 ? f / 1000 + "k" : String(f);
          cohCtx.fillText(label, xPos + 2, cH - 6 * dpr);
        }
      }

      // ERLE calculation
      const erle = updateErle(refFloatFreq, micFloatFreq);
      if (erle !== null) {
        erleDisplay.textContent = `${erle.toFixed(1)} dB`;
      } else {
        erleDisplay.textContent = "-- dB";
      }

      // Average coherence display
      let sum = 0;
      for (let i = 0; i < coherence.length; i++) sum += coherence[i];
      const avg = sum / coherence.length;
      coherenceAvg.textContent = avg.toFixed(3);

      // Band-specific coherence (low: 0-500Hz, mid: 500-2kHz, high: 2k-8kHz)
      let cohLow = 0, cohMid = 0, cohHigh = 0;
      let cntLow = 0, cntMid = 0, cntHigh = 0;
      if (audioCtx) {
        const nyquist = audioCtx.sampleRate / 2;
        const binHz = nyquist / coherence.length;
        for (let i = 0; i < coherence.length; i++) {
          const freq = i * binHz;
          if (freq <= 500) { cohLow += coherence[i]; cntLow++; }
          else if (freq <= 2000) { cohMid += coherence[i]; cntMid++; }
          else if (freq <= 8000) { cohHigh += coherence[i]; cntHigh++; }
        }
      }
      cohLow = cntLow > 0 ? cohLow / cntLow : 0;
      cohMid = cntMid > 0 ? cohMid / cntMid : 0;
      cohHigh = cntHigh > 0 ? cohHigh / cntHigh : 0;

      // Reference RMS (time-domain, same method as mic RMS)
      refAnalyser.getByteTimeDomainData(refTimeData);
      let refRms = 0;
      for (let i = 0; i < refTimeData.length; i++) {
        const v = (refTimeData[i] - 128) / 128;
        refRms += v * v;
      }
      refRms = 20 * Math.log10(Math.max(Math.sqrt(refRms / refTimeData.length), 1e-10));

      // Log coherence time-series (throttle to ~10Hz)
      if (!this._lastLogTime || performance.now() - this._lastLogTime > 100) {
        logCoherence(avg, erle, {
          micRmsDb: dbLevel,
          refRmsDb: refRms,
          cohLow,
          cohMid,
          cohHigh,
          aecEnabled: document.getElementById("echo-cancellation").checked,
        });
        this._lastLogTime = performance.now();
      }
    } else {
      // No reference signal
      cohCtx.fillStyle = "#475569";
      cohCtx.font = `${12 * dpr}px sans-serif`;
      cohCtx.textAlign = "center";
      cohCtx.fillText("Play a test source to see coherence", cW / 2, cH / 2);
      cohCtx.textAlign = "start";
      coherenceAvg.textContent = "--";
      erleDisplay.textContent = "-- dB";
    }

    // ---- Convergence Curve ----
    const cvW = convergenceCanvas.width;
    const cvH = convergenceCanvas.height;
    const cvCtx = convergenceCanvas.getContext("2d");
    cvCtx.fillStyle = "#1a1d27";
    cvCtx.fillRect(0, 0, cvW, cvH);

    if (coherenceLog.length >= 2) {
      const VISIBLE_SECONDS = 30;
      const log = coherenceLog;
      const latestTime = log[log.length - 1].time;
      const windowStart = Math.max(0, latestTime - VISIBLE_SECONDS);

      // Grid lines
      cvCtx.strokeStyle = "#2a2d3a";
      cvCtx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const gy = (cvH * i) / 4;
        cvCtx.beginPath();
        cvCtx.moveTo(0, gy);
        cvCtx.lineTo(cvW, gy);
        cvCtx.stroke();
      }

      // Time axis labels
      cvCtx.fillStyle = "#475569";
      cvCtx.font = `${10 * dpr}px monospace`;
      const timeStep = VISIBLE_SECONDS <= 10 ? 2 : 5;
      for (let t = Math.ceil(windowStart / timeStep) * timeStep; t <= latestTime; t += timeStep) {
        const tx = ((t - windowStart) / VISIBLE_SECONDS) * cvW;
        cvCtx.fillText(`${t}s`, tx + 2, cvH - 4);
      }

      // Filter visible data
      const visible = log.filter((d) => d.time >= windowStart);
      if (visible.length >= 2) {
        // Coherence curve (amber, 0-1, mapped to full height)
        cvCtx.strokeStyle = "#f59e0b";
        cvCtx.lineWidth = 2 * dpr;
        cvCtx.beginPath();
        for (let i = 0; i < visible.length; i++) {
          const px = ((visible[i].time - windowStart) / VISIBLE_SECONDS) * cvW;
          const py = cvH * (1 - visible[i].avgCoherence);
          if (i === 0) cvCtx.moveTo(px, py);
          else cvCtx.lineTo(px, py);
        }
        cvCtx.stroke();

        // ERLE curve (green, 0-40dB range mapped to full height)
        const ERLE_MAX = 40;
        const hasErle = visible.some((d) => d.erle !== null);
        if (hasErle) {
          cvCtx.strokeStyle = "#10b981";
          cvCtx.lineWidth = 2 * dpr;
          cvCtx.beginPath();
          let started = false;
          for (let i = 0; i < visible.length; i++) {
            if (visible[i].erle === null) continue;
            const px = ((visible[i].time - windowStart) / VISIBLE_SECONDS) * cvW;
            const erleNorm = Math.max(0, Math.min(1, visible[i].erle / ERLE_MAX));
            const py = cvH * (1 - erleNorm);
            if (!started) { cvCtx.moveTo(px, py); started = true; }
            else cvCtx.lineTo(px, py);
          }
          cvCtx.stroke();
        }

        // Legend
        cvCtx.font = `${11 * dpr}px monospace`;
        const legendY = 14 * dpr;
        cvCtx.fillStyle = "#f59e0b";
        cvCtx.fillText("■", 6, legendY);
        cvCtx.fillStyle = "#94a3b8";
        cvCtx.fillText("Coherence (0–1)", 6 + 14 * dpr, legendY);

        cvCtx.fillStyle = "#10b981";
        cvCtx.fillText("■", 6 + 140 * dpr, legendY);
        cvCtx.fillStyle = "#94a3b8";
        cvCtx.fillText("ERLE (0–40dB)", 6 + 154 * dpr, legendY);

        // Y-axis labels
        cvCtx.fillStyle = "#475569";
        cvCtx.font = `${10 * dpr}px monospace`;
        // Coherence scale (right side)
        cvCtx.textAlign = "right";
        cvCtx.fillStyle = "#f59e0b";
        cvCtx.fillText("1.0", cvW - 4, 12 * dpr);
        cvCtx.fillText("0.5", cvW - 4, cvH / 2 + 4);
        cvCtx.fillText("0", cvW - 4, cvH - 14 * dpr);
        // ERLE scale (left side)
        cvCtx.textAlign = "left";
        cvCtx.fillStyle = "#10b981";
        cvCtx.fillText("40dB", 4, 26 * dpr);
        cvCtx.fillText("20dB", 4, cvH / 2 + 4);
        cvCtx.fillText("0dB", 4, cvH - 14 * dpr);
        cvCtx.textAlign = "start";
      }
    } else {
      cvCtx.fillStyle = "#475569";
      cvCtx.font = `${12 * dpr}px sans-serif`;
      cvCtx.textAlign = "center";
      cvCtx.fillText("Play a test source + start mic to see convergence", cvW / 2, cvH / 2);
      cvCtx.textAlign = "start";
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

btnApplyConstraints.addEventListener("click", applyConstraintsLive);
btnExportLog.addEventListener("click", exportCoherenceLog);

volumeSlider.addEventListener("input", () => {
  const v = parseFloat(volumeSlider.value);
  volumeValue.textContent = v.toFixed(2);
  if (gainNode) gainNode.gain.value = v;
});
