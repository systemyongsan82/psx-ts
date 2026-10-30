import { ramWriteWord } from '../ram';
import {
  CMDLINE_ADDR,
  C_SENTINEL_BASE,
  C_SENTINEL_COUNT,
  C_SENTINEL_STRIDE,
  B_SENTINEL_BASE,
  B_SENTINEL_COUNT,
  B_SENTINEL_STRIDE,
  DEV_STRINGS_ADDR,
  DCB_ADDR,
  DCB_COUNT,
  DCB_SIZE,
  EVCB_ADDR,
  EVCB_SIZE,
  EXCB_ADDR,
  EXCB_COUNT,
  EXCB_SIZE,
  EXC_HANDLER,
  FCB_ADDR,
  FCB_COUNT,
  FCB_SIZE,
  JUMP_A_BASE,
  JUMP_A_COUNT,
  JUMP_A_SLOT,
  PCB_ADDR,
  PCB_SIZE,
  RAM_MASK,
  TCB_ADDR,
  TOT_ADDR,
  VEC_A,
  VEC_B,
  VEC_C,
  VEC_RET,
} from './layout';

const J_RET = 0x0800_0038;
const JR_RA = 0x03E0_0008;

const GARBLE_WORDS = [0x0000_0003, 0x275A_0C80, 0x0340_0008, 0x0000_0000];
const EXC_HANDLER_WORDS = [0x3C1A_0000, 0x275A_0C80, 0x0340_0008, 0x0000_0000];

interface DeviceSpec {
  readonly name: string;
  readonly flags: number;
  readonly sector: number;
}

const DEV_SPECS: Array<DeviceSpec> = [
  { name: 'cdrom', flags: 0x14, sector: 0x800 },
  { name: 'bu', flags: 0x14, sector: 0x80 },
  { name: 'tty', flags: 0x01, sector: 0x01 },
];

const DCB_FIELD_INIT = 0x10;
const DCB_FIELD_OPEN = 0x14;
const DCB_FIELD_CLOSE = 0x1C;
const DCB_FIELD_READ = 0x24;
const DCB_FIELD_FIRSTFILE = 0x34;
const DCB_FIELD_NEXTFILE = 0x38;
const DCB_FIELD_CHDIR = 0x40;

export interface KernelCounts {
  readonly evcbCount: number;
  readonly tcbCount: number;
}

export function writeKernelImage(ram: Uint32Array, counts: KernelCounts): void {
  writeStub(ram, VEC_A, JR_RA);
  writeStub(ram, VEC_B, JR_RA);
  writeStub(ram, VEC_C, JR_RA);
  writeStub(ram, VEC_RET, J_RET);
  writeStub(ram, EXC_HANDLER, JR_RA);

  writeWords(ram, 0x0000, GARBLE_WORDS);
  writeWords(ram, EXC_HANDLER, EXC_HANDLER_WORDS);

  writeTot(ram, counts);
  fillBytes(ram, CMDLINE_ADDR, 0x80, 0);

  for (let fn = 0; fn < JUMP_A_COUNT; fn++) {
    const slot = JUMP_A_BASE + fn * JUMP_A_SLOT;
    ramWriteWord(ram, slot, slot);
    ramWriteWord(ram, slot + 4, JR_RA);
  }
  for (let fn = 0; fn < B_SENTINEL_COUNT; fn++) {
    const at = B_SENTINEL_BASE + fn * B_SENTINEL_STRIDE;
    ramWriteWord(ram, at, at);
    ramWriteWord(ram, at + 4, JR_RA);
  }
  for (let fn = 0; fn < C_SENTINEL_COUNT; fn++) {
    const at = C_SENTINEL_BASE + fn * C_SENTINEL_STRIDE;
    ramWriteWord(ram, at, at);
    ramWriteWord(ram, at + 4, JR_RA);
  }

  writeDeviceStrings(ram);
  writeDcbDefaults(ram);

  for (let fd = 0; fd < FCB_COUNT; fd++) {
    fillWords(ram, FCB_ADDR + fd * FCB_SIZE, FCB_SIZE / 4, 0);
  }
  fillWords(ram, EXCB_ADDR, (EXCB_COUNT * EXCB_SIZE) / 4, 0);
  ramWriteWord(ram, PCB_ADDR, TCB_ADDR);
  ramWriteWord(ram, PCB_ADDR + 4, 0);
}

export function installExceptionHandlerStubs(ram: Uint32Array): void {
  writeStub(ram, EXC_HANDLER, JR_RA);
  writeStub(ram, 0x0000_0000, JR_RA);
}

