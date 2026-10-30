import { describe, expect, test } from 'bun:test';
import { HleBios } from './bios';
import { ramReadWord, ramWriteBytes, ramWriteWord } from './ram';
import { parseSystemCnf } from './kernel/cnf';
import {
  B0_TABLE_ADDR,
  B_SENTINEL_BASE,
  C0_TABLE_ADDR,
  C_SENTINEL_BASE,
  CMDLINE_ADDR,
  DCB_ADDR,
  EVCB_ADDR,
  EVCB_SIZE,
  EXCB_ADDR,
  EXC_HANDLER,
  FCB_ADDR,
  FCB_SIZE,
  PCB_ADDR,
  RAM_MASK,
  RAM_TOP,
  TCB_ADDR,
  TOT_ADDR,
  VEC_A,
  VEC_B,
  VEC_C,
  VEC_RET,
} from './kernel/layout';
import { physOf, readString as ramReadString } from './kernel/strmem';
import type {
  CdFileEntry,
  CdromUnit,
  CpuContext,
  CpuRegAccess,
  DmaChannel,
  DmaConfig,
  Iso9660,
  IsoEntry,
  LogTag,
  Logger,
  Scheduler,
} from './contracts';

class TestLogger implements Logger {
  readonly lines: Array<string> = [];

  debug(tag: LogTag, msg: string): void {
    this.lines.push(`d:${tag}:${msg}`);
  }

  warn(tag: LogTag, msg: string): void {
    this.lines.push(`w:${tag}:${msg}`);
  }

  error(tag: LogTag, msg: string): void {
    this.lines.push(`e:${tag}:${msg}`);
  }

  dump(limit: number): string {
    return this.lines.slice(-limit).join('\n');
  }

  has(needle: string): boolean {
    return this.lines.some((l) => l.includes(needle));
  }
}

interface SchedItem {
  deadline: number;
  fn: () => void;
}

class TestScheduler implements Scheduler {
  private readonly items: Array<SchedItem> = [];
  private readonly byHandle = new WeakMap<object, SchedItem>();
  private t = 0;

  get now(): number {
    return this.t;
  }

  at(cyclesFromNow: number, fn: () => void): object {
    const item: SchedItem = { deadline: this.t + cyclesFromNow, fn };
    const handle: object = new Object();
    this.byHandle.set(handle, item);
    this.items.push(item);
    this.items.sort((a, b) => a.deadline - b.deadline);

    return handle;
  }

  cancel(handle: object): void {
    const item = this.byHandle.get(handle);
    if (item === undefined) {
      return;
    }
    const i = this.items.indexOf(item);
    if (i >= 0) {
      this.items.splice(i, 1);
    }
  }

  advance(cycles: number): void {
    this.t += cycles;
    for (;;) {
      const top = this.items[0];
      if (top === undefined || top.deadline > this.t) {
        return;
      }
      this.items.shift();
      top.fn();
    }
  }
}

class TestCore implements CpuRegAccess {
  readonly rs: Array<number> = new Array<number>(32).fill(0);
  private curPc = 0;
  private curNextPc = 0;
  private curSr = 0;
  suspendCount = 0;
  resumeCount = 0;

  getReg(index: number): number {
    return this.rs[index] >>> 0;
  }

  setReg(index: number, value: number): void {
    if (index !== 0) {
      this.rs[index] = value >>> 0;
    }
  }

  pc(): number {
    return this.curPc;
  }

  setPc(value: number): void {
    this.curPc = value >>> 0;
  }

  get nextPc(): number {
    return this.curNextPc;
  }

  setNextPc(value: number): void {
    this.curNextPc = value >>> 0;
  }

  sr(): number {
    return this.curSr;
  }

  setSr(value: number): void {
    this.curSr = value >>> 0;
  }

  save(): CpuContext {
    return {
      pc: this.curPc,
      nextPc: this.curNextPc,
      regs: this.rs.slice(),
      hi: 0,
      lo: 0,
      sr: this.curSr,
      cause: 0,
      epc: this.curPc,
      branchDelay: false,
      branchTarget: 0,
    };
  }

  restore(ctx: CpuContext): void {
    this.curPc = ctx.pc;
    this.curNextPc = ctx.nextPc;
    this.curSr = ctx.sr;
    for (let i = 0; i < 32; i++) {
      this.rs[i] = ctx.regs[i] >>> 0;
    }
  }

  suspend(): void {
    this.suspendCount++;
  }

  resume(): void {
    this.resumeCount++;
  }
}

