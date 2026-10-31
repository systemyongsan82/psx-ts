import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { RingLogger } from '../core/logger';
import { PsxSystem } from '../core/system';
import { encodePng } from './png';
import { parsePjm } from './pjm';

interface ReplayArgs {
  binPath: string;
  biosPath: string;
  moviePath: string;
  outDir: string;
  frames: number;
  shotEvery: number;
  offset: number;
}

function parseArgs(argv: Array<string>): ReplayArgs {
  const args: ReplayArgs = {
    binPath: "games/Resident Evil - Director's Cut (USA)/Resident Evil - Director's Cut (USA).bin",
    biosPath: 'firmwares/scph5501.bin',
    moviePath: "games/Resident Evil - Director's Cut (USA)/arukado,uroboros-redc.pjm",
    outDir: 'shots-replay',
    frames: 0,
    shotEvery: 600,
    offset: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1] ?? '';
    switch (argv[i]) {
      case '--bin': args.binPath = value; i++; break;
      case '--bios': args.biosPath = value; i++; break;
      case '--movie': args.moviePath = value; i++; break;
      case '--out': args.outDir = value; i++; break;
      case '--frames': args.frames = Number(value); i++; break;
      case '--shot-every': args.shotEvery = Number(value); i++; break;
      case '--offset': args.offset = Number(value); i++; break;
      default: break;
    }
  }

  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const movie = parsePjm(new Uint8Array(readFileSync(args.moviePath)));
  const total = args.frames > 0 ? Math.min(args.frames, movie.frameCount + args.offset) : movie.frameCount + args.offset;
  mkdirSync(args.outDir, { recursive: true });
  console.log(`movie "${movie.author}" ${movie.serial}: ${movie.frameCount} frames, ${movie.rerecords} rerecords; replaying ${total} frames, offset ${args.offset}`);
  const log = new RingLogger();
  const system = new PsxSystem({ binPath: args.binPath, cuePath: null, log, biosRom: new Uint8Array(readFileSync(args.biosPath)) });
  system.boot();
  const started = performance.now();
  for (let f = 0; f < total; f++) {
    const index = f - args.offset;
    system.pad.buttons = index >= 0 && index < movie.frameCount ? movie.frames[index] : 0;
    system.runFrames(1);
    if ((f + 1) % args.shotEvery === 0 || f + 1 === total) {
      const frame = system.gpu.present();
      writeFileSync(`${args.outDir}/f${String(f + 1).padStart(6, '0')}.png`, encodePng(frame.width, frame.height, frame.rgba));
      const msPerFrame = (performance.now() - started) / (f + 1);
      console.log(`frame ${f + 1}/${total} pc=${(system.cpu.pc >>> 0).toString(16)} pad=${system.pad.buttons.toString(16)} ${msPerFrame.toFixed(2)} ms/frame`);
    }
  }
  writeFileSync(`${args.outDir}/session.log`, log.dump(4096));
}

main();
