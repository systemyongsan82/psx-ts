import { RingLogger } from '../core/logger';
import { PsxSystem } from '../core/system';

const binPath = process.argv[2] ?? 'test-discs/nortis.bin';
const sys = new PsxSystem({ binPath, cuePath: null, log: new RingLogger() });
sys.boot();

const ring: Array<number> = [];
const isStubPc = (pc: number): boolean => {
  const p = (pc & 0x1fffffff) >>> 0;

  return (p >= 0xa0 && p <= 0xd4) || (p >= 0x200 && p < 0x800);
};
let escaped = false;
for (let step = 0; step < 20_000_000 && !escaped; step++) {
  const pc = sys.cpu.pc >>> 0;
  const phys = (pc & 0x1fffffff) >>> 0;
  ring.push(pc);
  if (ring.length > 48) {
    ring.shift();
  }
  if (!isStubPc(pc) && phys < 0x10000) {
    escaped = true;
    console.log(`step ${step}: pc 0x${pc.toString(16)}`);
    console.log('ring:', ring.map((v) => v.toString(16)).join(' '));
    const r = (i: number): string => (sys.cpu.getReg(i) >>> 0).toString(16);
    console.log(`ra=${r(31)} sp=${r(29)} v0=${r(2)} a0=${r(4)} t9=${r(25)}`);
    break;
  }
  const used = sys.cpu.run(1);
  sys.sched.advance(Math.max(1, used));
}
if (!escaped) {
  console.log('no escape; final pc', (sys.cpu.pc >>> 0).toString(16));
}
