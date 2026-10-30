import { RAM_MASK, RAM_TOP } from './layout';

export const STRING_SCAN_LIMIT = RAM_TOP;

export function physOf(addr: number): number {
  return addr & RAM_MASK;
}

export function isUnsafePointer(addr: number): boolean {
  const top = addr >>> 16;

  return top === 0x1F80 || top === 0x1FC0 || top === 0xFFFE;
}

export function readByte(ram: Uint32Array, addr: number): number {
  const a = physOf(addr);
  if (a >= RAM_TOP) {
    return 0;
  }
  const w = ram[a >>> 2];
  const shift = (a & 3) * 8;

  return ((w >>> shift) & 0xFF) >>> 0;
}

export function writeByte(ram: Uint32Array, addr: number, value: number): void {
  const a = physOf(addr);
  if (a >= RAM_TOP) {
    return;
  }
  const shift = (a & 3) * 8;
  const keep = 0xFFFFFFFF ^ (0xFF << shift);
  const cur = ram[a >>> 2];
  const merged = ((cur & keep) | ((value & 0xFF) << shift)) >>> 0;

  ram[a >>> 2] = merged;
}

export function readString(ram: Uint32Array, addr: number, maxLen: number): string {
  let s = '';
  const a = physOf(addr);
  for (let i = 0; i < maxLen; i++) {
    const b = readByte(ram, a + i);
    if (b === 0) {
      break;
    }
    s += String.fromCharCode(b);
  }

  return s;
}

export function strlen(ram: Uint32Array, s: number): number {
  let n = 0;
  while (n < STRING_SCAN_LIMIT && readByte(ram, s + n) !== 0) {
    n++;
  }

  return n;
}

export function copyRegion(ram: Uint32Array, dstPhys: number, srcPhys: number, len: number, handleOverlap: boolean): void {
  if (len === 0) {
    return;
  }
  const overlap = handleOverlap && dstPhys > srcPhys && dstPhys < srcPhys + len;
  if (!overlap) {
    for (let i = 0; i < len; i++) {
      writeByte(ram, dstPhys + i, readByte(ram, srcPhys + i));
    }

    return;
  }
  for (let i = len - 1; i >= 0; i--) {
    writeByte(ram, dstPhys + i, readByte(ram, srcPhys + i));
  }
}

const COPY_LIMIT = RAM_TOP * 8;

export function memcpy(ram: Uint32Array, dst: number, src: number, len: number): number {
  copyRegion(ram, physOf(dst), physOf(src), clampCopy(len, dst, src), false);

  return dst >>> 0;
}

export function memmove(ram: Uint32Array, dst: number, src: number, len: number): number {
  copyRegion(ram, physOf(dst), physOf(src), clampCopy(len, dst, src), true);

  return dst >>> 0;
}

export function bcopy(ram: Uint32Array, src: number, dst: number, len: number): number {
  copyRegion(ram, physOf(dst), physOf(src), clampCopy(len, dst, src), true);

  return dst >>> 0;
}

export function memset(ram: Uint32Array, dst: number, value: number, len: number): number {
  const v = value & 0xFF;
  const n = clampCopy(len, dst, dst);
  for (let i = 0; i < n; i++) {
    writeByte(ram, physOf(dst) + i, v);
  }

  return dst >>> 0;
}

export function bzero(ram: Uint32Array, dst: number, len: number): number {
  memset(ram, dst, 0, len);

  return dst >>> 0;
}

function clampCopy(len: number, dst: number, src: number): number {
  const lo = Math.min(physOf(dst), physOf(src));
  if (lo >= STRING_SCAN_LIMIT) {
    return 0;
  }
  const room = STRING_SCAN_LIMIT - lo;

  return Math.min(Math.max(0, len >>> 0), room, COPY_LIMIT);
}

export function memcmp(ram: Uint32Array, a: number, b: number, len: number): number {
  const n = Math.min(Math.max(0, len >>> 0), STRING_SCAN_LIMIT);
  for (let i = 0; i < n; i++) {
    const x = readByte(ram, a + i);
    const y = readByte(ram, b + i);
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }

  return 0;
}

export function memchr(ram: Uint32Array, s: number, ch: number, len: number): number {
  const n = Math.min(Math.max(0, len >>> 0), STRING_SCAN_LIMIT);
  for (let i = 0; i < n; i++) {
    if (readByte(ram, s + i) === (ch & 0xFF)) {
      return (s + i) >>> 0;
    }
  }

  return 0;
}

