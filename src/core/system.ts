import { CYCLES_PER_LINE, FRAME_CYCLES, LINES_PER_FRAME, RAM_SIZE, VBLANK_LINE } from './contracts';
import type { CdromUnit, DmaDevice, IoDevice, Logger, Scheduler, System, SystemOptions } from './contracts';
import { RingLogger } from './logger';
import { IrqRouter } from './irq';
import { PadState } from './pad';
import { PsxBinImage } from '../disc/image';
import { IsoImage } from '../disc/iso9660';
import { Cdrom } from '../disc/cdrom';
import { Bus } from './bus';
import { CpuR3000A } from './cpu';
import { Gte } from './gte';
import { GpuCore } from './gpu';
import { SpuCore } from './spu';
import { MdecCore } from './mdec';
import { HleBios } from './bios';

const CPU_BURST_MAX = 8192;

interface Delayed {
  deadline: number;
  fn: () => void;
}

export class SchedulerQueue implements Scheduler {
  private readonly heap: Array<Delayed> = [];
  private _now = 0;

  get now(): number {
    return this._now;
  }

  at(cyclesFromNow: number, fn: () => void): object {
    const item: Delayed = { deadline: this._now + cyclesFromNow, fn };
    this.heap.push(item);
    this.siftUp(this.heap.length - 1);

    return item;
  }

  cancel(handle: object): void {
    const i = this.heap.indexOf(handle as Delayed);
    if (i >= 0) {
      this.heap[i] = this.heap[this.heap.length - 1];
      this.heap.pop();
      this.siftDown(i);
      this.siftUp(i);
    }
  }

  nextDeadline(): number | null {
    if (this.heap.length === 0) {
      return null;
    }

    return this.heap[0].deadline;
  }

  advance(cycles: number): void {
    this._now += cycles;
    while (this.heap.length > 0 && this.heap[0].deadline <= this._now) {
      const top = this.heap[0];
      this.heap[0] = this.heap[this.heap.length - 1];
      this.heap.pop();
      this.siftDown(0);
      top.fn();
    }
  }

  private siftUp(i: number): void {
    let c = i;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.heap[c].deadline >= this.heap[p].deadline) {
        break;
      }
      const tmp = this.heap[c];
      this.heap[c] = this.heap[p];
      this.heap[p] = tmp;
      c = p;
    }
  }

  private siftDown(i: number): void {
    let p = i;
    for (;;) {
      const l = p * 2 + 1;
      const r = p * 2 + 2;
      let m = p;
      if (l < this.heap.length && this.heap[l].deadline < this.heap[m].deadline) {
        m = l;
      }
      if (r < this.heap.length && this.heap[r].deadline < this.heap[m].deadline) {
        m = r;
      }
      if (m === p) {
        return;
      }
      const tmp = this.heap[m];
      this.heap[m] = this.heap[p];
      this.heap[p] = tmp;
      p = m;
    }
  }
}

export interface IoDeviceSet {
  readonly gpu: DmaDevice;
  readonly cd: DmaDevice;
  readonly spu: DmaDevice;
  readonly mdec: DmaDevice;
  readonly pad: PadState;
}

export class PsxSystem implements System {
  readonly log: Logger;
  private readonly _sched = new SchedulerQueue();
  readonly sched: SchedulerQueue;
  readonly image: PsxBinImage;
  readonly iso: IsoImage;
  readonly irq: IrqRouter;
  readonly pad: PadState;
  readonly ram: Uint32Array;
  readonly gpu: GpuCore;
  readonly spu: SpuCore;
  readonly mdec: MdecCore;
  readonly cd: CdromUnit;
  readonly bus: Bus;
  readonly gte: Gte;
  readonly bios: HleBios;
  readonly cpu: CpuR3000A;
  private _frame = 0;

  constructor(opts: SystemOptions) {
    this.log = opts.log ?? new RingLogger();
    this.sched = this._sched;
    this.image = new PsxBinImage(opts.binPath, this.log);
    this.iso = new IsoImage(this.image, this.log);
    this.ram = new Uint32Array(RAM_SIZE / 4);
    this.irq = new IrqRouter();
    this.pad = new PadState();
    this.gpu = new GpuCore(this.sched, this.log, this.irq);
    this.spu = new SpuCore(this.sched, this.log, this.irq);
    this.mdec = new MdecCore(this.sched, this.log, this.irq);
    this.cd = new Cdrom(this.sched, this.log, this.image, this.iso, this.spu, this.irq);
    this.gte = new Gte();
    this.bios = new HleBios(this.sched, this.log, this.ram, this.iso, this.cd);
    this.bus = new Bus(this.sched, this.log, this.ram, {
      gpu: this.gpu,
      cd: this.cd,
      spu: this.spu,
      mdec: this.mdec,
      pad: this.pad,
    });
    this.irq.sink = (line) => this.bus.raiseIrq(line);
    this.irq.dmaDoneSink = (ch) => this.bus.dmaChannelDone(ch);
    this.bios.padInput = this.pad;
    this.bios.hwRead32 = (addr) => this.bus.load32(addr);
    this.bios.hwWrite32 = (addr, value) => this.bus.store32(addr, value);
    this.cpu = new CpuR3000A({
      bus: this.bus,
      gte: this.gte,
      irqCheck: () => this.bus.irqActive(),
      hooks: {
        irqActive: () => this.bus.irqActive(),
        kuserCall: (pc, core) => this.bios.kuserCall(pc, core),
        exception: (kind, code, addr, core) => this.bios.exception(kind, code, addr, core),
      },
    });
  }

  get frameNumber(): number {
    return this._frame;
  }

  boot(): void {
    const info = this.bios.boot();
    this.bios.applyMemoryControl();
    this.cpu.reset(info.entryPc);
    this.cpu.setReg(29, info.sp);
    this.cpu.setReg(28, info.gp);
    this.cpu.setReg(4, 1);
    this.cpu.setReg(5, 0);
    this.cpu.setReg(7, 0x2a);
    this.cpu.setReg(8, info.sp);
    this.cpu.setReg(30, info.sp);
    this.cpu.setReg(11, info.entryPc);
    this.cpu.setReg(15, 0x1f801800);
    this.installClock();
  }

  private installClock(): void {
    const lineTick = (): void => {
      this.bus.lineTick();
      this.bus.line++;
      if (this.bus.line >= LINES_PER_FRAME) {
        this.bus.line = 0;
        this._frame++;
      }
      if (this.bus.line === VBLANK_LINE) {
        this.bus.raiseIrq(0);
        this.gpu.frameBoundary();
      }
      this.cd.tick(CYCLES_PER_LINE);
      this.sched.at(CYCLES_PER_LINE, lineTick);
    };
    this.sched.at(CYCLES_PER_LINE, lineTick);
  }

  runCycles(cycles: number): void {
    let remaining = cycles;
    while (remaining > 0) {
      const next = this.sched.nextDeadline();
      const untilEvent = next === null ? remaining : Math.max(1, Math.min(next - this.sched.now, remaining));
      const budget = Math.min(untilEvent, CPU_BURST_MAX, remaining);
      if (this.cpu.halted) {
        this.sched.advance(untilEvent);
        remaining -= untilEvent;
        continue;
      }
      const consumed = this.cpu.run(budget);
      this.sched.advance(consumed);
      remaining -= consumed;
    }
  }

  runFrames(count: number): void {
    for (let i = 0; i < count; i++) {
      this.runCycles(FRAME_CYCLES);
    }
  }
}