function normalizePath(path: string): string {
  return path
    .replace(/^\S+?:/, '')
    .replace(/;.*$/, '')
    .replace(/[\\/]+/g, '/')
    .replace(/^\//, '')
    .toLowerCase();
}

const ISO_ENTRIES: Array<IsoEntry> = [
  { name: 'ZNULL.DAT', path: '\\ZNULL.DAT', lba: 300, size: 4096, isDirectory: false },
  { name: 'CAPCOM.INF', path: '\\CAPCOM.INF', lba: 302, size: 1024, isDirectory: false },
  { name: 'ABCDE.DAT', path: '\\ABCDE.DAT', lba: 310, size: 2048, isDirectory: false },
];

class FakeIso implements Iso9660 {
  find(_path: string): IsoEntry | null {
    void _path;

    return null;
  }

  list(path: string): Array<IsoEntry> {
    const prefix = normalizePath(path);

    return ISO_ENTRIES.filter((e) => normalizePath(e.path).startsWith(prefix));
  }
}

interface DiscFile {
  readonly lba: number;
  readonly bytes: Uint8Array;
}

class FakeCd implements CdromUnit {
  readonly iso = new FakeIso();
  readonly files = new Map<string, DiscFile>();

  openFile(path: string, lba: number, bytes: Uint8Array): void {
    this.files.set(normalizePath(path), { lba, bytes });
  }

  findFile(path: string): CdFileEntry | null {
    const e = this.files.get(normalizePath(path));
    if (e === undefined) {
      return null;
    }

    return { lba: e.lba, size: e.bytes.length };
  }

  readFileBytes(path: string, byteOffset: number, length: number): Uint8Array | null {
    const e = this.files.get(normalizePath(path));
    if (e === undefined) {
      return null;
    }
    const start = Math.max(0, byteOffset);
    const end = Math.min(e.bytes.length, start + Math.max(0, length));
    if (end <= start) {
      return new Uint8Array(0);
    }

    return e.bytes.slice(start, end);
  }

  readIntoRam(lba: number, byteOffset: number, length: number, ram: Uint32Array, dstAddr: number): void {
    if (length <= 0) {
      return;
    }
    const buf = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      buf[i] = (byteOffset + i) & 0xFF;
    }
    void lba;
    ramWriteBytes(ram, dstAddr, buf, 0, length);
  }

  load8(_addr: number): number {
    return 0;
  }

  load16(_addr: number): number {
    return 0;
  }

  load32(_addr: number): number {
    return 0;
  }

  store8(_addr: number, _value: number): void {}

  store16(_addr: number, _value: number): void {}

  store32(_addr: number, _value: number): void {}

  dmaStart(_channel: DmaChannel, _config: DmaConfig, _ram: Uint32Array): void {}

  tick(_cycles: number): void {}
}

const CNF_TEXT = 'BOOT = cdrom:SLUS_001.70;1\r\nTCB = 4\nEVENT = 16\nSTACK = 0X801FFF00\n';

interface Fixture {
  bios: HleBios;
  ram: Uint32Array;
  sched: TestScheduler;
  log: TestLogger;
  core: TestCore;
  cd: FakeCd;
}

function writeU32(dst: Uint8Array, off: number, v: number): void {
  dst[off] = v & 0xFF;
  dst[off + 1] = (v >>> 8) & 0xFF;
  dst[off + 2] = (v >>> 16) & 0xFF;
  dst[off + 3] = (v >>> 24) & 0xFF;
}

function makeFixture(): Fixture {
  const log = new TestLogger();
  const sched = new TestScheduler();
  const ram = new Uint32Array(RAM_TOP / 4);
  const cd = new FakeCd();
  const header = new Uint8Array(2048);
  const magic = 'PS-X EXE';
  for (let i = 0; i < magic.length; i++) {
    header[i] = magic.charCodeAt(i);
  }
  writeU32(header, 0x10, 0x8005F8A0);
  writeU32(header, 0x14, 0x0);
  writeU32(header, 0x18, 0x80010000);
  writeU32(header, 0x1C, 0x800);
  writeU32(header, 0x30, 0x801FFFF0);
  writeU32(header, 0x34, 0x0);
  const exe = new Uint8Array(2048 + 0x800);
  exe.set(header, 0);
  const cnf = new Uint8Array(CNF_TEXT.length);
  for (let i = 0; i < CNF_TEXT.length; i++) {
    cnf[i] = CNF_TEXT.charCodeAt(i);
  }
  const znull = new Uint8Array(4096);
  for (let i = 0; i < znull.length; i++) {
    znull[i] = (i & 0xFF);
  }
  cd.openFile('cdrom:SYSTEM.CNF', 270718, cnf);
  cd.openFile('cdrom:SLUS_001.70', 270719, exe);
  cd.openFile('cdrom:ZNULL.DAT', 300, znull);
  const bios = new HleBios(sched, log, ram, cd.iso, cd);

  return { bios, ram, sched, log, core: new TestCore(), cd };
}