export function strcpy(ram: Uint32Array, dst: number, src: number): number {
  let i = 0;
  for (;;) {
    const b = readByte(ram, src + i);
    writeByte(ram, dst + i, b);
    if (b === 0) {
      break;
    }
    i++;
  }

  return dst >>> 0;
}

export function strncpy(ram: Uint32Array, dst: number, src: number, n: number): number {
  const max = Math.max(0, n >>> 0);
  let done = false;
  for (let i = 0; i < max; i++) {
    if (done) {
      writeByte(ram, dst + i, 0);
      continue;
    }
    const b = readByte(ram, src + i);
    writeByte(ram, dst + i, b);
    if (b === 0) {
      done = true;
    }
  }

  return dst >>> 0;
}

export function strcat(ram: Uint32Array, dst: number, src: number): number {
  strcpy(ram, dst + strlen(ram, dst), src);

  return dst >>> 0;
}

export function strncat(ram: Uint32Array, dst: number, src: number, n: number): number {
  strncpy(ram, dst + strlen(ram, dst), src, n);

  return dst >>> 0;
}

export function strcmp(ram: Uint32Array, a: number, b: number): number {
  for (let i = 0; i < STRING_SCAN_LIMIT; i++) {
    const x = readByte(ram, a + i);
    const y = readByte(ram, b + i);
    if (x !== y) {
      return x < y ? -1 : 1;
    }
    if (x === 0) {
      return 0;
    }
  }

  return 0;
}

export function strncmp(ram: Uint32Array, a: number, b: number, n: number): number {
  const max = Math.max(0, n >>> 0);
  for (let i = 0; i < max; i++) {
    const x = readByte(ram, a + i);
    const y = readByte(ram, b + i);
    if (x !== y) {
      return x < y ? -1 : 1;
    }
    if (x === 0) {
      return 0;
    }
  }

  return 0;
}

export function strchr(ram: Uint32Array, s: number, ch: number): number {
  const target = ch & 0xFF;
  for (let i = 0; i < STRING_SCAN_LIMIT; i++) {
    const b = readByte(ram, s + i);
    if (b === target) {
      return (s + i) >>> 0;
    }
    if (b === 0) {
      break;
    }
  }

  return 0;
}

export function strrchr(ram: Uint32Array, s: number, ch: number): number {
  const target = ch & 0xFF;
  let found = 0;
  for (let i = 0; i < STRING_SCAN_LIMIT; i++) {
    const b = readByte(ram, s + i);
    if (b === target) {
      found = (s + i) >>> 0;
    }
    if (b === 0) {
      break;
    }
  }

  return found;
}

export function strstr(ram: Uint32Array, hay: number, needle: number): number {
  const nlen = strlen(ram, needle);
  if (nlen === 0) {
    return hay >>> 0;
  }
  const hlen = strlen(ram, hay);
  for (let i = 0; i + nlen <= hlen; i++) {
    if (memcmp(ram, hay + i, needle, nlen) === 0) {
      return (hay + i) >>> 0;
    }
  }

  return 0;
}

export function strpbrk(ram: Uint32Array, s: number, set: number): number {
  for (let i = 0; i < STRING_SCAN_LIMIT; i++) {
    const b = readByte(ram, s + i);
    if (b === 0) {
      return 0;
    }
    if (strchr(ram, set, b) !== 0) {
      return (s + i) >>> 0;
    }
  }

  return 0;
}

export function strspn(ram: Uint32Array, s: number, set: number): number {
  let n = 0;
  while (n < STRING_SCAN_LIMIT) {
    const b = readByte(ram, s + n);
    if (b === 0 || strchr(ram, set, b) === 0) {
      break;
    }
    n++;
  }

  return n;
}

export function strcspn(ram: Uint32Array, s: number, set: number): number {
  let n = 0;
  while (n < STRING_SCAN_LIMIT) {
    const b = readByte(ram, s + n);
    if (b === 0 || strchr(ram, set, b) !== 0) {
      break;
    }
    n++;
  }

  return n;
}

