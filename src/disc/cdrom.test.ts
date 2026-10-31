import { test, expect } from 'bun:test';
import { Cdrom } from './cdrom';
import { seekCycles } from './seektime';
import { PsxBinImage } from './image';
import { IsoImage, readEntryBytes } from './iso9660';
import { RingLogger } from '../core/logger';
import { PSXJIN_CD_TIMING } from '../core/timingProfile';
import { CD_SECTOR_CYCLES, RAM_SIZE } from '../core/contracts';
import type {
  AudioSink,
  DmaChannel,
  DmaConfig,
  IrqLine,
  Scheduler,
  Spu,
  SpuXaIn,
} from '../core/contracts';

const BIN = 'games/Resident Evil (USA)/Resident Evil (USA).bin';
const REG0 = 0x1F801800;
const REG1 = 0x1F801801;
const REG2 = 0x1F801802;
const REG3 = 0x1F801803;

class TestSched implements Scheduler {
  private _now = 0;
  private readonly items: Array<TestItem> = [];

  get now(): number {
    return this._now;
  }

  at(cyclesFromNow: number, fn: () => void): object {
    const item: TestItem = { deadline: this._now + cyclesFromNow, fn };
    this.items.push(item);

    return item;
  }

  cancel(handle: object): void {
    let idx = -1;
    for (let k = 0; k < this.items.length; k++) {
      if (this.items[k] === handle) {
        idx = k;
        break;
      }
    }
    if (idx >= 0) {
      this.items.splice(idx, 1);
    }
  }

  advance(cycles: number): void {
    this._now += cycles;
    for (;;) {
      let best = -1;
      for (let k = 0; k < this.items.length; k++) {
        if (this.items[k].deadline <= this._now && (best < 0 || this.items[k].deadline < this.items[best].deadline)) {
          best = k;
        }
      }
      if (best < 0) {
        return;
      }
      const item = this.items[best];
      this.items.splice(best, 1);
      item.fn();
    }
  }
}

interface TestItem {
  readonly deadline: number;
  readonly fn: () => void;
}

interface XaCapture {
  channel: number;
  subheader: number;
  payload: Uint8Array;
}

class FakeSpu implements Spu {
  readonly xaSink: SpuXaIn;
  readonly sink: AudioSink;
  readonly xaCaptures: Array<XaCapture> = [];

  constructor() {
    this.xaSink = {
      xaSector: (channel: number, subheader: number, payload: Uint8Array): void => {
        this.xaCaptures.push({ channel, subheader, payload: new Uint8Array(payload) });
      },
      cddaSector: (_payload: Uint8Array): void => {},
    };
    this.sink = {
      availableFrames: 0,
      read: (_dst: Float32Array, _frames: number): void => {},
    };
  }

  load32(_addr: number): number {
    return 0;
  }

  load16(_addr: number): number {
    return 0;
  }

  load8(_addr: number): number {
    return 0;
  }

  store32(_addr: number, _value: number): void {}

  store16(_addr: number, _value: number): void {}

  store8(_addr: number, _value: number): void {}

  dmaStart(_channel: DmaChannel, _config: DmaConfig, _ram: Uint32Array): void {}

  tick(_cycles: number): void {}
}

class FakeIrq {
  readonly raised: Array<IrqLine> = [];
  readonly dmaDoneCh: Array<number> = [];

  raise(line: IrqLine): void {
    this.raised.push(line);
  }

  dmaDone(channel: number): void {
    this.dmaDoneCh.push(channel);
  }
}

interface Fixture {
  cd: Cdrom;
  sched: TestSched;
  img: PsxBinImage;
  iso: IsoImage;
  irq: FakeIrq;
  spu: FakeSpu;
  ram: Uint32Array;
}

function makeDrive(): Fixture {
  const log = new RingLogger();
  const sched = new TestSched();
  const img = new PsxBinImage(BIN, log);
  const iso = new IsoImage(img, log);
  const irq = new FakeIrq();
  const spu = new FakeSpu();
  const cd = new Cdrom(sched, log, img, iso, spu, irq);

  return { cd, sched, img, iso, irq, spu, ram: new Uint32Array(RAM_SIZE / 4) };
}