function kuser(fix: Fixture, vec: number, fn: number): number {
  const core = fix.core;
  core.setReg(9, fn);
  core.setPc(vec);
  fix.bios.kuserCall(vec, core);

  return core.getReg(2);
}

function kuserRedirected(fix: Fixture, vec: number, fn: number): boolean {
  fix.core.setReg(9, fn);
  fix.core.setPc(vec);

  return fix.bios.kuserCall(vec, fix.core);
}

function writeRamAscii(fix: Fixture, addr: number, text: string): void {
  const bytes = new Uint8Array(text.length + 1);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i);
  }
  ramWriteBytes(fix.ram, addr, bytes, 0, bytes.length);
}

describe('SYSTEM.CNF parser', () => {
  test('parses RE disc values', () => {
    const bytes = new Uint8Array(CNF_TEXT.length);
    for (let i = 0; i < CNF_TEXT.length; i++) {
      bytes[i] = CNF_TEXT.charCodeAt(i);
    }
    const cnf = parseSystemCnf(bytes);
    expect(cnf.boot).toBe('cdrom:SLUS_001.70;1');
    expect(cnf.tcb).toBe(4);
    expect(cnf.event).toBe(0x16);
    expect(cnf.stack).toBe(0x801FFF00);
  });

  test('defaults without entries', () => {
    const bytes = new Uint8Array(4);
    bytes[0] = 0x0A;
    const cnf = parseSystemCnf(bytes);
    expect(cnf.boot).toBe('');
    expect(cnf.event).toBe(0x10);
    expect(cnf.stack).toBe(0);
  });
});

describe('boot', () => {
  test('returns RE entry/stack/gp', () => {
    const fix = makeFixture();
    const info = fix.bios.boot();
    expect(info.entryPc).toBe(0x8005F8A0);
    expect(info.sp).toBe(0x801FFF00);
    expect(info.gp).toBe(0);
  });

  test('exe payload landed in RAM', () => {
    const fix = makeFixture();
    fix.bios.boot();
    expect(ramReadWord(fix.ram, 0x80010000)).toBe(0x03020100);
    expect(ramReadWord(fix.ram, 0x80010004)).toBe(0x07060504);
  });

  test('garbage area and exception handler', () => {
    const fix = makeFixture();
    fix.bios.boot();
    expect(ramReadWord(fix.ram, 0)).toBe(3);
    expect(ramReadWord(fix.ram, 4)).toBe(0x275A0C80);
    expect(ramReadWord(fix.ram, 8)).toBe(0x03400008);
    expect(ramReadWord(fix.ram, 12)).toBe(0);
    expect(ramReadWord(fix.ram, EXC_HANDLER)).toBe(0x3C1A0000);
    expect(ramReadWord(fix.ram, EXC_HANDLER + 8)).toBe(0x03400008);
  });

  test('table of tables', () => {
    const fix = makeFixture();
    fix.bios.boot();
    expect(ramReadWord(fix.ram, TOT_ADDR)).toBe(EXCB_ADDR);
    expect(ramReadWord(fix.ram, TOT_ADDR + 4)).toBe(4 * 8);
    expect(ramReadWord(fix.ram, TOT_ADDR + 8)).toBe(PCB_ADDR);
    expect(ramReadWord(fix.ram, TOT_ADDR + 12)).toBe(4);
    expect(ramReadWord(fix.ram, TOT_ADDR + 16)).toBe(TCB_ADDR);
    expect(ramReadWord(fix.ram, TOT_ADDR + 20)).toBe(4 * 0xC0);
    expect(ramReadWord(fix.ram, TOT_ADDR + 0x20)).toBe(EVCB_ADDR);
    expect(ramReadWord(fix.ram, TOT_ADDR + 0x24)).toBe(22 * EVCB_SIZE);
    expect(ramReadWord(fix.ram, TOT_ADDR + 0x40)).toBe(FCB_ADDR);
    expect(ramReadWord(fix.ram, TOT_ADDR + 0x44)).toBe(16 * FCB_SIZE);
    expect(ramReadWord(fix.ram, TOT_ADDR + 0x50)).toBe(DCB_ADDR);
    expect(ramReadWord(fix.ram, TOT_ADDR + 0x54)).toBe(10 * 0x50);
    expect(ramReadWord(fix.ram, PCB_ADDR)).toBe(TCB_ADDR);
  });

  test('call stubs and jump table', () => {
    const fix = makeFixture();
    fix.bios.boot();
    expect(ramReadWord(fix.ram, VEC_A)).toBe(0x03E00008);
    expect(ramReadWord(fix.ram, VEC_B)).toBe(0x03E00008);
    expect(ramReadWord(fix.ram, VEC_C)).toBe(0x03E00008);
    expect(ramReadWord(fix.ram, VEC_RET)).toBe(0x08000038);
    expect(ramReadWord(fix.ram, 0x0200)).toBe(0x03E00008);
    expect(ramReadWord(fix.ram, 0x0204)).toBe(0x03E00008);
    expect(ramReadWord(fix.ram, B_SENTINEL_BASE)).toBe(0x03E00008);
    expect(ramReadWord(fix.ram, C_SENTINEL_BASE)).toBe(0x03E00008);
  });

  test('command line from SYSTEM.CNF', () => {
    const fix = makeFixture();
    fix.bios.boot();
    expect(ramReadString(fix.ram, physOf(CMDLINE_ADDR), 0x80)).toBe('cdrom:SLUS_001.70;1');
  });

  test('internal CD events reserved in slots 0..4', () => {
    const fix = makeFixture();
    fix.bios.boot();
    expect(ramReadWord(fix.ram, EVCB_ADDR + 0)).toBe(0xF0000003);
    expect(ramReadWord(fix.ram, EVCB_ADDR + 4)).toBe(0x2000);
    expect(ramReadWord(fix.ram, EVCB_ADDR + 8)).toBe(0x10);
  });
});

