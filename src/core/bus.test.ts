import { beforeEach, describe, expect, it } from 'bun:test';
import type { DmaChannel, DmaConfig, DmaDevice, IoDevice, Scheduler } from './contracts';
import { RAM_SIZE } from './contracts';
import { RingLogger } from './logger';
import { IrqRouter } from './irq';
import { PadState } from './pad';
import { Bus, type IoDeviceSet } from './bus';
import { HARDWARE_PROFILE, PSXJIN_PROFILE } from './timingProfile';
import type { MdecUnit } from './contracts';

const IO = 0x1F801000;
const SECTOR_WORDS = 0x200;
const CHCR_BUSY_MASK = 0x01000000;

interface SchedulerItem {
  handle: object;
  deadline: number;
  fn: () => void;
}

class FakeScheduler implements Scheduler {
  now = 0;

  private readonly items: Array<SchedulerItem> = [];

  at(cyclesFromNow: number, fn: () => void): object {
    const handle: { id: number } = { id: this.items.length + 1 };
    const item: SchedulerItem = { handle, deadline: this.now + cyclesFromNow, fn };
    this.items.push(item);

    return handle;
  }

  cancel(handle: object): void {
    const i = this.items.findIndex((it) => it.handle === handle);
    if (i >= 0) {
      this.items.splice(i, 1);
    }
  }

  advance(cycles: number): void {
    const target = this.now + cycles;
    for (;;) {
      let pick = -1;
      let best = Number.MAX_SAFE_INTEGER;
      for (let i = 0; i < this.items.length; i++) {
        const it = this.items[i];
        if (it.deadline <= target && it.deadline < best) {
          pick = i;
          best = it.deadline;
        }
      }
      if (pick < 0) {
        break;
      }
      const item = this.items[pick];
      this.items.splice(pick, 1);
      this.now = item.deadline;
      item.fn();
    }
    this.now = target;
  }
}

class FakeDmaDevice implements IoDevice, DmaDevice {
  readonly started: Array<{ ch: number; cfg: DmaConfig }> = [];
  readonly buffer: Array<number> = [];

  constructor(private readonly irq: IrqRouter) {}

  load32(): number {
    return 0;
  }

  load16(): number {
    return 0;
  }

  load8(): number {
    return 0;
  }

  store32(): void {}

  store16(): void {}

  store8(): void {}

  dmaStart(channel: DmaChannel, config: DmaConfig, ram: Uint32Array): void {
    this.started.push({ ch: channel.id, cfg: config });
    if (config.direction === 'toRam') {
      for (let k = 0; k < config.wordsPerBlock; k++) {
        ram[((config.base + k * 4) & 0x1FFFFF) >>> 2] = (0x5EED0000 + k) >>> 0;
      }
      this.irq.dmaDone(channel.id);

      return;
    }
    for (let k = 0; k < config.wordsPerBlock * config.blockCount; k++) {
      this.buffer.push(ram[((config.base + k * 4) & 0x1FFFFF) >>> 2]);
    }
    this.irq.dmaDone(channel.id);
  }
}

const MDEC_OUT_FIFO_EMPTY = 0x80000000;

class FakeMdec implements IoDevice, MdecUnit {
  private readonly fifo: Array<number> = [];

  get busy(): boolean {
    return false;
  }

  pushOut(word: number): void {
    this.fifo.push(word);
  }

  dmaReadWord(): number {
    const w = this.fifo.shift();
    if (w === undefined) {

      return 0;
    }

    return w;
  }

  load32(addr: number): number {
    if ((addr & ~3) === 0x1F801824 || (addr & ~3) === 0x1F801E24) {
      if (this.fifo.length === 0) {
        return MDEC_OUT_FIFO_EMPTY;
      }

      return 0;
    }

    return 0;
  }

  load16(): number {
    return 0;
  }

  load8(): number {
    return 0;
  }

  store32(): void {}

  store16(): void {}

  store8(): void {}

  dmaStart(): void {}
}

function makeBus(): { bus: Bus; sched: FakeScheduler; router: IrqRouter; device: FakeDmaDevice; mdec: FakeMdec; ram: Uint32Array; pad: PadState } {
  const sched = new FakeScheduler();
  const router = new IrqRouter();
  const device = new FakeDmaDevice(router);
  const mdec = new FakeMdec();
  const ram = new Uint32Array(RAM_SIZE / 4);
  const pad = new PadState();
  const devices: IoDeviceSet = { gpu: device, cd: device, spu: device, mdec, pad };
  const bus = new Bus(sched, new RingLogger(), ram, devices);
  router.sink = (line) => bus.raiseIrq(line);
  router.dmaDoneSink = (ch) => bus.dmaChannelDone(ch);

  return { bus, sched, router, device, mdec, ram, pad };
}

const settlePad = (sched: FakeScheduler): void => {
  sched.advance(2000);
  sched.advance(1000);
};