function sendCommand(f: Fixture, id: number, params: Array<number>): void {
  f.cd.store8(REG0, 0x00);
  for (const p of params) {
    f.cd.store8(REG2, p);
  }
  f.cd.store8(REG1, id);
}

function setIndex(f: Fixture, i: number): void {
  f.cd.store8(REG0, i & 0x03);
}

function intNumber(f: Fixture): number {
  setIndex(f, 1);

  return f.cd.load8(REG3) & 0x07;
}

function drainResponse(f: Fixture): Array<number> {
  const out: Array<number> = [];
  for (let guard = 0; guard < 20; guard++) {
    if ((f.cd.load8(REG0) & 0x20) === 0) {
      break;
    }
    out.push(f.cd.load8(REG1));
  }

  return out;
}

interface IntResult {
  num: number;
  resp: Array<number>;
}

function settle(f: Fixture, advance: number): IntResult {
  f.sched.advance(advance);
  const num = intNumber(f);
  const resp = drainResponse(f);
  setIndex(f, 1);
  f.cd.store8(REG3, 0x1F);

  return { num, resp };
}

function ackAll(f: Fixture): void {
  setIndex(f, 1);
  f.cd.store8(REG3, 0x1F);
}

function ramBytes(ram: Uint32Array, start: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const a = (start + i) & 0x001F_FFFF;
    out[i] = (ram[a >> 2] >>> ((a & 3) * 8)) & 0xFF;
  }

  return out;
}

const DMA_CFG: DmaConfig = {
  base: 0,
  wordsPerBlock: 512,
  blockCount: 1,
  step: 4,
  direction: 'toRam',
  mode: 'manual',
  chopper: false,
  enable: true,
};

const CD_CH: DmaChannel = { id: 3 };

