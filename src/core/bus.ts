import type {
  DmaChannel,
  DmaConfig,
  DmaDevice,
  DmaMode,
  IoDevice,
  IrqLine,
  Logger,
  MemAccess,
  MdecUnit,
  Scheduler,
} from './contracts';
import { CYCLES_PER_LINE, SCRATCH_SIZE } from './contracts';
import { PadState } from './pad';
import { MemoryCard } from './memcard';
import { HARDWARE_PROFILE } from './timingProfile';
import type { SioTiming, TimingProfile } from './timingProfile';

export interface IoDeviceSet {
  readonly gpu: IoDevice & DmaDevice;
  readonly cd: IoDevice & DmaDevice;
  readonly spu: IoDevice & DmaDevice;
  readonly mdec: MdecUnit;
  readonly pad: PadState;
}

const RAM_MASK = 0x1F_FFFF;
const IO_BASE = 0x1F80_1000;
const CACHE_CTL_BASE = 0xFFFE_0000;
const CACHE_CTL_SIZE = 0x210;
const HBLANK_CYCLES = CYCLES_PER_LINE >> 3;
const ACK_WINDOW = 100;
const RX_FIFO_CAP = 8;
const DICTR_FORCE = 0x8000;
const DICTR_MASTER = 0x80_0000;
const DICTR_FLAGS = 0x7F00_0000;
const CHCR_BUSY = 0x0100_0000;
const CHCR_TRIGGER = 0x1000_0000;
const TIMER_FLAGS_MASK = 0x1800;
const MDEC_STATUS_PORT = 0x1F801824;
const MDEC_STATUS_BUSY = 0x2000_0000;
const MDEC_OUT_FIFO_EMPTY = 0x8000_0000;
const MDEC_OUT_WAIT_CYCLES = 64;
const MDEC_OUT_MAX_WAITS = 1024;

type Width = 1 | 2 | 4;
type SioSession = 'none' | 'pad' | 'card';

interface TimerState {
  counter: number;
  mode: number;
  target: number;
  fraction: number;
  sawEdge: boolean;
  firedOnce: boolean;
  pulseRestore: boolean;
}

interface ScheduledSlot {
  handle: object;
}

interface SioReply {
  reply: number;
  ack: boolean;
  ackDelay?: number;
}

function freshTimer(): TimerState {
  return { counter: 0, mode: 0, target: 0, fraction: 0, sawEdge: false, firedOnce: false, pulseRestore: false };
}

function mergeByte(slot: number, index: number, byte: number, fieldMask: number): number {
  const shift = index * 8;
  const kept = slot & fieldMask & ~(0xFF << shift);
  const put = (byte << shift) & fieldMask;

  return (kept | put) >>> 0;
}

function openBus(size: Width): number {
  return size === 1 ? 0xFF : size === 2 ? 0xFFFF : 0xFFFF_FFFF;
}

class Sio0Port {
  ctrl = 0;
  mode = 0x000D;
  baud = 0x0088;

  private readonly sched: Scheduler;
  private readonly pad: PadState;
  private readonly cards: ReadonlyArray<MemoryCard | null>;
  private readonly sioTiming: SioTiming;
  private card: MemoryCard;
  private readonly sendIrq: (line: IrqLine) => void;
  private readonly rx = new Uint8Array(RX_FIFO_CAP);
  private rxCount = 0;
  private rxHead = 0;
  private ackLow = false;
  private irqPending = false;
  private session: SioSession = 'none';
  private step = 0;
  private readonly scheduled: Array<ScheduledSlot> = [];

  constructor(
    sched: Scheduler,
    pad: PadState,
    cards: ReadonlyArray<MemoryCard | null>,
    sioTiming: SioTiming,
    sendIrq: (line: IrqLine) => void,
  ) {
    this.sched = sched;
    this.pad = pad;
    this.cards = cards;
    this.sioTiming = sioTiming;
    this.card = cards[0] ?? new MemoryCard(null);
    this.sendIrq = sendIrq;
  }

  loadByte(b: number): number {
    if (b < 4) {
      if (b < this.rxCount) {
        return this.rx[(this.rxHead + b) & (RX_FIFO_CAP - 1)];
      }

      return 0xFF;
    }
    if (b < 6) {
      return b === 4 ? this.statLow() : this.statHigh();
    }
    if (b < 8) {
      return 0;
    }
    if (b < 10) {
      return (this.mode >>> ((b - 8) * 8)) & 0xFF;
    }
    if (b < 12) {
      const raw = (this.ctrl >>> ((b - 10) * 8)) & 0xFF;
      if (b === 10) {
        return raw & ~0x50 & 0xFF;
      }

      return raw;
    }
    if (b < 14) {
      return 0;
    }

    return (this.baud >>> ((b - 14) * 8)) & 0xFF;
  }

  popRx(): void {
    if (this.rxCount === 0) {
      return;
    }
    this.rxCount -= 1;
    this.rxHead = (this.rxHead + 1) & (RX_FIFO_CAP - 1);
  }

  storeByte(b: number, v: number): void {
    if (b === 0) {
      this.transmit(v & 0xFF);

      return;
    }
    if (b >= 8 && b < 10) {
      this.mode = mergeByte(this.mode, b - 8, v, 0x7FFF);

      return;
    }
    if (b >= 10 && b < 12) {
      this.writeCtrl(b - 10, v);

      return;
    }
    if (b >= 14 && b < 16) {
      this.baud = mergeByte(this.baud, b - 14, v, 0xFFFF);
    }
  }

