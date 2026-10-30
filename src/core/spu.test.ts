import { test, expect } from 'bun:test';
import type { DmaChannel, DmaConfig, Scheduler } from './contracts';
import { RingLogger } from './logger';
import { IrqRouter } from './irq';
import { SpuCore } from './spu';
import { PsxBinImage } from '../disc/image';

const SPU_BASE = 0x1f801c00;
const BIN = 'Resident Evil (USA)/Resident Evil (USA).bin';

interface TestEvent {
  deadline: number;
  fn: () => void;
}

class TestScheduler implements Scheduler {
  private _now = 0;
  private readonly events: Array<TestEvent> = [];

  get now(): number {
    return this._now;
  }

  at(cyclesFromNow: number, fn: () => void): object {
    const ev: TestEvent = { deadline: this._now + cyclesFromNow, fn };
    this.events.push(ev);
    this.sortEvents();

    return ev;
  }

  cancel(handle: object): void {
    const i = this.events.findIndex((ev) => ev === handle);
    if (i >= 0) {
      this.events.splice(i, 1);
    }
  }

  advance(cycles: number): void {
    this._now += cycles;
    for (;;) {
      if (this.events.length === 0 || this.events[0].deadline > this._now) {
        return;
      }
      const ev: TestEvent | undefined = this.events.shift();
      if (ev === undefined) {
        return;
      }
      ev.fn();
    }
  }

  private sortEvents(): void {
    this.events.sort((a, b) => a.deadline - b.deadline);
  }
}

interface Rig {
  spu: SpuCore;
  sched: TestScheduler;
  dmaDone: Array<number>;
  irqLines: Array<number>;
}

function makeSpu(): Rig {
  const sched = new TestScheduler();
  const irq = new IrqRouter();
  const dmaDone: Array<number> = [];
  const irqLines: Array<number> = [];
  irq.dmaDoneSink = (ch) => {
    dmaDone.push(ch);
  };
  irq.sink = (line) => {
    irqLines.push(line);
  };
  const spu = new SpuCore(sched, new RingLogger(), irq);

  return { spu, sched, dmaDone, irqLines };
}

function setMainVol(spu: SpuCore, v: number): void {
  spu.store16(0x1f801d80, v & 0xffff);
  spu.store16(0x1f801d82, v & 0xffff);
}
function dmaConfig(base: number, words: number, direction: 'toDevice' | 'toRam'): DmaConfig {
  const wordsPerBlock = 16;
  const blockCount = Math.max(1, Math.ceil(words / wordsPerBlock));

  return {
    base,
    wordsPerBlock,
    blockCount,
    step: 4,
    direction,
    mode: 'blockFill',
    chopper: false,
    enable: true,
  };
}

const CH4: DmaChannel = { id: 4 };

function setVoiceRegs(
  spu: SpuCore,
  v: number,
  vol: number,
  pitch: number,
  adsr1: number,
  adsr2: number,
  startAddrReg: number,
): void {
  const base = SPU_BASE + v * 0x10;
  spu.store16(base, vol & 0xffff);
  spu.store16(base + 2, vol & 0xffff);
  spu.store16(base + 4, pitch);
  spu.store16(base + 6, startAddrReg);
  spu.store16(base + 8, adsr1);
  spu.store16(base + 10, adsr2);
}

function writeAdpcmBlocks(spu: SpuCore, byteAddr: number, nibs: Array<number>, hdr: number, flags: number): void {
  spu.spuRam[byteAddr] = hdr;
  spu.spuRam[byteAddr + 1] = flags;
  for (let i = 0; i < 14; i++) {
    spu.spuRam[byteAddr + 2 + i] = ((nibs[i * 2 + 1] << 4) | nibs[i * 2]) & 0xff;
  }
}

function drain(rig: Rig, frames: number): Float32Array {
  const dst = new Float32Array(frames * 2);
  rig.spu.readSamples(dst, frames);

  return dst;
}

