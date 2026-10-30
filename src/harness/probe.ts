import { RingLogger } from '../core/logger';
import { PsxSystem } from '../core/system';

const sys = new PsxSystem({ binPath: 'games/Resident Evil (USA)/Resident Evil (USA).bin', cuePath: null, log: new RingLogger() });
sys.boot();

const ring: Array<number> = [];
let lastGood = 0;
const chunks = 6000;
for (let c = 0; c < chunks; c++) {
  sys.runCycles(2_000);
  const pc = sys.cpu.pc >>> 0;
  const okRange = (pc >= 0x80010000 && pc < 0x800b0000) || (pc & 0x1fffffff) < 0x100;
  if (!okRange) {
    console.log(`cycle ${(c + 1) * 2_000}: pc 0x${pc.toString(16)} last good 0x${lastGood.toString(16)}`);
    console.log('ring:', ring.slice(-24).map((v) => v.toString(16)).join(' '));
    console.log(`regs: ra=0x${(sys.cpu.getReg(31) >>> 0).toString(16)} sp=0x${(sys.cpu.getReg(29) >>> 0).toString(16)} v0=0x${(sys.cpu.getReg(2) >>> 0).toString(16)} v1=0x${(sys.cpu.getReg(3) >>> 0).toString(16)}`);
    break;
  }
  ring.push(pc);
  lastGood = pc;
}
console.log('syscalls in log tail:', sys.log.dump(6));