import { RAM_SIZE } from './contracts';

const MASK = RAM_SIZE - 1;

const views = new WeakMap<Uint32Array, Uint8Array>();

function u8View(ram: Uint32Array): Uint8Array {
  let v = views.get(ram);
  if (v === undefined) {
    v = new Uint8Array(ram.buffer, ram.byteOffset, ram.byteLength);
    views.set(ram, v);
  }

  return v;
}

export function ramMasked(addr: number): number {
  return addr & MASK;
}

export function ramWordIndex(addr: number): number {
  return (addr & MASK) >>> 2;
}

export function ramWriteBytes(ram: Uint32Array, addr: number, bytes: Uint8Array, offset: number, length: number): void {
  const dst = u8View(ram);
  let a = addr & MASK;
  let i = offset;
  const stop = offset + length;
  if ((a & 3) === 0) {
    const n = Math.min(length, MASK + 1 - a);
    dst.set(bytes.subarray(i, i + n), a);
    i += n;
    a = (a + n) & MASK;
  }
  while (i < stop) {
    const n = Math.min(4 - (a & 3), MASK + 1 - a, stop - i);
    dst.set(bytes.subarray(i, i + n), a);
    i += n;
    a = (a + n) & MASK;
  }
}

export function ramReadBytes(ram: Uint32Array, addr: number, dst: Uint8Array, dstOffset: number, length: number): void {
  const src = u8View(ram);
  let a = addr & MASK;
  let i = 0;
  const stop = length;
  while (i < stop) {
    const n = Math.min(4 - (a & 3), MASK + 1 - a, stop - i);
    dst.set(src.subarray(a, a + n), dstOffset + i);
    i += n;
    a = (a + n) & MASK;
  }
}

export function ramWriteWord(ram: Uint32Array, addr: number, value: number): void {
  ram[ramWordIndex(addr)] = value >>> 0;
}

export function ramReadWord(ram: Uint32Array, addr: number): number {
  return ram[ramWordIndex(addr)];
}