function advanceFrames(rig: Rig, frames: number): void {
  for (let i = 0; i < frames; i++) {
    rig.sched.advance(768);
  }
}

function countZeroCrossings(samples: Float32Array): number {
  let n = 0;
  let prev = 0;
  for (let i = 0; i < samples.length; i++) {
    if (prev < 0 && samples[i] >= 0) {
      n++;
    }
    prev = samples[i];
  }

  return n;
}

function stats(dst: Float32Array): { peak: number; cross: number; finite: boolean; n: number } {
  let peak = 0;
  let cross = 0;
  let finite = true;
  let n = 0;
  let prev = 0;
  for (let i = 0; i < dst.length; i += 2) {
    const v = dst[i];
    if (Number.isNaN(v) || v === Infinity || v === -Infinity) {
      finite = false;
    }
    if (Math.abs(v) > peak) {
      peak = Math.abs(v);
    }
    if (prev < 0 && v >= 0) {
      cross++;
    }
    prev = v;
    if (v !== 0) {
      n++;
    }
  }

  return { peak, cross, finite, n };
}

test('voice register readback round-trips incl 32-bit writes', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  rig.sched.advance(768);
  setVoiceRegs(spu, 3, 0x3abc, 0x1234, 0x1ff0, 0x6a34, 0x200);
  expect(spu.load16(SPU_BASE + 0x30)).toBe(0x3abc);
  expect(spu.load16(SPU_BASE + 0x32)).toBe(0x3abc);
  expect(spu.load16(SPU_BASE + 0x34)).toBe(0x1234);
  expect(spu.load16(SPU_BASE + 0x36)).toBe(0x200);
  expect(spu.load16(SPU_BASE + 0x38)).toBe(0x1ff0);
  expect(spu.load16(SPU_BASE + 0x3a)).toBe(0x6a34);
  spu.store32(0x1f801db0, 0x43219876);
  expect(spu.load32(0x1f801db0)).toBe(0x43219876);
  expect(spu.load16(0x1f801db0)).toBe(0x9876);
  expect(spu.load16(0x1f801db2)).toBe(0x4321);
  spu.store16(0x1f801daa, 0xc000);
  expect(spu.load16(0x1f801daa)).toBe(0xc000);
});

test('unlooped zigzag sample plays once then rests, ENDX stays clear', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  spu.store16(0x1f801daa, 0xc000);
  setMainVol(spu, 0x3fff);
  setVoiceRegs(spu, 0, 0x3fff, 0x1000, 0x00ff, 0x0000, 0x1000 >> 3);
  for (let b = 0; b < 4; b++) {
    const nibs: Array<number> = [];
    for (let i = 0; i < 14; i++) {
      nibs.push(7, 9);
    }
    writeAdpcmBlocks(spu, 0x1000 + b * 16, nibs, 0x06, 0x00);
  }
  advanceFrames(rig, 2);
  spu.store16(0x1f801d88, 0x0001);
  advanceFrames(rig, 4096);

  const dst = drain(rig, 4000);
  const s = stats(dst);
  expect(s.finite).toBe(true);
  expect(s.n).toBeGreaterThan(100);
  expect(s.peak).toBeGreaterThan(0.004);
  expect(s.peak).toBeLessThan(0.02);
  expect(s.cross).toBeGreaterThan(40);
  expect(s.cross).toBeLessThan(90);
  expect(spu.load16(0x1f801d9c)).toBe(0);
  expect(spu.load16(0x1f801d9e)).toBe(0);
});