  private writeCtrl(slot: number, v: number): void {
    const prev = this.ctrl;
    const merged = mergeByte(prev, slot, v, 0x3FFF);
    if (slot === 0 && (v & 0x40) !== 0) {
      this.resetState();
      this.ctrl = v & ~0x40 & 0xFF;

      return;
    }
    this.ctrl = merged;
    if (slot === 0 && (v & 0x10) !== 0) {
      this.irqPending = false;
    }
    if (slot === 0 && (prev & 2) === 0 && (this.ctrl & 2) !== 0) {
      this.deselect();
    }
  }

  private deselect(): void {
    this.dropScheduled();
    this.card.abort();
    this.rxCount = 0;
    this.rxHead = 0;
    this.session = 'none';
    this.step = 0;
    this.ackLow = false;
    this.irqPending = false;
  }

  resetState(): void {
    this.dropScheduled();
    this.card.abort();
    this.rxCount = 0;
    this.rxHead = 0;
    this.ackLow = false;
    this.irqPending = false;
    this.session = 'none';
    this.step = 0;
    this.ctrl = 0;
    this.mode = 0;
    this.baud = 0;
  }

  private statLow(): number {
    let s = 0x45;
    if (this.rxCount > 0) {
      s |= 2;
    }
    if (this.ackLow) {
      s |= 0x80;
    }

    return s;
  }

  private statHigh(): number {
    if (this.irqPending) {
      return 2;
    }

    return 0;
  }

  private byteCycles(): number {
    if (this.sioTiming.byteCycles !== null) {
      return this.sioTiming.byteCycles;
    }
    const reload = Math.max(1, this.baud & 0xFFFF);
    const factorSel = this.mode & 3;
    const factor = factorSel === 2 ? 16 : factorSel === 3 ? 64 : 1;
    const perBit = Math.max(1, reload * factor);

    return Math.max(128, perBit * 8);
  }

  private pushRx(v: number): void {
    if (this.rxCount >= RX_FIFO_CAP) {
      return;
    }
    this.rx[(this.rxHead + this.rxCount) & (RX_FIFO_CAP - 1)] = v;
    this.rxCount += 1;
    if ((this.ctrl & 0x800) === 0) {
      return;
    }
    const modeSel = (this.ctrl >>> 8) & 3;
    const threshold = modeSel === 0 ? 1 : modeSel === 1 ? 2 : modeSel === 2 ? 4 : 8;
    if (this.rxCount >= threshold) {
      this.irqPending = true;
      this.sendIrq(7);
    }
  }

  private transmit(byte: number): void {
    if ((this.ctrl & 1) === 0) {
      return;
    }

    const r = this.nextReply(byte);
    const immediate = this.sioTiming.replyImmediate;
    const delay = immediate ? this.byteCycles() - this.sioTiming.ackIrqDelay : this.byteCycles();
    if (immediate) {
      this.pushRx(r.reply);
    }
    this.later(delay, () => {
      if (!immediate) {
        this.pushRx(r.reply);
      }
      if ((this.ctrl & 4) !== 0) {
        this.ctrl &= ~4;
      }
      if (r.ack) {
        const pulse = (): void => {
          this.ackLow = true;
          this.later(this.sioTiming.ackIrqDelay, () => {
            this.irqPending = true;
            if ((this.ctrl & 0x1000) !== 0) {
              this.sendIrq(7);
            }
          });
          this.later(this.sioTiming.ackIrqDelay + ACK_WINDOW, () => {
            this.ackLow = false;
          });
        };
        const extra = r.ackDelay ?? 0;
        if (extra > 0) {
          this.later(extra, pulse);
        } else {
          pulse();
        }
      }
    });
  }

  private nextReply(cmd: number): SioReply {
    if (this.session === 'card' && this.card.busy) {
      const c = this.card.exchange(cmd);

      return { reply: c.reply, ack: c.ack, ackDelay: c.ackDelay };
    }
    if (cmd === 0x01) {
      if ((this.ctrl & 0x2000) === 0) {
        this.session = 'pad';
        this.step = 1;

        return { reply: 0xFF, ack: true };
      }
      this.session = 'none';
      this.step = 0;

      return { reply: 0xFF, ack: false };
    }
    if (cmd === 0x81) {
      const selected = this.cards[(this.ctrl & 0x2000) === 0 ? 0 : 1] ?? null;
      if (selected !== null) {
        this.session = 'card';
        this.card = selected;
        this.card.begin();

        return { reply: 0xFF, ack: true };
      }
      this.session = 'none';

      return { reply: 0xFF, ack: false };
    }
    if (this.session === 'card') {
      const c = this.card.exchange(cmd);

      return { reply: c.reply, ack: c.ack, ackDelay: c.ackDelay };
    }
    if (this.session === 'pad') {
      const step = this.step;
      this.step = step + 1;
      if (step === 1) {
        return { reply: 0x41, ack: true };
      }
      if (step === 2) {
        return { reply: 0x5A, ack: true };
      }
      if (step === 3) {
        return { reply: ~this.pad.buttons & 0xFF, ack: true };
      }
      if (step === 4) {
        return { reply: (~this.pad.buttons >>> 8) & 0xFF, ack: false };
      }

      return { reply: 0xFF, ack: false };
    }

    return { reply: 0xFF, ack: false };
  }

