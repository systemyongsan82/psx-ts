import { test, expect } from 'bun:test';
import { PsxBinImage } from './image';
import { IsoImage, readEntryBytes } from './iso9660';
import { parsePsExe, planExeLoad } from './psxexe';
import { RingLogger } from '../core/logger';

const BIN = 'Resident Evil (USA)/Resident Evil (USA).bin';

test('image detects starting at LBA 0', () => {
  const log = new RingLogger();
  const img = new PsxBinImage(BIN, log);
  expect(img.baseOffset).toBe(0);
  expect(img.totalSectors).toBeGreaterThan(280000);
  img.close();
});

test('iso9660 finds the boot exe and SYSTEM.CNF', () => {
  const log = new RingLogger();
  const img = new PsxBinImage(BIN, log);
  const iso = new IsoImage(img, log);
  const cnf = iso.find('SYSTEM.CNF');
  expect(cnf).not.toBeNull();
  const cnfText = Buffer.from(readEntryBytes(img, cnf!.lba, 0, cnf!.size)).toString('latin1');
  expect(cnfText).toContain('SLUS_001.70');
  const exe = iso.find('SLUS_001.70');
  expect(exe).not.toBeNull();
  expect(exe!.size).toBe(653312);
  img.close();
});

test('ps-exe parses RE boot exe with the t_size=0 quirk', () => {
  const log = new RingLogger();
  const img = new PsxBinImage(BIN, log);
  const iso = new IsoImage(img, log);
  const exe = iso.find('SLUS_001.70');
  const bytes = readEntryBytes(img, exe!.lba, 0, 2048);
  const info = parsePsExe(new Uint8Array([...bytes, ...new Array(0)]));
  expect(info.textAddr).toBe(0x8005f8a0);
  expect(info.textSize).toBe(0);
  expect(info.dataAddr).toBe(0x80010000);
  expect(info.dataSize).toBe(0x0009f000);
  const plan = planExeLoad(info);
  expect(plan.entry).toBe(0x8005f8a0);
  expect(plan.loads[0]!.addr).toBe(0x80010000);
  expect(plan.loads[0]!.size).toBe(0x0009f000);
  img.close();
});