test('continuous looped sine (7799) rings forever after code-3 loop-end', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  spu.store16(0x1f801daa, 0xc000);
  setMainVol(spu, 0x3fff);
  setVoiceRegs(spu, 1, 0x3fff, 0x1000, 0x00ff, 0x0000, 0x2000 >> 3);
  const nibs: Array<number> = [];
  for (let i = 0; i < 14; i++) {
    nibs.push(7, 7, 9, 9);
  }
  writeAdpcmBlocks(spu, 0x2000, nibs, 0x06, 0x07);
  advanceFrames(rig, 2);
  spu.store16(0x1f801d88, 0x0002);
  advanceFrames(rig, 4096);

  const dst = drain(rig, 4000);
  const s = stats(dst);
  expect(s.finite).toBe(true);
  expect(s.peak).toBeGreaterThan(0.009);
  expect(s.cross).toBeGreaterThan(850);
  expect(s.cross).toBeLessThan(1200);
  expect(s.n).toBeGreaterThanOrEqual(3990);
  const endx = spu.load16(0x1f801d9c);
  expect((endx & 2) !== 0).toBe(true);
  expect(endx & 0xfffd).toBe(0);
});

test('end+mute flag silences the voice and sets ENDX', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  spu.store16(0x1f801daa, 0xc000);
  setMainVol(spu, 0x3fff);
  setVoiceRegs(spu, 2, 0x3fff, 0x1000, 0x00ff, 0x0000, 0x2000 >> 3);
  const nibs: Array<number> = [];
  for (let i = 0; i < 14; i++) {
    nibs.push(7, 7);
  }
  writeAdpcmBlocks(spu, 0x2000, nibs, 0x06, 0x01);
  advanceFrames(rig, 2);
  spu.store16(0x1f801d88, 0x0004);
  advanceFrames(rig, 64);

  const early = drain(rig, 20);
  expect(stats(early).n).toBeGreaterThanOrEqual(15);
  advanceFrames(rig, 64);
  drain(rig, 10000);
  advanceFrames(rig, 64);
  const later = drain(rig, 200);
  const s = stats(later);
  expect(s.n).toBe(0);
  expect((spu.load16(0x1f801d9c) & 4) !== 0).toBe(true);
});

test('key-off starts release; level decays monotonically to zero', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  spu.store16(0x1f801daa, 0xc000);
  setVoiceRegs(spu, 4, 0x3fff, 0x1000, 0x00ff, 0x0000, 0x2000 >> 3);
  const nibs: Array<number> = [];
  for (let i = 0; i < 14; i++) {
    nibs.push(7, 7);
  }
  writeAdpcmBlocks(spu, 0x2000, nibs, 0x06, 0x07);
  advanceFrames(rig, 2);
  spu.store16(0x1f801d88, 0x0010);
  advanceFrames(rig, 6000);
  expect(spu.load16(SPU_BASE + 0x4c)).toBe(0x7fff);
  spu.store16(0x1f801d8c, 0x0010);
  const first = spu.load16(SPU_BASE + 0x4c);
  let monotone = true;
  let prev = first;
  for (let i = 0; i < 6000; i++) {
    advanceFrames(rig, 1);
    const lvl = spu.load16(SPU_BASE + 0x4c);
    if (lvl > prev) {
      monotone = false;
    }
    prev = lvl;
  }

  expect(first).toBe(0x7fff);
  expect(monotone).toBe(true);
  expect(prev).toBe(0);
});

test('linear attack rate matches shift table; decay lands on sustain level', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  spu.store16(0x1f801daa, 0xc000);
  const adsr1 = (0 << 15) | (0x10 << 10) | (0 << 8) | (0xf << 4) | 0x0004;
  setVoiceRegs(spu, 5, 0x3fff, 0x1000, adsr1, 0x0000, 0x2000 >> 3);
  const nibs: Array<number> = [];
  for (let i = 0; i < 14; i++) {
    nibs.push(7);
  }
  writeAdpcmBlocks(spu, 0x2000, nibs, 0x06, 0x07);
  advanceFrames(rig, 2);
  spu.store16(0x1f801d88, 0x0020);
  advanceFrames(rig, 159);
  expect(spu.load16(SPU_BASE + 0x5c)).toBe(35);
  advanceFrames(rig, 3040);
  const at3200 = spu.load16(SPU_BASE + 0x5c);
  expect(at3200).toBeGreaterThanOrEqual(650);
  expect(at3200).toBeLessThan(750);
});

