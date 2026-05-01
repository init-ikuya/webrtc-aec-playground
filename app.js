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

// ---- DOM ----
const btnPlay = document.getElementById("btn-play");
const btnStop = document.getElementById("btn-stop");
const btnMic = document.getElementById("btn-mic");
const btnMicStop = document.getElementById("btn-mic-stop");
const btnRecord = document.getElementById("btn-record");
const btnRecordStop = document.getElementById("btn-record-stop");
const volumeSlider = document.getElementById("volume");
const volumeValue = document.getElementById("volume-value");
const waveformCanvas = document.getElementById("waveform");
const spectrumCanvas = document.getElementById("spectrum");
const envInfo = document.getElementById("env-info");
const trackSettings = document.getElementById("track-settings");
const recordingsDiv = document.getElementById("recordings");

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
    const freq =
      startFreq * Math.pow(endFreq / startFreq, t / durationSec);
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
  // Simulated speech-like signal: modulated formant frequencies
  const sampleRate = ctx.sampleRate;
  const length = sampleRate * durationSec;
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const f0 = 150; // fundamental
  const formants = [700, 1200, 2500];
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    // Pitch modulation
    const pitch = f0 * (1 + 0.1 * Math.sin(2 * Math.PI * 3 * t));
    let sample = 0;
    // Glottal pulse approximation
    const phase = (pitch * t) % 1;
    const glottal = phase < 0.4 ? Math.sin(Math.PI * phase / 0.4) : 0;
    // Simple formant resonance simulation
    for (const f of formants) {
      sample += glottal * Math.sin(2 * Math.PI * f * t) * 0.3;
    }
    // Amplitude envelope (syllable-like)
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
    case "sweep":
      buffer = createSweep(audioCtx);
      break;
    case "whitenoise":
      buffer = createWhiteNoise(audioCtx);
      break;
    case "speech":
      buffer = createSpeechLike(audioCtx);
      break;
  }

  playbackSource = audioCtx.createBufferSource();
  playbackSource.buffer = buffer;
  playbackSource.loop = true;
  playbackSource.connect(gainNode);
  playbackSource.start();

  btnPlay.disabled = true;
  btnStop.disabled = false;
}

function stopPlayback() {
  if (playbackSource) {
    playbackSource.stop();
    playbackSource.disconnect();
    playbackSource = null;
  }
  btnPlay.disabled = false;
  btnStop.disabled = true;
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
    alert("マイクの取得に失敗しました: " + err.message);
    return;
  }

  micSource = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  micSource.connect(analyser);
  // Do NOT connect to destination to avoid feedback loop

  // Show track settings
  const audioTrack = micStream.getAudioTracks()[0];
  const settings = audioTrack.getSettings();
  const capabilities = audioTrack.getCapabilities ? audioTrack.getCapabilities() : "N/A";
  trackSettings.textContent = JSON.stringify(
    { settings, capabilities },
    null,
    2
  );

  btnMic.disabled = true;
  btnMicStop.disabled = false;
  btnRecord.disabled = false;

  startVisualization();
}

function stopMic() {
  stopRecording();
  stopVisualization();

  if (micSource) {
    micSource.disconnect();
    micSource = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  analyser = null;
  trackSettings.textContent = "マイク未開始";

  btnMic.disabled = false;
  btnMicStop.disabled = true;
  btnRecord.disabled = true;
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

    const label = document.createElement("div");
    label.textContent = `echoCancellation: ${ecEnabled} | ${new Date().toLocaleTimeString()}`;

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = url;

    const downloadLink = document.createElement("a");
    downloadLink.href = url;
    downloadLink.download = `aec-${ecEnabled ? "on" : "off"}-${Date.now()}.webm`;
    downloadLink.textContent = "ダウンロード";
    downloadLink.style.marginLeft = "8px";
    downloadLink.style.fontSize = "0.85rem";

    entry.appendChild(label);
    entry.appendChild(audio);
    entry.appendChild(downloadLink);
    recordingsDiv.prepend(entry);
  };

  mediaRecorder.start();
  btnRecord.disabled = true;
  btnRecordStop.disabled = false;
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
  btnRecord.disabled = !micStream;
  btnRecordStop.disabled = true;
}

// ---- Visualization ----
function startVisualization() {
  if (!analyser) return;

  const waveCtx = waveformCanvas.getContext("2d");
  const specCtx = spectrumCanvas.getContext("2d");
  const bufferLength = analyser.frequencyBinCount;
  const timeData = new Uint8Array(bufferLength);
  const freqData = new Uint8Array(bufferLength);

  function draw() {
    animationId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(timeData);
    analyser.getByteFrequencyData(freqData);

    // Waveform
    const wW = waveformCanvas.width;
    const wH = waveformCanvas.height;
    waveCtx.fillStyle = "#111";
    waveCtx.fillRect(0, 0, wW, wH);
    waveCtx.lineWidth = 1.5;
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
    waveCtx.lineTo(wW, wH / 2);
    waveCtx.stroke();

    // RMS level indicator
    let rms = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = (timeData[i] - 128) / 128;
      rms += v * v;
    }
    rms = Math.sqrt(rms / bufferLength);
    const dbLevel = 20 * Math.log10(Math.max(rms, 1e-10));
    waveCtx.fillStyle = "#94a3b8";
    waveCtx.font = "12px monospace";
    waveCtx.fillText(`RMS: ${dbLevel.toFixed(1)} dB`, 10, 20);

    // Spectrum
    const sW = spectrumCanvas.width;
    const sH = spectrumCanvas.height;
    specCtx.fillStyle = "#111";
    specCtx.fillRect(0, 0, sW, sH);
    const barWidth = sW / bufferLength;
    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (freqData[i] / 255) * sH;
      const hue = (i / bufferLength) * 270;
      specCtx.fillStyle = `hsl(${hue}, 80%, 50%)`;
      specCtx.fillRect(i * barWidth, sH - barHeight, barWidth + 1, barHeight);
    }

    // Frequency labels
    specCtx.fillStyle = "#94a3b8";
    specCtx.font = "11px monospace";
    if (audioCtx) {
      const nyquist = audioCtx.sampleRate / 2;
      const freqs = [100, 500, 1000, 2000, 4000, 8000];
      for (const f of freqs) {
        if (f > nyquist) continue;
        const xPos = (f / nyquist) * sW;
        specCtx.fillText(`${f >= 1000 ? f / 1000 + "k" : f}`, xPos, sH - 4);
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

volumeSlider.addEventListener("input", () => {
  const v = parseFloat(volumeSlider.value);
  volumeValue.textContent = v.toFixed(2);
  if (gainNode) gainNode.gain.value = v;
});