describe('events', () => {
  test('OpenEvent allocates handles after the 5 internal slots', () => {
    const fix = makeFixture();
    fix.bios.boot();
    fix.core.setReg(4, 0xF2000003);
    fix.core.setReg(5, 2);
    fix.core.setReg(6, 0x2000);
    fix.core.setReg(7, 0);
    expect(kuser(fix, VEC_B, 8)).toBe(0xF1000005);
    expect(ramReadWord(fix.ram, EVCB_ADDR + 5 * EVCB_SIZE + 4)).toBe(0x1000);
    expect(ramReadWord(fix.ram, EVCB_ADDR + 5 * EVCB_SIZE + 8)).toBe(2);
  });

  test('flag event deliver/test cycle', () => {
    const fix = makeFixture();
    fix.bios.boot();
    fix.core.setReg(4, 0xF2000003);
    fix.core.setReg(5, 2);
    fix.core.setReg(6, 0x2000);
    const handle = kuser(fix, VEC_B, 8);
    fix.core.setReg(4, handle);
    expect(kuser(fix, VEC_B, 0x0B)).toBe(0);
    expect(kuser(fix, VEC_B, 0x0C)).toBe(1);
    fix.core.setReg(4, 0xF2000003);
    fix.core.setReg(5, 2);
    kuser(fix, VEC_B, 7);
    fix.core.setReg(4, handle);
    expect(kuser(fix, VEC_B, 0x0B)).toBe(1);
    expect(kuser(fix, VEC_B, 0x0B)).toBe(0);
  });

  test('callback delivery and return-from-exception', () => {
    const fix = makeFixture();
    fix.bios.boot();
    const fn = 0x80045678;
    fix.core.setReg(4, 0xF0000001);
    fix.core.setReg(5, 0x1000);
    fix.core.setReg(6, 0x1000);
    fix.core.setReg(7, fn);
    const handle = kuser(fix, VEC_B, 8);
    expect(handle & 0xFFFF).toBe(5);
    fix.core.setReg(4, handle);
    expect(kuser(fix, VEC_B, 0x0C)).toBe(1);
    fix.core.setReg(4, 0xF0000001);
    fix.core.setReg(5, 0x1000);
    fix.core.rs[31] = 0x12345000;
    expect(kuserRedirected(fix, VEC_B, 7)).toBe(true);
    expect(fix.core.pc()).toBe(fn);
    expect(fix.core.getReg(31)).toBe(VEC_RET);
    expect(fix.core.getReg(4)).toBe(0xF0000001);
    expect(fix.core.getReg(5)).toBe(0x1000);
    const sp = fix.core.getReg(29);
    expect(sp).toBeGreaterThan(0x0000C000);
    expect(sp).toBeLessThanOrEqual(0x0000D000);
    expect(fix.bios.kuserCall(VEC_RET, fix.core)).toBe(true);
    expect(fix.core.pc()).toBe(0x12345000);
  });

  test('WaitEvent blocks and scheduler fallback resumes with 1', () => {
    const fix = makeFixture();
    fix.bios.boot();
    fix.core.setReg(4, 0xF2000003);
    fix.core.setReg(5, 2);
    fix.core.setReg(6, 0x2000);
    const handle = kuser(fix, VEC_B, 8);
    fix.core.setReg(4, handle);
    expect(kuser(fix, VEC_B, 0x0C)).toBe(1);
    fix.core.rs[31] = 0x8004F000;
    expect(kuserRedirected(fix, VEC_B, 0x0A)).toBe(true);
    expect(fix.core.suspendCount).toBe(1);
    fix.sched.advance(590013);
    expect(fix.core.resumeCount).toBe(1);
    expect(fix.core.getReg(2)).toBe(1);
    expect(fix.core.pc()).toBe(0x8004F000);
  });

  test('WaitEvent with pending delivery resumes first', () => {
    const fix = makeFixture();
    fix.bios.boot();
    fix.core.setReg(4, 0xF2000003);
    fix.core.setReg(5, 2);
    fix.core.setReg(6, 0x2000);
    const handle = kuser(fix, VEC_B, 8);
    fix.core.setReg(4, handle);
    expect(kuser(fix, VEC_B, 0x0C)).toBe(1);
    fix.core.rs[31] = 0x8004F000;
    expect(kuserRedirected(fix, VEC_B, 0x0A)).toBe(true);
    expect(fix.core.suspendCount).toBe(1);
    fix.bios.exception('interrupt', 1, 0, fix.core);
    expect(fix.core.resumeCount).toBe(1);
    expect(fix.core.getReg(2)).toBe(1);
  });

  test('WaitEvent on ready event returns 1 without suspending', () => {
    const fix = makeFixture();
    fix.bios.boot();
    fix.core.setReg(4, 0xF2000003);
    fix.core.setReg(5, 2);
    fix.core.setReg(6, 0x2000);
    const handle = kuser(fix, VEC_B, 8);
    fix.core.setReg(4, handle);
    expect(kuser(fix, VEC_B, 0x0C)).toBe(1);
    fix.core.setReg(4, 0xF2000003);
    fix.core.setReg(5, 2);
    kuser(fix, VEC_B, 7);
    fix.core.setReg(4, handle);
    fix.core.rs[31] = 1;
    expect(kuserRedirected(fix, VEC_B, 0x0A)).toBe(false);
    expect(fix.core.getReg(2)).toBe(1);
    expect(fix.core.suspendCount).toBe(0);
  });

  test('CloseEvent frees the slot (returns 1 even for junk)', () => {
    const fix = makeFixture();
    fix.bios.boot();
    fix.core.setReg(4, 0xF2000003);
    fix.core.setReg(5, 2);
    fix.core.setReg(6, 0x2000);
    const handle = kuser(fix, VEC_B, 8);
    fix.core.setReg(4, handle);
    expect(kuser(fix, VEC_B, 9)).toBe(1);
    fix.core.setReg(4, 0xF2000003);
    fix.core.setReg(5, 2);
    fix.core.setReg(6, 0x2000);
    expect(kuser(fix, VEC_B, 8)).toBe(handle);
    fix.core.setReg(4, 0xDEADBEEF);
    expect(kuser(fix, VEC_B, 9)).toBe(1);
  });
});