describe('Bus interrupt status', () => {
  it('raise sets bits, mask gates irqActive as a pending mask, write-0 acks, write-1 keeps', () => {
    const { bus } = makeBus();
    bus.store32(IO + 0x74, 1 << 3);
    bus.raiseIrq(3);
    bus.raiseIrq(4);
    expect(bus.irqActive()).toBe(8);
    expect(bus.load16(IO + 0x70)).toBe(0x18);
    bus.store32(IO + 0x70, 0x08);
    expect(bus.irqActive()).toBe(8);
    expect(bus.load16(IO + 0x70)).toBe(0x08);
    bus.store32(IO + 0x70, 0);
    expect(bus.irqActive()).toBe(0);
    bus.store32(IO + 0x70, 0xFFFF_FFFF);
    expect(bus.irqActive()).toBe(0);
    bus.raiseIrq(4);
    bus.store32(IO + 0x74, 1 << 4);
    expect(bus.irqActive()).toBe(0x10);
  });
});

describe('Bus DMA', () => {
  let harness: ReturnType<typeof makeBus>;

  beforeEach(() => {
    harness = makeBus();
  });

  it('sync-mode-1 to-device transfer delivers config, clears busy, sets DICR + ISTAT.3', () => {
    const { bus, ram, device } = harness;
    for (let k = 0; k < 32; k++) {
      ram[(0x1000 >>> 2) + k] = 0x11000000 + k;
    }
    bus.store32(IO + 0xF0, 0x07654321 | (1 << 19));
    bus.store32(IO + 0xF4, (1 << 20) | (1 << 23));
    bus.store32(IO + 0xC0, 0x00001000);
    bus.store32(IO + 0xC4, (2 << 16) | 16);
    bus.store32(IO + 0xC8, 0x01000201);
    expect(device.started.length).toBe(1);
    expect(device.started[0]).toEqual({
      ch: 4,
      cfg: {
        base: 0x1000, wordsPerBlock: 16, blockCount: 2, step: 4,
        direction: 'toDevice', mode: 'manual', chopper: false, enable: true,
      },
    });
    expect(device.buffer.length).toBe(32);
    expect(device.buffer[0]).toBe(0x11000000);
    expect(bus.load32(IO + 0xC8)).toBe(0x00000201);
    expect(bus.load32(IO + 0xC0)).toBe(0x1080);
    expect(bus.load32(IO + 0xC4)).toBe(0x0010);
    expect(bus.load32(IO + 0xF4)).toBe(0x9090_0000);
    expect(bus.load16(IO + 0x70) & 8).toBe(8);
    bus.store32(IO + 0xF4, 0x0090_0000 | (1 << 28));
    expect(bus.load32(IO + 0xF4)).toBe(0x0090_0000);
    expect(bus.load16(IO + 0x70) & 8).toBe(8);
  });

  it('a byte write to DICR bits 16-23 keeps the pending channel flags in bits 24-30', () => {
    const { bus } = harness;
    bus.store32(IO + 0xF0, 0x07654321 | (1 << 19));
    bus.store32(IO + 0xF4, (1 << 20) | (1 << 23));
    bus.store32(IO + 0xC0, 0x00001000);
    bus.store32(IO + 0xC4, (1 << 16) | 16);
    bus.store32(IO + 0xC8, 0x01000201);
    expect(bus.load32(IO + 0xF4) >>> 24).toBe(0x90);
    bus.store8(IO + 0xF6, 0x90);
    expect(bus.load32(IO + 0xF4) >>> 24).toBe(0x90);
    bus.store8(IO + 0xF7, 0x10);
    expect(bus.load32(IO + 0xF4) >>> 24).toBe(0x00);
  });

  it('sync-mode-0 to-RAM transfer accepts the kernel CD sequence shape and leaves MADR', () => {
    const { bus, ram, device } = harness;
    bus.store32(IO + 0xF0, 0x07654321 | 0x8000);
    bus.store32(IO + 0xF4, 0x0088_0000);
    bus.store32(IO + 0xB0, 0xA0010000);
    bus.store32(IO + 0xB4, 0x00010200);
    bus.store32(IO + 0xB8, 0x11000000);
    expect(device.started.length).toBe(1);
    expect(device.started[0]).toEqual({
      ch: 3,
      cfg: {
        base: 0x00010000, wordsPerBlock: SECTOR_WORDS, blockCount: 1, step: 4,
        direction: 'toRam', mode: 'manual', chopper: false, enable: true,
      },
    });
    expect(ram[0x00010000 >>> 2]).toBe(0x5EED0000);
    expect(bus.load32(IO + 0xB8)).toBe(0);
    expect(bus.load32(IO + 0xB0)).toBe(0xA0010000);
    expect(bus.load32(IO + 0xF4)).toBe(0x8888_0000);
  });

  it('channel without DPCR master enable stays armed until DPCR wakes it', () => {
    const { bus, device } = harness;
    bus.store32(IO + 0xA8, 0x01000401);
    expect(device.started.length).toBe(0);
    expect(bus.load32(IO + 0xA8)).toBe(0x01000401);
    bus.store32(IO + 0xF0, 0x07654321 | 0x800);
    expect(device.started.length).toBe(1);
    expect(device.started[0].ch).toBe(2);
    expect(device.started[0].cfg.mode).toBe('linked');
    expect(bus.load32(IO + 0xA8)).toBe(0x00000401);
  });

  it('unsolicited completion is ignored', () => {
    const { bus, router } = harness;
    bus.store32(IO + 0xF4, 0x0090_0000);
    router.dmaDone(4);
    expect(bus.load32(IO + 0xF4) & 0x8000_0000).toBe(0);
    expect(bus.load16(IO + 0x70) & 8).toBe(0);
  });

  it('bus bridges mdec-out: waits on DRQ, drains blocks via dmaReadWord into RAM, completes', () => {
    const { bus, mdec, sched, ram } = harness;
    bus.store32(IO + 0xF0, 0x07654321 | 0x80);
    bus.store32(IO + 0xF4, (1 << 17) | (1 << 23));
    for (let k = 0; k < 3; k++) {
      mdec.pushOut(0x2A00 + k);
    }
    bus.store32(IO + 0x90, 0x00002000);
    bus.store32(IO + 0x94, (2 << 16) | 3);
    bus.store32(IO + 0x98, 0x01000200);
    sched.advance(100);
    expect(bus.load32(IO + 0x98) & CHCR_BUSY_MASK).toBe(CHCR_BUSY_MASK);
    for (let k = 0; k < 3; k++) {
      mdec.pushOut(0x2A03 + k);
    }
    sched.advance(200000);
    expect(ram[0x2000 >>> 2]).toBe(0x2A00);
    expect(ram[0x2004 >>> 2]).toBe(0x2A01);
    expect(ram[0x2008 >>> 2]).toBe(0x2A02);
    expect(ram[0x200C >>> 2]).toBe(0x2A03);
    expect(ram[0x2010 >>> 2]).toBe(0x2A04);
    expect(ram[0x2014 >>> 2]).toBe(0x2A05);
    expect(bus.load32(IO + 0x98)).toBe(0x00000200);
    expect(bus.load16(IO + 0x70) & 8).toBe(8);
  });

  it('an underfed mdec-out transfer still completes instead of hanging', () => {
    const { bus, mdec, sched, ram } = harness;
    bus.store32(IO + 0xF0, 0x07654321 | 0x80);
    for (let k = 0; k < 3; k++) {
      mdec.pushOut(0x11 + k);
    }
    bus.store32(IO + 0x90, 0x00002000);
    bus.store32(IO + 0x94, (2 << 16) | 3);
    bus.store32(IO + 0x98, 0x01000200);
    sched.advance(200000);
    expect(ram[0x2000 >>> 2]).toBe(0x11);
    expect(ram[0x2008 >>> 2]).toBe(0x13);
    expect(ram[0x200C >>> 2]).toBe(0);
    expect(bus.load32(IO + 0x98)).toBe(0x00000200);
  });

  it('OTC writes the SPX reverse-chain example and flags channel 6 only when enabled', () => {
    const { bus } = harness;
    bus.store32(IO + 0xF0, 0x07654321 | (1 << 27));
    bus.store32(IO + 0xE0, 0x8012300C);
    bus.store32(IO + 0xE4, 4);
    bus.store32(IO + 0xE8, 0x11000002);
    expect(bus.load32(0x80123000)).toBe(0x00FFFFFF);
    expect(bus.load32(0x80123004)).toBe(0x00123000);
    expect(bus.load32(0x80123008)).toBe(0x00123004);
    expect(bus.load32(0x8012300C)).toBe(0x00123008);
    expect(bus.load32(IO + 0xE8)).toBe(0x00000002);
    expect(bus.load32(IO + 0xF4) & 0x8000_0000).toBe(0);
    bus.store32(IO + 0xF4, (1 << 22) | (1 << 23));
    bus.store32(IO + 0xE0, 0x8012300C);
    bus.store32(IO + 0xE4, 4);
    bus.store32(IO + 0xE8, 0x11000002);
    expect(bus.load32(IO + 0xF4)).toBe(0xC0C0_0000);
  });
});

