import { CYCLES_PER_LINE, RAM_SIZE } from './contracts';
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
import { SHELL_ENTRY_PC, applyExeHandoff, loadDiscExe, returnFromShell } from './fastboot';
import { lineDelayCycles, profileFor } from './timingProfile';
import type { TimingProfile } from './timingProfile';

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
    if (i < 0) {
      return;
    }
    const last = this.heap.pop();
    if (last !== undefined && i < this.heap.length) {
      this.heap[i] = last;
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
    this.fireDue();
  }

  elapse(cycles: number): void {
    this._now += cycles;
  }

  fireDue(): void {
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
  private readonly lowLevelBios: boolean;
  private readonly fastBoot: boolean;
  private readonly profile: TimingProfile;
  private awaitingShell = false;
  exeStartFrame: number | null = null;
  exeStartCycle: number | null = null;
  onExeStart: (() => void) | null = null;

  constructor(opts: SystemOptions) {
    this.log = opts.log ?? new RingLogger();
    this.sched = this._sched;
    this.lowLevelBios = opts.biosRom !== undefined;
    this.profile = profileFor(opts.timing);
    if (this.profile.returnFromShell && !this.lowLevelBios) {
      throw new Error('the psxjin timing profile needs a BIOS ROM');
    }
    this.fastBoot = this.lowLevelBios && (opts.fastBoot === true || this.profile.returnFromShell);
    this.image = new PsxBinImage(opts.binPath, this.log);
    this.iso = new IsoImage(this.image, this.log);
    this.ram = new Uint32Array(RAM_SIZE / 4);
    this.irq = new IrqRouter();
    this.pad = new PadState();
    this.gpu = new GpuCore(this.sched, this.log, this.irq);
    this.spu = new SpuCore(this.sched, this.log, this.irq);
    this.mdec = new MdecCore(this.sched, this.log, this.irq);
    this.cd = new Cdrom(this.sched, this.log, this.image, this.iso, this.spu, this.irq, this.profile.cd);
    this.gte = new Gte();
    this.bios = new HleBios(this.sched, this.log, this.ram, this.iso, this.cd);
    this.bus = new Bus(this.sched, this.log, this.ram, {
      gpu: this.gpu,
      cd: this.cd,
      spu: this.spu,
      mdec: this.mdec,
      pad: this.pad,
    }, opts.biosRom ?? null, opts.memcard1 ?? null, this.profile, opts.memcard2 ?? null);
    this.irq.sink = (line) => this.bus.raiseIrq(line);
    this.irq.dmaDoneSink = (ch) => this.bus.dmaChannelDone(ch);
    this.bios.padInput = this.pad;
    this.bios.hwRead32 = (addr) => this.bus.load32(addr);
    this.bios.hwWrite32 = (addr, value) => this.bus.store32(addr, value);
    this.cpu = new CpuR3000A({
      bus: this.bus,
      gte: this.gte,
      irqCheck: () => this.bus.irqActive(),
      realExceptions: this.lowLevelBios,
      unitInstructionCycles: this.profile.unitInstructionCycles,
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
    if (this.lowLevelBios) {
      this.ram.fill(0);
      this.cpu.reset(0xBFC00000);
      this.awaitingShell = this.fastBoot;
      this.installClock();

      return;
    }
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
    const profile = this.profile;
    let lastDelay = lineDelayCycles(profile, 0, CYCLES_PER_LINE);
    const lineTick = (): void => {
      this.bus.lineTick();
      this.bus.line++;
      if (this.bus.line >= profile.linesPerFrame) {
        this.bus.line = 0;
        this._frame++;
      }
      if (this.bus.line === profile.vblankLine) {
        this.bus.raiseIrq(0);
        this.gpu.frameBoundary();
      }
      this.cd.tick(lastDelay);
      lastDelay = lineDelayCycles(profile, this.bus.line, CYCLES_PER_LINE);
      this.sched.at(lastDelay, lineTick);
    };
    this.sched.at(lastDelay, lineTick);
  }

  private handOffToDiscExe(): void {
    this.awaitingShell = false;
    if (this.profile.returnFromShell) {
      this.cpu.restore(returnFromShell(this.cpu.save()));
      this.exeStartFrame = this._frame;
      this.exeStartCycle = this.sched.now;
      this.onExeStart?.();

      return;
    }
    const handoff = loadDiscExe(this.cd, this.ram, this.log);
    if (handoff === null) {
      this.log.error('sys', 'fast boot: disc exe could not be loaded, continuing on the BIOS shell');

      return;
    }
    this.cpu.restore(applyExeHandoff(this.cpu.save(), handoff));
    this.exeStartFrame = this._frame;
    this.exeStartCycle = this.sched.now;
    this.log.debug('sys', `fast boot: exe started at frame ${this._frame}, pc ${handoff.entryPc.toString(16)}`);
  }

  runCycles(cycles: number): void {
    let remaining = cycles;
    while (remaining > 0) {
      if (this.awaitingShell) {
        if ((this.cpu.pc >>> 0) === SHELL_ENTRY_PC) {
          this.handOffToDiscExe();
        } else {
          const stepped = this.cpu.run(1);
          this.sched.advance(stepped);
          remaining -= stepped;

          continue;
        }
      }
      const next = this.sched.nextDeadline();
      const untilEvent = next === null ? remaining : Math.max(1, Math.min(next - this.sched.now, remaining));
      const budget = this.profile.unitInstructionCycles ? 1 : Math.min(untilEvent, CPU_BURST_MAX, remaining);
      if (this.cpu.halted) {
        this.sched.advance(untilEvent);
        remaining -= untilEvent;
        continue;
      }
      const wasDelaySlot = this.cpu.inDelaySlot;
      const consumed = this.cpu.run(budget);
      if (this.profile.eventsAtBranchOnly) {
        this.sched.elapse(consumed);
        if (wasDelaySlot) {
          this.sched.fireDue();
        }
      } else {
        this.sched.advance(consumed);
      }
      remaining -= consumed;
    }
    if (this.profile.eventsAtBranchOnly) {
      this.sched.fireDue();
    }
  }

  runFrames(count: number): void {
    for (let i = 0; i < count; i++) {
      this.runCycles(this.profile.frameCycles);
    }
  }
}