describe('files', () => {
  test('open/read/seek/getc/close cycle', () => {
    const fix = makeFixture();
    fix.bios.boot();
    const nameStr = 0x80100000;
    writeRamAscii(fix, nameStr, 'cdrom:\\ZNULL.DAT;1');
    fix.core.setReg(4, nameStr);
    fix.core.setReg(5, 1);
    expect(kuser(fix, VEC_A, 0)).toBe(2);

    const dst = 0x80120000;
    fix.core.setReg(4, 2);
    fix.core.setReg(5, dst);
    fix.core.setReg(6, 0x100);
    expect(kuser(fix, VEC_A, 2)).toBe(0x100);
    expect(ramReadWord(fix.ram, dst)).toBe(0x03020100);

    fix.core.setReg(4, 2);
    fix.core.setReg(5, 0x200);
    fix.core.setReg(6, 0);
    expect(kuser(fix, VEC_A, 1)).toBe(0x200);
    expect(kuser(fix, VEC_A, 8)).toBe(0);

    fix.core.setReg(4, 2);
    fix.core.setReg(5, 1);
    fix.core.setReg(6, 1);
    expect(kuser(fix, VEC_A, 1)).toBe(0x202);
    expect(kuser(fix, VEC_A, 8)).toBe(2);

    fix.core.setReg(4, 2);
    expect(kuser(fix, VEC_A, 7)).toBe(0x14);

    fix.core.setReg(4, 2);
    expect(kuser(fix, VEC_A, 4)).toBe(1);

    fix.core.setReg(4, nameStr);
    fix.core.setReg(5, 1);
    expect(kuser(fix, VEC_A, 0)).toBe(2);
  });

  test('FCB mirror in RAM', () => {
    const fix = makeFixture();
    fix.bios.boot();
    const nameStr = 0x80100100;
    writeRamAscii(fix, nameStr, 'cdrom:\\ZNULL.DAT;1');
    fix.core.setReg(4, nameStr);
    fix.core.setReg(5, 1);
    const fd = kuser(fix, VEC_A, 0);
    const base = FCB_ADDR + fd * FCB_SIZE;
    expect(ramReadWord(fix.ram, base)).toBe(1);
    expect(ramReadWord(fix.ram, base + 0x20)).toBe(4096);
    expect(ramReadWord(fix.ram, base + 0x24)).toBe(300);
    expect(ramReadWord(fix.ram, base + 0x14)).toBe(0x14);
  });

  test('unknown device and not-found open', () => {
    const fix = makeFixture();
    fix.bios.boot();
    const bad = 0x80100200;
    writeRamAscii(fix, bad, 'paranoia:\\SAVE.RAM;1');
    fix.core.setReg(4, bad);
    fix.core.setReg(5, 1);
    expect(kuser(fix, VEC_A, 0)).toBe(0xFFFF_FFFF);
    expect(fix.log.has('d:bios:fileopen: unknown device')).toBe(true);
    const missing = 0x80100300;
    writeRamAscii(fix, missing, 'cdrom:\\NOPE.BIN;1');
    fix.core.setReg(4, missing);
    fix.core.setReg(5, 1);
    expect(kuser(fix, VEC_A, 0)).toBe(0xFFFF_FFFF);
    expect(fix.bios.lastBiosFileError()).toBe(0x02);
  });
  test('firstfile/nextfile with ? wildcard', () => {
    const fix = makeFixture();
    fix.bios.boot();
    const nameStr = 0x80100400;
    writeRamAscii(fix, nameStr, 'cdrom:\\?????.DAT');
    const dst = 0x80100800;
    fix.core.setReg(4, nameStr);
    fix.core.setReg(5, dst);
    expect(kuser(fix, VEC_B, 0x42)).toBe(1);
    expect(ramReadWord(fix.ram, dst)).toBe(4096);
    fix.core.setReg(4, dst);
    expect(kuser(fix, VEC_B, 0x43)).toBe(1);
    expect(ramReadWord(fix.ram, dst)).toBe(2048);
    fix.core.setReg(4, dst);
    expect(kuser(fix, VEC_B, 0x43)).toBe(0);
  });
});