describe('Bus timers', () => {
  let harness: ReturnType<typeof makeBus>;

  beforeEach(() => {
    harness = makeBus();
  });

  const tickLines = (bus: Bus, count: number): void => {
    for (let i = 0; i < count; i++) {
      bus.lineTick();
    }
  };

  it('timer1 hblank clock counts lines, fires on target with reset, repeats', () => {
    const { bus } = harness;
    bus.store32(IO + 0x74, 1 << 5);
    bus.store16(IO + 0x118, 3);
    bus.store16(IO + 0x114, 0x0158);
    for (let i = 0; i < 3; i++) {
      bus.lineTick();
    }
    expect(bus.load16(IO + 0x70) & 0x20).toBe(0x20);
    expect(bus.load16(IO + 0x110)).toBe(0);
    bus.store32(IO + 0x70, 0);
    for (let i = 0; i < 3; i++) {
      bus.lineTick();
    }
    expect(bus.load16(IO + 0x70) & 0x20).toBe(0x20);
  });

  it('timer1 toggle mode raises on every second event; one-shot stops until mode rewrite', () => {
    const { bus } = harness;
    bus.store32(IO + 0x74, 1 << 5);
    bus.store16(IO + 0x118, 3);
    bus.store16(IO + 0x114, 0x01D8);
    for (let i = 0; i < 3; i++) {
      bus.lineTick();
    }
    expect(bus.load16(IO + 0x70) & 0x20).toBe(0x20);
    bus.store32(IO + 0x70, 0);
    for (let i = 0; i < 3; i++) {
      bus.lineTick();
    }
    expect(bus.load16(IO + 0x70) & 0x20).toBe(0);
    for (let i = 0; i < 3; i++) {
      bus.lineTick();
    }
    expect(bus.load16(IO + 0x70) & 0x20).toBe(0x20);
  });

  it('timer2 one-eighth clock crosses target; reset-on-target variant restarts past it; sync 0 stops', () => {
    const { bus } = harness;
    bus.store32(IO + 0x74, 1 << 6);
    bus.store16(IO + 0x128, 0x0100);
    bus.store16(IO + 0x124, 0x0210);
    tickLines(bus, 1);
    expect(bus.load16(IO + 0x70) & 0x40).toBe(0x40);
    expect(bus.load16(IO + 0x120)).toBe(268);
    expect(bus.load16(IO + 0x124) & 0x800).toBe(0x800);
    bus.store32(IO + 0x70, 0);
    bus.store16(IO + 0x124, 0x0218);
    tickLines(bus, 1);
    expect(bus.load16(IO + 0x120)).toBe(12);
    bus.store32(IO + 0x70, 0);
    bus.store16(IO + 0x124, 0x0201);
    tickLines(bus, 5);
    expect(bus.load16(IO + 0x70) & 0x40).toBe(0);
    expect(bus.load16(IO + 0x120)).toBe(0);
  });

  it('timer1 sync mode 0 pauses during vblank lines only', () => {
    const { bus } = harness;
    bus.store16(IO + 0x114, 0x0001);
    bus.line = 1;
    bus.lineTick();
    bus.lineTick();
    expect(bus.load16(IO + 0x110)).toBe(2 * 2150);
    bus.line = 250;
    bus.lineTick();
    expect(bus.load16(IO + 0x110)).toBe(2 * 2150);
    bus.line = 5;
    bus.lineTick();
    expect(bus.load16(IO + 0x110)).toBe(3 * 2150);
  });

  it('timer1 sync mode 2 counts only between vblank start and frame end', () => {
    const { bus } = harness;
    bus.store16(IO + 0x114, 0x0005);
    bus.line = 242;
    bus.lineTick();
    expect(bus.load16(IO + 0x110)).toBe(0);
    bus.line = 250;
    bus.lineTick();
    expect(bus.load16(IO + 0x110)).toBe(2150);
    bus.line = 262;
    bus.lineTick();
    expect(bus.load16(IO + 0x110)).toBe(2 * 2150);
    bus.line = 1;
    bus.lineTick();
    expect(bus.load16(IO + 0x110)).toBe(2 * 2150);
  });
});

