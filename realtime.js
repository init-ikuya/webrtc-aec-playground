// ---- OpenAI Realtime API via WebRTC ----
// API key is used in-memory only and never persisted to storage.

let rtPeerConnection = null;
let rtDataChannel = null;
let rtRemoteAudio = null;

const OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime";
const OPENAI_MODEL = "gpt-4o-realtime-preview";

async function startRealtimeSession(apiKey, micConstraints) {
  if (rtPeerConnection) {
    throw new Error("Session already active");
  }

  const pc = new RTCPeerConnection();
  rtPeerConnection = pc;

  // Remote audio playback
  rtRemoteAudio = document.createElement("audio");
  rtRemoteAudio.autoplay = true;
  pc.ontrack = (e) => {
    rtRemoteAudio.srcObject = e.streams[0];
  };

  // Data channel for Realtime API events
  const dc = pc.createDataChannel("oai-events");
  rtDataChannel = dc;

  dc.onopen = () => {
    dc.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: "You are a friendly assistant. Respond briefly in the same language the user speaks. Keep responses short (1-2 sentences).",
        voice: "alloy",
        input_audio_transcription: { model: "gpt-4o-mini-transcription" },
      },
    }));
  };

  dc.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      handleRealtimeEvent(event);
    } catch (_) {
      // ignore parse errors
    }
  };

  // Add mic track
  let micStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints });
  } catch (err) {
    cleanupRealtime();
    throw new Error("Mic access failed: " + err.message);
  }

  for (const track of micStream.getTracks()) {
    pc.addTrack(track, micStream);
  }

  // Create offer and exchange SDP
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const response = await fetch(`${OPENAI_REALTIME_URL}?model=${OPENAI_MODEL}`, {
    method: "POST",
    body: pc.localDescription.sdp,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/sdp",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    cleanupRealtime();
    throw new Error(`OpenAI API error (${response.status}): ${body}`);
  }

  const answerSdp = await response.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  return { peerConnection: pc, dataChannel: dc, micStream };
}

function stopRealtimeSession() {
  cleanupRealtime();
}

function cleanupRealtime() {
  if (rtDataChannel) {
    rtDataChannel.close();
    rtDataChannel = null;
  }
  if (rtPeerConnection) {
    rtPeerConnection.getSenders().forEach((s) => {
      if (s.track) s.track.stop();
    });
    rtPeerConnection.close();
    rtPeerConnection = null;
  }
  if (rtRemoteAudio) {
    rtRemoteAudio.srcObject = null;
    rtRemoteAudio = null;
  }
}

function handleRealtimeEvent(event) {
  const statusEl = document.getElementById("rt-status");
  switch (event.type) {
    case "session.created":
      statusEl.textContent = "Session active";
      statusEl.className = "rt-status connected";
      break;
    case "session.updated":
      statusEl.textContent = "Session configured";
      statusEl.className = "rt-status connected";
      break;
    case "input_audio_buffer.speech_started":
      statusEl.textContent = "Listening...";
      statusEl.className = "rt-status connected";
      break;
    case "response.audio.delta":
      statusEl.textContent = "AI speaking...";
      statusEl.className = "rt-status connected";
      break;
    case "response.done":
      statusEl.textContent = "Ready";
      statusEl.className = "rt-status connected";
      break;
    case "error":
      statusEl.textContent = `Error: ${event.error?.message || "unknown"}`;
      statusEl.className = "rt-status error";
      break;
  }
}
