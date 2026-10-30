import type { PsExeInfo } from '../core/contracts';

const MAGIC = 'PS-X EXE';
const HEADER_SIZE = 2048;

function u32(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

export function parsePsExe(file: Uint8Array): PsExeInfo {
  let magicAcc = '';
  for (let i = 0; i < 8; i++) {
    magicAcc += String.fromCharCode(file[i]);
  }
  if (magicAcc !== MAGIC) {
    throw new Error(`not a PS-EXE (magic ${JSON.stringify(magicAcc)})`);
  }

  return {
    magic: MAGIC,
    entryPc: u32(file, 0x10),
    gp: u32(file, 0x14),
    loadAddr: u32(file, 0x18),
    loadSize: u32(file, 0x1c),
    memfillAddr: u32(file, 0x28),
    memfillSize: u32(file, 0x2c),
    spBase: u32(file, 0x30),
    spOffset: u32(file, 0x34),
    payload: file.slice(HEADER_SIZE),
  };
}

export interface ExeLoadPlan {
  readonly loadAddr: number;
  readonly loadSize: number;
  readonly memfillAddr: number;
  readonly memfillSize: number;
  readonly entryPc: number;
}

export function planExeLoad(exe: PsExeInfo): ExeLoadPlan {
  return {
    loadAddr: exe.loadAddr,
    loadSize: exe.loadSize,
    memfillAddr: exe.memfillAddr,
    memfillSize: exe.memfillSize,
    entryPc: exe.entryPc,
  };
}