test('attack reaches full then decay settles at sustain level and holds', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  spu.store16(0x1f801daa, 0xc000);
  const adsr1 = (0 << 15) | (0 << 10) | (0 << 8) | (6 << 4) | 0x0004;
  const adsr2 = 0x4000 | (0x1f << 8) | (3 << 6) | 0x1f;
  setVoiceRegs(spu, 6, 0x3fff, 0x1000, adsr1, adsr2, 0x2000 >> 3);
  const nibs: Array<number> = [];
  for (let i = 0; i < 14; i++) {
    nibs.push(7);
  }
  writeAdpcmBlocks(spu, 0x2000, nibs, 0x06, 0x07);
  advanceFrames(rig, 2);
  spu.store16(0x1f801d88, 0x0040);
  advanceFrames(rig, 10_000);
  const settled = spu.load16(SPU_BASE + 0x6c);
  expect(Math.abs(settled - (((0x4 + 1) << 11) & 0x7fff))).toBeLessThanOrEqual(6);
  advanceFrames(rig, 100_000);
  expect(spu.load16(SPU_BASE + 0x6c)).toBe(settled);
});

test('XA stereo sector from the real disc decodes to sane audio', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  const log = new RingLogger();
  const img = new PsxBinImage(BIN, log);
  const raw = new Uint8Array(2352);
  const got = img.readRawSectors(11430, 1, raw);
  if (!got) {
    throw new Error('sector read failed');
  }
  expect(raw[0]).toBe(0);
  expect(raw[1]).toBe(0xff);
  expect(raw[15]).toBe(2);
  expect(raw[16]).toBe(1);
  expect(raw[17]).toBe(1);
  expect(raw[19]).toBe(0x01);
  spu.store16(0x1f801daa, 0xc001);
  setMainVol(spu, 0x3fff);
  spu.store16(0x1f801db0, 0x7fff);
  spu.store16(0x1f801db2, 0x7fff);
  const subheader = raw[16] | (raw[17] << 8) | (raw[18] << 16) | (raw[19] << 24);
  spu.xaSink.xaSector(raw[17], subheader >>> 0, raw.subarray(24, 24 + 0x900));
  for (let i = 0; i < 4200; i++) {
    rig.sched.advance(768);
  }
  const dst = drain(rig, 1000);
  let peak = 0;
  let sum2 = 0;
  let diffMax = 0;
  for (let i = 0; i < dst.length; i += 2) {
    const l = dst[i];
    const r = dst[i + 1];
    expect(Number.isNaN(l)).toBe(false);
    expect(Number.isFinite(l)).toBe(true);
    expect(Number.isFinite(r)).toBe(true);
    sum2 += l * l;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    diffMax = Math.max(diffMax, Math.abs(l - r));
  }
  const rms = Math.sqrt(sum2 / (dst.length >> 1));
  expect(rms).toBeGreaterThan(0.001);
  expect(rms).toBeLessThan(0.5);
  expect(peak).toBeLessThan(1.1);
  expect(diffMax).toBeGreaterThan(0.004);
  img.close();
});

