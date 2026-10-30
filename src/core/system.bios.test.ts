import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { RingLogger } from './logger';
import { PsxSystem } from './system';

const BIOS_PATH = 'firmwares/scph5501.bin';
const DISC_PATH = "games/Resident Evil - Director's Cut (USA)/Resident Evil - Director's Cut (USA).bin";
const available = existsSync(BIOS_PATH) && existsSync(DISC_PATH);

describe('real BIOS boot', () => {
  test.skipIf(!available)('starts at the reset vector and executes ROM code', () => {
    const system = new PsxSystem({
      binPath: DISC_PATH,
      cuePath: null,
      log: new RingLogger(),
      biosRom: new Uint8Array(readFileSync(BIOS_PATH)),
    });
    system.boot();
    expect(system.cpu.pc).toBe(0xBFC00000);
    system.runFrames(2);
    expect(system.cpu.pc).not.toBe(0xBFC00000);
    expect(system.cpu.halted).toBe(false);
  });
});