describe('Bus memory map', () => {
  let bus: Bus;

  beforeEach(() => {
    bus = makeBus().bus;
  });

  it('KUSEG/KSEG0/KSEG1 mirror RAM and the scratchpad decodes into the IO region', () => {
    bus.store32(0x00000010, 0x12345678);
    expect(bus.load32(0x80000010)).toBe(0x12345678);
    expect(bus.load32(0xA0000010)).toBe(0x12345678);
    bus.store32(0x1F800000, 0xAABBCCDD);
    expect(bus.load32(0x9F800000)).toBe(0xAABBCCDD);
    expect(bus.load32(0xBF800000)).toBe(0xAABBCCDD);
    bus.store32(0x00200010, 0x0000DEAD);
    expect(bus.load32(0x00000010)).toBe(0x0000DEAD);
  });

  it('expansion regions read open bus, BIOS reads zeros, holes follow IO conventions', () => {
    bus.store32(0x9F000010, 1);
    expect(bus.load32(0x9F000010)).toBe(0xFFFF_FFFF);
    expect(bus.load32(0xBFC00004)).toBe(0);
    bus.store16(0xBFC00004, 5);
    expect(bus.load32(0xBFC00004)).toBe(0);
    expect(bus.load8(0x1F801700)).toBe(0xFF);
    expect(bus.load16(0x1F801700)).toBe(0xFFFF);
    expect(bus.load32(0x1F801700)).toBe(0xFFFF_FFFF);
    expect(bus.load8(0x1F801131)).toBe(0xFF);
    expect(bus.load32(0x9F801330)).toBe(0xFFFF_FFFF);
    expect(bus.load32(0x00900000)).toBe(0);
    expect(bus.load32(0xBFA0000C)).toBe(0xFFFF_FFFF);
  });

  it('EXP2 work area and cache control ports store and return', () => {
    bus.store32(0x9F802004, 0x0000CAFE);
    expect(bus.load32(0x9F802004)).toBe(0x0000CAFE);
    bus.store32(0xFFFE0130, 0x0001E988);
    expect(bus.load32(0xFFFE0130)).toBe(0x0001E988);
  });

  it('memory control boots with nocash defaults and DMA CHCR mirrors to +0xC', () => {
    expect(bus.load32(IO + 0x00)).toBe(0x1F000000);
    expect(bus.load32(IO + 0x14)).toBe(0x200931E1);
    expect(bus.load32(IO + 0x18)).toBe(0x00020943);
    expect(bus.load32(IO + 0x20)).toBe(0x00031125);
    expect(bus.load32(IO + 0x60)).toBe(0x00000B88);
    expect(bus.load32(IO + 0xF0)).toBe(0x07654321);
    bus.store32(IO + 0xA8, 0x01000401);
    expect(bus.load32(IO + 0xAC)).toBe(0x01000401);
    expect(bus.load16(IO + 0x54)).toBe(0);
  });
});

