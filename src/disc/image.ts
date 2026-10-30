import { openSync, readSync, closeSync, statSync } from 'node:fs';
import type { Logger, RawSectorIo } from '../core/contracts';

const SECTOR_SIZE = 2352;
const SYNC_PATTERN = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

function matchesSync(dst: Uint8Array, off: number): boolean {
  for (let i = 0; i < 12; i++) {
    if (dst[off + i] !== SYNC_PATTERN[i]) {
      return false;
    }
  }

  return true;
}

export class PsxBinImage implements RawSectorIo {
  readonly totalSectors: number;
  readonly baseOffset: number;
  private readonly fd: number;

  constructor(binPath: string, log: Logger) {
    this.fd = openSync(binPath, 'r');
    const size = statSync(binPath).size;
    this.totalSectors = Math.floor(size / SECTOR_SIZE);

    const first = new Uint8Array(SECTOR_SIZE);
    readSync(this.fd, first, 0, SECTOR_SIZE, 0);
    this.baseOffset = detectBaseOffset(first);
    log.debug('disc', `image ${binPath}: ${this.totalSectors} sectors, LBA0 at file sector ${this.baseOffset}`);
  }

  readRawSectors(startLba: number, count: number, dst: Uint8Array): boolean {
    const fileSector = startLba + this.baseOffset;
    if (startLba < 0 || count <= 0 || fileSector + count > this.baseOffset + this.totalSectors) {
      return false;
    }
    const need = SECTOR_SIZE * count;
    if (dst.length < need) {
      return false;
    }
    const got = readSync(this.fd, dst, 0, need, fileSector * SECTOR_SIZE);
    return got === need;
  }

  close(): void {
    closeSync(this.fd);
  }
}

export function detectBaseOffset(firstSector: Uint8Array): number {
  const probe = (fileSector: number): number | null => {
    if (!matchesSync(firstSector, fileSector * SECTOR_SIZE)) {
      return null;
    }
    const off = fileSector * SECTOR_SIZE;
    const min = firstSector[off + 12];
    const sec = firstSector[off + 13];
    const frm = firstSector[off + 14];

    return min * 75 * 60 + sec * 75 + frm;
  };

  const at0 = probe(0);
  if (at0 === 150) {
    return 0;
  }

  return 150;
}

export type SectorKind = 'mode2form1' | 'mode2form2' | 'unknown';

export function detectSectorKind(raw: Uint8Array, offset: number): SectorKind {
  if (raw[offset + 15] !== 2) {
    return 'unknown';
  }
  const submode = raw[offset + 18];
  if ((submode & 0x20) !== 0) {
    return 'mode2form2';
  }

  return 'mode2form1';
}