import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import type { CpuContext } from './contracts';
import { SHELL_ENTRY_PC, applyExeHandoff } from './fastboot';
import { RingLogger } from './logger';
import { PsxSystem } from './system';

function baseContext(): CpuContext {
  return {
    pc: SHELL_ENTRY_PC,
    nextPc: SHELL_ENTRY_PC + 4,
    regs: Array.from({ length: 32 }, (_, i) => 0x1000 + i),
    hi: 7,
    lo: 9,
    sr: 0x401,
    cause: 0,
    epc: 0,
    branchDelay: true,
    branchTarget: 0x1234,
  };
}

describe('exe handoff register setup', () => {
  test('jumps to the entry, sets gp and a0/a1, and uses sp from the header', () => {
    const ctx = applyExeHandoff(baseContext(), { entryPc: 0x8005ef34, gp: 0x800ae090, sp: 0x801fff00 });
    expect(ctx.pc).toBe(0x8005ef34);
    expect(ctx.nextPc).toBe(0x8005ef38);
    expect(ctx.regs[28] >>> 0).toBe(0x800ae090);
    expect(ctx.regs[29] >>> 0).toBe(0x801fff00);
    expect(ctx.regs[30] >>> 0).toBe(0x801fff00);
    expect(ctx.regs[4]).toBe(1);
    expect(ctx.regs[5]).toBe(0);
    expect(ctx.branchDelay).toBe(false);
  });

  test('keeps the BIOS stack when the header has no stack address', () => {
    const before = baseContext();
    const ctx = applyExeHandoff(before, { entryPc: 0x80010000, gp: 0, sp: null });
    expect(ctx.regs[29]).toBe(before.regs[29]);
    expect(ctx.regs[30]).toBe(before.regs[30]);
    expect(ctx.sr).toBe(before.sr);
  });
});

const BIOS_PATH = 'firmwares/scph5501.bin';
const DISC_PATH = "games/Resident Evil - Director's Cut (USA)/Resident Evil - Director's Cut (USA).bin";

describe('fast boot with the real BIOS', () => {
  test.skipIf(!(existsSync(BIOS_PATH) && existsSync(DISC_PATH)))('hands off to the disc exe within a few frames', () => {
    const system = new PsxSystem({
      binPath: DISC_PATH,
      cuePath: null,
      log: new RingLogger(),
      biosRom: new Uint8Array(readFileSync(BIOS_PATH)),
      fastBoot: true,
    });
    system.boot();
    expect(system.exeStartFrame).toBeNull();
    system.runFrames(20);
    expect(system.exeStartFrame).not.toBeNull();
    expect(system.exeStartFrame ?? 99).toBeLessThan(20);
    expect((system.cpu.pc >>> 0)).toBeGreaterThanOrEqual(0x80010000);
  });
});
