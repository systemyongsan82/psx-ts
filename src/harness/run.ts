import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RingLogger } from '../core/logger';
import { PsxSystem } from '../core/system';
import { encodePng } from './png';

interface Args {
  frames: number;
  outDir: string;
  shotEvery: number;
  logLines: number;
  binPath: string;
}

function parseArgs(argv: Array<string>): Args {
  const args: Args = { frames: 600, outDir: 'shots', shotEvery: 60, logLines: 300, binPath: 'Resident Evil (USA)/Resident Evil (USA).bin' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (): string => {
      i++;
      if (i >= argv.length) {
        throw new Error(`missing value for ${a}`);
      }

      return argv[i];
    };
    if (a === '--frames') { args.frames = Number(val()); }
    else if (a === '--out') { args.outDir = val(); }
    else if (a === '--shot-every') { args.shotEvery = Number(val()); }
    else if (a === '--log-lines') { args.logLines = Number(val()); }
    else if (a === '--bin') { args.binPath = val(); }
  }

  return args;
}

export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const log = new RingLogger();
  mkdirSync(args.outDir, { recursive: true });

  const started = performance.now();
  const system = new PsxSystem({ binPath: args.binPath, cuePath: null, log });
  system.log.debug('sys', 'system constructed');

  let shotIndex = 0;
  const stats: Array<string> = [];
  for (let f = 1; f <= args.frames; f++) {
    try {
      system.runFrames(1);
    } catch (e) {
      console.error(`\n=== STOPPED at frame ${f} ===`);
      console.error(String(e instanceof Error ? (e.stack ?? e.message) : e));
      console.error('--- last log entries ---');
      console.error(log.dump(args.logLines));
      writeFileSync(`${args.outDir}/stopped.log`, log.dump(4096));
      process.exit(1);
    }
    if (f % args.shotEvery === 0 || f === 1 || f === args.frames) {
      const frame = system.gpu.present();
      const png = encodePng(frame.width, frame.height, frame.rgba);
      writeFileSync(resolve(args.outDir, `frame${String(shotIndex).padStart(4, '0')}_f${f}.png`), png);
      const now = performance.now();
      const fps = (f === 1 ? now - started : ((now - started) / f));
      stats.push(`frame ${f}: ${fps.toFixed(1)} ms/frame, rgba ${frame.width}x${frame.height}`);
      shotIndex++;
    }
  }

  for (const s of stats) {
    console.log(s);
  }
  console.log(`\nlog tail (last 60):\n${log.dump(60)}`);
  writeFileSync(`${args.outDir}/session.log`, log.dump(4096));
}

main();