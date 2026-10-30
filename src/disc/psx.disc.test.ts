import { test, expect } from 'bun:test';
import { PsxBinImage } from './image';
import { IsoImage, readEntryBytes } from './iso9660';
import { parsePsExe, planExeLoad } from './psxexe';
import { RingLogger } from '../core/logger';

const BIN = 'games/Resident Evil (USA)/Resident Evil (USA).bin';

test('image detects starting at LBA 0', () => {
  const log = new RingLogger();
  const img = new PsxBinImage(BIN, log);
  expect(img.baseOffset).toBe(0);
  expect(img.totalSectors).toBeGreaterThan(280000);
  img.close();
});

test('sector classification per nocash submode semantics', () => {
  const log = new RingLogger();
  const img = new PsxBinImage(BIN, log);
  const dir = new Uint8Array(2352);
  img.readRawSectors(270719, 1, dir);
  expect(dir[15]).toBe(2);
  expect(dir[18] & 0x20).toBe(0);
  const xa = new Uint8Array(2352);
  img.readRawSectors(11430, 1, xa);
  expect((xa[18] & 0x20) !== 0).toBe(true);
  expect((xa[18] & 0x04) !== 0).toBe(true);
  expect((xa[18] & 0x40) !== 0).toBe(true);
  img.close();
});

test('iso9660 finds the boot exe and SYSTEM.CNF', () => {
  const log = new RingLogger();
  const img = new PsxBinImage(BIN, log);
  const iso = new IsoImage(img, log);
  const cnf = iso.find('SYSTEM.CNF');
  if (cnf === null) {
    throw new Error('SYSTEM.CNF not found in ISO9660');
  }
  expect(cnf.size).toBe(69);
  const cnfText = Buffer.from(readEntryBytes(img, cnf.lba, 0, cnf.size)).toString('latin1');
  expect(cnfText).toContain('SLUS_001.70');
  const exe = iso.find('SLUS_001.70');
  if (exe === null) {
    throw new Error('SLUS_001.70 not found in ISO9660');
  }
  expect(exe.size).toBe(653312);
  img.close();
});

test('ps-exe parses RE boot exe per nocash field map', () => {
  const log = new RingLogger();
  const img = new PsxBinImage(BIN, log);
  const iso = new IsoImage(img, log);
  const exe = iso.find('SLUS_001.70');
  if (exe === null) {
    throw new Error('SLUS_001.70 not found');
  }
  const bytes = readEntryBytes(img, exe.lba, 0, exe.size);
  const info = parsePsExe(bytes);
  expect(info.entryPc).toBe(0x8005f8a0);
  expect(info.gp).toBe(0);
  expect(info.loadAddr).toBe(0x80010000);
  expect(info.loadSize).toBe(0x0009f000);
  expect(info.memfillSize).toBe(0);
  expect(info.spBase).toBe(0x801ffff0);
  const plan = planExeLoad(info);
  expect(plan.entryPc).toBe(0x8005f8a0);
  expect(plan.loadAddr).toBe(0x80010000);
  expect(plan.loadSize).toBe(0x0009f000);
  expect(info.payload.length).toBe(651264);
  img.close();
});