test('hle findFile and readFileBytes match known disc facts', () => {
  const f = makeDrive();
  const boot = f.cd.findFile('SYSTEM.CNF');
  if (boot === null) {
    throw new Error('findFile returned null');
  }
  expect(boot.lba).toBe(270718);
  expect(boot.size).toBe(69);
  const bytes = f.cd.readFileBytes('SYSTEM.CNF', 0, 69);
  if (bytes === null) {
    throw new Error('readFileBytes returned null');
  }
  const text = Buffer.from(bytes).toString('latin1');
  expect(text).toBe('BOOT = cdrom:SLUS_001.70;1\r\nTCB = 4\r\nEVENT = 16\r\nSTACK = 0X801FFF00\r\n');
  const exe = f.cd.findFile('SLUS_001.70');
  if (exe === null) {
    throw new Error('SLUS_001.70 missing');
  }
  expect(exe.lba).toBe(270719);
  expect(exe.size).toBe(653312);
  const magic = f.cd.readFileBytes('SLUS_001.70', 0, 16);
  if (magic === null) {
    throw new Error('readFileBytes returned null');
  }
  expect(Array.from(magic)).toEqual([0x50, 0x53, 0x2d, 0x58, 0x20, 0x45, 0x58, 0x45, 0, 0, 0, 0, 0, 0, 0, 0]);
  const znull = f.cd.findFile('ZNULL.DAT');
  if (znull === null) {
    throw new Error('ZNULL.DAT missing');
  }
  expect(znull.lba).toBe(271039);
  expect(znull.size).toBe(37044000);
  const zhead = f.cd.readFileBytes('ZNULL.DAT', 0, 16);
  if (zhead === null) {
    throw new Error('readFileBytes returned null');
  }
  expect(Array.from(zhead)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  f.img.close();
});

test('readIntoRam bulk-copies boot exe into RAM at aligned and offset addresses', () => {
  const f = makeDrive();
  const exe = f.cd.findFile('SLUS_001.70');
  if (exe === null) {
    throw new Error('SLUS_001.70 missing');
  }
  f.cd.readIntoRam(exe.lba, 0, exe.size, f.ram, 0x0010_0000);
  const expectedAt = (off: number): Uint8Array => readEntryBytes(f.img, exe.lba, off, 16);
  expect(Array.from(ramBytes(f.ram, 0x0010_0000, 16))).toEqual(Array.from(expectedAt(0)));
  expect(Array.from(ramBytes(f.ram, 0x0010_0000, 8))).toEqual(Array.from([0x50, 0x53, 0x2d, 0x58, 0x20, 0x45, 0x58, 0x45]));
  expect(Array.from(ramBytes(f.ram, 0x0010_0200, 16))).toEqual(Array.from(expectedAt(0x0200)));
  expect(Array.from(ramBytes(f.ram, 0x0010_0400, 16))).toEqual(Array.from(expectedAt(0x0400)));
  expect(Array.from(ramBytes(f.ram, 0x001F_0000, 16))).toEqual(Array.from(expectedAt(0x000F_0000)));

  const sys = f.cd.findFile('SYSTEM.CNF');
  if (sys === null) {
    throw new Error('SYSTEM.CNF missing');
  }
  f.cd.readIntoRam(sys.lba, 3, 30, f.ram, 0x0020_1003);
  const want = readEntryBytes(f.img, sys.lba, 3, 30);
  const got = ramBytes(f.ram, 0x0020_1003, 30);
  expect(Array.from(got)).toEqual(Array.from(want));
  expect(Array.from(ramBytes(f.ram, 0, 3))).toEqual([0, 0, 0]);
  f.img.close();
});

test('getstat: INT3 number 3, status 02h, handshake bits, ack clears', () => {
  const f = makeDrive();
  expect(f.cd.load8(REG0) & 0x08).toBe(0x08);
  sendCommand(f, 0x01, []);
  const r = settle(f, 30_000);
  expect(r.num).toBe(3);
  expect(r.resp).toEqual([0x02]);
  expect(intNumber(f)).toBe(0);
  f.img.close();
});

test('unknown command 17h responds INT5 with (11h,40h)', () => {
  const f = makeDrive();
  sendCommand(f, 0x17, []);
  expect(settle(f, 30_000)).toEqual({ num: 5, resp: [0x11, 0x40] });
  sendCommand(f, 0x01, []);
  expect(settle(f, 30_000)).toEqual({ num: 3, resp: [0x02] });
  f.img.close();
});

test('setloc, seekL and the 8-byte location reports match real sector headers', () => {
  const f = makeDrive();
  sendCommand(f, 0x02, [0x60, 0x11, 0x43]);
  expect(settle(f, 30_000).num).toBe(3);
  sendCommand(f, 0x15, []);
  const seekAck = settle(f, 30_000);
  expect(seekAck.num).toBe(3);
  expect(seekAck.resp).toEqual([0x40]);
  f.sched.advance(seekCycles(0, (60 * 60 + 11) * 75 + 43 - 150, CD_SECTOR_CYCLES));
  const done = settle(f, 0);
  expect(done.num).toBe(2);
  expect(done.resp).toEqual([0x02]);
  sendCommand(f, 0x10, []);
  expect(settle(f, 30_000)).toEqual({ num: 3, resp: [0x60, 0x11, 0x43, 0x02, 0x00, 0x00, 0x89, 0x00] });
  sendCommand(f, 0x11, []);
  expect(settle(f, 30_000)).toEqual({ num: 3, resp: [0x01, 0x01, 0x60, 0x09, 0x43, 0x60, 0x11, 0x43] });
  f.img.close();
});

test('readN after setloc and seekL starts at the seek target, not the previous read position', () => {
  const f = makeDrive();
  sendCommand(f, 0x02, [0x00, 0x02, 0x00]);
  settle(f, 30_000);
  sendCommand(f, 0x06, []);
  settle(f, 30_000);
  f.cd.tick(CD_SECTOR_CYCLES * 3);
  ackAll(f);
  sendCommand(f, 0x09, []);
  settle(f, 30_000);
  settle(f, 30_000);
  sendCommand(f, 0x02, [0x60, 0x11, 0x43]);
  settle(f, 30_000);
  sendCommand(f, 0x15, []);
  settle(f, 30_000);
  f.sched.advance(40_000_000);
  ackAll(f);
  sendCommand(f, 0x0E, [0x20]);
  settle(f, 30_000);
  sendCommand(f, 0x06, []);
  settle(f, 30_000);
  f.cd.tick(CD_SECTOR_CYCLES);
  setIndex(f, 0);
  f.cd.store8(REG3, 0x00);
  f.cd.store8(REG3, 0x80);
  const header = [f.cd.load8(REG2), f.cd.load8(REG2), f.cd.load8(REG2)];
  expect(header).toEqual([0x60, 0x11, 0x43]);
  f.img.close();
});

test('readN: INT3 then INT1 per sector, BFRD handshake, DRQSTS, DMA data', () => {
  const f = makeDrive();
  sendCommand(f, 0x02, [0x00, 0x02, 0x00]);
  expect(settle(f, 30_000).num).toBe(3);
  sendCommand(f, 0x06, []);
  expect(settle(f, 30_000)).toEqual({ num: 3, resp: [0x22] });
  setIndex(f, 0);
  expect(f.cd.load8(REG0) & 0x40).toBe(0x00);
  f.cd.tick(seekCycles(0, 0, CD_SECTOR_CYCLES) + CD_SECTOR_CYCLES);
  expect(f.cd.load8(REG0) & 0x40).toBe(0x40);
  expect(intNumber(f)).toBe(1);
  expect(drainResponse(f)).toEqual([0x22]);
  setIndex(f, 0);
  expect(f.cd.load8(REG0) & 0x40).toBe(0x40);
  f.cd.store8(REG3, 0x00);
  expect(f.cd.load8(REG0) & 0x40).toBe(0x00);
  f.cd.store8(REG3, 0x80);
  expect(f.cd.load8(REG0) & 0x40).toBe(0x40);
  f.irq.dmaDoneCh.length = 0;
  f.cd.dmaStart(CD_CH, { ...DMA_CFG, base: 0x0010_1000 }, f.ram);
  expect(f.irq.dmaDoneCh).toEqual([3]);
  const want = readEntryBytes(f.img, 0, 0, 2048);
  expect(Array.from(ramBytes(f.ram, 0x0010_1000, 2048))).toEqual(Array.from(want));
  expect(f.cd.load8(REG0) & 0x40).toBe(0x00);
  expect(intNumber(f)).toBe(1);
  ackAll(f);
  expect(intNumber(f)).toBe(0);
  f.cd.tick(CD_SECTOR_CYCLES);
  expect(intNumber(f)).toBe(1);
  expect(settle(f, 0).resp).toEqual([0x22]);
  f.img.close();
});

test('pio data reads at 1802 pop sequentially after BFRD load', () => {
  const f = makeDrive();
  sendCommand(f, 0x02, [0x00, 0x02, 0x00]);
  expect(settle(f, 30_000).num).toBe(3);
  sendCommand(f, 0x06, []);
  expect(settle(f, 30_000).num).toBe(3);
  f.cd.tick(CD_SECTOR_CYCLES);
  ackAll(f);
  setIndex(f, 0);
  f.cd.store8(REG3, 0x80);
  const want = readEntryBytes(f.img, 0, 0, 2048);
  const got: Array<number> = [];
  for (let i = 0; i < 2048; i++) {
    got.push(f.cd.load8(REG2));
  }
  expect(got).toEqual(Array.from(want));
  expect(f.cd.load8(REG0) & 0x40).toBe(0x00);
  f.img.close();
});

test('pause keeps bit5 in first response and clears it in second', () => {
  const f = makeDrive();
  sendCommand(f, 0x06, []);
  expect(settle(f, 30_000)).toEqual({ num: 3, resp: [0x22] });
  f.cd.tick(CD_SECTOR_CYCLES);
  expect(settle(f, 0).num).toBe(1);
  sendCommand(f, 0x09, []);
  const ack = settle(f, 30_000);
  expect(ack).toEqual({ num: 3, resp: [0x22] });
  const done = settle(f, 2_200_000);
  expect(done).toEqual({ num: 2, resp: [0x02] });
  sendCommand(f, 0x01, []);
  expect(settle(f, 30_000)).toEqual({ num: 3, resp: [0x02] });
  f.img.close();
});

test('stop turns motor off and parks at track 1 start', () => {
  const f = makeDrive();
  sendCommand(f, 0x06, []);
  expect(settle(f, 30_000)).toEqual({ num: 3, resp: [0x22] });
  sendCommand(f, 0x08, []);
  expect(settle(f, 30_000)).toEqual({ num: 3, resp: [0x02] });
  const done = settle(f, 14_000_000);
  expect(done).toEqual({ num: 2, resp: [0x00] });
  sendCommand(f, 0x01, []);
  expect(settle(f, 30_000)).toEqual({ num: 3, resp: [0x00] });
  f.img.close();
});

test('init resets mode to 20h and aborts pending reads', () => {
  const f = makeDrive();
  sendCommand(f, 0x0A, []);
  const ack = settle(f, 81_000);
  expect(ack.num).toBe(3);
  expect(ack.resp).toEqual([0x02]);
  const done = settle(f, 10_000_000);
  expect(done.num).toBe(2);
  sendCommand(f, 0x0F, []);
  expect(settle(f, 30_000)).toEqual({ num: 3, resp: [0x02, 0x20, 0, 0, 0] });
  f.img.close();
});

function makeXaAudioSector(file: number, chan: number): Uint8Array {
  const raw = new Uint8Array(2352);
  raw[1] = 0xFF;
  raw[12] = 0x02;
  raw[13] = 0x34;
  raw[14] = 0x30;
  raw[15] = 2;
  raw[16] = file;
  raw[17] = chan;
  raw[18] = 0x64;
  raw[19] = 1;
  raw[20] = file;
  raw[21] = chan;
  raw[22] = 0x64;
  raw[23] = 1;
  raw[24] = 0xAB;
  raw[25] = 0xCD;

  return raw;
}

function makeForm1Sector(): Uint8Array {
  const raw = makeXaAudioSector(1, 3);
  raw[18] = 0x89;
  raw[19] = 0;

  return raw;
}

test('xa audio routes to spu sink with packed subheader, no INT1', () => {
  const f = makeDrive();
  f.cd.deliverSector(makeXaAudioSector(1, 3));
  expect(f.spu.xaCaptures.length).toBe(1);
  const cap = f.spu.xaCaptures[0];
  if (cap === undefined) {
    throw new Error('no capture');
  }
  expect(cap.channel).toBe(3);
  expect(cap.subheader).toBe(((1 << 24) | (3 << 16) | (0x64 << 8) | 1) >>> 0);
  expect(cap.payload.length).toBe(2304);
  expect(cap.payload[0]).toBe(0xAB);
  expect(cap.payload[1]).toBe(0xCD);
  expect(intNumber(f)).toBe(0);
  expect(f.cd.load8(REG0) & 0x40).toBe(0x00);
  f.img.close();
});

test('setmode 00h sends audio to data path with 800h fifo', () => {
  const f = makeDrive();
  sendCommand(f, 0x0E, [0x00]);
  expect(settle(f, 30_000).num).toBe(3);
  f.cd.deliverSector(makeXaAudioSector(1, 3));
  expect(f.spu.xaCaptures.length).toBe(0);
  expect(intNumber(f)).toBe(1);
  setIndex(f, 0);
  f.cd.store8(REG3, 0x80);
  setIndex(f, 0);
  const got: Array<number> = [];
  for (let i = 0; i < 4; i++) {
    got.push(f.cd.load8(REG2));
  }
  expect(got).toEqual([0xAB, 0xCD, 0, 0]);
  f.img.close();
});

test('setmode 48h + setfilter gates xa by file/channel', () => {
  const f = makeDrive();
  sendCommand(f, 0x0E, [0x48]);
  expect(settle(f, 30_000).num).toBe(3);
  sendCommand(f, 0x0D, [0x01, 0x02]);
  expect(settle(f, 30_000).num).toBe(3);
  f.cd.deliverSector(makeXaAudioSector(1, 3));
  expect(f.spu.xaCaptures.length).toBe(0);
  expect(intNumber(f)).toBe(0);
  f.cd.deliverSector(makeXaAudioSector(1, 2));
  expect(f.spu.xaCaptures.length).toBe(1);
  expect(intNumber(f)).toBe(0);
  f.img.close();
});

test('mute consumes xa sectors silently, demute restores', () => {
  const f = makeDrive();
  sendCommand(f, 0x0B, []);
  expect(settle(f, 30_000).num).toBe(3);
  f.cd.deliverSector(makeXaAudioSector(1, 3));
  expect(f.spu.xaCaptures.length).toBe(0);
  expect(intNumber(f)).toBe(0);
  sendCommand(f, 0x0C, []);
  expect(settle(f, 30_000).num).toBe(3);
  f.cd.deliverSector(makeXaAudioSector(1, 3));
  expect(f.spu.xaCaptures.length).toBe(1);
  f.img.close();
});

test('double-speed mode halves the sector period', () => {
  const f = makeDrive();
  sendCommand(f, 0x0E, [0x80]);
  expect(settle(f, 30_000).num).toBe(3);
  sendCommand(f, 0x06, []);
  expect(settle(f, 30_000)).toEqual({ num: 3, resp: [0x22] });
  f.cd.tick(Math.floor(CD_SECTOR_CYCLES / 2));
  expect(intNumber(f)).toBe(1);
  f.img.close();
});

test('newer command replaces a still-busy older command', () => {
  const f = makeDrive();
  sendCommand(f, 0x01, []);
  sendCommand(f, 0x01, []);
  const r = settle(f, 30_000);
  expect(r).toEqual({ num: 3, resp: [0x02] });
  ackAll(f);
  f.sched.advance(1_000_000);
  expect(drainResponse(f).length).toBe(0);
  f.img.close();
});
test('back-to-back SeekL commands each deliver their own INT2 with the right response bytes', () => {
  const f = makeDrive();
  for (let round = 0; round < 3; round++) {
    sendCommand(f, 0x02, [0x00, 0x02, 0x10 + round]);
    expect(settle(f, 30_000).num).toBe(3);
    sendCommand(f, 0x15, []);
    expect(settle(f, 30_000)).toEqual({ num: 3, resp: [0x40] });
    f.sched.advance(40_000_000);
    const done = settle(f, 0);
    expect(done.num).toBe(2);
    expect(done.resp.length).toBe(1);
  }
  f.img.close();
});

test('a second response that becomes due while the first is unacknowledged waits in the queue and keeps its own bytes', () => {
  const f = makeDrive();
  sendCommand(f, 0x02, [0x00, 0x02, 0x00]);
  settle(f, 30_000);
  sendCommand(f, 0x15, []);
  f.sched.advance(30_000);
  expect(intNumber(f)).toBe(3);
  f.sched.advance(40_000_000);
  expect(intNumber(f)).toBe(3);
  expect(drainResponse(f)).toEqual([0x40]);
  setIndex(f, 1);
  f.cd.store8(REG3, 0x07);
  expect(intNumber(f)).toBe(2);
  expect(drainResponse(f)).toEqual([0x02]);
  f.img.close();
});

test('commands issued with a zero-length seek still complete a ReadN/Pause cycle', () => {
  const f = makeDrive();
  sendCommand(f, 0x02, [0x00, 0x02, 0x00]);
  settle(f, 30_000);
  sendCommand(f, 0x06, []);
  expect(settle(f, 30_000).num).toBe(3);
  f.cd.tick(CD_SECTOR_CYCLES * 3);
  expect(intNumber(f)).toBe(1);
  ackAll(f);
  sendCommand(f, 0x09, []);
  expect(settle(f, 30_000).num).toBe(3);
  f.sched.advance(2_500_000);
  expect(intNumber(f)).toBe(2);
  f.img.close();
});

function makePsxjinDrive(): Fixture {
  const log = new RingLogger();
  const sched = new TestSched();
  const img = new PsxBinImage(BIN, log);
  const iso = new IsoImage(img, log);
  const irq = new FakeIrq();
  const spu = new FakeSpu();
  const cd = new Cdrom(sched, log, img, iso, spu, irq, PSXJIN_CD_TIMING);

  return { cd, sched, img, iso, irq, spu, ram: new Uint32Array(RAM_SIZE / 4) };
}

test('psxjin read: ack at 0x800, first sector 0x40000 later, then every cdReadTime', () => {
  const f = makePsxjinDrive();
  sendCommand(f, 0x02, [0x00, 0x02, 0x00]);
  f.sched.advance(0x800);
  expect(intNumber(f)).toBe(3);
  ackAll(f);
  sendCommand(f, 0x06, []);
  f.sched.advance(0x800);
  expect(intNumber(f)).toBe(3);
  ackAll(f);
  f.sched.advance(0x40000 - 1);
  expect(intNumber(f)).toBe(0);
  f.sched.advance(1);
  expect(intNumber(f)).toBe(1);
  ackAll(f);
  f.sched.advance(PSXJIN_CD_TIMING.sectorCycles - 1);
  expect(intNumber(f)).toBe(0);
  f.sched.advance(1);
  expect(intNumber(f)).toBe(1);
  f.img.close();
});

test('psxjin read: a sector due while an interrupt is unacknowledged retries every 0x800 cycles', () => {
  const f = makePsxjinDrive();
  sendCommand(f, 0x02, [0x00, 0x02, 0x00]);
  f.sched.advance(0x800);
  ackAll(f);
  sendCommand(f, 0x06, []);
  f.sched.advance(0x800);
  ackAll(f);
  f.sched.advance(0x40000);
  expect(intNumber(f)).toBe(1);
  f.sched.advance(PSXJIN_CD_TIMING.sectorCycles + 0x800 * 3);
  expect(intNumber(f)).toBe(1);
  ackAll(f);
  f.sched.advance(0x800 - 1);
  expect(intNumber(f)).toBe(0);
  f.sched.advance(1);
  expect(intNumber(f)).toBe(1);
  f.img.close();
});

test('psxjin pause stops sector delivery at the command write', () => {
  const f = makePsxjinDrive();
  sendCommand(f, 0x02, [0x00, 0x02, 0x00]);
  f.sched.advance(0x800);
  ackAll(f);
  sendCommand(f, 0x06, []);
  f.sched.advance(0x800);
  ackAll(f);
  f.sched.advance(0x40000 - 100);
  sendCommand(f, 0x09, []);
  f.sched.advance(1000);
  expect(intNumber(f)).not.toBe(1);
  f.img.close();
});

test('psxjin read: acking a drained sector response restarts the sector timer from the ack', () => {
  const f = makePsxjinDrive();
  sendCommand(f, 0x02, [0x00, 0x02, 0x00]);
  f.sched.advance(0x800);
  ackAll(f);
  sendCommand(f, 0x06, []);
  f.sched.advance(0x800);
  ackAll(f);
  f.sched.advance(0x40000);
  expect(intNumber(f)).toBe(1);
  drainResponse(f);
  f.sched.advance(10_000);
  setIndex(f, 1);
  f.cd.store8(REG3, 0x07);
  f.sched.advance(PSXJIN_CD_TIMING.sectorCycles - 1);
  expect(intNumber(f)).toBe(0);
  f.sched.advance(1);
  expect(intNumber(f)).toBe(1);
  f.img.close();
});

test('psxjin read: acking an unread sector response keeps the existing sector timer', () => {
  const f = makePsxjinDrive();
  sendCommand(f, 0x02, [0x00, 0x02, 0x00]);
  f.sched.advance(0x800);
  ackAll(f);
  sendCommand(f, 0x06, []);
  f.sched.advance(0x800);
  ackAll(f);
  f.sched.advance(0x40000);
  f.sched.advance(10_000);
  setIndex(f, 1);
  f.cd.store8(REG3, 0x07);
  f.sched.advance(PSXJIN_CD_TIMING.sectorCycles - 10_000);
  expect(intNumber(f)).toBe(1);
  f.img.close();
});

test('psxjin read: acking the READ_ACK response does not move the 0x40000 first sector', () => {
  const f = makePsxjinDrive();
  sendCommand(f, 0x02, [0x00, 0x02, 0x00]);
  f.sched.advance(0x800);
  ackAll(f);
  sendCommand(f, 0x06, []);
  f.sched.advance(0x800);
  expect(intNumber(f)).toBe(3);
  drainResponse(f);
  ackAll(f);
  f.sched.advance(0x40000 - 1);
  expect(intNumber(f)).toBe(0);
  f.sched.advance(1);
  expect(intNumber(f)).toBe(1);
  f.img.close();
});

test('psxjin read: acking a command response while reading does not restart the sector timer', () => {
  const f = makePsxjinDrive();
  sendCommand(f, 0x02, [0x00, 0x02, 0x00]);
  f.sched.advance(0x800);
  ackAll(f);
  sendCommand(f, 0x06, []);
  f.sched.advance(0x800);
  ackAll(f);
  f.sched.advance(0x40000);
  drainResponse(f);
  ackAll(f);
  f.sched.advance(1000);
  sendCommand(f, 0x0D, [0x80, 0x00]);
  f.sched.advance(0x800);
  expect(intNumber(f)).toBe(3);
  drainResponse(f);
  ackAll(f);
  const elapsed = 1000 + 0x800;
  f.sched.advance(PSXJIN_CD_TIMING.sectorCycles - elapsed - 1);
  expect(intNumber(f)).toBe(0);
  f.sched.advance(1);
  expect(intNumber(f)).toBe(1);
  f.img.close();
});

function startXaModeRead(f: Fixture, muteCommand: number): void {
  sendCommand(f, muteCommand, []);
  f.sched.advance(0x800);
  ackAll(f);
  sendCommand(f, 0x0E, [0x40]);
  f.sched.advance(0x800);
  ackAll(f);
  sendCommand(f, 0x02, [0x00, 0x02, 0x00]);
  f.sched.advance(0x800);
  ackAll(f);
  sendCommand(f, 0x06, []);
  f.sched.advance(0x800);
  ackAll(f);
  f.sched.advance(0x40000);
  expect(intNumber(f)).toBe(1);
  drainResponse(f);
  f.sched.advance(10_000);
  setIndex(f, 1);
  f.cd.store8(REG3, 0x07);
}

test('psxjin read: after Mute (cdr.Muted=0) a drained sector ack restarts the timer even with XA mode bit set', () => {
  const f = makePsxjinDrive();
  startXaModeRead(f, 0x0B);
  f.sched.advance(PSXJIN_CD_TIMING.sectorCycles - 1);
  expect(intNumber(f)).toBe(0);
  f.sched.advance(1);
  expect(intNumber(f)).toBe(1);
  f.img.close();
});

test('psxjin read: after Demute (cdr.Muted=1) with XA mode a drained sector ack leaves the timer alone', () => {
  const f = makePsxjinDrive();
  startXaModeRead(f, 0x0C);
  f.sched.advance(PSXJIN_CD_TIMING.sectorCycles - 10_000 - 1);
  expect(intNumber(f)).toBe(0);
  f.sched.advance(1);
  expect(intNumber(f)).toBe(1);
  f.img.close();
});