test('XA mono sector mirrors left into right', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  spu.store16(0x1f801daa, 0xc001);
  setMainVol(spu, 0x3fff);
  spu.store16(0x1f801db0, 0x7fff);
  spu.store16(0x1f801db2, 0x7fff);
  const payload = new Uint8Array(0x900);
  const nibs: Array<number> = [];
  for (let i = 0; i < 14; i++) {
    nibs.push(7, 7, 9, 9);
  }
  for (let p = 0; p < 18; p++) {
    const off = p * 128;
    for (let i = 0; i < 8; i++) {
      payload[off + 4 + i] = 0x06;
    }
    for (let j = 0; j < 28; j++) {
      const b = ((nibs[j * 2 + 1] << 4) | nibs[j * 2]) & 0xff;
      payload[off + 16 + j * 4] = b;
      payload[off + 16 + j * 4 + 1] = b;
      payload[off + 16 + j * 4 + 2] = b;
      payload[off + 16 + j * 4 + 3] = b;
    }
  }
  const subheader = 1 | (1 << 8) | (0x62 << 16) | (0x00 << 24);
  spu.xaSink.xaSector(1, subheader >>> 0, payload);
  for (let i = 0; i < 6000; i++) {
    rig.sched.advance(768);
  }
  const dst = drain(rig, 1000);
  const s = stats(dst);
  expect(s.n).toBeGreaterThanOrEqual(995);
  expect(s.peak).toBeGreaterThan(0.009);
  let maxDiff = 0;
  for (let i = 0; i < dst.length; i += 2) {
    if (Math.abs(dst[i] - dst[i + 1]) > maxDiff) {
      maxDiff = Math.abs(dst[i] - dst[i + 1]);
    }
  }
  expect(maxDiff).toBe(0);
});

test('DMA ch4 toDevice writes halfwords at transfer address and toRam reads them back', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  const ram = new Uint32Array(32);
  for (let i = 0; i < 16; i++) {
    ram[i] = (0xa0000000 + i * 0x01010101) >>> 0;
  }
  spu.store16(0x1f801dac, 0x0004);
  spu.store16(0x1f801da6, 0x2000);
  spu.dmaStart(CH4, dmaConfig(0, 16, 'toDevice'), ram);
  expect(rig.dmaDone).toContain(4);
  for (let i = 0; i < 32; i++) {
    const lo = spu.spuRam[0x10000 + i * 2] | (spu.spuRam[0x10000 + i * 2 + 1] << 8);
    const expected = i % 2 === 0 ? ram[i >> 1] & 0xffff : (ram[i >> 1] >>> 16) & 0xffff;
    expect(lo).toBe(expected);
  }
  const readBack = new Uint32Array(64);
  spu.store16(0x1f801da6, 0x2000);
  spu.dmaStart(CH4, dmaConfig(0x80, 16, 'toRam'), readBack);
  for (let i = 0; i < 16; i++) {
    expect(readBack[0x20 + i]).toBe(ram[i]);
  }
});

test('manual write fifo applies queued halfwords on manual-write mode', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  spu.store16(0x1f801dac, 0x0004);
  spu.store16(0x1f801da6, 0x0040);
  spu.store16(0x1f801da8, 0x1111);
  spu.store16(0x1f801da8, 0x2222);
  expect(spu.spuRam[0x200]).toBe(0);
  spu.store16(0x1f801daa, 0xc010);
  expect(spu.spuRam[0x200]).toBe(0x11);
  expect(spu.spuRam[0x201]).toBe(0x11);
  expect(spu.spuRam[0x202]).toBe(0x22);
  expect(spu.spuRam[0x203]).toBe(0x22);
  expect(spu.load16(0x1f801dae) & 0x400).toBe(0);
});

test('SPU IRQ9 raises when a keyed voice fetches the IRQ address block', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  spu.store16(0x1f801daa, 0xc040);
  setMainVol(spu, 0x3fff);
  setVoiceRegs(spu, 7, 0x3fff, 0x1000, 0x00ff, 0x0000, 0x4000 >> 3);
  const nibs: Array<number> = [];
  for (let i = 0; i < 14; i++) {
    nibs.push(7, 7);
  }
  writeAdpcmBlocks(spu, 0x4000, nibs, 0x06, 0x07);
  spu.store16(0x1f801da4, 0x4000 >> 3);
  expect(rig.irqLines.length).toBe(0);
  advanceFrames(rig, 2);
  spu.store16(0x1f801d88, 0x0080);
  advanceFrames(rig, 200);
  expect(rig.irqLines).toContain(9);
  expect(rig.irqLines.length).toBeGreaterThan(1);
  expect((spu.load16(0x1f801dae) & 0x40) !== 0).toBe(true);
  spu.store16(0x1f801daa, 0xc000);
  expect((spu.load16(0x1f801dae) & 0x40) !== 0).toBe(false);
});