describe('interrupt path', () => {
  test('SysEnqIntRP node runs and drains with fn2', () => {
    const fix = makeFixture();
    fix.bios.boot();
    const struc = 0x00040000;
    ramWriteWord(fix.ram, struc, 0);
    ramWriteWord(fix.ram, struc + 4, 0x80043210);
    ramWriteWord(fix.ram, struc + 8, 0x80041234);
    fix.core.setReg(4, 1);
    fix.core.setReg(5, struc);
    expect(kuser(fix, VEC_C, 2)).toBe(1);
    expect(ramReadWord(fix.ram, struc)).toBe(0);

    fix.core.setPc(0x80051000);
    fix.bios.exception('interrupt', 1, 0, fix.core);
    expect(fix.core.pc()).toBe(0x80041234);
    expect(fix.core.getReg(31)).toBe(VEC_RET);
    fix.core.setReg(2, 1);
    expect(fix.bios.kuserCall(VEC_RET, fix.core)).toBe(true);
    expect(fix.core.pc()).toBe(0x80043210);
    fix.core.setReg(2, 0);
    fix.bios.kuserCall(VEC_RET, fix.core);
    expect(fix.core.pc()).toBe(0x80051000);
  });

  test('vblank tick delivers timer and default events', () => {
    const fix = makeFixture();
    fix.bios.boot();
    fix.core.setReg(4, 0xF2000003);
    fix.core.setReg(5, 2);
    fix.core.setReg(6, 0x2000);
    const rcHandle = kuser(fix, VEC_B, 8);
    fix.core.setReg(4, rcHandle);
    expect(kuser(fix, VEC_B, 0x0C)).toBe(1);
    fix.core.setReg(4, 0xF0000001);
    fix.core.setReg(5, 0x1000);
    fix.core.setReg(6, 0x2000);
    const defHandle = kuser(fix, VEC_B, 8);
    fix.core.setReg(4, defHandle);
    expect(kuser(fix, VEC_B, 0x0C)).toBe(1);

    fix.bios.exception('interrupt', 1, 0, fix.core);
    fix.core.setReg(4, rcHandle);
    expect(kuser(fix, VEC_B, 0x0B)).toBe(1);
    fix.core.setReg(4, defHandle);
    expect(kuser(fix, VEC_B, 0x0B)).toBe(1);
  });

  test('cdrom line notifies waiters via exception delivery', () => {
    const fix = makeFixture();
    fix.bios.boot();
    fix.core.setReg(4, 0xF0000003);
    fix.core.setReg(5, 0x1000);
    fix.core.setReg(6, 0x2000);
    const handle = kuser(fix, VEC_B, 8);
    fix.core.setReg(4, handle);
    expect(kuser(fix, VEC_B, 0x0C)).toBe(1);
    fix.bios.exception('interrupt', 1 << 2, 0, fix.core);
    fix.core.setReg(4, handle);
    expect(kuser(fix, VEC_B, 0x0B)).toBe(1);
  });

  test('cdrom async completion wakes a WaitEvent waiter', () => {
    const fix = makeFixture();
    fix.bios.boot();
    const dst = 0x8004A000;
    fix.core.setReg(4, dst);
    expect(kuser(fix, VEC_A, 0x7C)).toBe(0);

    fix.core.setReg(4, 0xF0000003);
    fix.core.setReg(5, 0x0010);
    fix.core.setReg(6, 0x2000);
    const handle = kuser(fix, VEC_B, 8);
    fix.core.setReg(4, handle);
    expect(kuser(fix, VEC_B, 0x0C)).toBe(1);
    fix.core.rs[31] = 0x8004E000;
    expect(kuserRedirected(fix, VEC_B, 0x0A)).toBe(true);
    fix.sched.advance(60_000);
    expect(fix.core.resumeCount).toBe(1);
    expect(fix.core.pc()).toBe(0x8004E000);
    expect(fix.core.getReg(2)).toBe(1);
    expect(ramReadWord(fix.ram, dst & RAM_MASK) & 0xFF).toBe(0x02);
  });

  test('nested interrupt is deferred while in exception context', () => {
    const fix = makeFixture();
    fix.bios.boot();
    const fn = 0x80047700;
    fix.core.setReg(4, 0xF0000001);
    fix.core.setReg(5, 0x1000);
    fix.core.setReg(6, 0x1000);
    fix.core.setReg(7, fn);
    const handle = kuser(fix, VEC_B, 8);
    fix.core.setReg(4, handle);
    kuser(fix, VEC_B, 0x0C);

    fix.core.setPc(0x80051000);
    fix.bios.exception('interrupt', 1, 0, fix.core);
    expect(fix.core.pc()).toBe(fn);
    fix.bios.exception('interrupt', 1, 0, fix.core);
    expect(fix.log.has('interrupt while in exception context')).toBe(true);
    expect(fix.bios.kuserCall(VEC_RET, fix.core)).toBe(true);
    expect(fix.core.pc()).toBe(0x80051000);
  });

  test('critical section syscalls', () => {
    const fix = makeFixture();
    fix.bios.boot();
    fix.core.setSr((0x404 | 0x1) >>> 0);
    fix.core.setReg(4, 1);
    fix.bios.exception('syscall', 1, 0, fix.core);
    expect(fix.core.getReg(2)).toBe(1);
    expect(fix.core.sr() & 0x405).toBe(0);
    fix.core.setReg(4, 2);
    fix.bios.exception('syscall', 2, 0, fix.core);
    expect(fix.core.sr() & 0x405).toBe(0x405);
    fix.core.setSr(0x402);
    fix.bios.exception('syscall', 1, 0, fix.core);
    expect(fix.core.getReg(2)).toBe(0);
  });

  test('out-of-range syscall delivers F0000010h', () => {
    const fix = makeFixture();
    fix.bios.boot();
    fix.core.setReg(4, 0xF0000010);
    fix.core.setReg(5, 0x4000);
    fix.core.setReg(6, 0x2000);
    const handle = kuser(fix, VEC_B, 8);
    fix.core.setReg(4, handle);
    expect(kuser(fix, VEC_B, 0x0C)).toBe(1);
    fix.bios.exception('syscall', 0x1B, 0, fix.core);
    fix.core.setReg(4, handle);
    expect(kuser(fix, VEC_B, 0x0B)).toBe(1);
  });
});