describe('Bus SIO0 pad protocol', () => {
  let harness: ReturnType<typeof makeBus>;

  beforeEach(() => {
    harness = makeBus();
    harness.pad.buttons = 0x4000;
    harness.bus.store16(IO + 0x4A, 0x1003);
  });

  it('answers the kernel poll sequence 01 42 00 00 00 with FF 41 5A lo hi', () => {
    const { bus, sched } = harness;
    bus.store8(IO + 0x40, 0x01);
    settlePad(sched);
    expect(bus.load16(IO + 0x44) & 2).toBe(2);
    expect(bus.load8(IO + 0x40)).toBe(0xFF);
    expect(bus.load16(IO + 0x44) & 2).toBe(0);
    bus.store8(IO + 0x40, 0x42);
    settlePad(sched);
    expect(bus.load8(IO + 0x40)).toBe(0x41);
    expect(bus.load16(IO + 0x70) & 0x80).toBe(0x80);
    bus.store32(IO + 0x70, 0xFFFF_FF7F);
    expect(bus.load16(IO + 0x44) & 0x200).toBe(0x200);
    bus.store16(IO + 0x4A, 0x1013);
    expect(bus.load16(IO + 0x44) & 0x200).toBe(0);
    bus.store8(IO + 0x40, 0x00);
    settlePad(sched);
    expect(bus.load8(IO + 0x40)).toBe(0x5A);
    bus.store8(IO + 0x40, 0x00);
    settlePad(sched);
    expect(bus.load8(IO + 0x40)).toBe(0xFF);
    bus.store32(IO + 0x70, 0);
    bus.store8(IO + 0x40, 0x00);
    settlePad(sched);
    expect(bus.load8(IO + 0x40)).toBe(0xBF);
    expect(bus.load16(IO + 0x70) & 0x80).toBe(0);
  });

  it('a connected pad acknowledges the 01h select byte so the kernel driver continues', () => {
    const { bus, sched } = harness;
    bus.store8(IO + 0x40, 0x01);
    settlePad(sched);
    expect(bus.load16(IO + 0x70) & 0x80).toBe(0x80);
    expect(bus.load8(IO + 0x40)).toBe(0xFF);
    bus.store32(IO + 0x70, 0);
    bus.store16(IO + 0x4A, 0x3003);
    bus.store8(IO + 0x40, 0x01);
    settlePad(sched);
    expect(bus.load16(IO + 0x70) & 0x80).toBe(0);
  });

  it('CTRL reads back the ACK interrupt enable bit and hides only the write-only ACK and RESET bits', () => {
    const { bus } = harness;
    bus.store16(IO + 0x4A, 0x1013);
    expect(bus.load16(IO + 0x4A)).toBe(0x1003);
    bus.store16(IO + 0x4A, 0x0040);
    expect(bus.load16(IO + 0x4A) & 0x50).toBe(0);
  });

  it('DATA exposes RX byte and three preview entries and pops one entry per read', () => {
    const { bus, sched } = harness;
    for (const cmd of [0x01, 0x42, 0x00]) {
      bus.store8(IO + 0x40, cmd);
      settlePad(sched);
    }
    expect(bus.load32(IO + 0x40)).toBe(0xFF5A41FF);
    expect(bus.load8(IO + 0x40)).toBe(0x41);
    expect(bus.load8(IO + 0x40)).toBe(0x5A);
    expect(bus.load8(IO + 0x40)).toBe(0xFF);
    expect(bus.load8(IO + 0x40)).toBe(0xFF);
  });

  it('slot 2 selection answers idle with no ACK or IRQ7 for both pad and card commands', () => {
    const { bus, sched } = harness;
    bus.store16(IO + 0x4A, 0x3003);
    for (const cmd of [0x81, 0x01]) {
      bus.store8(IO + 0x40, cmd);
      settlePad(sched);
      expect(bus.load16(IO + 0x70) & 0x80).toBe(0);
      expect(bus.load8(IO + 0x40)).toBe(0xFF);
      bus.store8(IO + 0x40, 0x52);
      settlePad(sched);
      settlePad(sched);
      expect(bus.load16(IO + 0x70) & 0x80).toBe(0);
      expect(bus.load8(IO + 0x40)).toBe(0xFF);
    }
  });

  it('CTRL reset (bit6) clears mode, baud, FIFO and pending state', () => {
    const { bus, sched } = harness;
    bus.store8(IO + 0x40, 0x01);
    bus.store16(IO + 0x4A, 0x0040);
    expect(bus.load16(IO + 0x48)).toBe(0);
    expect(bus.load16(IO + 0x4E)).toBe(0);
    settlePad(sched);
    settlePad(sched);
    expect(bus.load16(IO + 0x44) & 2).toBe(0);
  });
});
describe('Bus BIOS ROM mapping', () => {
  const buildRom = (): Uint8Array => {
    const rom = new Uint8Array(0x80000);
    rom.forEach((_, i) => {
      rom[i] = (i * 7 + 3) & 0xFF;
    });

    return rom;
  };

  const makeRomBus = (rom: Uint8Array): Bus => {
    const router = new IrqRouter();
    const device = new FakeDmaDevice(router);
    const devices: IoDeviceSet = { gpu: device, cd: device, spu: device, mdec: new FakeMdec(), pad: new PadState() };

    return new Bus(new FakeScheduler(), new RingLogger(), new Uint32Array(RAM_SIZE / 4), devices, rom);
  };

  it('reads 8/16/32 bits through KUSEG, KSEG0 and KSEG1 mirrors', () => {
    const rom = buildRom();
    const bus = makeRomBus(rom);
    const word = (rom[0x104] | (rom[0x105] << 8) | (rom[0x106] << 16) | (rom[0x107] << 24)) >>> 0;
    for (const base of [0x1FC00000, 0x9FC00000, 0xBFC00000]) {
      expect(bus.load32(base + 0x104)).toBe(word);
      expect(bus.load16(base + 0x106)).toBe(word >>> 16);
      expect(bus.load8(base + 0x105)).toBe(rom[0x105]);
    }
  });

  it('ignores stores to the ROM region', () => {
    const rom = buildRom();
    const bus = makeRomBus(rom);
    const before = bus.load32(0xBFC00000);
    bus.store32(0xBFC00000, 0xDEADBEEF);
    expect(bus.load32(0xBFC00000)).toBe(before);
  });

  it('reads 0xFF from expansion region 1 so no PIO cart is detected', () => {
    const bus = makeRomBus(buildRom());
    expect(bus.load8(0x1F000084)).toBe(0xFF);
  });

  it('keeps returning 0 for the ROM region when no ROM is given', () => {
    const { bus } = makeBus();
    expect(bus.load32(0xBFC00000)).toBe(0);
  });
});