  private later(delay: number, fn: () => void): void {
    const slot: ScheduledSlot = { handle: { } };
    const wrapped = (): void => {
      const i = this.scheduled.indexOf(slot);
      if (i >= 0) {
        this.scheduled.splice(i, 1);
      }
      fn();
    };
    slot.handle = this.sched.at(delay, wrapped);
    this.scheduled.push(slot);
  }

  private dropScheduled(): void {
    for (const s of this.scheduled) {
      this.sched.cancel(s.handle);
    }
    this.scheduled.length = 0;
  }
}

export class Bus implements MemAccess {
  line = 0;

  private readonly sched: Scheduler;
  private readonly log: Logger;
  private readonly devices: IoDeviceSet;
  private readonly ram: Uint32Array;
  private readonly ramBytes: DataView;
  private readonly scratch: Uint32Array;
  private readonly scratchBytes: DataView;
  private readonly exp2: Uint32Array;
  private readonly exp2Bytes: DataView;
  private readonly cacheCtl = new Uint8Array(CACHE_CTL_SIZE);
  private readonly memCtrl = new Uint32Array(12);
  private readonly timers: Array<TimerState>;
  private readonly madr = new Uint32Array(7);
  private readonly bcr = new Uint32Array(7);
  private readonly chcr = new Uint32Array(7);
  private readonly running: Array<boolean> = new Array<boolean>(7).fill(false);
  private readonly endMadr: Array<number> = new Array<number>(7).fill(-1);
  private readonly endBcrClamp: Array<boolean> = new Array<boolean>(7).fill(false);
  private readonly channels: Array<DmaChannel> = [
    { id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 },
  ];
  private readonly sio: Sio0Port;
  private readonly sio1Bytes = new Uint8Array(16);
  private mdecOutAddr = 0;
  private mdecOutWords = 0;
  private mdecOutBlocks = 0;
  private mdecOutWaits = 0;
  private dpcr = 0x07654321;
  private dicr = 0;
  private dicrSignal = false;
  private istat = 0;
  private imask = 0;
  private ramSize = 0x00000B88;
  private icache = 0;
  private readonly rom: Uint8Array | null;
  private readonly vblankLine: number;
  private readonly dmaWordDivisor: number | null;
  private readonly mdecBusyReleaseCycles: number | null;
  private mdecBusy = false;
  private mdecBusyRelease: object | null = null;
  private readonly completionDelay = new Uint32Array(7);

  constructor(sched: Scheduler, log: Logger, ram: Uint32Array, devices: IoDeviceSet, rom: Uint8Array | null = null, memcard1: Uint8Array | null = null, profile: TimingProfile = HARDWARE_PROFILE, memcard2: Uint8Array | null = null) {
    this.vblankLine = profile.vblankLine;
    this.dmaWordDivisor = profile.dmaWordDivisor;
    this.mdecBusyReleaseCycles = profile.mdecBusyReleaseCycles;
    this.rom = rom;
    this.sched = sched;
    this.log = log;
    this.devices = devices;
    this.ram = ram;
    this.ramBytes = new DataView(ram.buffer);
    this.scratch = new Uint32Array(SCRATCH_SIZE / 4);
    this.scratchBytes = new DataView(this.scratch.buffer);
    this.exp2 = new Uint32Array(0x400);
    this.exp2Bytes = new DataView(this.exp2.buffer);
    this.timers = [freshTimer(), freshTimer(), freshTimer()];
    this.memCtrl[0] = 0x1F000000;
    this.memCtrl[1] = 0x1F802000;
    this.memCtrl[2] = 0x0013243F;
    this.memCtrl[3] = 0x00003022;
    this.memCtrl[4] = 0x0013243F;
    this.memCtrl[5] = 0x200931E1;
    this.memCtrl[6] = 0x00020943;
    this.memCtrl[7] = 0x00070777;
    this.memCtrl[8] = 0x00031125;
    this.sio = new Sio0Port(sched, devices.pad, [new MemoryCard(memcard1, profile.sio.cardReadExtraDelay), profile.secondMemoryCard ? new MemoryCard(memcard2, profile.sio.cardReadExtraDelay) : null], profile.sio, (line) => {
      this.raiseIrq(line);
    });
  }

  load8(addr: number): number {
    return this.read(addr, 1);
  }

  load16(addr: number): number {
    return this.read(addr, 2);
  }

  load32(addr: number): number {
    return this.read(addr, 4);
  }

  store8(addr: number, v: number): void {
    this.write(addr, v, 1);
  }

  store16(addr: number, v: number): void {
    this.write(addr, v, 2);
  }

  store32(addr: number, v: number): void {
    this.write(addr, v, 4);
  }

  raiseIrq(line: IrqLine): void {
    this.setPending(line);
  }