describe('pad path', () => {
  test('InitPad + StartPad + vblank fills replies', () => {
    const fix = makeFixture();
    fix.bios.boot();
    const buf1 = 0x80030000;
    const buf2 = 0x80030100;
    fix.core.setReg(4, buf1);
    fix.core.setReg(5, 0x22);
    fix.core.setReg(6, buf2);
    fix.core.setReg(7, 0x22);
    expect(kuser(fix, VEC_B, 0x12)).toBe(0);
    expect(ramReadWord(fix.ram, buf1 & RAM_MASK)).toBe(0x000000FF);
    kuser(fix, VEC_B, 0x13);

    fix.bios.padInput = { buttons: 0x4008 };
    fix.bios.exception('interrupt', 1, 0, fix.core);
    const word = ramReadWord(fix.ram, buf1 & RAM_MASK);
    expect(word & 0xFF).toBe(0x00);
    expect((word >>> 8) & 0xFF).toBe(0x41);
    expect((word >>> 16) & 0xFF).toBe(0xF7);
    expect((word >>> 24) & 0xFF).toBe(0xBF);
    expect(ramReadWord(fix.ram, buf2 & RAM_MASK) & 0xFFFF).toBe(0x4100);
  });

  test('controller class event on IRQ line 7', () => {
    const fix = makeFixture();
    fix.bios.boot();
    fix.core.setReg(4, 0xF0000008);
    fix.core.setReg(5, 0x1000);
    fix.core.setReg(6, 0x2000);
    const handle = kuser(fix, VEC_B, 8);
    fix.core.setReg(4, handle);
    expect(kuser(fix, VEC_B, 0x0C)).toBe(1);
    fix.bios.exception('interrupt', 1 << 7, 0, fix.core);
    fix.core.setReg(4, handle);
    expect(kuser(fix, VEC_B, 0x0B)).toBe(1);
  });

  test('card status reports absence', () => {
    const fix = makeFixture();
    fix.bios.boot();
    expect(kuser(fix, VEC_B, 0x5C)).toBe(0x11);
    expect(kuser(fix, VEC_B, 0x5D)).toBe(0x11);
  });
});

