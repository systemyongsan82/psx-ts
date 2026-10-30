import { writeFileSync } from 'node:fs';
import { RingLogger } from '../core/logger';
import { PsxSystem } from '../core/system';

const binPath = process.argv[2] ?? 'games/Resident Evil (USA)/Resident Evil (USA).bin';
const frames = Number(process.argv[3] ?? 1800);
const outPath = process.argv[4] ?? '/tmp/re.wav';
const sys = new PsxSystem({ binPath, cuePath: null, log: new RingLogger() });
sys.boot();
const chunks: Array<Float32Array> = [];
let total = 0;
const perFrame: Array<number> = [];
for (let f = 0; f < frames; f++) {
  sys.runFrames(1);
  const n = sys.spu.sink.availableFrames;
  perFrame.push(n);
  const buf = new Float32Array(n * 2);
  sys.spu.sink.read(buf, n);
  chunks.push(buf);
  total += n;
}
const pcm = new Int16Array(total * 2);
let w = 0;
let clips = 0;
let jumps = 0;
let prevL = 0;
let prevR = 0;
for (const c of chunks) {
  for (let i = 0; i < c.length; i += 2) {
    const l = c[i];
    const r = c[i + 1];
    if (Math.abs(l) >= 0.999 || Math.abs(r) >= 0.999) clips++;
    if (Math.abs(l - prevL) > 0.5 || Math.abs(r - prevR) > 0.5) jumps++;
    prevL = l;
    prevR = r;
    pcm[w++] = Math.max(-32768, Math.min(32767, Math.round(l * 32767)));
    pcm[w++] = Math.max(-32768, Math.min(32767, Math.round(r * 32767)));
  }
}
const header = new ArrayBuffer(44);
const v = new DataView(header);
const str = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
str(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE'); str(12, 'fmt ');
v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, 44100, true);
v.setUint32(28, 44100 * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, pcm.byteLength, true);
writeFileSync(outPath, Buffer.concat([Buffer.from(header), Buffer.from(pcm.buffer)]));
const min = Math.min(...perFrame);
const max = Math.max(...perFrame);
console.log(`samples=${total} (${(total / 44100).toFixed(2)} s for ${(frames / 59.94).toFixed(2)} s video) perFrame min=${min} max=${max} clips=${clips} jumps>0.5=${jumps}`);
