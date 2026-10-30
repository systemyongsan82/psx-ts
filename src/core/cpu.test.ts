import { describe, expect, test } from 'bun:test';
import { CpuR3000A } from './cpu';
import { Gte } from './gte';
import type { CpuDeps, CpuExceptionKind, CpuRegAccess, GteUnit, MemAccess } from './contracts';

const RAM_WORDS = 0x80000;

class RamBus implements MemAccess {
  words = new Uint32Array(RAM_WORDS);

  load8(addr: number): number {
    const a = addr >>> 0;
    const w = this.words[(a & 0x1FFFFF) >>> 2];

    return (w >>> ((a & 3) * 8)) & 0xFF;
  }

  load16(addr: number): number {
    const a = addr >>> 0;
    const w = this.words[(a & 0x1FFFFF) >>> 2];
    if ((a & 2) === 0) {
      return w & 0xFFFF;
    }

    return w >>> 16;
  }

  load32(addr: number): number {
    return this.words[(addr & 0x1FFFFF) >>> 2];
  }

  store8(addr: number, value: number): void {
    const a = addr >>> 0;
    const i = (a & 0x1FFFFF) >>> 2;
    const shift = (a & 3) * 8;
    this.words[i] = ((this.words[i] & ~(0xFF << shift)) | ((value & 0xFF) << shift)) >>> 0;
  }

  store16(addr: number, value: number): void {
    const a = addr >>> 0;
    const i = (a & 0x1FFFFF) >>> 2;
    if ((a & 2) === 0) {
      this.words[i] = ((this.words[i] & 0xFFFF0000) | (value & 0xFFFF)) >>> 0;

      return;
    }
    this.words[i] = ((this.words[i] & 0xFFFF) | ((value & 0xFFFF) << 16)) >>> 0;
  }

  store32(addr: number, value: number): void {
    this.words[(addr & 0x1FFFFF) >>> 2] = value >>> 0;
  }
}

function rtype(funct: number, rs = 0, rt = 0, rd = 0, shamt = 0): number {
  return (rs << 21) | (rt << 16) | (rd << 11) | (shamt << 6) | funct;
}

function itype(op: number, rs: number, rt: number, imm: number): number {
  return (op << 26) | (rs << 21) | (rt << 16) | (imm & 0xFFFF);
}

function jtype(op: number, target: number): number {
  return (op << 26) | ((target >>> 2) & 0x3FFFFFF);
}

function mfc0Word(reg: number, rt: number): number {
  return (0x10 << 26) | (rt << 16) | (reg << 11);
}

function mtc0Word(rt: number, reg: number): number {
  return (0x10 << 26) | (4 << 21) | (rt << 16) | (reg << 11);
}

interface Raise {
  kind: CpuExceptionKind;
  code: number;
  addr: number;
}

const NOP = 0;

function makeDeps(
  bus: MemAccess,
  lines: { n: number },
  raises: Array<Raise>,
  kusers: Array<number>,
  onException?: (kind: CpuExceptionKind, code: number, addr: number, core: CpuRegAccess) => void,
  onKuser?: (pc: number, core: CpuRegAccess) => boolean,
): CpuDeps {
  return {
    bus,
    gte: new Gte(),
    irqCheck: () => lines.n,
    hooks: {
      irqActive: () => lines.n,
      kuserCall: (pc, core) => {
        kusers.push(pc);
        if (onKuser) {
          return onKuser(pc, core);
        }

        return false;
      },
      exception: (kind, code, addr, core) => {
        raises.push({ kind, code, addr });
        onException?.(kind, code, addr, core);
      },
    },
  };
}

function poke(bus: RamBus, addr: number, word: number): void {
  bus.words[(addr & 0x1FFFFF) >>> 2] = word >>> 0;
}

