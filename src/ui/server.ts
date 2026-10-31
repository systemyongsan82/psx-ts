import { serve, type ServerWebSocket } from 'bun';
import { readFileSync } from 'node:fs';
import { RingLogger } from '../core/logger';
import { PsxSystem } from '../core/system';
import { CPU_HZ, FRAME_CYCLES } from '../core/contracts';
import { MovieCursor, parsePjm } from '../harness/pjm';

const FRAME_TAG = 0x46524d45;
const AUDIO_TAG = 0x4155444f;
const AUDIO_CHUNK_FRAMES = 256;
const MAX_AUDIO_CHUNKS_PER_FRAME = 4;

let moviePath: string | null = null;
let biosPath: string | null = null;
const positional: Array<string> = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--movie') {
    moviePath = argv[++i] ?? null;
  } else if (argv[i] === '--bios') {
    biosPath = argv[++i] ?? null;
  } else {
    positional.push(argv[i]);
  }
}
const defaultBin = moviePath === null
  ? 'games/Resident Evil (USA)/Resident Evil (USA).bin'
  : "games/Resident Evil - Director's Cut (USA)/Resident Evil - Director's Cut (USA).bin";
const binPath = positional[0] ?? defaultBin;
const port = Number(positional[1] ?? 7171);
if (moviePath !== null && biosPath === null) {
  biosPath = 'firmwares/scph1001.bin';
}

const log = new RingLogger();
const biosRom = biosPath === null ? undefined : new Uint8Array(readFileSync(biosPath));
const system = new PsxSystem({ binPath, cuePath: null, log, biosRom, timing: moviePath === null ? 'hardware' : 'psxjin' });
system.boot();

const movieCursor = moviePath === null ? null : new MovieCursor(parsePjm(new Uint8Array(readFileSync(moviePath))).frames, -1);
if (movieCursor !== null) {
  const cursor = movieCursor;
  system.onExeStart = (): void => {
    system.pad.onPoll = (): void => {
      system.pad.buttons = cursor.poll();
    };
    system.onFrameEnd = (): void => {
      cursor.frameEnd();
    };
  };
}

const sockets = new Set<ServerWebSocket<unknown>>();

function broadcast(bytes: Uint8Array): void {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  for (const ws of sockets) {
    ws.send(buf);
  }
}

const indexHtml = `<!doctype html><html><head><meta charset="utf-8"><title>RE (SLUS-00170) — psx-tiramisu</title>
<style>
  body{margin:0;background:#0a0a0f;color:#9aa;display:flex;flex-direction:column;align-items:center;font-family:monospace}
  canvas{image-rendering:pixelated;margin-top:24px;width:64%;max-width:70vw;border:1px solid #26263a}
  .legend{margin-top:10px;font-size:12px;opacity:.7}
  .fps{position:fixed;top:8px;right:12px;font-size:12px;color:#5f6}
</style></head><body>
<div class="fps" id="fps"></div>
<canvas id="v" width="320" height="240"></canvas>
<div class="legend">arrows=dpad &nbsp; Z=&times; cross &nbsp; X=&#9633; square &nbsp; C=&#9679; circle &nbsp; V=&#9651; triangle &nbsp; Enter=start</div>
<script type="module" src="/bundle.js"></script>
</body></html>`;

serve({
  port,
  async fetch(req, serverInstance) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const upgraded = serverInstance.upgrade(req);
      if (upgraded) {
        return new Response(null, { status: 101 });
      }
      return new Response('ws upgrade failed', { status: 500 });
    }
    if (url.pathname === '/bundle.js') {
      const built = await Bun.build({ entrypoints: ['./src/ui/client.ts'], target: 'browser', format: 'esm' });
      const artifacts = built.outputs;
      const js = artifacts.find((a) => a.path.endsWith('.js'));
      if (js === undefined) {
        return new Response('build failed', { status: 500 });
      }
      return new Response(js, { headers: { 'content-type': 'text/javascript' } });
    }

    return new Response(indexHtml, { headers: { 'content-type': 'text/html' } });
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
    },
    message(_ws, data) {
      const parsed: unknown = JSON.parse(String(data));
      if (movieCursor === null && parsed && typeof parsed === 'object' && 'buttons' in (parsed as object)) {
        const buttons = Number((parsed as { buttons: unknown }).buttons);
        system.pad.buttons = buttons | 0;
      }
    },
    close(ws) {
      sockets.delete(ws);
    },
  },
});

const packetHeader = new Uint8Array(12);
const packetHeaderView = new DataView(packetHeader.buffer);

function tick(): void {
  const start = performance.now();
  system.runFrames(1);
  const frame = system.gpu.present();

  packetHeaderView.setUint32(0, FRAME_TAG);
  packetHeaderView.setUint32(4, frame.width);
  packetHeaderView.setUint32(8, frame.height);
  const packet = new Uint8Array(12 + frame.rgba.length);
  packet.set(packetHeader, 0);
  packet.set(frame.rgba, 12);
  broadcast(packet);

  let audioChunks = 0;
  while (system.spu.sink.availableFrames >= AUDIO_CHUNK_FRAMES && audioChunks < MAX_AUDIO_CHUNKS_PER_FRAME) {
    audioChunks++;
    const dst = new Float32Array(2 + AUDIO_CHUNK_FRAMES * 2);
    const dv = new DataView(dst.buffer);
    dv.setUint32(0, AUDIO_TAG);
    dv.setUint32(4, AUDIO_CHUNK_FRAMES);
    system.spu.sink.read(dst.subarray(2), AUDIO_CHUNK_FRAMES);
    broadcast(new Uint8Array(dst.buffer));
  }

  const now = performance.now();
  framesInSecond++;
  if (now - fpsLast > 1000) {
    const fps = (framesInSecond * 1000) / (now - fpsLast);
    const movieInfo = movieCursor === null ? '' : ` movie=${movieCursor.frameIndex}`;
    console.log(`fps=${fps.toFixed(1)} frame=${system.frameNumber}${movieInfo} coreMs=${(now - start).toFixed(1)}`);
    framesInSecond = 0;
    fpsLast = now;
  }
}

let framesInSecond = 0;
let fpsLast = performance.now();

const FRAME_MS = (FRAME_CYCLES / CPU_HZ) * 1000;
const MAX_CATCH_UP_FRAMES = 3;
let nextFrameAt = performance.now();

function pace(): void {
  const now = performance.now();
  if (now - nextFrameAt > FRAME_MS * MAX_CATCH_UP_FRAMES) {
    nextFrameAt = now;
  }
  let ran = 0;
  while (nextFrameAt <= now && ran < MAX_CATCH_UP_FRAMES) {
    tick();
    nextFrameAt += FRAME_MS;
    ran++;
  }
}

setInterval(pace, 4);

console.log(`serving http://localhost:${port} for ${binPath}`);