test('silent idle SPU produces exactly one frame per 768 cycles and caps the ring', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  rig.sched.advance(4096 * 768);
  expect(spu.sink.availableFrames).toBe(4096);
  rig.sched.advance(16_384 * 768);
  expect(spu.sink.availableFrames).toBe(8192);
  const dst = new Float32Array(100);
  spu.sink.read(dst, 50);
  expect(spu.sink.availableFrames).toBe(8142);
});

test('soft reset (SPUCNT bit15=0) keys everything off and ignores KON', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  setMainVol(spu, 0x3fff);
  spu.store16(0x1f801daa, 0xc000);
  setVoiceRegs(spu, 8, 0x3fff, 0x1000, 0x00ff, 0x0000, 0x2000 >> 3);
  spu.store16(0x1f801d88, 0x0100);
  advanceFrames(rig, 100);
  expect(spu.load16(SPU_BASE + 0x8c)).toBe(0x7fff);
  spu.store16(0x1f801daa, 0x4000);
  expect(spu.load16(SPU_BASE + 0x8c)).toBe(0);
  const konWrite = spu.load16(SPU_BASE + 0x8c);
  expect(konWrite).toBe(0);
  spu.store16(0x1f801d88, 0x0100);
  expect(spu.load16(SPU_BASE + 0x8c)).toBe(0);
  advanceFrames(rig, 100);
  expect(spu.load16(SPU_BASE + 0x8c)).toBe(0);
});

test('24 voices at 44.1kHz for one second stays well under realtime', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  spu.store16(0x1f801daa, 0xc000);
  setMainVol(spu, 0x3fff);
  for (let v = 0; v < 24; v++) {
    setVoiceRegs(spu, v, 0x3fff, 0x1000, 0x00ff, 0x0000, (0x3000 + v * 16) >> 3);
    const b = 0x3000 + v * 16;
    const nibs: Array<number> = [];
    for (let i = 0; i < 14; i++) {
      nibs.push(7, 7, 9, 9);
    }
    writeAdpcmBlocks(spu, b, nibs, 0x06, 0x07);
  }
  rig.sched.advance(3);
  const konAll = 0x00ffffff;
  spu.store16(0x1f801d88, konAll & 0xffff);
  spu.store16(0x1f801d8a, (konAll >>> 16) & 0xffff);
  const frames = 44100;
  const t0 = performance.now();
  advanceFrames(rig, frames);
  const ms = performance.now() - t0;
  expect(spu.sink.availableFrames).toBeGreaterThan(2000);
  expect(ms).toBeLessThan(3000);
  console.log(`spx perf: ${frames} frames, 24 voices: ${ms.toFixed(1)}ms`);
});