  dmaChannelDone(ch: number): void {
    if (ch < 0 || ch > 6 || !this.running[ch]) {
      return;
    }
    const delay = this.completionDelay[ch];
    if (delay > 0) {
      this.completionDelay[ch] = 0;
      this.sched.at(delay, () => {
        this.dmaChannelDone(ch);
      });

      return;
    }
    this.running[ch] = false;
    this.chcr[ch] = (this.chcr[ch] & ~CHCR_BUSY) >>> 0;
    if (ch === 1 && this.mdecBusy) {
      this.releaseMdecBusyLater();
    }
    const end = this.endMadr[ch];
    if (end >= 0) {
      this.madr[ch] = end;
      this.endMadr[ch] = -1;
    }
    if (this.endBcrClamp[ch]) {
      this.bcr[ch] = this.bcr[ch] & 0xFFFF;
      this.endBcrClamp[ch] = false;
    }
    if ((this.dicr & (1 << (16 + ch))) !== 0) {
      this.dicr |= 1 << (24 + ch);
      this.updateDmaSignal();
    }
  }

  irqActive(): number {
    return (this.istat & this.imask) >>> 0;
  }

  lineTick(): void {
    this.tickTimer(this.timers[0], 0);
    this.tickTimer(this.timers[1], 1);
    this.tickTimer(this.timers[2], 2);
  }

  private setPending(line: number): void {
    const bit = 1 << line;
    if ((this.istat & bit) === 0) {
      this.istat |= bit;
    }
  }

  private tickTimer(t: TimerState, idx: number): void {
    if (t.pulseRestore) {
      t.mode |= 0x400;
      t.pulseRestore = false;
    }
    const syncOn = (t.mode & 1) !== 0;
    const syncMode = (t.mode >>> 1) & 3;
    if (idx === 2 && syncOn && (syncMode === 0 || syncMode === 3)) {
      return;
    }
    const quanta = this.lineQuanta(t, idx);
    let inc: number;
    if (idx === 0) {
      if (!syncOn) {
        inc = quanta;
      } else if (syncMode === 0) {
        inc = quanta - Math.min(quanta, HBLANK_CYCLES);
      } else if (syncMode === 1) {
        t.counter = 0;
        inc = quanta;
      } else if (syncMode === 2) {
        t.counter = 0;
        inc = Math.min(quanta, HBLANK_CYCLES);
      } else {
        inc = t.sawEdge ? quanta : 0;
      }
    } else if (idx === 1) {
      const inVblank = this.line >= this.vblankLine;
      const atEdge = this.line === this.vblankLine - 1;
      if (!syncOn) {
        inc = quanta;
      } else if (syncMode === 0) {
        inc = inVblank ? 0 : quanta;
      } else if (syncMode === 1) {
        if (atEdge) {
          t.counter = 0;
        }
        inc = quanta;
      } else if (syncMode === 2) {
        if (atEdge) {
          t.counter = 0;
        }
        inc = inVblank ? quanta : 0;
      } else {
        if (atEdge) {
          t.sawEdge = true;
        }
        inc = t.sawEdge ? quanta : 0;
      }
    } else {
      inc = quanta;
    }
    if (inc <= 0) {
      return;
    }
    const old = t.counter >>> 0;
    let next = old + inc;
    const target = t.target & 0xFFFF;
    if ((t.mode & 8) !== 0) {
      if (target !== 0) {
        while (next >= target) {
          this.fireTimerEvent(t, idx, true, false);
          next = next - target - 1;
          if (next < 0) {
            next = 0;
          }
        }
      }
    } else {
      if (target !== 0 && old < target && next >= target) {
        this.fireTimerEvent(t, idx, true, false);
      }
      if (next > 0xFFFF) {
        this.fireTimerEvent(t, idx, false, true);
        next -= 0x1_0000;
      }
    }
    t.counter = next;
  }

  private fireTimerEvent(t: TimerState, idx: number, isTarget: boolean, isOverflow: boolean): void {
    if (isTarget) {
      t.mode |= 0x800;
    }
    if (isOverflow) {
      t.mode |= 0x1000;
    }
    const gated = (isTarget && (t.mode & 0x10) !== 0) || (isOverflow && (t.mode & 0x20) !== 0);
    if (!gated) {
      return;
    }
    if ((t.mode & 0x40) === 0 && t.firedOnce) {
      return;
    }
    t.firedOnce = true;
    const line = 4 + idx;
    if ((t.mode & 0x80) === 0) {
      t.mode &= ~0x400;
      t.pulseRestore = true;
      this.setPending(line);

      return;
    }
    if ((t.mode & 0x400) !== 0) {
      t.mode &= ~0x400;
      this.setPending(line);

      return;
    }
    t.mode |= 0x400;
  }

  private lineQuanta(t: TimerState, idx: number): number {
    const clk = (t.mode >>> 8) & 3;
    if (idx === 2) {
      if (clk < 2) {
        return CYCLES_PER_LINE;
      }
    } else if ((clk & 1) === 0) {
      return CYCLES_PER_LINE;
    } else if (idx === 1) {
      return 1;
    }
    t.fraction = t.fraction + CYCLES_PER_LINE;
    const quanta = t.fraction >> 3;
    t.fraction = t.fraction & 7;

    return quanta;
  }

  private updateDmaSignal(): void {
    const force = (this.dicr & DICTR_FORCE) !== 0;
    const flags = this.dicr & DICTR_FLAGS;
    const on = force || ((this.dicr & DICTR_MASTER) !== 0 && flags !== 0);
    if (on === this.dicrSignal) {
      return;
    }
    this.dicrSignal = on;
    if (on) {
      this.setPending(3);
    }
  }

