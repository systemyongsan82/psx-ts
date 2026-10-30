import { PsxBinImage, detectSectorKind } from './image';
import { RingLogger } from '../core/logger';

const BIN = 'Resident Evil (USA)/Resident Evil (USA).bin';
const log = new RingLogger();
const img = new PsxBinImage(BIN, log);
const raw = new Uint8Array(80 * 2352);

const hexOf = (b: Uint8Array, off: number, n: number): string => Array.from(b.slice(off, off + n)).map((x) => x.toString(16).padStart(2, '0')).join(' ');

img.readRawSectors(271039 + 512, 1, raw);
console.log('ZNULL@1MB msf:', hexOf(raw, 12, 3), 'mode', raw[15].toString(16), 'sub', hexOf(raw, 16, 8), 'kind', detectSectorKind(raw, 0));
console.log('ZNULL@1MB user[0..16]:', hexOf(raw, 24, 16));

img.readRawSectors(271039 + 2048, 1, raw);
console.log('ZNULL@4MB msf:', hexOf(raw, 12, 3), 'mode', raw[15].toString(16), 'sub', hexOf(raw, 16, 8), 'kind', detectSectorKind(raw, 0));
console.log('ZNULL@4MB user[0..16]:', hexOf(raw, 24, 16));

img.readRawSectors(11430 + 5, 1, raw);
console.log('xa@11435 msf:', hexOf(raw, 12, 3), 'mode', raw[15].toString(16), 'sub', hexOf(raw, 16, 8), 'kind', detectSectorKind(raw, 0));

img.readRawSectors(11500, 1, raw);
console.log('xa@11500 msf:', hexOf(raw, 12, 3), 'mode', raw[15].toString(16), 'sub', hexOf(raw, 16, 8), 'kind', detectSectorKind(raw, 0));

const kinds = { f1: 0, f2: 0, unk: 0 };
for (let lba = 11430; lba < 270000; lba += 1000) {
  img.readRawSectors(lba, 1, raw);
  const k = detectSectorKind(raw, 0);
  if (k === 'mode2form1') kinds.f1++; else if (k === 'mode2form2') kinds.f2++; else kinds.unk++;
}
console.log('kinds sampled every 1000 in xa range:', kinds);

const audioSubs = new Set<string>();
for (let lba = 11430; lba < 12000; lba++) {
  img.readRawSectors(lba, 1, raw);
  if (raw[15] === 2 && (raw[18] & 0x04) !== 0) {
    audioSubs.add(`${raw[16].toString(16)}:${raw[17].toString(16)}:${raw[18].toString(16)}:${raw[19].toString(16)}`);
  }
}
console.log('audio 11430..12000 subheader set:', Array.from(audioSubs).sort().join(' | '));

const form2DataSubs = new Set<string>();
for (let lba = 11430; lba < 12000; lba++) {
  img.readRawSectors(lba, 1, raw);
  if (raw[15] === 2 && (raw[18] & 0x08) !== 0 && (raw[18] & 0x20) !== 0) {
    form2DataSubs.add(`${raw[16].toString(16)}:${raw[17].toString(16)}:${raw[18].toString(16)}:${raw[19].toString(16)}`);
  }
}
console.log('form2-with-data-bit 11430..12000:', Array.from(form2DataSubs).sort().join(' | '));
img.close();