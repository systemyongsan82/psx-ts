import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { CYCLES_PER_LINE, FRAME_CYCLES } from './contracts';
import { returnFromShell, SHELL_ENTRY_PC } from './fastboot';
import { RingLogger } from './logger';
import { HARDWARE_PROFILE, PSXJIN_PROFILE, lineDelayCycles, profileFor } from './timingProfile';
import { PsxSystem } from './system';

describe('timing profiles', () => {
  test('the hardware profile keeps the existing frame and line geometry', () => {
    expect(HARDWARE_PROFILE.frameCycles).toBe(FRAME_CYCLES);
    expect(lineDelayCycles(HARDWARE_PROFILE, 5, CYCLES_PER_LINE)).toBe(CYCLES_PER_LINE);
    expect(profileFor(undefined)).toBe(HARDWARE_PROFILE);
    expect(HARDWARE_PROFILE.unitInstructionCycles).toBe(false);
    expect(HARDWARE_PROFILE.secondMemoryCard).toBe(false);
  });

  test('the psxjin profile uses PSXCLK/60/BIAS frames, 262 lines, VBlank at line 240', () => {
    expect(PSXJIN_PROFILE.frameCycles).toBe(Math.floor(33_868_800 / 60 / 2));
    expect(PSXJIN_PROFILE.linesPerFrame).toBe(262);
    expect(PSXJIN_PROFILE.vblankLine).toBe(240);
    expect(PSXJIN_PROFILE.unitInstructionCycles).toBe(true);
    expect(PSXJIN_PROFILE.secondMemoryCard).toBe(true);
    expect(PSXJIN_PROFILE.returnFromShell).toBe(true);
  });

  test('psxjin line delays add up to exactly one frame', () => {
    let sum = 0;
    for (let line = 0; line < PSXJIN_PROFILE.linesPerFrame; line++) {
      sum += lineDelayCycles(PSXJIN_PROFILE, line, CYCLES_PER_LINE);
    }
    expect(sum).toBe(PSXJIN_PROFILE.frameCycles);
  });

  test('psxjin CD latencies match PSXjin: 0x800 responses, no seek time, cdReadTime sectors', () => {
    const cd = PSXJIN_PROFILE.cd;
    expect(cd.firstResponse).toBe(0x800);
    expect(cd.secondResponse).toBe(0x800);
    expect(cd.pauseSecond).toBe(0x800);
    expect(cd.initSecond).toBe(0x800);
    expect(cd.getIdSecond).toBe(0x800);
    expect(cd.pauseFirst).toBe(0x40000);
    expect(cd.sectorCycles).toBe(225_792);
    expect(cd.fixedSeekCycles).toBe(0x800);
    expect(PSXJIN_PROFILE.sio.byteCycles).toBe(200);
  });
});

describe('shell return', () => {
  test('continues at ra and clears the delay slot state', () => {
    const regs = Array.from({ length: 32 }, () => 0);
    regs[31] = 0x8004_1234 | 0;
    const ctx = returnFromShell({
      pc: SHELL_ENTRY_PC,
      nextPc: SHELL_ENTRY_PC + 4,
      regs,
      hi: 0,
      lo: 0,
      sr: 0x401,
      cause: 0,
      epc: 0,
      branchDelay: true,
      branchTarget: 5,
    });
    expect(ctx.pc).toBe(0x8004_1234);
    expect(ctx.nextPc).toBe(0x8004_1238);
    expect(ctx.branchDelay).toBe(false);
    expect(ctx.sr).toBe(0x401);
  });
});

const BIOS_PATH = 'firmwares/scph5501.bin';
const DISC_PATH = "games/Resident Evil - Director's Cut (USA)/Resident Evil - Director's Cut (USA).bin";

describe('psxjin profile on the real BIOS', () => {
  test.skipIf(!(existsSync(BIOS_PATH) && existsSync(DISC_PATH)))('returns from the shell, runs the BIOS CD path and keeps frames 282,240 cycles long', () => {
    const system = new PsxSystem({
      binPath: DISC_PATH,
      cuePath: null,
      log: new RingLogger(),
      biosRom: new Uint8Array(readFileSync(BIOS_PATH)),
      timing: 'psxjin',
    });
    let handoffs = 0;
    system.onExeStart = (): void => {
      handoffs += 1;
    };
    system.boot();
    const before = system.sched.now;
    system.runFrames(1);
    expect(system.sched.now - before).toBeGreaterThanOrEqual(PSXJIN_PROFILE.frameCycles);
    expect(system.sched.now - before).toBeLessThan(PSXJIN_PROFILE.frameCycles + 64);
    system.runFrames(30);
    expect(handoffs).toBe(1);
    expect(system.exeStartFrame).not.toBeNull();
    expect(system.exeStartFrame).toBe(9);
  });

  test('refuses the psxjin profile without a BIOS ROM', () => {
    expect(() => new PsxSystem({ binPath: DISC_PATH, cuePath: null, log: new RingLogger(), timing: 'psxjin' })).toThrow();
  });
});