  private read(addr: number, size: Width): number {
    const p = addr >>> 0;
    if (p >= CACHE_CTL_BASE && p < CACHE_CTL_BASE + CACHE_CTL_SIZE) {
      let v = 0;
      for (let k = 0; k < size; k++) {
        const i = p - CACHE_CTL_BASE + k;
        v |= (i < CACHE_CTL_SIZE ? this.cacheCtl[i] : 0) << (k * 8);
      }

      return v >>> 0;
    }
    const q = p >= 0xA000_0000 ? p - 0xA000_0000 : p >= 0x8000_0000 ? p - 0x8000_0000 : p;
    if (q < 0x0080_0000) {
      return this.ramLoad(q, size);
    }
    if (q >= 0x1F00_0000) {
      if (q < 0x1F80_0000) {
        return openBus(size);
      }
      if (q < 0x1F80_0400) {
        return this.blobLoad(this.scratch, this.scratchBytes, 0x3FF, q - 0x1F80_0000, size);
      }
      if (q < 0x1F80_1000) {
        return openBus(size);
      }
      if (q < 0x1F80_2000) {
        return this.ioLoad(q, size);
      }
      if (q < 0x1F80_3000) {
        return this.blobLoad(this.exp2, this.exp2Bytes, 0xFFF, q - 0x1F80_2000, size);
      }
      if (q < 0x1FC8_0000) {
        if (q < 0x1FC0_0000) {
          return openBus(size);
        }
        if (this.rom !== null) {
          return this.romLoad(q - 0x1FC0_0000, size);
        }

        return 0;
      }

      return openBus(size);
    }

    return 0;
  }

  private write(addr: number, value: number, size: Width): void {
    const v = value >>> 0;
    const p = addr >>> 0;
    if (p >= CACHE_CTL_BASE && p < CACHE_CTL_BASE + CACHE_CTL_SIZE) {
      for (let k = 0; k < size; k++) {
        const i = p - CACHE_CTL_BASE + k;
        if (i < CACHE_CTL_SIZE) {
          this.cacheCtl[i] = (v >>> (k * 8)) & 0xFF;
        }
      }

      return;
    }
    const q = p >= 0xA000_0000 ? p - 0xA000_0000 : p >= 0x8000_0000 ? p - 0x8000_0000 : p;
    if (q < 0x0080_0000) {
      this.ramStore(q, v, size);

      return;
    }
    if (q >= 0x1F80_0000 && q < 0x1F80_0400) {
      this.blobStore(this.scratch, this.scratchBytes, 0x3FF, q - 0x1F80_0000, v, size);

      return;
    }
    if (q >= 0x1F80_1000 && q < 0x1F80_2000) {
      this.ioStore(q, v, size);

      return;
    }
    if (q >= 0x1F80_2000 && q < 0x1F80_3000) {
      this.blobStore(this.exp2, this.exp2Bytes, 0xFFF, q - 0x1F80_2000, v, size);
    }
  }

  private romLoad(rel: number, size: Width): number {
    const rom = this.rom;
    if (rom === null) {
      return 0;
    }
    let v = 0;
    for (let k = 0; k < size; k++) {
      v |= rom[(rel + k) & (rom.length - 1)] << (k * 8);
    }

    return v >>> 0;
  }

  private ramLoad(p: number, size: Width): number {
    if (size === 4 && (p & 3) === 0) {
      return this.ram[(p & RAM_MASK) >>> 2] >>> 0;
    }
    const base = p & RAM_MASK;
    let v = 0;
    for (let k = 0; k < size; k++) {
      v |= this.ramBytes.getUint8((base + k) & RAM_MASK) << (k * 8);
    }

    return v >>> 0;
  }

  private ramStore(p: number, v: number, size: Width): void {
    if (size === 4 && (p & 3) === 0) {
      this.ram[(p & RAM_MASK) >>> 2] = v >>> 0;

      return;
    }
    const base = p & RAM_MASK;
    for (let k = 0; k < size; k++) {
      this.ramBytes.setUint8((base + k) & RAM_MASK, (v >>> (k * 8)) & 0xFF);
    }
  }

  private blobLoad(blob: Uint32Array, dv: DataView, mask: number, rel: number, size: Width): number {
    const base = rel & mask;
    if (size === 4 && (base & 3) === 0) {
      return blob[base >>> 2] >>> 0;
    }
    let v = 0;
    for (let k = 0; k < size; k++) {
      v |= dv.getUint8((base + k) & mask) << (k * 8);
    }

    return v >>> 0;
  }

  private blobStore(blob: Uint32Array, dv: DataView, mask: number, rel: number, v: number, size: Width): void {
    const base = rel & mask;
    if (size === 4 && (base & 3) === 0) {
      blob[base >>> 2] = v >>> 0;

      return;
    }
    for (let k = 0; k < size; k++) {
      dv.setUint8((base + k) & mask, (v >>> (k * 8)) & 0xFF);
    }
  }