describe('Bus SIO0 memory card', () => {
  const SETTLE_LONG = 40_000;

  const exchange = (h: ReturnType<typeof makeBus>, byte: number, wait = 3000): number => {
    h.bus.store8(IO + 0x40, byte);
    h.sched.advance(wait);

    return h.bus.load8(IO + 0x40);
  };

  const begin = (h: ReturnType<typeof makeBus>, command: number): number => {
    h.bus.store16(IO + 0x4A, 0x1003);
    exchange(h, 0x81);

    return exchange(h, command);
  };

  const readSector = (h: ReturnType<typeof makeBus>, sector: number): Array<number> => {
    const out: Array<number> = [begin(h, 0x52)];
    out.push(exchange(h, 0x00), exchange(h, 0x00));
    out.push(exchange(h, sector >> 8), exchange(h, sector & 0xFF, SETTLE_LONG));
    for (let i = 0; i < 2 + 2 + 128 + 2; i++) {
      out.push(exchange(h, 0x00));
    }

    return out;
  };

  const writeSector = (h: ReturnType<typeof makeBus>, sector: number, data: Array<number>, checksum: number): number => {
    begin(h, 0x57);
    exchange(h, 0x00);
    exchange(h, 0x00);
    exchange(h, sector >> 8);
    exchange(h, sector & 0xFF);
    for (const b of data) {
      exchange(h, b);
    }
    exchange(h, checksum);
    exchange(h, 0x00);
    exchange(h, 0x00);

    return exchange(h, 0x00);
  };

  it('reads the header frame of a fresh card: MC, checksum 0Eh and end byte G', () => {
    const h = makeBus();
    const r = readSector(h, 0);
    expect(r[0]).toBe(0x08);
    expect(r[1]).toBe(0x5A);
    expect(r[2]).toBe(0x5D);
    expect(r[5]).toBe(0x5C);
    expect(r[6]).toBe(0x5D);
    expect(r[7]).toBe(0x00);
    expect(r[8]).toBe(0x00);
    const data = r.slice(9, 9 + 128);
    expect(data[0]).toBe(0x4D);
    expect(data[1]).toBe(0x43);
    expect(data[0x7F]).toBe(0x0E);
    expect(r[9 + 128]).toBe(data.reduce((a, b) => a ^ b, 0));
    expect(r[9 + 129]).toBe(0x47);
  });

  it('fresh card directory frames are free (A0h) with a valid XOR checksum and no broken sectors', () => {
    const h = makeBus();
    const dir = readSector(h, 1).slice(9, 9 + 128);
    expect(dir[0]).toBe(0xA0);
    expect(dir.slice(8, 10)).toEqual([0xFF, 0xFF]);
    expect(dir[0x7F]).toBe(dir.slice(0, 0x7F).reduce((a, b) => a ^ b, 0));
    const broken = readSector(h, 16).slice(9, 9 + 128);
    expect(broken.slice(0, 4)).toEqual([0xFF, 0xFF, 0xFF, 0xFF]);
  });

  it('a good write is read back and clears the unread-directory flag bit', () => {
    const h = makeBus();
    const data = Array.from({ length: 128 }, (_, i) => (i * 3 + 1) & 0xFF);
    const checksum = data.reduce((a, b) => a ^ b, 0x00 ^ 0x3F);
    expect(writeSector(h, 0x3F, data, checksum)).toBe(0x47);
    const r = readSector(h, 0x3F);
    expect(r[0]).toBe(0x00);
    expect(r.slice(9, 9 + 128)).toEqual(data);
  });

  it('a write with a bad checksum ends with N and leaves the sector untouched', () => {
    const h = makeBus();
    const data = Array.from({ length: 128 }, () => 0x11);
    expect(writeSector(h, 0x10, data, 0x00)).toBe(0x4E);
    expect(readSector(h, 0x10).slice(9, 9 + 4)).toEqual([0xFF, 0xFF, 0xFF, 0xFF]);
  });

  it('an invalid sector number is answered with FFFFh and no data', () => {
    const h = makeBus();
    begin(h, 0x52);
    exchange(h, 0x00);
    exchange(h, 0x00);
    exchange(h, 0x04);
    exchange(h, 0x00, SETTLE_LONG);
    exchange(h, 0x00);
    exchange(h, 0x00);
    expect(exchange(h, 0x00)).toBe(0xFF);
    expect(exchange(h, 0x00)).toBe(0xFF);
  });

  it('get-id replies 5Ch 5Dh 04h 00h 00h 80h', () => {
    const h = makeBus();
    begin(h, 0x53);
    exchange(h, 0x00);
    exchange(h, 0x00);
    const rest = [0, 0, 0, 0, 0, 0].map(() => exchange(h, 0x00));
    expect(rest).toEqual([0x5C, 0x5D, 0x04, 0x00, 0x00, 0x80]);
  });

  it('ACKs every byte except the last, and delays the first ACK after a read command', () => {
    const h = makeBus();
    h.bus.store16(IO + 0x4A, 0x1003);
    exchange(h, 0x81);
    expect(h.bus.load16(IO + 0x70) & 0x80).toBe(0x80);
    h.bus.store32(IO + 0x70, 0);
    begin(h, 0x53);
    h.bus.store32(IO + 0x70, 0);
    for (let i = 0; i < 8; i++) {
      h.bus.store8(IO + 0x40, 0x00);
      h.sched.advance(3000);
      expect(h.bus.load16(IO + 0x70) & 0x80).toBe(i < 7 ? 0x80 : 0);
      h.bus.store32(IO + 0x70, 0);
    }
    const r = makeBus();
    r.bus.store16(IO + 0x4A, 0x1003);
    exchange(r, 0x81);
    exchange(r, 0x52);
    exchange(r, 0x00);
    exchange(r, 0x00);
    exchange(r, 0x00);
    exchange(r, 0x00);
    r.bus.store32(IO + 0x70, 0);
    r.bus.store8(IO + 0x40, 0x00);
    r.sched.advance(3000);
    expect(r.bus.load16(IO + 0x70) & 0x80).toBe(0);
    r.sched.advance(SETTLE_LONG);
    expect(r.bus.load16(IO + 0x70) & 0x80).toBe(0x80);
  });
});

