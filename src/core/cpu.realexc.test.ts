import { describe, expect, test } from 'bun:test';
import { CpuR3000A } from './cpu';
import { Gte } from './gte';
import type { CpuDeps, MemAccess } from './contracts';

class WordBus implements MemAccess {
  readonly words = new Uint32Array(0x40000);
  readonly stores: Array<number> = [];

  load8(addr: number): number {
    return (this.words[(addr & 0xFFFFF) >>> 2] >>> ((addr & 3) * 8)) & 0xFF;
  }

  load16(addr: number): number {
    return (this.words[(addr & 0xFFFFF) >>> 2] >>> ((addr & 2) * 8)) & 0xFFFF;
  }

  load32(addr: number): number {
    return this.words[(addr & 0xFFFFF) >>> 2];
  }

  store8(addr: number, value: number): void {
    this.stores.push(addr >>> 0);
    const i = (addr & 0xFFFFF) >>> 2;
    const shift = (addr & 3) * 8;
    this.words[i] = ((this.words[i] & ~(0xFF << shift)) | ((value & 0xFF) << shift)) >>> 0;
  }

  store16(addr: number, value: number): void {
    this.stores.push(addr >>> 0);
    const i = (addr & 0xFFFFF) >>> 2;
    const shift = (addr & 2) * 8;
    this.words[i] = ((this.words[i] & ~(0xFFFF << shift)) | ((value & 0xFFFF) << shift)) >>> 0;
  }

  store32(addr: number, value: number): void {
    this.stores.push(addr >>> 0);
    this.words[(addr & 0xFFFFF) >>> 2] = value >>> 0;
  }
}

const SYSCALL = 0x0C;
const RFE = 0x42000010;
const SW_R1_0_R2 = (0x2B << 26) | (2 << 21) | (1 << 16);
const MTC0_R1_SR = (0x10 << 26) | (4 << 21) | (1 << 16) | (12 << 11);
const ORI_R1 = (0x0D << 26) | (1 << 16);
const LUI_R1 = (0x0F << 26) | (1 << 16);

function makeCpu(bus: WordBus, realExceptions: boolean, hookCalls: Array<string>): CpuR3000A {
  const deps: CpuDeps = {
    bus,
    gte: new Gte(),
    irqCheck: () => 0,
    realExceptions,
    hooks: {
      irqActive: () => 0,
      kuserCall: (pc) => {
        hookCalls.push(`kuser ${pc.toString(16)}`);

        return false;
      },
      exception: (kind) => {
        hookCalls.push(`exception ${kind}`);
      },
    },
  };

  return new CpuR3000A(deps);
}

describe('CpuR3000A real exception vectoring', () => {
  test('syscall vectors to 0x80000080 with EPC, Cause and SR mode stack pushed', () => {
    const bus = new WordBus();
    const hooks: Array<string> = [];
    const cpu = makeCpu(bus, true, hooks);
    bus.words[0x100 >>> 2] = ORI_R1 | 0x0001;
    bus.words[0x104 >>> 2] = MTC0_R1_SR;
    bus.words[0x108 >>> 2] = 0;
    bus.words[0x10C >>> 2] = SYSCALL;
    cpu.reset(0x100);
    cpu.run(8);
    const ctx = cpu.save();
    expect(cpu.pc).toBe(0x80000080);
    expect(ctx.epc).toBe(0x10C);
    expect((ctx.cause >>> 2) & 0x1F).toBe(8);
    expect(ctx.sr & 0x3F).toBe(0x04);
    expect(hooks).toEqual([]);
  });

  test('BEV set vectors to 0xBFC00180', () => {
    const bus = new WordBus();
    const cpu = makeCpu(bus, true, []);
    bus.words[0x100 >>> 2] = SYSCALL;
    cpu.reset(0x100);
    cpu.restore({ ...cpu.save(), sr: 0x00400000 });
    cpu.run(1);
    expect(cpu.pc).toBe(0xBFC00180);
  });

  test('exception in a branch delay slot reports EPC of the branch and BD', () => {
    const bus = new WordBus();
    const cpu = makeCpu(bus, true, []);
    bus.words[0x100 >>> 2] = (0x04 << 26) | 0x0001;
    bus.words[0x104 >>> 2] = SYSCALL;
    cpu.reset(0x100);
    cpu.run(3);
    const ctx = cpu.save();
    expect(ctx.epc).toBe(0x100);
    expect(ctx.cause >>> 31).toBe(1);
  });

  test('rfe pops the KU/IE stack after vectoring', () => {
    const bus = new WordBus();
    const cpu = makeCpu(bus, true, []);
    bus.words[0x100 >>> 2] = SYSCALL;
    cpu.reset(0x100);
    cpu.restore({ ...cpu.save(), sr: 0x1 });
    cpu.run(1);
    expect(cpu.save().sr & 0x3F).toBe(0x04);
    bus.words[0x80 >>> 2] = RFE;
    cpu.run(1);
    expect(cpu.save().sr & 0x3F).toBe(0x01);
  });

  test('a0/b0/c0 stubs are not intercepted in real mode', () => {
    const bus = new WordBus();
    const hooks: Array<string> = [];
    const cpu = makeCpu(bus, true, hooks);
    cpu.reset(0xA0);
    cpu.run(2);
    expect(hooks).toEqual([]);
  });

  test('HLE mode still routes exceptions and stubs to hooks', () => {
    const bus = new WordBus();
    const hooks: Array<string> = [];
    const cpu = makeCpu(bus, false, hooks);
    bus.words[0x100 >>> 2] = SYSCALL;
    cpu.reset(0x100);
    cpu.run(1);
    cpu.reset(0xA0);
    cpu.run(1);
    expect(hooks).toEqual(['exception syscall', 'kuser a0']);
  });
});

describe('CpuR3000A cache isolation', () => {
  const program = (bus: WordBus): void => {
    bus.words[0x100 >>> 2] = LUI_R1 | 0x0001;
    bus.words[0x104 >>> 2] = MTC0_R1_SR;
    bus.words[0x108 >>> 2] = 0;
    bus.words[0x10C >>> 2] = SW_R1_0_R2;
  };

  test('stores are dropped while SR.IsC is set in real mode', () => {
    const bus = new WordBus();
    program(bus);
    const cpu = makeCpu(bus, true, []);
    cpu.reset(0x100);
    cpu.run(6);
    expect(bus.stores).toEqual([]);
  });

  test('stores reach the bus again after IsC is cleared', () => {
    const bus = new WordBus();
    program(bus);
    bus.words[0x110 >>> 2] = (0x0F << 26) | (1 << 16);
    bus.words[0x114 >>> 2] = MTC0_R1_SR;
    bus.words[0x118 >>> 2] = 0;
    bus.words[0x11C >>> 2] = SW_R1_0_R2;
    const cpu = makeCpu(bus, true, []);
    cpu.reset(0x100);
    cpu.run(30);
    expect(bus.stores.length).toBe(1);
  });
});