describe('CpuR3000A basics', () => {
  test('jal executes delay slot before target', () => {
    const bus = new RamBus();
    const raises: Array<Raise> = [];
    const kusers: Array<number> = [];
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, raises, kusers));
    poke(bus, 0x200, jtype(0x03, 0x20C));
    poke(bus, 0x204, itype(0x09, 0, 1, 0x555));
    poke(bus, 0x208, NOP);
    poke(bus, 0x20C, rtype(0x21, 1, 0, 2));
    cpu.reset(0x200);
    cpu.run(4);
    expect(cpu.getReg(1)).toBe(0x555);
    expect(cpu.getReg(2)).toBe(0x555);
    expect(cpu.getReg(31)).toBe(0x208);
    expect(cpu.pc).toBe(0x210);
  });

  test('bltzal writes ra even when branch not taken', () => {
    const bus = new RamBus();
    const cpu = new CpuR3000A(
      makeDeps(bus, { n: 0 }, [], []),
    );
    poke(bus, 0x200, itype(0x01, 0, 0x10, 1));
    poke(bus, 0x204, itype(0x09, 0, 1, 0x555));
    poke(bus, 0x208, itype(0x09, 0, 2, 0x111));
    cpu.reset(0x200);
    cpu.run(64);
    expect(cpu.getReg(1)).toBe(0x555);
    expect(cpu.getReg(2)).toBe(0x111);
    expect(cpu.getReg(31)).toBe(0x208);
  });

  test('slt signed vs sltu unsigned compare', () => {
    const bus = new RamBus();
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, [], []));
    poke(bus, 0x200, itype(0x09, 0, 4, -1));
    poke(bus, 0x204, itype(0x0F, 0, 5, 0x8000));
    poke(bus, 0x208, rtype(0x2A, 4, 5, 6));
    poke(bus, 0x20C, rtype(0x2B, 4, 5, 7));
    poke(bus, 0x210, rtype(0x2A, 5, 4, 8));
    cpu.reset(0x200);
    cpu.run(8);
    expect(cpu.getReg(4)).toBe(-1);
    expect(cpu.getReg(5)).toBe(0x80000000 | 0);
    expect(cpu.getReg(6)).toBe(0);
    expect(cpu.getReg(7)).toBe(0);
    expect(cpu.getReg(8)).toBe(1);
  });
});

describe('CpuR3000A unaligned access', () => {
  test('lwl/lwr merge variants', () => {
    const bus = new RamBus();
    const cases: Array<[number, number]> = [
      [itype(0x22, 0, 4, 0x1000), 0x44BBCCDD],
      [itype(0x22, 0, 4, 0x1001), 0x3344CCDD],
      [itype(0x22, 0, 4, 0x1003), 0x11223344],
      [itype(0x26, 0, 4, 0x1000), 0x11223344],
      [itype(0x26, 0, 4, 0x1001), 0xAA112233 | 0],
      [itype(0x26, 0, 4, 0x1003), 0xAABBCC11 | 0],
    ];
    poke(bus, 0x1000, 0x11223344);
    for (const [instr, wanted] of cases) {
      const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, [], []));
      cpu.reset(0x200);
      cpu.setReg(4, 0xAABBCCDD | 0);
      poke(bus, 0x200, instr);
      poke(bus, 0x204, NOP);
      poke(bus, 0x208, NOP);
      cpu.run(16);
      expect(cpu.getReg(4)).toBe(wanted);
    }
  });

  test('unaligned word load via lwr+lwl pair', () => {
    const bus = new RamBus();
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, [], []));
    poke(bus, 0x1000, 0x11223344);
    poke(bus, 0x1004, 0x55667788);
    poke(bus, 0x200, itype(0x26, 0, 6, 0x1001));
    poke(bus, 0x204, itype(0x22, 0, 6, 0x1004));
    poke(bus, 0x208, NOP);
    cpu.reset(0x200);
    cpu.run(16);
    expect(cpu.getReg(6)).toBe(0x88112233 | 0);
  });

  test('swl/swr byte semantics', () => {
    const bus = new RamBus();
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, [], []));
    poke(bus, 0x1000, 0x11223344);
    poke(bus, 0x200, itype(0x2A, 0, 7, 0x1001));
    cpu.reset(0x200);
    cpu.setReg(7, 0xAABBCCDD | 0);
    cpu.run(2);
    expect(bus.words[(0x1000 & 0x1FFFFF) >>> 2]).toBe(0x1122AABB);
    poke(bus, 0x1000, 0x11223344);
    poke(bus, 0x200, itype(0x2E, 0, 7, 0x1001));
    cpu.reset(0x200);
    cpu.setReg(7, 0xAABBCCDD | 0);
    cpu.run(2);
    expect(bus.words[(0x1000 & 0x1FFFFF) >>> 2]).toBe(0xBBCCDD44);
    poke(bus, 0x1000, 0x11223344);
    poke(bus, 0x200, itype(0x2A, 0, 7, 0x1003));
    cpu.reset(0x200);
    cpu.setReg(7, 0xAABBCCDD | 0);
    cpu.run(2);
    expect(bus.words[(0x1000 & 0x1FFFFF) >>> 2]).toBe(0xAABBCCDD);
    poke(bus, 0x1000, 0x11223344);
    poke(bus, 0x200, itype(0x2E, 0, 7, 0x1000));
    cpu.reset(0x200);
    cpu.setReg(7, 0xAABBCCDD | 0);
    cpu.run(2);
    expect(bus.words[(0x1000 & 0x1FFFFF) >>> 2]).toBe(0xAABBCCDD);
  });
});