describe('Bus SIO0 memory card sessions', () => {
  it('a data byte equal to a select byte inside a card transfer does not restart the session', () => {
    const h = makeBus();
    h.bus.store16(IO + 0x4A, 0x1003);
    const ex = (b: number): number => {
      h.bus.store8(IO + 0x40, b);
      h.sched.advance(40_000);

      return h.bus.load8(IO + 0x40);
    };
    ex(0x81);
    ex(0x57);
    ex(0x00);
    ex(0x00);
    ex(0x00);
    ex(0x00);
    const data = Array.from({ length: 128 }, (_, i) => (i === 5 ? 0x81 : i === 9 ? 0x01 : 0x22));
    for (const b of data) {
      ex(b);
    }
    ex(data.reduce((a, b) => a ^ b, 0));
    ex(0x00);
    ex(0x00);
    expect(ex(0x00)).toBe(0x47);
  });

  it('a card provided through the constructor is used and written in place', () => {
    const router = new IrqRouter();
    const device = new FakeDmaDevice(router);
    const devices: IoDeviceSet = { gpu: device, cd: device, spu: device, mdec: new FakeMdec(), pad: new PadState() };
    const sched = new FakeScheduler();
    const image = new Uint8Array(0x20000);
    image[0] = 0x4D;
    const bus = new Bus(sched, new RingLogger(), new Uint32Array(RAM_SIZE / 4), devices, null, image);
    bus.store16(IO + 0x4A, 0x1003);
    const ex = (b: number): number => {
      bus.store8(IO + 0x40, b);
      sched.advance(40_000);

      return bus.load8(IO + 0x40);
    };
    for (const b of [0x81, 0x57, 0x00, 0x00, 0x00, 0x02]) {
      ex(b);
    }
    for (let i = 0; i < 128; i++) {
      ex(0x7E);
    }
    ex(0x02);
    ex(0x00);
    ex(0x00);
    expect(ex(0x00)).toBe(0x47);
    expect(image[0]).toBe(0x4D);
    expect(image[0x100]).toBe(0x7E);
    expect(image[0x17F]).toBe(0x7E);
  });
});