describe('misc', () => {
  test('alloc bump region and cap', () => {
    const fix = makeFixture();
    fix.bios.boot();
    expect(kuser(fix, VEC_B, 0)).toBe(0x00008920);
    fix.core.setReg(4, 7);
    expect(kuser(fix, VEC_B, 0)).toBe(0x00008924);
    fix.core.setReg(4, 0x10000);
    expect(kuser(fix, VEC_B, 0)).toBe(0);
  });

  test('GetC0Table/GetB0Table point into sentinel windows', () => {
    const fix = makeFixture();
    fix.bios.boot();
    expect(kuser(fix, VEC_B, 0x56)).toBe(C0_TABLE_ADDR);
    expect(kuser(fix, VEC_B, 0x57)).toBe(B0_TABLE_ADDR);
    expect(ramReadWord(fix.ram, C0_TABLE_ADDR)).toBe(C_SENTINEL_BASE);
    expect(ramReadWord(fix.ram, B0_TABLE_ADDR + 8)).toBe(B_SENTINEL_BASE + 2 * 4);
  });

  test('OpenThread returns thread handles', () => {
    const fix = makeFixture();
    fix.bios.boot();
    expect(kuser(fix, VEC_B, 0x0E)).toBe(0xFF000001);
    expect(kuser(fix, VEC_B, 0x0E)).toBe(0xFF000002);
    expect(kuser(fix, VEC_B, 0x0E)).toBe(0xFF000003);
    expect(kuser(fix, VEC_B, 0x0E)).toBe(0xFFFFFFFF);
    fix.core.setReg(4, 0xFF000002);
    expect(kuser(fix, VEC_B, 0x0F)).toBe(1);
    expect(kuser(fix, VEC_B, 0x0E)).toBe(0xFF000002);
  });

  test('ExceptionHandler and InstallExceptionHandlers', () => {
    const fix = makeFixture();
    fix.bios.boot();
    expect(kuser(fix, VEC_C, 6)).toBe(0x80000080);
    expect(kuser(fix, VEC_C, 7)).toBe(0);
    expect(ramReadWord(fix.ram, 0)).toBe(0x03E00008);
  });

  test('ChangeClearRCnt returns old flag', () => {
    const fix = makeFixture();
    fix.bios.boot();
    fix.core.setReg(4, 1);
    fix.core.setReg(5, 1);
    expect(kuser(fix, VEC_C, 0x0A)).toBe(0);
    expect(kuser(fix, VEC_C, 0x0A)).toBe(1);
  });

  test('Krom2RawAdd returns failure marker', () => {
    const fix = makeFixture();
    fix.bios.boot();
    expect(kuser(fix, VEC_B, 0x51)).toBe(0xFFFFFFFF);
  });

  test('GetConf reflects SYSTEM.CNF values', () => {
    const fix = makeFixture();
    fix.bios.boot();
    const out = 0x80100C00;
    fix.core.setReg(4, out);
    fix.core.setReg(5, out + 4);
    fix.core.setReg(6, out + 8);
    expect(kuser(fix, VEC_A, 0x9D)).toBe(0);
    expect(ramReadWord(fix.ram, out)).toBe(22);
    expect(ramReadWord(fix.ram, out + 4)).toBe(4);
    expect(ramReadWord(fix.ram, out + 8)).toBe(0x801FFF00);
  });

  test('exit and SystemError suspend', () => {
    const fix = makeFixture();
    fix.bios.boot();
    fix.core.setReg(4, 0);
    kuser(fix, VEC_A, 6);
    expect(fix.core.suspendCount).toBe(1);
    fix.core.setReg(4, 0);
    kuser(fix, VEC_B, 0x5A);
    expect(fix.core.suspendCount).toBe(2);
  });
});