describe('CpuR3000A multiply divide', () => {
  test('div signed edges', () => {
    const bus = new RamBus();
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, [], []));
    poke(bus, 0x200, rtype(0x1A, 4, 5));
    poke(bus, 0x204, rtype(0x10, 0, 0, 8));
    poke(bus, 0x208, rtype(0x12, 0, 0, 9));
    cpu.reset(0x200);
    cpu.setReg(4, 0x80000000 | 0);
    cpu.setReg(5, -1);
    cpu.run(64);
    expect(cpu.getReg(8)).toBe(0);
    expect(cpu.getReg(9)).toBe(0x80000000 | 0);
    cpu.reset(0x200);
    cpu.setReg(4, 5);
    cpu.setReg(5, 0);
    cpu.run(64);
    expect(cpu.getReg(8)).toBe(5);
    expect(cpu.getReg(9)).toBe(-1);
    cpu.reset(0x200);
    cpu.setReg(4, -5);
    cpu.setReg(5, 0);
    cpu.run(64);
    expect(cpu.getReg(8)).toBe(-5);
    expect(cpu.getReg(9)).toBe(1);
  });

  test('divu by zero', () => {
    const bus = new RamBus();
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, [], []));
    poke(bus, 0x200, rtype(0x1B, 4, 5));
    poke(bus, 0x204, rtype(0x10, 0, 0, 8));
    poke(bus, 0x208, rtype(0x12, 0, 0, 9));
    cpu.reset(0x200);
    cpu.setReg(4, 0x80000000 | 0);
    cpu.setReg(5, 0);
    cpu.run(64);
    expect(cpu.getReg(8)).toBe(0x80000000 | 0);
    expect(cpu.getReg(9)).toBe(-1);
  });

  test('mult exact 64-bit signed', () => {
    const bus = new RamBus();
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, [], []));
    poke(bus, 0x200, rtype(0x18, 4, 5));
    poke(bus, 0x204, rtype(0x10, 0, 0, 8));
    poke(bus, 0x208, rtype(0x12, 0, 0, 9));
    cpu.reset(0x200);
    cpu.setReg(4, 0x12345678 | 0);
    cpu.setReg(5, 0x9ABCDEF0 | 0);
    cpu.run(64);
    expect(cpu.getReg(8)).toBe(-120810538 | 0);
    expect(cpu.getReg(9)).toBe(606937216);
    cpu.reset(0x200);
    cpu.setReg(4, -1);
    cpu.setReg(5, -1);
    cpu.run(64);
    expect(cpu.getReg(8)).toBe(0);
    expect(cpu.getReg(9)).toBe(1);
  });

  test('multu exact 64-bit unsigned', () => {
    const bus = new RamBus();
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, [], []));
    poke(bus, 0x200, rtype(0x19, 4, 5));
    poke(bus, 0x204, rtype(0x10, 0, 0, 8));
    poke(bus, 0x208, rtype(0x12, 0, 0, 9));
    cpu.reset(0x200);
    cpu.setReg(4, -1);
    cpu.setReg(5, -1);
    cpu.run(64);
    expect(cpu.getReg(8)).toBe(-2);
    expect(cpu.getReg(9)).toBe(1);
  });
});

