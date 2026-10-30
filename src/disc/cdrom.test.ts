import { test, expect } from 'bun:test';
import { Cdrom } from './cdrom';
import { PsxBinImage } from './image';
import { IsoImage, readEntryBytes } from './iso9660';
import { RingLogger } from '../core/logger';
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

const BIN = 'Resident Evil (USA)/Resident Evil (USA).bin';
const REG0 = 0x1F801800;
const REG1 = 0x1F801801;
const REG2 = 0x1F801802;
const REG_ACK = 0x1F801803;

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
  for (const p of params) {
    f.cd.store8(REG1, p);
  }
  f.cd.store8(REG0, id);
}

interface IntResult {
  flags: number;
  resp: Array<number>;
}

function settleInt(f: Fixture): IntResult {
  f.sched.advance(20_000);
  const flags = f.cd.load8(REG2);
  const resp: Array<number> = [];
  while ((f.cd.load8(REG0) & 0x04) !== 0) {
    resp.push(f.cd.load8(REG1));
  }
  f.cd.store8(REG_ACK, 0x1F);

  return { flags, resp };
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
  const sys = f.iso.find('SYSTEM.CNF');
  if (sys === null) {
    throw new Error('SYSTEM.CNF missing');
  }
  const boot = f.cd.findFile('SYSTEM.CNF');
  if (boot === null) {
    throw new Error('findFile returned null');
  }
  expect(boot.lba).toBe(sys.lba);
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

test('getstat responds INT3 with status byte and ack clears flags', () => {
  const f = makeDrive();
  sendCommand(f, 0x01, []);
  const r = settleInt(f);
  expect(r.flags).toBe(0x04);
  expect(r.resp).toEqual([0x02]);
  expect(f.cd.load8(REG2)).toBe(0x00);
  f.img.close();
});

test('unknown command responds INT5 with error bit, latch clears on next command', () => {
  const f = makeDrive();
  sendCommand(f, 0x02, []);
  expect(settleInt(f)).toEqual({ flags: 0x10, resp: [0x03] });
  sendCommand(f, 0x01, []);
  expect(settleInt(f)).toEqual({ flags: 0x04, resp: [0x02] });
  f.img.close();
});

test('setloc, seek and location reports match the real sector headers', () => {
  const f = makeDrive();
  sendCommand(f, 0x0E, [0x60, 0x11, 0x43]);
  expect(settleInt(f).flags).toBe(0x04);
  sendCommand(f, 0x17, []);
  expect(settleInt(f)).toEqual({ flags: 0x04, resp: [0x42] });
  f.sched.advance(13_547_520);
  expect(settleInt(f)).toEqual({ flags: 0x08, resp: [0x02] });
  sendCommand(f, 0x10, []);
  expect(settleInt(f)).toEqual({ flags: 0x04, resp: [0x60, 0x11, 0x43, 0x02, 0x00, 0x00, 0x89, 0x00, 0x00, 0x00, 0x89, 0x00] });
  sendCommand(f, 0x11, []);
  expect(settleInt(f)).toEqual({ flags: 0x04, resp: [0x01, 0x01, 0x60, 0x09, 0x43, 0x60, 0x11, 0x43, 0, 0, 0, 0] });
  f.img.close();
});

test('read pumps INT1 per sector at CD_SECTOR_CYCLES and dma moves user data', () => {
  const f = makeDrive();
  sendCommand(f, 0x0E, [0x00, 0x02, 0x00]);
  expect(settleInt(f).flags).toBe(0x04);
  sendCommand(f, 0x06, []);
  expect(settleInt(f)).toEqual({ flags: 0x04, resp: [0x22] });
  f.cd.tick(CD_SECTOR_CYCLES);
  expect(f.cd.load8(REG2)).toBe(0x01);
  expect(settleInt(f)).toEqual({ flags: 0x01, resp: [0x22] });
  f.irq.dmaDoneCh.length = 0;
  f.cd.dmaStart(CD_CH, { ...DMA_CFG, base: 0x0010_1000 }, f.ram);
  expect(f.irq.dmaDoneCh).toEqual([3]);
  const want = readEntryBytes(f.img, 0, 0, 2048);
  expect(Array.from(ramBytes(f.ram, 0x0010_1000, 2048))).toEqual(Array.from(want));
  expect(f.cd.load8(REG2)).toBe(0x00);
  f.cd.tick(CD_SECTOR_CYCLES);
  expect(f.cd.load8(REG2)).toBe(0x01);
  f.cd.store8(REG_ACK, 0x01);
  expect(f.cd.load8(REG2)).toBe(0x00);
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

test('xa audio sectors route to the spu sink with packed subheader', () => {
  const f = makeDrive();
  f.cd.deliverSector(makeXaAudioSector(1, 3));
  expect(f.spu.xaCaptures.length).toBe(1);
  const cap = f.spu.xaCaptures[0];
  if (cap === undefined) {
    throw new Error('no capture');
  }
  expect(cap.channel).toBe(3);
  expect(cap.subheader).toBe(((1 << 24) | (3 << 16) | (0x64 << 8) | 1) >>> 0);
  expect(cap.payload.length).toBe(2328);
  expect(cap.payload[0]).toBe(0xAB);
  expect(cap.payload[1]).toBe(0xCD);
  expect(f.cd.load8(REG2)).toBe(0x00);
  f.img.close();
});

function makeForm1Sector(): Uint8Array {
  const raw = makeXaAudioSector(1, 3);
  raw[18] = 0x08;
  raw[19] = 0;

  return raw;
}

test('form1 data sector stages 2048 bytes for DMA, no xa route', () => {
  const f = makeDrive();
  f.ram.fill(0);
  f.cd.deliverSector(makeForm1Sector());
  expect(f.spu.xaCaptures.length).toBe(0);
  expect(f.cd.load8(REG2)).toBe(0x01);
  f.cd.dmaStart(CD_CH, { ...DMA_CFG, base: 0x0010_0000 }, f.ram);
  expect(Array.from(ramBytes(f.ram, 0x0010_0000, 4))).toEqual([0xAB, 0xCD, 0, 0]);
  expect(f.cd.load8(REG2)).toBe(0x01);
  f.cd.store8(REG_ACK, 0x01);
  expect(f.cd.load8(REG2)).toBe(0x00);
  f.cd.deliverSector(makeForm1Sector());
  f.cd.dmaStart(CD_CH, { ...DMA_CFG, base: 0x0010_0000 }, f.ram);
  expect(Array.from(ramBytes(f.ram, 0x0010_0000, 4))).toEqual([0xAB, 0xCD, 0, 0]);
  f.img.close();
});

test('mute suppresses xa routing and unmute restores it', () => {
  const f = makeDrive();
  sendCommand(f, 0x0B, []);
  expect(settleInt(f).flags).toBe(0x04);
  f.cd.deliverSector(makeXaAudioSector(1, 3));
  expect(f.spu.xaCaptures.length).toBe(0);
  sendCommand(f, 0x0C, []);
  expect(settleInt(f).flags).toBe(0x04);
  f.cd.deliverSector(makeXaAudioSector(1, 3));
  expect(f.spu.xaCaptures.length).toBe(1);
  f.img.close();
});

test('setfilter passes only matching file and channel', () => {
  const f = makeDrive();
  sendCommand(f, 0x0D, [0x01, 0x02]);
  expect(settleInt(f).flags).toBe(0x04);
  f.cd.deliverSector(makeXaAudioSector(1, 3));
  expect(f.spu.xaCaptures.length).toBe(0);
  f.cd.deliverSector(makeXaAudioSector(1, 2));
  expect(f.spu.xaCaptures.length).toBe(1);
  f.img.close();
});