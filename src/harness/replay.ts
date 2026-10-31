import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { RingLogger } from '../core/logger';
import { PsxSystem } from '../core/system';
import { encodePng } from './png';
import { MovieCursor, parsePjm } from './pjm';

interface ReplayArgs {
  binPath: string;
  biosPath: string;
  moviePath: string;
  outDir: string;
  frames: number;
  shotEvery: number;
  offset: number;
  fastBoot: boolean;
  profile: 'hardware' | 'psxjin';
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
    fastBoot: false,
    profile: 'hardware',
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
      case '--fast-boot': args.fastBoot = true; break;
      case '--profile': args.profile = value === 'psxjin' ? 'psxjin' : 'hardware'; i++; break;
      case '--offset': args.offset = Number(value); i++; break;
      default: break;
    }
  }

  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const movie = parsePjm(new Uint8Array(readFileSync(args.moviePath)));
  mkdirSync(args.outDir, { recursive: true });
  console.log(`movie "${movie.author}" ${movie.serial}: ${movie.frameCount} frames, ${movie.rerecords} rerecords; replaying up to ${args.frames > 0 ? args.frames : movie.frameCount} frames, offset ${args.offset}, profile ${args.profile}`);
  const log = new RingLogger();
  const system = new PsxSystem({ binPath: args.binPath, cuePath: null, log, biosRom: new Uint8Array(readFileSync(args.biosPath)), fastBoot: args.fastBoot, timing: args.profile });
  system.boot();
  const started = performance.now();
  const shellReturn = args.profile === 'psxjin';
  const movieLength = args.frames > 0 ? Math.min(args.frames, movie.frameCount) : movie.frameCount;
  const cursor = new MovieCursor(movie.frames);
  let origin = shellReturn ? null : args.offset;
  system.onExeStart = (): void => {
    if (!shellReturn) {
      return;
    }
    origin = system.frameNumber;
    system.pad.onPoll = (): void => {
      system.pad.buttons = cursor.poll();
    };
    system.onFrameEnd = (): void => {
      cursor.frameEnd();
    };
    console.log(`boot hand-off at system frame ${system.exeStartFrame} (cycle ${system.exeStartCycle}); movie cursor starts here`);
  };
  let ran = 0;
  const bootBudget = 4000;
  for (let step = 0; step < movieLength + bootBudget + args.offset; step++) {
    if (!shellReturn) {
      const index = origin === null ? -1 : step - origin;
      system.pad.buttons = index >= 0 && index < movie.frameCount ? movie.frames[index] : 0;
    }
    system.runFrames(1);
    ran++;
    const movieFrame = shellReturn ? (origin === null ? -1 : cursor.frameIndex) : step - (origin ?? 0);
    if (origin !== null && movieFrame >= movieLength) {
      break;
    }
    const reportAt = args.shotEvery;
    if (origin !== null && movieFrame > 0 && (shellReturn ? movieFrame % reportAt < 1 : (movieFrame + 1) % reportAt === 0)) {
      const frame = system.gpu.present();
      writeFileSync(`${args.outDir}/f${String(movieFrame).padStart(6, '0')}.png`, encodePng(frame.width, frame.height, frame.rgba));
      const msPerFrame = (performance.now() - started) / ran;
      console.log(`movie frame ${movieFrame}/${movieLength} (system ${system.frameNumber}, lag ${cursor.lagFrames.length}) pc=${(system.cpu.pc >>> 0).toString(16)} pad=${system.pad.buttons.toString(16)} ${msPerFrame.toFixed(2)} ms/frame`);
    }
  }
  if (shellReturn) {
    console.log(`lag frames: ${cursor.lagFrames.length}; first 40 at movie index: ${cursor.lagFrames.slice(0, 40).join(',')}`);
  }
  writeFileSync(`${args.outDir}/session.log`, log.dump(4096));
}

main();
