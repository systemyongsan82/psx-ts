import { ramReadWord } from '../ram';
import {
  KERNEL_SP_BASE,
  KERNEL_SP_MAX_DEPTH,
  KERNEL_SP_WINDOW,
  VEC_RET,
  isKernelCallPc,
} from './layout';
import type { CpuContext, CpuRegAccess, Logger } from '../contracts';

export type InternalKind =
  | 'none'
  | 'cdIo'
  | 'cdDma'
  | 'syscall'
  | 'card'
  | 'vblank'
  | 'timer2'
  | 'timer1'
  | 'timer0'
  | 'padcard'
  | 'defint';

export interface ChainNode {
  readonly ramAddr: number;
  readonly fn1: number;
  readonly fn2: number;
  readonly internal: InternalKind;
}

export type CallbackKind = 'event' | 'chain';

export interface QueueEntry {
  fn: number;
  kind: CallbackKind;
  fn2: number;
  arg0: number;
  arg1: number;
}

interface CallbackDesc {
  kind: CallbackKind;
  fn2: number;
}

const QUEUE_CAPACITY = 96;
const CTX_CAPACITY = 8;

export class IntrTable {
  private readonly chains = [new Array<ChainNode>(), new Array<ChainNode>(), new Array<ChainNode>(), new Array<ChainNode>()];
  readonly autoAckRcnt = [0, 0, 0, 0];
  readonly autoAckIrq = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  chain(prio: number): Array<ChainNode> {
    if (prio < 0 || prio >= this.chains.length) {
      return this.chains[0];
    }

    return this.chains[prio];
  }

  enqueueInternal(prio: number, internal: InternalKind): void {
    const list = this.chains[prio];

    list.unshift({ ramAddr: 0, fn1: 0, fn2: 0, internal });
  }

  removeInternal(prio: number, internal: InternalKind): void {
    const list = this.chains[prio];
    for (let i = 0; i < list.length; i++) {
      if (list[i].internal === internal) {
        list.splice(i, 1);

        return;
      }
    }
  }

  enqueueGame(prio: number, ramAddr: number, ram: Uint32Array, headNextWrite: (prevAddr: number) => void): number {
    const fn1 = ramReadWord(ram, ramAddr + 8);
    const fn2 = ramReadWord(ram, ramAddr + 4);
    const list = this.chains[prio];
    const prev = list[0]?.ramAddr ?? 0;
    list.unshift({ ramAddr, fn1, fn2, internal: 'none' });
    headNextWrite(prev);

    return ramAddr;
  }

  dequeueGame(prio: number, ramAddr: number): number {
    const list = this.chains[prio];
    for (let i = 0; i < list.length; i++) {
      if (list[i].ramAddr === ramAddr) {
        list.splice(i, 1);

        return ramAddr;
      }
    }

    return 0;
  }

  reset(): void {
    this.chains[0].length = 0;
    this.chains[1].length = 0;
    this.chains[2].length = 0;
    this.chains[3].length = 0;
    for (let i = 0; i < 4; i++) {
      this.autoAckRcnt[i] = 0;
    }
    for (let i = 0; i < this.autoAckIrq.length; i++) {
      this.autoAckIrq[i] = 0;
    }
  }
}

export class CallbackRunner {
  private readonly ctxStack: Array<CpuContext> = [];
  private readonly descRing: Array<CallbackDesc>;
  private descTop = 0;
  private readonly ring: Array<QueueEntry>;
  private ringHead = 0;
  private ringCount = 0;
  private waitCtx: CpuContext | null = null;
  private waitSlot = -1;
  private waitActive = false;
  private spWarned = false;

  constructor(private readonly log: Logger) {
    this.descRing = new Array<CallbackDesc>(CTX_CAPACITY + 1);
    for (let i = 0; i < this.descRing.length; i++) {
      this.descRing[i] = { kind: 'event', fn2: 0 };
    }
    this.ring = new Array<QueueEntry>(QUEUE_CAPACITY);
    for (let i = 0; i < QUEUE_CAPACITY; i++) {
      this.ring[i] = { fn: 0, kind: 'event', fn2: 0, arg0: 0, arg1: 0 };
    }
  }

  get depth(): number {
    return this.ctxStack.length;
  }

  get pendingCount(): number {
    return this.ringCount;
  }

  get isWaiting(): boolean {
    return this.waitActive;
  }

  get waitingSlot(): number {
    return this.waitSlot;
  }

  clearQueues(): void {
    this.ringHead = 0;
    this.ringCount = 0;
    this.descTop = 0;
  }

  queueEvent(fn: number, arg0: number, arg1: number): void {
    this.pushQueue(fn >>> 0, 'event', 0, arg0 >>> 0, arg1 >>> 0);
  }

  queueChain(fn: number, fn2: number): void {
    this.pushQueue(fn >>> 0, 'chain', fn2 >>> 0, 0, 0);
  }

  private pushQueue(fn: number, kind: CallbackKind, fn2: number, arg0: number, arg1: number): void {
    if (this.ringCount >= QUEUE_CAPACITY) {
      this.log.warn('bios', 'event callback queue overflow');

      return;
    }
    const e = this.ring[(this.ringHead + this.ringCount) % QUEUE_CAPACITY];
    e.fn = fn;
    e.kind = kind;
    e.fn2 = fn2;
    e.arg0 = arg0;
    e.arg1 = arg1;
    this.ringCount++;
  }