  private ioLoad(q: number, size: Width): number {
    const off = q - IO_BASE;
    const cd = this.devices.cd;
    if (off >= 0x800 && off < 0x804) {
      if (size === 1) {
        return cd.load8(q);
      }
      if (size === 2) {
        return cd.load16(q);
      }

      return cd.load32(q);
    }
    const gpu = this.devices.gpu;
    if (off >= 0x810 && off < 0x820) {
      if (size === 1) {
        return gpu.load8(q);
      }
      if (size === 2) {
        return gpu.load16(q);
      }

      return gpu.load32(q);
    }
    const mdec = this.devices.mdec;
    if ((off >= 0x820 && off < 0x828) || (off >= 0xE20 && off < 0xE28)) {
      if (this.mdecBusyReleaseCycles !== null && (q & 4) !== 0) {
        return this.mdecBusyStatus(q, size);
      }
      if (size === 1) {
        return mdec.load8(q);
      }
      if (size === 2) {
        return mdec.load16(q);
      }

      return mdec.load32(q);
    }
    const spu = this.devices.spu;
    if (off >= 0xC00 && off < 0xE00) {
      if (size === 1) {
        return spu.load8(q);
      }
      if (size === 2) {
        return spu.load16(q);
      }

      return spu.load32(q);
    }
    let v = 0;
    for (let k = 0; k < size; k++) {
      v = (v | (this.ioByte(off + k) << (k * 8))) >>> 0;
    }
    this.ioPostLoad(off);

    return v;
  }

  private ioStore(q: number, v: number, size: Width): void {
    const off = q - IO_BASE;
    const cd = this.devices.cd;
    if (off >= 0x800 && off < 0x804) {
      if (size === 1) {
        cd.store8(q, v);

        return;
      }
      if (size === 2) {
        cd.store16(q, v);

        return;
      }
      cd.store32(q, v);

      return;
    }
    const gpu = this.devices.gpu;
    if (off >= 0x810 && off < 0x820) {
      if (size === 1) {
        gpu.store8(q, v);

        return;
      }
      if (size === 2) {
        gpu.store16(q, v);

        return;
      }
      gpu.store32(q, v);

      return;
    }
    const mdec = this.devices.mdec;
    if ((off >= 0x820 && off < 0x828) || (off >= 0xE20 && off < 0xE28)) {
      if (this.mdecBusyReleaseCycles !== null && (q & 4) !== 0 && size === 4 && (v & 0x8000_0000) !== 0) {
        this.clearMdecBusy();
      }
      if (size === 1) {
        mdec.store8(q, v);

        return;
      }
      if (size === 2) {
        mdec.store16(q, v);

        return;
      }
      mdec.store32(q, v);

      return;
    }
    const spu = this.devices.spu;
    if (off >= 0xC00 && off < 0xE00) {
      if (size === 1) {
        spu.store8(q, v);

        return;
      }
      if (size === 2) {
        spu.store16(q, v);

        return;
      }
      spu.store32(q, v);

      return;
    }
    for (let k = 0; k < size; k++) {
      this.ioStoreByte(off + k, (v >>> (k * 8)) & 0xFF);
    }
  }

  private ioPostLoad(off: number): void {
    if (off >= 0x40 && off < 0x44 && (off & 3) === 0) {
      this.sio.popRx();
    }
    if (off >= 0x100 && off < 0x140 && (off & 0xF) === 4) {
      const t = this.timers[(off - 0x100) >>> 4];
      t.mode &= ~TIMER_FLAGS_MASK;
    }
  }

  private ioByte(off: number): number {
    if (off < 0x40) {
      if (off < 0x30) {
        return (this.memCtrl[off >>> 2] >>> ((off & 3) * 8)) & 0xFF;
      }

      return 0xFF;
    }
    if (off < 0x50) {
      return this.sio.loadByte(off - 0x40);
    }
    if (off < 0x60) {
      return this.sio1Bytes[off - 0x50];
    }
    if (off < 0x64) {
      return (this.ramSize >>> ((off & 3) * 8)) & 0xFF;
    }
    if (off < 0x70) {
      return 0xFF;
    }
    if (off < 0x74) {
      return (this.istat >>> ((off & 3) * 8)) & 0xFF;
    }
    if (off < 0x78) {
      return (this.imask >>> ((off & 3) * 8)) & 0xFF;
    }
    if (off < 0x80) {
      return (this.icache >>> ((off & 3) * 8)) & 0xFF;
    }
    if (off < 0xF0) {
      const ch = (off - 0x80) >>> 4;
      const r = off & 0xF;
      if (r < 4) {
        return (this.madr[ch] >>> (r * 8)) & 0xFF;
      }
      if (r < 8) {
        return (this.bcr[ch] >>> ((r - 4) * 8)) & 0xFF;
      }

      return (this.chcr[ch] >>> ((r - 8) * 8)) & 0xFF;
    }
    if (off < 0xF4) {
      return (this.dpcr >>> ((off & 3) * 8)) & 0xFF;
    }
    if (off < 0xF8) {
      const w = (this.dicr | (this.dicrSignal ? 0x8000_0000 : 0)) >>> 0;

      return (w >>> ((off & 3) * 8)) & 0xFF;
    }
    if (off < 0xFC) {
      return (0x7FFAC68B >>> ((off & 3) * 8)) & 0xFF;
    }
    if (off < 0x100) {
      return (0x00FFFFF7 >>> ((off & 3) * 8)) & 0xFF;
    }
    if (off < 0x140) {
      const row = off - 0x100;
      if (row >= 0x30) {
        return 0xFF;
      }
      const t = this.timers[row >>> 4];
      const r = row & 0xF;
      if (r < 4) {
        return (t.counter >>> (r * 8)) & 0xFF;
      }
      if (r < 8) {
        return (t.mode >>> ((r - 4) * 8)) & 0xFF;
      }
      if (r < 12) {
        return (t.target >>> ((r - 8) * 8)) & 0xFF;
      }

      return 0;
    }

    return 0xFF;
  }