describe('CpuR3000A exceptions and hooks', () => {
  test('syscall code field', () => {
    const bus = new RamBus();
    const raises: Array<Raise> = [];
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, raises, []));
    poke(bus, 0x200, 0x0C | (0x12345 << 6));
    cpu.reset(0x200);
    cpu.run(4);
    expect(raises.length).toBe(1);
    expect(raises[0].kind).toBe('syscall');
    expect(raises[0].code).toBe(0x12345);
    expect(raises[0].addr).toBe(0x200);
  });

  test('break code field', () => {
    const bus = new RamBus();
    const raises: Array<Raise> = [];
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, raises, []));
    poke(bus, 0x200, 0x0D | (0x9 << 6));
    cpu.reset(0x200);
    cpu.run(4);
    expect(raises.length).toBe(1);
    expect(raises[0].kind).toBe('breakpoint');
    expect(raises[0].code).toBe(9);
  });

  test('unaligned lw addressLoad, rd untouched', () => {
    const bus = new RamBus();
    const raises: Array<Raise> = [];
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, raises, []));
    poke(bus, 0x200, itype(0x23, 0, 1, 0x1002));
    poke(bus, 0x1000, 0x11223344);
    cpu.reset(0x200);
    cpu.setReg(1, 7);
    cpu.run(4);
    expect(raises.length).toBe(1);
    expect(raises[0].kind).toBe('addressLoad');
    expect(raises[0].addr).toBe(0x1002);
    expect(cpu.getReg(1)).toBe(7);
  });

  test('unaligned sh addressStore', () => {
    const bus = new RamBus();
    const raises: Array<Raise> = [];
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, raises, []));
    poke(bus, 0x200, itype(0x29, 0, 1, 0x1001));
    cpu.reset(0x200);
    cpu.run(4);
    expect(raises.length).toBe(1);
    expect(raises[0].kind).toBe('addressStore');
    expect(raises[0].addr).toBe(0x1001);
  });

  test('add overflow trap, rd unchanged', () => {
    const bus = new RamBus();
    const raises: Array<Raise> = [];
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, raises, []));
    poke(bus, 0x200, itype(0x0F, 0, 4, 0x7FFF));
    poke(bus, 0x204, itype(0x0D, 4, 4, 0xFFFF));
    poke(bus, 0x208, itype(0x09, 0, 5, 1));
    poke(bus, 0x20C, NOP);
    poke(bus, 0x210, rtype(0x20, 4, 5, 6));
    cpu.reset(0x200);
    cpu.setReg(6, 111);
    cpu.run(64);
    expect(raises.length).toBe(1);
    expect(raises[0].kind).toBe('overflow');
    expect(cpu.getReg(6)).toBe(111);
  });

  test('irq poll skipped inside delay slots', () => {
    const bus = new RamBus();
    const raises: Array<Raise> = [];
    let pollCalls = 0;
    const cpu = new CpuR3000A({
      bus,
      gte: new Gte(),
      irqCheck: () => {
        pollCalls++;

        return pollCalls === 1 ? 0 : 5;
      },
      hooks: {
        irqActive: () => 5,
        kuserCall: () => false,
        exception: (kind, code, addr, core) => {
          raises.push({ kind, code, addr });
          core.setPc(addr + 4);
        },
      },
    });
    poke(bus, 0x300, itype(0x09, 0, 4, 0x401));
    poke(bus, 0x304, mtc0Word(4, 12));
    poke(bus, 0x308, itype(0x04, 0, 0, 1));
    poke(bus, 0x30C, itype(0x09, 0, 1, 0x555));
    poke(bus, 0x310, itype(0x09, 0, 2, 0x111));
    cpu.reset(0x300);
    for (let i = 0; i < 5; i++) {
      cpu.run(100);
    }
    expect(cpu.getReg(1)).toBe(0x555);
    expect(cpu.getReg(2)).toBe(0);
    expect(raises.length).toBeGreaterThanOrEqual(1);
    expect(raises[0].kind).toBe('interrupt');
    expect(raises[0].addr).toBe(0x310);
    expect(raises.some((r) => r.addr === 0x30C)).toBe(false);
    expect(pollCalls).toBeGreaterThanOrEqual(2);
  });

  test('interrupt code carries pending lines mask', () => {
    const bus = new RamBus();
    const raises: Array<Raise> = [];
    const cpu = new CpuR3000A({
      bus,
      gte: new Gte(),
      irqCheck: () => 0x41,
      hooks: {
        irqActive: () => 0x41,
        kuserCall: () => false,
        exception: (kind, code, addr, core) => {
          raises.push({ kind, code, addr });
          core.setSr(core.sr() & ~1);
        },
      },
    });
    poke(bus, 0x300, itype(0x09, 0, 4, 0x401));
    poke(bus, 0x304, mtc0Word(4, 12));
    cpu.reset(0x300);
    cpu.run(64);
    expect(raises.length).toBe(1);
    expect(raises[0].kind).toBe('interrupt');
    expect(raises[0].code).toBe(0x41);
  });

  test('kuser stub entry intercepted on each fresh entry', () => {
    const bus = new RamBus();
    const kusers: Array<number> = [];
    const cpu = new CpuR3000A({
      bus,
      gte: new Gte(),
      irqCheck: () => 0,
      hooks: {
        irqActive: () => 0,
        kuserCall: (pc, core) => {
          kusers.push(pc);
          if (kusers.length === 1) {
            core.setPc(0x400);
          } else {
            core.setPc(0x800);
          }

          return true;
        },
        exception: () => {},
      },
    });
    poke(bus, 0x200, jtype(0x02, 0xA0));
    poke(bus, 0x204, itype(0x09, 0, 1, 7));
    poke(bus, 0x400, jtype(0x02, 0xA0));
    poke(bus, 0x404, itype(0x09, 0, 5, 9));
    poke(bus, 0x800, itype(0x09, 0, 6, 11));
    cpu.reset(0x200);
    cpu.run(64);
    expect(kusers).toEqual([0xA0, 0xA0]);
    expect(cpu.getReg(1)).toBe(7);
    expect(cpu.getReg(6)).toBe(11);
  });

  test('jr to 0xD0 sentinel triggers kuser', () => {
    const bus = new RamBus();
    const kusers: Array<number> = [];
    const cpu = new CpuR3000A({
      bus,
      gte: new Gte(),
      irqCheck: () => 0,
      hooks: {
        irqActive: () => 0,
        kuserCall: (pc, core) => {
          kusers.push(pc);
          core.setPc(0x400);

          return true;
        },
        exception: () => {},
      },
    });
    cpu.reset(0x200);
    cpu.setReg(31, 0xD0);
    poke(bus, 0x200, rtype(0x08, 31));
    cpu.run(16);
    expect(kusers).toEqual([0xD0]);
  });

  test('COP1 raises coprocessorError with CE=1', () => {
    const bus = new RamBus();
    const raises: Array<Raise> = [];
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, raises, []));
    poke(bus, 0x200, 0x44000000);
    cpu.reset(0x200);
    cpu.run(4);
    expect(raises.length).toBe(1);
    expect(raises[0].kind).toBe('coprocessorError');
    expect(raises[0].code).toBe(1);
  });
});

