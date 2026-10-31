import { mkdirSync, writeFileSync } from 'node:fs';
import { RingLogger } from '../core/logger';
import { PsxSystem } from '../core/system';
import { PadButton } from '../core/pad';
import { encodePng } from './png';

const binPath = process.argv[2] ?? 'games/Resident Evil (USA)/Resident Evil (USA).bin';
const frames = Number(process.argv[3] ?? 6000);
const outDir = process.argv[4] ?? 'shots-gameplay';
const every = Number(process.argv[5] ?? 200);
mkdirSync(outDir, { recursive: true });
const sys = new PsxSystem({ binPath, cuePath: null, log: new RingLogger() });
sys.boot();

const startAt = 1700;
const started = performance.now();
for (let f = 1; f <= frames; f++) {
  const phase = (f - startAt) % 120;
  const press = f >= startAt && phase >= 0 && phase < 10;
  const cross = f >= startAt && phase >= 60 && phase < 70;
  sys.pad.buttons = press ? PadButton.Start : cross ? PadButton.Cross : 0;
  sys.runFrames(1);
  if (f % every === 0) {
    const fr = sys.gpu.present();
    writeFileSync(`${outDir}/f${f}.png`, encodePng(fr.width, fr.height, fr.rgba));
    console.log(`frame ${f} pc=${(sys.cpu.pc >>> 0).toString(16)} ms/frame=${((performance.now() - started) / f).toFixed(1)}`);
  }
}