  shiftQueued(): QueueEntry | null {
    if (this.ringCount === 0) {
      return null;
    }
    const e = this.ring[this.ringHead];
    this.ringHead = (this.ringHead + 1) % QUEUE_CAPACITY;
    this.ringCount--;

    return e;
  }

  startQueued(next: QueueEntry, core: CpuRegAccess, fromKuser: boolean): void {
    if (next.kind === 'chain') {
      this.startChain(next.fn, next.fn2, core, fromKuser);

      return;
    }
    this.startEvent(next.fn, next.arg0, next.arg1, core, fromKuser);
  }

  startEvent(fn: number, arg0: number, arg1: number, core: CpuRegAccess, fromKuser: boolean): void {
    this.pushCtx(core, 'event', 0, fromKuser);
    core.setPc(fn >>> 0);
    core.setNextPc((fn + 4) >>> 0);
    core.setReg(31, VEC_RET);
    core.setReg(4, arg0 >>> 0);
    core.setReg(5, arg1 >>> 0);
    core.setReg(6, 0);
    core.setReg(7, 0);
  }

  startChain(fn: number, fn2: number, core: CpuRegAccess, fromKuser: boolean): void {
    this.pushCtx(core, 'chain', fn2 >>> 0, fromKuser);
    core.setPc(fn >>> 0);
    core.setNextPc((fn + 4) >>> 0);
    core.setReg(31, VEC_RET);
  }

  beginWait(slot: number, core: CpuRegAccess): boolean {
    const ctx = core.save();
    const continuation = ctx.regs[31] >>> 0;
    if (continuation === 0) {
      this.log.warn('bios', 'WaitEvent with zero RA; ignoring block');

      return false;
    }
    if (isKernelCallPc(ctx.pc >>> 0) && !isKernelCallPc(continuation)) {
      ctx.pc = continuation;
      ctx.nextPc = (continuation + 4) >>> 0;
    }
    ctx.regs[2] = 1;
    this.waitCtx = ctx;
    this.waitSlot = slot;
    this.waitActive = true;
    core.suspend();

    return true;
  }

  resumeWait(core: CpuRegAccess): boolean {
    if (!this.waitActive || this.waitCtx === null) {
      return false;
    }
    core.restore(this.waitCtx);
    this.waitCtx = null;
    this.waitActive = false;
    this.waitSlot = -1;
    core.resume();

    return true;
  }

  cancelWait(): void {
    this.waitCtx = null;
    this.waitActive = false;
    this.waitSlot = -1;
  }

  returnFrom(core: CpuRegAccess): boolean {
    const v0 = core.getReg(2) >>> 0;
    const desc = this.descTop > 0 ? this.descRing[this.descTop - 1] : null;
    const ctx = this.ctxStack.pop();
    if (desc === null || ctx === undefined) {
      this.log.error('bios', 'ReturnFromException with no saved context');
      core.suspend();

      return false;
    }
    this.descTop--;
    core.restore(ctx);
    if (desc.kind === 'chain' && desc.fn2 !== 0 && v0 !== 0) {
      this.startChain(desc.fn2, 0, core, true);

      return true;
    }
    const next = this.shiftQueued();
    if (next !== null) {
      this.startQueued(next, core, true);

      return true;
    }

    return true;
  }

  shortCircuitReturn(core: CpuRegAccess): boolean {
    const base = this.ctxStack[0];
    if (this.ctxStack.length === 0 || base === undefined) {
      this.log.error('bios', 'ReturnFromException outside exception handling');
      core.suspend();

      return false;
    }
    this.ctxStack.length = 0;
    this.descTop = 0;
    this.ringHead = 0;
    this.ringCount = 0;
    core.restore(base);

    return true;
  }

  isGameBaseContextLive(): boolean {
    return this.ctxStack.length > 0;
  }

  private pushCtx(core: CpuRegAccess, kind: CallbackKind, fn2: number, fromKuser: boolean): void {
    const depth = this.ctxStack.length;
    const ctx = core.save();
    if (fromKuser) {
      fixupKuserContinuation(ctx);
    }
    if (this.ctxStack.length < CTX_CAPACITY) {
      this.ctxStack.push(ctx);
    } else {
      this.log.error('bios', 'callback context stack overflow');
      this.ctxStack[this.ctxStack.length - 1] = ctx;
    }
    const idx = Math.min(this.ctxStack.length - 1, this.descRing.length - 1);
    const desc = this.descRing[idx];
    desc.kind = kind;
    desc.fn2 = fn2 >>> 0;
    this.descTop = this.ctxStack.length;
    core.setReg(29, this.spForDepth(depth + 1));
  }

  private spForDepth(depth: number): number {
    const capped = Math.min(depth, KERNEL_SP_MAX_DEPTH);
    if (depth > KERNEL_SP_MAX_DEPTH && !this.spWarned) {
      this.spWarned = true;
      this.log.warn('bios', 'kernel callback stack deeper than 4 windows');
    }

    return (KERNEL_SP_BASE - (capped - 1) * KERNEL_SP_WINDOW) >>> 0;
  }
}

function fixupKuserContinuation(ctx: CpuContext): void {
  if (!isKernelCallPc(ctx.pc >>> 0)) {
    return;
  }
  const ra = ctx.regs[31] >>> 0;
  if (ra === 0 || isKernelCallPc(ra)) {
    return;
  }
  ctx.pc = ra;
  ctx.nextPc = (ra + 4) >>> 0;
}