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

  const textAddr = u32(file, 0x10);
  const textSize = u32(file, 0x14);
  const dataAddr = u32(file, 0x18);
  const dataSize = u32(file, 0x1c);
  const bssAddr = u32(file, 0x20);
  const bssSize = u32(file, 0x24);
  const pcField = u32(file, 0x28);
  const gp = u32(file, 0x2c);

  const payload = file.slice(HEADER_SIZE);
  const entry = pcField !== 0 ? pcField : textAddr;

  return {
    magic: MAGIC,
    textAddr,
    textSize,
    dataAddr,
    dataSize,
    bssAddr,
    bssSize,
    pc: entry,
    gp,
    payload,
  };
}

export interface ExeLoadPlan {
  readonly loads: Array<{ addr: number; offset: number; size: number }>;
  readonly bss: Array<{ addr: number; size: number }>;
  readonly entry: number;
}

export function planExeLoad(exe: PsExeInfo): ExeLoadPlan {
  const loads: Array<{ addr: number; offset: number; size: number }> = [];
  let payloadOffset = 0;
  if (exe.textSize > 0) {
    loads.push({ addr: exe.textAddr, offset: payloadOffset, size: exe.textSize });
    payloadOffset += exe.textSize;
  }
  if (exe.dataSize > 0) {
    loads.push({ addr: exe.dataAddr, offset: payloadOffset, size: exe.dataSize });
    payloadOffset += exe.dataSize;
  }
  const bss = exe.bssSize > 0 ? [{ addr: exe.bssAddr, size: exe.bssSize }] : [];

  return { loads, bss, entry: exe.pc };
}