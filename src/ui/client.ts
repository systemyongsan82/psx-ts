const FRAME_TAG = 0x46524d45;
const AUDIO_TAG = 0x4155444f;

const canvasEl = document.getElementById('v');
if (!(canvasEl instanceof HTMLCanvasElement)) {
  throw new Error('canvas missing');
}
const canvas = canvasEl;
const ctxOrNull = canvas.getContext('2d');
if (ctxOrNull === null) {
  throw new Error('2d context missing');
}
const ctx = ctxOrNull;
const fpsElOrNull = document.getElementById('fps');

const audioCtx = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
let nextPlayTime = 0;
const jitterSeconds = 0.06;

const KEY_MAP: Record<string, number> = {
  ArrowUp: 0x0010,
  ArrowRight: 0x0020,
  ArrowDown: 0x0040,
  ArrowLeft: 0x0080,
  KeyZ: 0x4000,
  KeyX: 0x8000,
  KeyC: 0x2000,
  KeyV: 0x1000,
  Enter: 0x0008,
  Backspace: 0x0001,
  KeyQ: 0x0400,
  KeyW: 0x0800,
};

let buttons = 0;
const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
ws.binaryType = 'arraybuffer';

function sendButtons(): void {
  ws.send(JSON.stringify({ buttons }));
}

for (const key of Object.keys(KEY_MAP)) {
  window.addEventListener('keydown', (e) => {
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume();
    }
    const target = KEY_MAP[e.code];
    if (target === undefined) {
      return;
    }
    e.preventDefault();
    buttons |= target;
    sendButtons();
  });
  window.addEventListener('keyup', (e) => {
    const target = KEY_MAP[e.code];
    if (target === undefined) {
      return;
    }
    e.preventDefault();
    buttons &= ~target;
    sendButtons();
  });
}

let drawnFrames = 0;
let drawnBaseline = 0;
let fpsTime = performance.now();

function handleFrame(data: ArrayBuffer): void {
  const view = new DataView(data);
  const width = view.getUint32(4);
  const height = view.getUint32(8);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const pixels = new Uint8ClampedArray(data, view.byteOffset + 12, width * height * 4);
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  drawnFrames++;
  const now = performance.now();
  if (now - fpsTime > 1000) {
    const fps = ((drawnFrames - drawnBaseline) * 1000) / (now - fpsTime);
    if (fpsElOrNull !== null) {
      fpsElOrNull.textContent = `${fps.toFixed(0)} fps`;
    }
    drawnBaseline = drawnFrames;
    fpsTime = now;
  }
}

function handleAudio(data: ArrayBuffer): void {
  const view = new DataView(data);
  const count = view.getUint32(4);
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume();
  }
  const samples = new Float32Array(data, view.byteOffset + 8, count * 2);
  const left = new Float32Array(count);
  const right = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    left[i] = samples[i * 2];
    right[i] = samples[i * 2 + 1];
  }
  const buf = audioCtx.createBuffer(2, count, 44100);
  buf.copyToChannel(left, 0);
  buf.copyToChannel(right, 1);
  const source = audioCtx.createBufferSource();
  source.buffer = buf;
  const now = audioCtx.currentTime;
  if (nextPlayTime < now) {
    nextPlayTime = now + jitterSeconds;
  }
  if (nextPlayTime > now + 0.4) {
    return;
  }
  source.connect(audioCtx.destination);
  source.start(nextPlayTime);
  nextPlayTime += count / 44100;
}

ws.onmessage = (event) => {
  if (!(event.data instanceof ArrayBuffer)) {
    return;
  }
  const tag = new DataView(event.data).getUint32(0);
  if (tag === FRAME_TAG) {
    handleFrame(event.data);
  } else if (tag === AUDIO_TAG) {
    handleAudio(event.data);
  }
};

ws.onopen = () => {
  sendButtons();
};