export function strtok(ram: Uint32Array, s: number, seps: number, state: { last: number }): number {
  if (s !== 0) {
    state.last = s >>> 0;
  }
  let start = state.last;
  if (start === 0) {
    return 0;
  }
  while (readByte(ram, start) !== 0 && strchr(ram, seps, readByte(ram, start)) !== 0) {
    start++;
  }
  if (readByte(ram, start) === 0) {
    state.last = 0;

    return 0;
  }
  let end = start;
  while (readByte(ram, end) !== 0 && strchr(ram, seps, readByte(ram, end)) === 0) {
    end++;
  }
  if (readByte(ram, end) !== 0) {
    writeByte(ram, end, 0);
    state.last = (end + 1) >>> 0;
  } else {
    state.last = 0;
  }

  return start >>> 0;
}

export function toUpper(c: number): number {
  return c >= 0x61 && c <= 0x7A ? c - 0x20 : c;
}

export function toLower(c: number): number {
  return c >= 0x41 && c <= 0x5A ? c + 0x20 : c;
}

function signedInt(text: string): number {
  const t = text.trim();
  let sign = 1;
  let body = t;
  if (body.startsWith('-')) {
    sign = -1;
    body = body.slice(1);
  } else if (body.startsWith('+')) {
    body = body.slice(1);
  }
  const decimal = parseInt(body, 10);

  if (!Number.isNaN(decimal)) {
    return (sign * decimal) | 0;
  }

  return 0;
}

export function atoiText(ram: Uint32Array, s: number): number {
  return signedInt(readString(ram, s & RAM_MASK, 32));
}

export function strtolText(
  ram: Uint32Array,
  s: number,
  endDst: number,
  baseArg: number,
): number {
  const text = readString(ram, physOf(s), 32);
  const parsed = parseNumberWithBase(text, baseArg);
  if (endDst !== 0) {
    writeWord(ram, endDst, (physOf(s) + parsed.consumed) >>> 0);
  }

  return parsed.value;
}

interface ParsedNumber {
  readonly value: number;
  readonly consumed: number;
}

function parseNumberWithBase(text: string, baseArg: number): ParsedNumber {
  let i = 0;
  while (i < text.length && isSpace(text.charCodeAt(i))) {
    i++;
  }
  let sign = 1;
  if (text[i] === '-') {
    sign = -1;
    i++;
  } else if (text[i] === '+') {
    i++;
  }
  let base = baseArg;
  if (base === 0) {
    if (text[i] === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X') && isDigitInBase(text[i + 2] ?? '', 16)) {
      i += 2;
      base = 16;
    } else if (text[i] === '0' && isDigitInBase(text[i + 1] ?? '', 8)) {
      base = 8;
    } else {
      base = 10;
    }
  } else if (base === 16 && text[i] === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X') && isDigitInBase(text[i + 2] ?? '', 16)) {
    i += 2;
  }
  const digitsStart = i;
  let digits = '';
  while (i < text.length && isDigitInBase(text[i], base)) {
    digits += text[i];
    i++;
  }
  if (digits.length === 0) {
    return { value: 0, consumed: digitsStart };
  }
  const v = parseInt(digits, base);

  return { value: ((sign * v) | 0) >>> 0, consumed: i };
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D || c === 0x0B || c === 0x0C;
}

function isDigitInBase(ch: string, base: number): boolean {
  let v = -1;
  if (ch >= '0' && ch <= '9') {
    v = ch.charCodeAt(0) - 0x30;
  } else if (ch >= 'a' && ch <= 'z') {
    v = ch.charCodeAt(0) - 0x61 + 10;
  } else if (ch >= 'A' && ch <= 'Z') {
    v = ch.charCodeAt(0) - 0x41 + 10;
  }

  return v >= 0 && v < base;
}

function writeWord(ram: Uint32Array, addr: number, value: number): void {
  const a = physOf(addr);
  for (let i = 0; i < 4; i++) {
    writeByte(ram, a + i, (value >>> (i * 8)) & 0xFF);
  }
}

export function strtodText(ram: Uint32Array, s: number): number {
  const text = readString(ram, physOf(s), 48);
  const m = /^[ \t\n\r]*[+-]?[0-9]*\.?[0-9]*([eE][+-]?\d+)?/.exec(text);
  if (m === null) {
    return 0;
  }
  const v = Number(m[0].trim());

  return Number.isNaN(v) ? 0 : v;
}

export function todayDigitOfByte(b: number): number {
  if (b >= 0x30 && b <= 0x39) {
    return b - 0x30;
  }
  if (b >= 0x41 && b <= 0x46) {
    return b - 0x37;
  }
  if (b >= 0x61 && b <= 0x66) {
    return b - 0x57;
  }

  return 0x10;
}