test('pitch modulation clamps step to 0x4000 (4x rate) per nocash glitch math', () => {
  const period28 = (spu: SpuCore, byteAddr: number): void => {
    const nibs: Array<number> = [];
    for (let i = 0; i < 14; i++) {
      const nib = i < 7 ? 7 : 9;
      nibs.push(nib, nib);
    }
    writeAdpcmBlocks(spu, byteAddr, nibs, 0x06, 0x07);
  };

  const rigC = makeSpu();
  rigC.spu.store16(0x1f801daa, 0xc000);
  setMainVol(rigC.spu, 0x3fff);
  setVoiceRegs(rigC.spu, 0, 0x3fff, 0x1000, 0x00ff, 0x0000, 0x4000 >> 3);
  period28(rigC.spu, 0x4000);
  advanceFrames(rigC, 2);
  rigC.spu.store16(0x1f801d88, 0x0001);
  advanceFrames(rigC, 4096);
  const cControl = countZeroCrossings(drain(rigC, 4000));

  const rigM = makeSpu();
  rigM.spu.store16(0x1f801daa, 0xc000);
  setMainVol(rigM.spu, 0x3fff);
  setVoiceRegs(rigM.spu, 0, 0x0000, 0x0040, 0x00ff, 0x0000, 0x6000 >> 3);
  { 
    const nibs: Array<number> = [];
    for (let i = 0; i < 14; i++) {
      nibs.push(7, 7);
    }
    writeAdpcmBlocks(rigM.spu, 0x6000, nibs, 0x06, 0x07);
  }
  setVoiceRegs(rigM.spu, 1, 0x3fff, 0x8000, 0x00ff, 0x0000, 0x4000 >> 3);
  period28(rigM.spu, 0x4000);
  rigM.spu.store16(0x1f801d90, 0x0002);
  advanceFrames(rigM, 2);
  rigM.spu.store16(0x1f801d88, 0x0003);
  advanceFrames(rigM, 4096);
  const cMod = countZeroCrossings(drain(rigM, 4000));

  expect(cControl).toBeGreaterThan(100);
  expect(cControl).toBeLessThan(220);
  expect(cMod).toBeGreaterThan(3 * cControl);
});

test('cdda sectors mix at 44100Hz with per-channel volume', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  spu.store16(0x1f801daa, 0xc001);
  setMainVol(spu, 0x3fff);
  spu.store16(0x1f801db0, 0x3fff);
  spu.store16(0x1f801db2, 0x0000);
  const payload = new Uint8Array(2352);
  for (let f = 0; f < 588; f++) {
    const o = f * 4;
    payload[o] = 0x10;
    payload[o + 1] = 0x08;
    payload[o + 2] = 0x00;
    payload[o + 3] = 0x80;
  }
  rig.spu.xaSink.cddaSector(payload);
  advanceFrames(rig, 700);
  const dst = drain(rig, 620);
  const want = ((0x0810 * 0x3fff) >> 15) / 32768;
  for (let i = 3; i < 588; i++) {
    expect(Math.abs(dst[i * 2] - want)).toBeLessThan(0.001);
    expect(dst[i * 2 + 1]).toBe(0);
  }
});

test('high voice ENDX lives in the upper flag halfword', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  spu.store16(0x1f801daa, 0xc000);
  setMainVol(spu, 0x3fff);
  setVoiceRegs(spu, 20, 0x3fff, 0x1000, 0x00ff, 0x0000, 0x6000 >> 3);
  const nibs: Array<number> = [];
  for (let i = 0; i < 14; i++) {
    nibs.push(7, 7);
  }
  writeAdpcmBlocks(spu, 0x6000, nibs, 0x06, 0x07);
  spu.store16(0x1f801d8a, 0x0010);
  advanceFrames(rig, 100);
  const endxHi = spu.load16(0x1f801d9e);
  expect((endxHi & (1 << 4)) !== 0).toBe(true);
});

test('noise mode voices output noise level', () => {
  const rig = makeSpu();
  const spu = rig.spu;
  spu.store16(0x1f801daa, 0xc000 | 0x2000 | 0x0200);
  setMainVol(spu, 0x3fff);
  setVoiceRegs(spu, 9, 0x3fff, 0x1000, 0x00ff, 0x0000, 0x7000 >> 3);
  const nibs: Array<number> = [];
  for (let i = 0; i < 14; i++) {
    nibs.push(7, 7);
  }
  writeAdpcmBlocks(spu, 0x7000, nibs, 0x06, 0x07);
  spu.store16(0x1f801d94, 0x0200);
  advanceFrames(rig, 2);
  spu.store16(0x1f801d88, 0x0200);
  advanceFrames(rig, 2000);
  const dst = drain(rig, 1500);
  const s = stats(dst);
  expect(s.n).toBeGreaterThan(1000);
  expect(s.peak).toBeGreaterThan(0.001);
});