  private ioStoreByte(off: number, byte: number): void {
    if (off < 0x40) {
      if (off < 0x30) {
        const s = (off & 3) * 8;
        const c = off >>> 2;
        this.memCtrl[c] = ((this.memCtrl[c] & ~(0xFF << s)) | ((byte & 0xFF) << s)) >>> 0;
      }

      return;
    }
    if (off < 0x50) {
      this.sio.storeByte(off - 0x40, byte);

      return;
    }
    if (off < 0x60) {
      this.sio1Bytes[off - 0x50] = byte & 0xFF;

      return;
    }
    if (off < 0x64) {
      const s = (off & 3) * 8;
      this.ramSize = ((this.ramSize & ~(0xFF << s)) | ((byte & 0xFF) << s)) >>> 0;

      return;
    }
    if (off < 0x70) {
      return;
    }
    if (off < 0x74) {
      const s = (off & 3) * 8;
      this.istat = (this.istat & ((byte << s) | ~(0xFF << s))) >>> 0;

      return;
    }
    if (off < 0x78) {
      this.imask = mergeByte(this.imask, off & 3, byte, 0xFFFF);

      return;
    }
    if (off < 0x80) {
      this.icache = mergeByte(this.icache, off & 3, byte, 0xFFFF_FFFF);

      return;
    }
    if (off < 0xF0) {
      const ch = (off - 0x80) >>> 4;
      const r = off & 0xF;
      if (r < 4) {
        this.madr[ch] = mergeByte(this.madr[ch], r, byte, 0xFFFF_FFFF);

        return;
      }
      if (r < 8) {
        this.bcr[ch] = mergeByte(this.bcr[ch], r - 4, byte, 0xFFFF_FFFF);

        return;
      }
      const slot = r < 12 ? r - 8 : r - 12;
      this.chcr[ch] = mergeByte(this.chcr[ch], slot, byte, 0xFFFF_FFFF);
      this.maybeStartChannel(ch);

      return;
    }
    if (off < 0xF4) {
      this.dpcr = mergeByte(this.dpcr, off & 3, byte, 0xFFFF_FFFF);
      this.wakeDpcrChannels();

      return;
    }
    if (off < 0xF8) {
      if ((off & 3) < 3) {
        const shift = (off & 3) * 8;
        this.dicr = ((this.dicr & ~(0xFF << shift)) | ((byte & 0xFF) << shift)) >>> 0;
        this.updateDmaSignal();
      } else {
        this.dicr = (this.dicr & ~((byte & 0x7F) << 24)) >>> 0;
        this.updateDmaSignal();
      }

      return;
    }
    if (off < 0x100) {
      return;
    }
    if (off < 0x140) {
      const row = off - 0x100;
      if (row >= 0x30) {
        return;
      }
      const t = this.timers[row >>> 4];
      const r = row & 0xF;
      if (r < 4) {
        t.counter = mergeByte(t.counter, r, byte, 0xFFFF);

        return;
      }
      if (r < 8) {
        t.mode = mergeByte(t.mode, r - 4, byte, 0x1FFF);
        t.mode = (t.mode | 0x400) & ~TIMER_FLAGS_MASK;
        t.counter = 0;
        t.firedOnce = false;
        t.sawEdge = false;
        t.pulseRestore = false;

        return;
      }
      if (r < 12) {
        t.target = mergeByte(t.target, r - 8, byte, 0xFFFF);
      }
    }
  }

  private wakeDpcrChannels(): void {
    for (let ch = 0; ch < 7; ch++) {
      if ((this.dpcr & (1 << (ch * 4 + 3))) !== 0) {
        this.maybeStartChannel(ch);
      }
    }
  }

  private maybeStartChannel(ch: number): void {
    const chcr = this.chcr[ch];
    if ((chcr & CHCR_BUSY) === 0 || this.running[ch]) {
      return;
    }
    const sync = (chcr >>> 9) & 3;
    if (sync === 3) {
      return;
    }
    if (sync === 0 && (chcr & CHCR_TRIGGER) === 0) {
      return;
    }
    if ((this.dpcr & (1 << (ch * 4 + 3))) === 0) {
      return;
    }
    this.chcr[ch] = (this.chcr[ch] & ~CHCR_TRIGGER) >>> 0;
    this.running[ch] = true;
    if (ch === 5) {
      this.log.warn('dma', 'dma5 PIO transfer routed to nonexistent expansion device');
      this.dmaChannelDone(ch);

      return;
    }
    if (ch === 6) {
      this.runOtc();

      return;
    }
    const cfg = this.buildConfig(ch, this.chcr[ch], sync);
    if (sync === 1) {
      this.endMadr[ch] = (cfg.base + cfg.wordsPerBlock * cfg.blockCount * 4) & 0x00FF_FFFF;
      this.endBcrClamp[ch] = true;
    } else if (sync === 2) {
      this.endMadr[ch] = 0x00FF_FFFF;
    }
    if (ch === 1 && cfg.direction === 'toRam') {
      this.startMdecOutDrain(cfg);

      return;
    }
    if (this.dmaWordDivisor !== null && ch === 2 && cfg.direction === 'toDevice' && cfg.mode !== 'linked') {
      this.completionDelay[ch] = Math.max(1, Math.floor((cfg.wordsPerBlock * cfg.blockCount) / this.dmaWordDivisor));
    }
    this.deviceFor(ch).dmaStart(this.channels[ch], cfg, this.ram);
  }