describe('Bus SIO0 two memory cards (psxjin profile)', () => {
  const build = (profile: typeof PSXJIN_PROFILE): { bus: Bus; sched: FakeScheduler } => {
    const router = new IrqRouter();
    const device = new FakeDmaDevice(router);
    const devices: IoDeviceSet = { gpu: device, cd: device, spu: device, mdec: new FakeMdec(), pad: new PadState() };
    const sched = new FakeScheduler();
    const bus = new Bus(sched, new RingLogger(), new Uint32Array(RAM_SIZE / 4), devices, null, null, profile, null);

    return { bus, sched };
  };

  const selectCard = (h: { bus: Bus; sched: FakeScheduler }, ctrl: number): number => {
    h.bus.store16(IO + 0x4A, ctrl);
    h.bus.store8(IO + 0x40, 0x81);
    h.sched.advance(1000);
    h.bus.load8(IO + 0x40);
    h.bus.store8(IO + 0x40, 0x52);
    h.sched.advance(1000);

    return h.bus.load8(IO + 0x40);
  };

  it('slot 2 answers like a blank formatted card with the psxjin profile', () => {
    const h = build(PSXJIN_PROFILE);
    expect(selectCard(h, 0x3003)).toBe(0x08);
    h.bus.store8(IO + 0x40, 0x00);
    h.sched.advance(1000);
    expect(h.bus.load8(IO + 0x40)).toBe(0x5A);
  });

  it('slot 2 stays empty with the hardware profile', () => {
    const h = build(HARDWARE_PROFILE);
    expect(selectCard(h, 0x3003)).toBe(0xFF);
  });

  it('psxjin SIO byte has its reply at once and raises the IRQ 200 cycles after the write', () => {
    const h = build(PSXJIN_PROFILE);
    h.bus.store16(IO + 0x4A, 0x1003);
    h.bus.store8(IO + 0x40, 0x01);
    expect(h.bus.load16(IO + 0x44) & 2).toBe(2);
    h.sched.advance(199);
    expect(h.bus.load16(IO + 0x44) & 0x200).toBe(0);
    h.sched.advance(2);
    expect(h.bus.load16(IO + 0x44) & 0x200).toBe(0x200);
  });
});

describe('Bus MDEC busy bit after DMA1 (psxjin profile)', () => {
  const build = (profile: typeof PSXJIN_PROFILE): { bus: Bus; sched: FakeScheduler; mdec: FakeMdec } => {
    const router = new IrqRouter();
    const device = new FakeDmaDevice(router);
    const mdec = new FakeMdec();
    const devices: IoDeviceSet = { gpu: device, cd: device, spu: device, mdec, pad: new PadState() };
    const sched = new FakeScheduler();
    const bus = new Bus(sched, new RingLogger(), new Uint32Array(RAM_SIZE / 4), devices, null, null, profile, null);
    bus.store32(IO + 0xF0, 0x07654321 | 0x80);

    return { bus, sched, mdec };
  };

  const startOutDma = (h: { bus: Bus; mdec: FakeMdec }): void => {
    for (let k = 0; k < 8; k++) {
      h.mdec.pushOut(k);
    }
    h.bus.store32(IO + 0x90, 0x2000);
    h.bus.store32(IO + 0x94, (1 << 16) | 8);
    h.bus.store32(IO + 0x98, 0x01000200);
  };

  it('keeps status bit 29 set for PSXCLK/1000 cycles after the DMA1 channel completes', () => {
    const h = build(PSXJIN_PROFILE);
    startOutDma(h);
    expect(h.bus.load32(IO + 0x824) & 0x2000_0000).toBe(0x2000_0000);
    h.sched.advance(1000);
    expect(h.bus.load32(IO + 0x98) & CHCR_BUSY_MASK).toBe(0);
    expect(h.bus.load32(IO + 0x824) & 0x2000_0000).toBe(0x2000_0000);
    h.sched.advance(33_868);
    expect(h.bus.load32(IO + 0x824) & 0x2000_0000).toBe(0);
  });

  it('a control reset clears the busy bit at once', () => {
    const h = build(PSXJIN_PROFILE);
    startOutDma(h);
    h.sched.advance(1000);
    h.bus.store32(IO + 0x824, 0x8000_0000);
    expect(h.bus.load32(IO + 0x824) & 0x2000_0000).toBe(0);
  });

  it('hardware profile leaves the status word to the MDEC', () => {
    const h = build(HARDWARE_PROFILE);
    startOutDma(h);
    h.sched.advance(1000);
    expect(h.bus.load32(IO + 0x824) & 0x2000_0000).toBe(0);
  });
});
