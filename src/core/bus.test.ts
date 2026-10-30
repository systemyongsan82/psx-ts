import { beforeEach, describe, expect, it } from 'bun:test';
import type { DmaChannel, DmaConfig, DmaDevice, IoDevice, Scheduler } from './contracts';
import { RAM_SIZE } from './contracts';
import { RingLogger } from './logger';
import { IrqRouter } from './irq';
import { PadState } from './pad';
import { Bus, type IoDeviceSet } from './bus';
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

  it('memcard command and slot2 selection answer idle with no ACK or IRQ7', () => {
    const { bus, sched } = harness;
    bus.store16(IO + 0x4A, 0x1003);
    bus.store8(IO + 0x40, 0x81);
    settlePad(sched);
    expect(bus.load16(IO + 0x44) & 2).toBe(2);
    expect(bus.load8(IO + 0x40)).toBe(0xFF);
    expect(bus.load16(IO + 0x70) & 0x80).toBe(0);
    bus.store8(IO + 0x40, 0x00);
    settlePad(sched);
    expect(bus.load16(IO + 0x70) & 0x80).toBe(0);
    bus.store16(IO + 0x4A, 0x3003);
    bus.store8(IO + 0x40, 0x01);
    bus.store8(IO + 0x40, 0x42);
    settlePad(sched);
    settlePad(sched);
    expect(bus.load16(IO + 0x70) & 0x80).toBe(0);
    expect(bus.load8(IO + 0x40)).toBe(0xFF);
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