describe('CpuR3000A state', () => {
  test('save/restore roundtrip and determinism', () => {
    const bus = new RamBus();
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, [], []));
    poke(bus, 0x200, itype(0x09, 0, 1, 3));
    poke(bus, 0x204, rtype(0x18, 1, 1));
    poke(bus, 0x208, rtype(0x10, 0, 0, 3));
    poke(bus, 0x20C, itype(0x09, 1, 1, 5));
    poke(bus, 0x210, rtype(0x21, 1, 0, 2));
    cpu.reset(0x200);
    cpu.run(1);
    const snap = cpu.save();
    expect(snap.regs[1]).toBe(3);
    cpu.run(100);
    const pcA = cpu.pc;
    const r2A = cpu.getReg(2);
    const r3A = cpu.getReg(3);
    cpu.restore(snap);
    expect(cpu.pc).toBe(snap.pc);
    expect(cpu.getReg(1)).toBe(3);
    cpu.run(100);
    expect(cpu.pc).toBe(pcA);
    expect(cpu.getReg(3)).toBe(r3A);
    expect(cpu.getReg(2)).toBe(r2A);
  });

  test('mtc0/mfc0 then rfe pops SR bits', () => {
    const bus = new RamBus();
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, [], []));
    poke(bus, 0x300, itype(0x09, 0, 4, 0xF));
    poke(bus, 0x304, mtc0Word(4, 12));
    poke(bus, 0x308, 0x42000010);
    poke(bus, 0x30C, mfc0Word(12, 1));
    cpu.reset(0x300);
    cpu.run(64);
    expect(cpu.getReg(1)).toBe(3);
  });

  test('mfc0 PRID and mtc0-cause sw bits', () => {
    const bus = new RamBus();
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, [], []));
    poke(bus, 0x300, mfc0Word(15, 1));
    poke(bus, 0x304, itype(0x09, 0, 4, 0x300));
    poke(bus, 0x308, mtc0Word(4, 13));
    poke(bus, 0x30C, mfc0Word(13, 2));
    cpu.reset(0x300);
    cpu.run(64);
    expect(cpu.getReg(1)).toBe(2);
    expect(cpu.getReg(2)).toBe(0x300);
  });

  test('load delay slot: value read one instruction later', () => {
    const bus = new RamBus();
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, [], []));
    poke(bus, 0x1000, 0x12345678);
    poke(bus, 0x200, itype(0x23, 0, 4, 0x1000));
    poke(bus, 0x204, rtype(0x21, 4, 0, 9));
    poke(bus, 0x208, rtype(0x21, 4, 0, 10));
    poke(bus, 0x20C, NOP);
    cpu.reset(0x200);
    cpu.run(16);
    expect(cpu.getReg(9)).toBe(0);
    expect(cpu.getReg(10)).toBe(0x12345678 | 0);
  });
});

describe('CpuR3000A perf floor', () => {
  test('bench: 100M loop instructions under 8s', () => {
    const bus = new RamBus();
    const cpu = new CpuR3000A(makeDeps(bus, { n: 0 }, [], []));
    poke(bus, 0x200, itype(0x09, 0, 8, -33333333));
    poke(bus, 0x204, itype(0x09, 8, 8, -1));
    poke(bus, 0x208, itype(0x05, 8, 0, -2));
    poke(bus, 0x20C, NOP);
    cpu.reset(0x200);
    const started = performance.now();
    cpu.run(140000000);
    const ms = performance.now() - started;
    const instructions = 100000000;
    const opsPerSec = (instructions / ms) * 1000;
    console.log(`bench: 100M instrs in ${ms.toFixed(0)}ms, ~${Math.round(opsPerSec / 1e6)}M instr/s`);
    expect(cpu.getReg(8)).toBe(0);
    expect(ms).toBeLessThan(8000);
  }, 30000);
});