function writeWords(ram: Uint32Array, addr: number, words: Array<number>): void {
  for (let i = 0; i < words.length; i++) {
    ramWriteWord(ram, addr + i * 4, words[i]);
  }
}

function fillWords(ram: Uint32Array, addr: number, count: number, value: number): void {
  for (let i = 0; i < count; i++) {
    ramWriteWord(ram, addr + i * 4, value);
  }
}

function fillBytes(ram: Uint32Array, addr: number, length: number, value: number): void {
  for (let i = 0; i < length; i++) {
    writeByte(ram, addr + i, value);
  }
}

function writeByte(ram: Uint32Array, addr: number, value: number): void {
  const a = addr & RAM_MASK;
  const shift = (a & 3) * 8;
  const keep = 0xFFFFFFFF ^ (0xFF << shift);

  ram[a >>> 2] = (ram[a >>> 2] & keep) | ((value & 0xFF) << shift);
}

function writeStub(ram: Uint32Array, base: number, jumpWord: number): void {
  ramWriteWord(ram, base, jumpWord);
  ramWriteWord(ram, base + 4, 0);
  ramWriteWord(ram, base + 8, 0);
  ramWriteWord(ram, base + 12, 0);
}

function writeTot(ram: Uint32Array, counts: KernelCounts): void {
  fillWords(ram, TOT_ADDR, 0x58 / 4, 0);
  ramWriteWord(ram, TOT_ADDR + 0x00, EXCB_ADDR);
  ramWriteWord(ram, TOT_ADDR + 0x04, EXCB_COUNT * EXCB_SIZE);
  ramWriteWord(ram, TOT_ADDR + 0x08, PCB_ADDR);
  ramWriteWord(ram, TOT_ADDR + 0x0C, PCB_SIZE);
  ramWriteWord(ram, TOT_ADDR + 0x10, TCB_ADDR);
  ramWriteWord(ram, TOT_ADDR + 0x14, counts.tcbCount * 0xC0);
  ramWriteWord(ram, TOT_ADDR + 0x20, EVCB_ADDR);
  ramWriteWord(ram, TOT_ADDR + 0x24, counts.evcbCount * EVCB_SIZE);
  ramWriteWord(ram, TOT_ADDR + 0x40, FCB_ADDR);
  ramWriteWord(ram, TOT_ADDR + 0x44, FCB_COUNT * FCB_SIZE);
  ramWriteWord(ram, TOT_ADDR + 0x50, DCB_ADDR);
  ramWriteWord(ram, TOT_ADDR + 0x54, DCB_COUNT * DCB_SIZE);
}

function writeByteString(ram: Uint32Array, addr: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    writeByte(ram, addr + i, text.charCodeAt(i));
  }
  writeByte(ram, addr + text.length, 0);
}

function writeDeviceStrings(ram: Uint32Array): void {
  let at = DEV_STRINGS_ADDR;
  for (const dev of DEV_SPECS) {
    writeByteString(ram, at, dev.name);
    at += 8;
  }
}

function writeDcbDefaults(ram: Uint32Array): void {
  let strAddr = DEV_STRINGS_ADDR;
  for (let i = 0; i < DEV_SPECS.length; i++) {
    const dev = DEV_SPECS[i];
    const base = DCB_ADDR + i * DCB_SIZE;
    ramWriteWord(ram, base, strAddr);
    ramWriteWord(ram, base + 4, dev.flags);
    ramWriteWord(ram, base + 8, dev.sector);
    ramWriteWord(ram, base + 12, strAddr);
    strAddr += 8;
  }

  const cdromBase = DCB_ADDR;
  ramWriteWord(ram, cdromBase + DCB_FIELD_OPEN, B_SENTINEL_BASE + 0x5F * B_SENTINEL_STRIDE);
  ramWriteWord(ram, cdromBase + DCB_FIELD_CLOSE, B_SENTINEL_BASE + 0x61 * B_SENTINEL_STRIDE);
  ramWriteWord(ram, cdromBase + DCB_FIELD_READ, B_SENTINEL_BASE + 0x60 * B_SENTINEL_STRIDE);
  ramWriteWord(ram, cdromBase + DCB_FIELD_FIRSTFILE, B_SENTINEL_BASE + 0x62 * B_SENTINEL_STRIDE);
  ramWriteWord(ram, cdromBase + DCB_FIELD_NEXTFILE, B_SENTINEL_BASE + 0x63 * B_SENTINEL_STRIDE);
  ramWriteWord(ram, cdromBase + DCB_FIELD_CHDIR, B_SENTINEL_BASE + 0x64 * B_SENTINEL_STRIDE);
  ramWriteWord(ram, cdromBase + DCB_FIELD_INIT, 0);
}