  private startMdecOutDrain(cfg: DmaConfig): void {
    if (this.mdecBusyReleaseCycles !== null) {
      this.clearMdecBusy();
      this.mdecBusy = true;
    }
    this.mdecOutAddr = cfg.base;
    this.mdecOutWords = cfg.wordsPerBlock;
    this.mdecOutBlocks = cfg.blockCount;
    this.mdecOutWaits = 0;
    this.sched.at(this.mdecOutBlockCycles(), () => {
      this.mdecOutStep();
    });
  }

  private mdecBusyStatus(q: number, size: Width): number {
    const word = this.mdecBusy ? MDEC_STATUS_BUSY : 0;
    const shifted = word >>> ((q & 3) * 8);
    if (size === 1) {
      return shifted & 0xFF;
    }
    if (size === 2) {
      return shifted & 0xFFFF;
    }

    return shifted >>> 0;
  }

  private clearMdecBusy(): void {
    if (this.mdecBusyRelease !== null) {
      this.sched.cancel(this.mdecBusyRelease);
      this.mdecBusyRelease = null;
    }
    this.mdecBusy = false;
  }

  private releaseMdecBusyLater(): void {
    if (this.mdecBusyReleaseCycles === null) {
      return;
    }
    if (this.mdecBusyRelease !== null) {
      this.sched.cancel(this.mdecBusyRelease);
    }
    this.mdecBusyRelease = this.sched.at(this.mdecBusyReleaseCycles, () => {
      this.mdecBusyRelease = null;
      this.mdecBusy = false;
    });
  }

  private mdecOutBlockCycles(): number {
    const divisor = this.dmaWordDivisor ?? 1;

    return Math.max(1, Math.floor(this.mdecOutWords / divisor));
  }

  private mdecOutStep(): void {
    if (!this.running[1] || (this.chcr[1] & CHCR_BUSY) === 0) {
      this.running[1] = false;

      return;
    }
    const mdec = this.devices.mdec;
    if ((mdec.load32(MDEC_STATUS_PORT) & MDEC_OUT_FIFO_EMPTY) !== 0) {
      if (this.mdecOutWaits < MDEC_OUT_MAX_WAITS) {
        this.mdecOutWaits += 1;
        this.sched.at(MDEC_OUT_WAIT_CYCLES, () => {
          this.mdecOutStep();
        });

        return;
      }
    }
    const words = this.mdecOutWords;
    const dst = this.ram;
    let addr = this.mdecOutAddr;
    for (let k = 0; k < words; k++) {
      dst[addr >>> 2] = mdec.dmaReadWord() >>> 0;
      addr = (addr + 4) & RAM_MASK;
    }
    this.mdecOutAddr = addr;
    this.mdecOutBlocks -= 1;
    if (this.mdecOutBlocks <= 0) {
      this.dmaChannelDone(1);

      return;
    }
    this.sched.at(this.mdecOutBlockCycles(), () => {
      this.mdecOutStep();
    });
  }

  private buildConfig(ch: number, chcr: number, sync: number): DmaConfig {
    const direction: 'toDevice' | 'toRam' = (chcr & 1) !== 0 ? 'toDevice' : 'toRam';
    const step: 1 | 4 = (chcr & 2) !== 0 ? 1 : 4;
    const mode: DmaMode = sync === 2 ? 'linked' : 'manual';
    const bcr = this.bcr[ch];
    let wordsPerBlock: number;
    let blockCount: number;
    if (sync === 2) {
      wordsPerBlock = 0;
      blockCount = 0;
    } else if (sync === 1) {
      const bs = bcr & 0xFFFF;
      const ba = (bcr >>> 16) & 0xFFFF;
      wordsPerBlock = bs === 0 ? 0x1_0000 : bs;
      blockCount = ba === 0 ? 0x1_0000 : ba;
    } else {
      const bc = bcr & 0xFFFF;
      wordsPerBlock = bc === 0 ? 0x1_0000 : bc;
      blockCount = 1;
    }

    return {
      base: this.madr[ch] & 0x1F_FFFC,
      wordsPerBlock,
      blockCount,
      step,
      direction,
      mode,
      chopper: (chcr & 0x100) !== 0,
      enable: true,
    };
  }

  private deviceFor(ch: number): IoDevice & DmaDevice {
    if (ch === 2) {
      return this.devices.gpu;
    }
    if (ch === 3) {
      return this.devices.cd;
    }
    if (ch === 4) {
      return this.devices.spu;
    }

    return this.devices.mdec;
  }

  private runOtc(): void {
    const rawCount = this.bcr[6] & 0xFFFF;
    const count = rawCount === 0 ? 0x1_0000 : rawCount;
    const base = this.madr[6] & 0x1F_FFFC;
    const words = this.ram;
    for (let i = 0; i < count; i++) {
      const addr = (base - i * 4) & RAM_MASK;
      words[addr >>> 2] = i === count - 1 ? 0x00FF_FFFF : (addr - 4) & 0x00FF_FFFF;
    }
    this.dmaChannelDone(6);
  }
}