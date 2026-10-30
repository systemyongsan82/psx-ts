import type {
  Bios,
  BootInfo,
  CdromUnit,
  CpuContext,
  CpuExceptionKind,
  CpuRegAccess,
  Iso9660,
  Logger,
  PadInput,
  Scheduler,
} from './contracts';
import { FRAME_CYCLES } from './contracts';
import { parsePsExe, planExeLoad } from '../disc/psxexe';
import type { PsExeInfo } from './contracts';
import { ramReadWord, ramWriteBytes, ramWriteWord } from './ram';
import { CallbackRunner, IntrTable, type InternalKind } from './kernel/intr';
import { EventTable } from './kernel/events';
import { FileTable } from './kernel/files';
import { ExeLoader, parseSystemCnf, CNF_DEFAULTS } from './kernel/cnf';
import {
  installExceptionHandlerStubs,
  writeKernelImage,
} from './kernel/ramImage';
import {
  B0_TABLE_ADDR,
  B0_TABLE_ENTRIES,
  B_SENTINEL_BASE,
  B_SENTINEL_COUNT,
  B_SENTINEL_STRIDE,
  C0_TABLE_ADDR,
  C0_TABLE_ENTRIES,
  C_SENTINEL_BASE,
  C_SENTINEL_COUNT,
  C_SENTINEL_STRIDE,
  CMDLINE_ADDR,
  PCB_ADDR,
  DEFINT_LINE_CLASS,
  DEFINT_SPEC,
  EV_CLASS_CDROM,
  EV_CLASS_EXCEPTION,
  EV_SPEC_CMD_ACK,
  EV_SPEC_CMD_COMPLETE,
  EV_SPEC_DMA_DONE,
  EV_SPEC_GEN_IRQ,
  EV_SPEC_SYSCALL,
  EXIT_STRUCT_ADDR,
  HEAP_BASE,
  HEAP_TOP,
  INTERNAL_MIN,
  IRQ_MASK_REG,
  JUMP_A_BASE,
  JUMP_A_SLOT,
  KERNEL_STACK_TOP,
  RC_REG_BASE,
  RC_REG_MODE_OFF,
  RC_REG_TARGET_OFF,
  TCB_ADDR,
  TCB_COUNT_MAX,
  TCB_SIZE,
  TCB_STATUS_FREE,
  VEC_A,
  VEC_B,
  VEC_C,
  VEC_RET,
} from './kernel/layout';
import {
  atoiText,
  bcopy as bcopyRegion,
  bzero as bzeroRegion,
  memcmp,
  memchr,
  memcpy,
  memmove,
  memset,
  physOf,
  readString,
  strcat,
  strchr,
  strcmp,
  strcpy,
  strcspn,
  strlen,
  strncat,
  strncmp,
  strncpy,
  strrchr,
  strspn,
  strstr,
  strtok,
  strpbrk,
  strtolText,
  toLower,
  toUpper,
  todayDigitOfByte,
} from './kernel/strmem';

const RCNT_TIMER_COUNT = 4;
const EXC_STUB_WORDS: Array<number> = [0x3C1A_0000, 0x275A_0C80, 0x0340_0008, 0x0000_0000];
const BOOT_ARG1 = 1;
const BOOT_ARG2 = 0;
const BOOT_ARG4 = 0x2A;
const BOOT_T7 = 0x1F80_1800;

export class HleBios implements Bios {
  padInput: PadInput | null = null;
  hwRead32: ((addr: number) => number) | null = null;
  hwWrite32: ((addr: number, value: number) => void) | null = null;

  private readonly sched: Scheduler;
  private readonly log: Logger;
  private readonly ram: Uint32Array;
  private readonly iso: Iso9660;
  private readonly cd: CdromUnit;
  private readonly events: EventTable;
  private readonly files: FileTable;
  private readonly intr = new IntrTable();
  private readonly runner: CallbackRunner;
  private readonly fnBuf: Array<number> = [];
  private readonly strtokState = { last: 0 };
  private readonly rngState = { acc: 0x1F0_2A6F };
  private readonly onceWarn = { gpuFn: false, devTty: false, devCard: false, cdAsync: false, hwRegs: false };
  private confEvcb = 16;
  private confTcb = 4;
  private confStack = 0;
  private bump = HEAP_BASE;
  private readonly tcbStatus: Array<number> = [0x4000];
  private readonly threadContexts: Array<CpuContext | null> = [null];
  private currentThread = 0;
  private padBuf1 = 0;
  private padBuf2 = 0;
  private padOn = false;
  private outdatedDest = 0;
  private changeClearPad = 0;
  private kernelRedirectFlag = 0;
  private exitHookFn = 0;
  private cardFindMode = 0;
  private cdSysMode = 0;
  private cdSeekLba = 0;
  private cdAudioVolume: Array<number> = [0, 0, 0, 0, 0, 0, 0, 0];
  private cdAutoAbort: Array<number> = [0, 0, 0, 0];
  private cdAsyncHandle: object | null = null;
  private waitCore: CpuRegAccess | null = null;
  private walkAborted = false;

  constructor(
    sched: Scheduler,
    log: Logger,
    ram: Uint32Array,
    iso: Iso9660,
    cd: CdromUnit,
  ) {
    this.sched = sched;
    this.log = log;
    this.ram = ram;
    this.iso = iso;
    this.cd = cd;
    this.runner = new CallbackRunner(log);
    this.files = new FileTable(ram, cd, iso, log);
    this.events = new EventTable(ram, this.confEvcb);
    writeKernelImage(ram, { evcbCount: this.confEvcb, tcbCount: this.confTcb });
    this.installKernelDefaults();
  }

  boot(): BootInfo {
    const cnfBytes = this.readSystemCnf();
    const cnf = cnfBytes === null ? CNF_DEFAULTS : parseSystemCnf(cnfBytes);
    this.applyConf(cnf.event, cnf.tcb, cnf.stack);
    const loader = new ExeLoader(this.ram, this.cd, this.log);
    const plan = loader.load(cnf);
    if (plan === null) {
      this.log.error('bios', 'exe load failed; cannot boot');

      return { entryPc: 0, sp: this.confStack !== 0 ? this.confStack : 0x801F_FF00, gp: 0 };
    }
    this.writeCommandBuffer(cnf.boot);
    this.log.debug(
      'bios',
      `exe loaded: ${plan.loadSize} bytes at phys ${plan.loadAddr.toString(16)}, entry ${plan.entryPc.toString(16)}, sp ${plan.sp.toString(16)}, gp ${plan.gp.toString(16)}`,
    );

    return { entryPc: plan.entryPc, sp: plan.sp, gp: plan.gp };
  }

  lastBiosFileError(): number {
    return this.files.lastFileError();
  }

  applyMemoryControl(): void {
    this.hwStore(0x1F80_1000, 0x1F00_0000);
    this.hwStore(0x1F80_1004, 0x1F80_2000);
    this.hwStore(0x1F80_1008, 0x0013_243F);
    this.hwStore(0x1F80_100C, 0x0000_3022);
    this.hwStore(0x1F80_1010, 0x0013_243F);
    this.hwStore(0x1F80_1014, 0x2009_31E1);
    this.hwStore(0x1F80_1018, 0x0002_0843);
    this.hwStore(0x1F80_101C, 0x0007_0777);
    this.hwStore(0x1F80_1020, 0x0003_1125);
    this.hwStore(0x1F80_1060, 0x0000_0B88);
  }

  kuserCall(virtualPc: number, core: CpuRegAccess): boolean {
    const pc = (virtualPc & 0x1FFF_FFFF) >>> 0;
    if (pc === VEC_RET) {
      return this.runner.returnFrom(core);
    }
    if (pc === VEC_A) {
      return this.dispatchA(core, core.getReg(9));
    }
    if (pc === VEC_B) {
      return this.dispatchB(core, core.getReg(9));
    }
    if (pc === VEC_C) {
      return this.dispatchC(core, core.getReg(9));
    }
    if (pc >= JUMP_A_BASE && pc < JUMP_A_BASE + 96 * JUMP_A_SLOT) {
      const fn = (pc - JUMP_A_BASE) / JUMP_A_SLOT;
      if (Number.isInteger(fn) && fn >= 0) {
        return this.dispatchA(core, fn);
      }
    }
    if (pc >= B_SENTINEL_BASE && pc < B_SENTINEL_BASE + B_SENTINEL_COUNT * B_SENTINEL_STRIDE) {
      const fn = (pc - B_SENTINEL_BASE) / B_SENTINEL_STRIDE;
      if (Number.isInteger(fn)) {
        return this.dispatchB(core, fn);
      }
    }
    if (pc >= C_SENTINEL_BASE && pc < C_SENTINEL_BASE + C_SENTINEL_COUNT * C_SENTINEL_STRIDE) {
      const fn = (pc - C_SENTINEL_BASE) / C_SENTINEL_STRIDE;
      if (Number.isInteger(fn)) {
        return this.dispatchC(core, fn);
      }
    }

    this.log.warn('bios', `kuserCall at unowned pc ${virtualPc.toString(16)}`);

    return false;
  }

  exception(kind: CpuExceptionKind, code: number, addr: number, core: CpuRegAccess): void {
    if (kind === 'interrupt') {
      this.doInterrupt(code, core);

      return;
    }
    if (kind === 'syscall') {
      this.doSyscall(core.getReg(4) >>> 0, core);

      return;
    }
    this.log.error('bios', `unresolved exception ${kind} at ${addr.toString(16)}`);
    this.collectDeliveries(EV_CLASS_EXCEPTION, EV_SPEC_GEN_IRQ);
    const next = this.runner.shiftQueued();
    if (next !== null) {
      this.runner.startQueued(next, core, true);

      return;
    }
    core.suspend();
  }

  private readSystemCnf(): Uint8Array | null {
    const entry = this.cd.findFile('SYSTEM.CNF');
    if (entry === null) {
      this.log.warn('bios', 'SYSTEM.CNF not on disc');

      return null;
    }
    const len = Math.min(Math.max(1, entry.size), 4096);
    const bytes = this.cd.readFileBytes('SYSTEM.CNF', 0, len);
    if (bytes === null) {
      this.log.warn('bios', 'SYSTEM.CNF unreadable');

      return null;
    }

    return bytes;
  }

  private writeCommandBuffer(bootArg: string): void {
    const bytes = new Uint8Array(0x80);
    const arg = bootArg;
    for (let i = 0; i < Math.min(arg.length, 0x7F); i++) {
      bytes[i] = arg.charCodeAt(i) & 0xFF;
    }
    ramWriteBytes(this.ram, CMDLINE_ADDR, bytes, 0, 0x80);
  }

  private applyConf(evcbCount: number, tcbCount: number, stackTop: number): void {
    const evcb = Math.max(INTERNAL_MIN, evcbCount >>> 0);
    const tcb = Math.min(Math.max(1, tcbCount >>> 0), TCB_COUNT_MAX);
    const changed = evcb !== this.confEvcb || tcb !== this.confTcb;
    this.confEvcb = evcb;
    this.confTcb = tcb;
    this.confStack = stackTop >>> 0;
    if (changed) {
      this.events.rebuild(evcb);
      this.tcbStatus.length = 0;
      this.tcbStatus.push(0x4000);
      this.threadContexts.length = 0;
      this.threadContexts.push(null);
      this.currentThread = 0;
      for (let i = 1; i < tcb; i++) {
        this.tcbStatus.push(TCB_STATUS_FREE);
        this.threadContexts.push(null);
      }
      writeKernelImage(this.ram, { evcbCount: evcb, tcbCount: tcb });
      this.files.remirrorAll();
      this.installKernelDefaults();
    }
    this.fillCallTables();
    this.bump = HEAP_BASE;
  }

  private fillCallTables(): void {
    for (let fn = 0; fn < B0_TABLE_ENTRIES; fn++) {
      const target = fn < B_SENTINEL_COUNT ? B_SENTINEL_BASE + fn * B_SENTINEL_STRIDE : 0;
      ramWriteWord(this.ram, B0_TABLE_ADDR + fn * 4, target);
    }
    for (let fn = 0; fn < C0_TABLE_ENTRIES; fn++) {
      const target = fn < C_SENTINEL_COUNT ? C_SENTINEL_BASE + fn * C_SENTINEL_STRIDE : 0;
      ramWriteWord(this.ram, C0_TABLE_ADDR + fn * 4, target);
    }
  }

  private installKernelDefaults(): void {
    this.intr.reset();
    this.intr.enqueueInternal(0, 'syscall');
    this.intr.enqueueInternal(0, 'cdIo');
    this.intr.enqueueInternal(0, 'cdDma');
    this.intr.enqueueInternal(1, 'timer0');
    this.intr.enqueueInternal(1, 'timer1');
    this.intr.enqueueInternal(1, 'timer2');
    this.intr.enqueueInternal(1, 'vblank');
    this.intr.enqueueInternal(1, 'card');
    this.intr.enqueueInternal(2, 'padcard');
    this.intr.enqueueInternal(3, 'defint');
  }

  private collectDeliveries(cls: number, spec: number): void {
    this.fnBuf.length = 0;
    this.events.deliver(cls, spec, this.fnBuf);
    for (let i = 0; i < this.fnBuf.length; i++) {
      this.runner.queueEvent(this.fnBuf[i], cls, spec);
    }
  }

  private deliverFromGame(cls: number, spec: number, core: CpuRegAccess): boolean {
    this.collectDeliveries(cls, spec);
    if (this.runner.depth === 0) {
      const next = this.runner.shiftQueued();
      if (next !== null) {
        this.runner.startQueued(next, core, true);

        return true;
      }

      return this.ret(core, 0);
    }

    return false;
  }

  private doInterrupt(lines: number, core: CpuRegAccess): void {
    if (this.runner.depth > 0) {
      this.log.debug('bios', 'interrupt while in exception context; left pending');

      return;
    }
    const pend = lines & 0x3FF;
    this.walkAborted = false;
    for (let prio = 0; prio < 4 && !this.walkAborted; prio++) {
      const chain = this.intr.chain(prio);
      for (let i = 0; i < chain.length && !this.walkAborted; i++) {
        const node = chain[i];
        if (node.internal !== 'none') {
          this.runInternalHandler(node.internal, pend, core);
          continue;
        }
        if (node.fn1 !== 0) {
          this.runner.queueChain(node.fn1, node.fn2);
        } else if (node.fn2 !== 0) {
          this.runner.queueChain(node.fn2, 0);
        }
      }
    }
    const wokeWait = this.maybeResumeWaiter();
    if (!wokeWait && !this.walkAborted && this.runner.pendingCount === 0 && this.runner.depth === 0 && this.exitHookFn !== 0) {
      this.startExitHook(this.exitHookFn, core);

      return;
    }
    const next = this.runner.shiftQueued();
    if (next !== null) {
      this.runner.startQueued(next, core, false);
    }
  }

  private startExitHook(jmpBuf: number, core: CpuRegAccess): void {
    const word = (index: number): number => ramReadWord(this.ram, physOf(jmpBuf) + index * 4) >>> 0;

    this.runner.startEvent(word(0), 0, 0, core, false);
    core.setReg(2, 1);
    core.setReg(29, word(1));
    core.setReg(30, word(2));
    for (let i = 0; i < 8; i++) {
      core.setReg(16 + i, word(3 + i));
    }
    core.setReg(28, word(11));
  }

  private maybeResumeWaiter(): boolean {
    if (!this.runner.isWaiting || this.waitCore === null) {
      return false;
    }
    if (!this.events.isReadySlot(this.runner.waitingSlot)) {
      return false;
    }

    return this.runner.resumeWait(this.waitCore);
  }

  private runInternalHandler(internal: InternalKind, pend: number, _core: CpuRegAccess): void {
    switch (internal) {
      case 'syscall':
      case 'cdIo':
      case 'cdDma':
      case 'card':

        return;
      case 'vblank':
        if ((pend & (1 << 0)) !== 0) {
          this.collectDeliveries(0xF200_0003, 0x0002);
          if (this.intr.autoAckRcnt[3] !== 0) {
            this.walkAborted = true;
          }
        }

        return;
      case 'timer0':
        this.timerDeliver(pend, 4, 0xF200_0000, 0);

        return;
      case 'timer1':
        this.timerDeliver(pend, 5, 0xF200_0001, 1);

        return;
      case 'timer2':
        this.timerDeliver(pend, 6, 0xF200_0002, 2);

        return;
      case 'padcard':
        if (this.padOn && (pend & (1 << 0)) !== 0) {
          this.refreshPadBuffers();
        }

        return;
      case 'defint':
        for (let line = 0; line < DEFINT_LINE_CLASS.length; line++) {
          if ((pend & (1 << line)) !== 0) {
            this.collectDeliveries(DEFINT_LINE_CLASS[line], DEFINT_SPEC);
          }
        }

        return;
      case 'none':

        return;
    }
  }

  private timerDeliver(pend: number, line: number, cls: number, slot: number): void {
    if ((pend & (1 << line)) !== 0) {
      this.collectDeliveries(cls, 0x0002);
      if (this.intr.autoAckRcnt[slot] !== 0) {
        this.walkAborted = true;
      }
    }
  }

  private refreshPadBuffers(): void {
    if (this.padBuf1 === 0 && this.padBuf2 === 0) {
      this.warnOncePad('InitPad not called; no pad buffers');

      return;
    }
    if (this.padInput === null) {
      this.warnOncePad('pad input not wired (system.bios.padInput); buffers stay in timeout state');

      return;
    }
    const buttons = this.padInput.buttons & 0xFFFF;
    const inv = (~buttons) & 0xFFFF;
    if (this.padBuf1 !== 0) {
      this.writePadReply(this.padBuf1, inv);
    }
    if (this.padBuf2 !== 0) {
      this.writePadReply(this.padBuf2, inv);
    }
    if (this.outdatedDest !== 0) {
      ramWriteWord(this.ram, this.outdatedDest, buttons >>> 0);
    }
  }

  private writePadReply(base: number, inv: number): void {
    this.writeRamByte(base, 0x00);
    this.writeRamByte(base + 1, 0x41);
    this.writeRamByte(base + 2, inv & 0xFF);
    this.writeRamByte(base + 3, (inv >>> 8) & 0xFF);
  }

  private warnOncePad(msg: string): void {
    if (this.onceWarn.devCard) {
      return;
    }
    this.onceWarn.devCard = true;
    this.log.warn('bios', msg);
  }

  private writeRamByte(addr: number, value: number): void {
    const a = addr & 0x001F_FFFF;
    const shift = (a & 3) * 8;
    const keep = 0xFFFFFFFF ^ (0xFF << shift);
    const cur = this.ram[a >>> 2];
    const merged = ((cur & keep) | ((value & 0xFF) << shift)) >>> 0;

    this.ram[a >>> 2] = merged >>> 0;
  }

  private doSyscall(code: number, core: CpuRegAccess): void {
    switch (code) {
      case 0:
        this.log.debug('bios', 'syscall 00h NoFunction');
        this.ret(core, 0);

        return;
      case 1: {
        const sr = core.sr() >>> 0;
        const both = (sr & 0x0000_0404) === 0x0000_0404;
        core.setSr((sr & ~0x0000_0405) >>> 0);
        this.ret(core, both ? 1 : 0);

        return;
      }
      case 2: {
        const sr = core.sr() >>> 0;
        core.setSr((sr | 0x0000_0405) >>> 0);
        this.ret(core, 0);

        return;
      }
      case 3:
        this.log.debug('bios', 'syscall 03h ChangeThreadSubFunction (HLE no-op)');
        this.ret(core, 0);

        return;
      default:
        this.log.debug('bios', `syscall ${code.toString(16)}h pc=${core.pc().toString(16)} -> DeliverEvent(F0000010h,4000h)`);
        const redirected = this.deliverFromGame(EV_CLASS_EXCEPTION, EV_SPEC_SYSCALL, core);
        if (!redirected) {
          this.ret(core, 0);
        }

        return;
    }
  }

  private allocKernelMemory(size: number): number {
    let rounded = ((size >>> 0) + 3) & ~3;
    if (rounded === 0) {
      rounded = 4;
    }
    if (this.bump + rounded > HEAP_TOP) {
      return 0;
    }
    const ret = this.bump;
    this.bump += rounded;

    return ret >>> 0;
  }

  private spOf(core: CpuRegAccess): number {
    return core.getReg(29) >>> 0;
  }

  private regStr(core: CpuRegAccess, reg: number): string {
    return readString(this.ram, physOf(core.getReg(reg)), 96);
  }

  private ret(core: CpuRegAccess, value: number): boolean {
    core.setReg(2, value >>> 0);

    return false;
  }

  private dispatchA(core: CpuRegAccess, fn: number): boolean {
    if (fn < 0x14) {
      return this.dispatchANumbers(core, fn);
    }
    if (fn < 0x30) {
      return this.dispatchAStrings(core, fn);
    }
    if (fn < 0x40) {
      return this.dispatchALibcTail(core, fn);
    }
    if (fn < 0x54) {
      return this.dispatchAExecGpu(core, fn);
    }

    return this.dispatchADevices(core, fn);
  }

  private dispatchANumbers(core: CpuRegAccess, fn: number): boolean {
    if (fn === 0x00) {
      return this.ret(core, this.files.open(this.regStr(core, 4), this.a1(core)));
    }
    if (fn === 0x01) {
      return this.ret(core, this.files.seek(this.a0(core), core.getReg(5) | 0, this.a2(core)));
    }
    if (fn === 0x02) {
      return this.ret(core, this.files.read(this.a0(core), this.a1(core), this.a2(core)));
    }
    if (fn === 0x03) {
      return this.ret(core, this.files.write(this.a0(core), this.a1(core), this.a2(core)));
    }
    if (fn === 0x04) {
      return this.ret(core, this.files.close(this.a0(core)));
    }
    if (fn === 0x05) {
      return this.ret(core, this.files.ioctl(this.a0(core), this.a1(core), this.a2(core)));
    }
    if (fn === 0x06) {
      this.log.warn('bios', `exit(${this.a0(core)})`);
      core.suspend();

      return this.ret(core, 0);
    }
    if (fn === 0x07) {
      return this.ret(core, this.files.getDeviceFlag(this.a0(core)));
    }
    if (fn === 0x08) {
      const b = this.files.getByte(this.a0(core));
      const v = b < 0 ? 0xFFFF_FFFF : b > 0x7F ? (b - 0x100) >>> 0 : b;

      return this.ret(core, v);
    }
    if (fn === 0x09) {
      return this.ret(core, this.files.putByte(this.a1(core), this.a0(core)));
    }
    if (fn === 0x0A) {
      return this.ret(core, todayDigitOfByte(this.a0(core) & 0xFF));
    }
    if (fn === 0x0B) {
      this.log.debug('bios', 'atof: broken on real hardware; returning 0');

      return this.ret(core, 0);
    }
    if (fn === 0x0C || fn === 0x0D) {
      return this.ret(core, strtolText(this.ram, this.a0(core), this.a1(core), this.a2(core)));
    }
    if (fn === 0x0E || fn === 0x0F) {
      const v = this.a0(core) | 0;

      return this.ret(core, v < 0 ? -v : v);
    }
    if (fn === 0x10 || fn === 0x11) {
      return this.ret(core, atoiText(this.ram, this.a0(core)));
    }
    if (fn === 0x12) {
      const v = strtolText(this.ram, this.a0(core), 0, 0);
      ramWriteWord(this.ram, this.a1(core), v);

      return this.ret(core, v);
    }
    if (fn === 0x13) {
      return this.saveState(this.a0(core), core);
    }

    return this.unknown(core, 'A', fn);
  }

  private saveState(buf: number, core: CpuRegAccess): boolean {
    const base = buf & 0x001F_FFFF;
    ramWriteWord(this.ram, base + 0x00, core.getReg(31));
    ramWriteWord(this.ram, base + 0x04, core.getReg(29));
    ramWriteWord(this.ram, base + 0x08, core.getReg(30));
    for (let i = 0; i < 8; i++) {
      ramWriteWord(this.ram, base + 0x0C + i * 4, core.getReg(16 + i));
    }
    ramWriteWord(this.ram, base + 0x2C, core.getReg(28));

    return this.ret(core, 0);
  }

  private restoreState(buf: number, param: number, core: CpuRegAccess): boolean {
    void param;
    const base = buf & 0x001F_FFFF;
    for (let i = 0; i < 8; i++) {
      core.setReg(16 + i, ramReadWord(this.ram, base + 0x0C + i * 4));
    }
    core.setReg(30, ramReadWord(this.ram, base + 0x08));
    core.setReg(28, ramReadWord(this.ram, base + 0x2C));

    return this.ret(core, 0);
  }

  private dispatchAStrings(core: CpuRegAccess, fn: number): boolean {
    if (fn === 0x14) {
      return this.restoreState(this.a0(core), this.a1(core), core);
    }
    if (fn === 0x15) {
      return this.ret(core, strcat(this.ram, this.a0(core), this.a1(core)));
    }
    if (fn === 0x16) {
      return this.ret(core, strncat(this.ram, this.a0(core), this.a1(core), this.a2(core)));
    }
    if (fn === 0x17) {
      return this.ret(core, strcmp(this.ram, this.a0(core), this.a1(core)));
    }
    if (fn === 0x18) {
      return this.ret(core, strncmp(this.ram, this.a0(core), this.a1(core), this.a2(core)));
    }
    if (fn === 0x19) {
      return this.ret(core, strcpy(this.ram, this.a0(core), this.a1(core)));
    }
    if (fn === 0x1A) {
      return this.ret(core, strncpy(this.ram, this.a0(core), this.a1(core), this.a2(core)));
    }
    if (fn === 0x1B) {
      return this.ret(core, strlen(this.ram, this.a0(core)));
    }
    if (fn === 0x1C || fn === 0x1E) {
      return this.ret(core, strchr(this.ram, this.a0(core), this.a1(core)));
    }
    if (fn === 0x1D || fn === 0x1F) {
      return this.ret(core, strrchr(this.ram, this.a0(core), this.a1(core)));
    }
    if (fn === 0x20) {
      return this.ret(core, strpbrk(this.ram, this.a0(core), this.a1(core)));
    }
    if (fn === 0x21) {
      return this.ret(core, strspn(this.ram, this.a0(core), this.a1(core)));
    }
    if (fn === 0x22) {
      return this.ret(core, strcspn(this.ram, this.a0(core), this.a1(core)));
    }
    if (fn === 0x23) {
      return this.ret(core, strtok(this.ram, this.a0(core), this.a1(core), this.strtokState));
    }
    if (fn === 0x24) {
      return this.ret(core, strstr(this.ram, this.a0(core), this.a1(core)));
    }
    if (fn === 0x25) {
      return this.ret(core, toUpper(this.a0(core) & 0xFF));
    }
    if (fn === 0x26) {
      return this.ret(core, toLower(this.a0(core) & 0xFF));
    }
    if (fn === 0x27) {
      return this.ret(core, bcopyRegion(this.ram, this.a0(core), this.a1(core), this.a2(core)));
    }
    if (fn === 0x28) {
      return this.ret(core, bzeroRegion(this.ram, this.a0(core), this.a1(core)));
    }
    if (fn === 0x29 || fn === 0x2D) {
      return this.ret(core, memcmp(this.ram, this.a0(core), this.a1(core), this.a2(core)));
    }
    if (fn === 0x2A) {
      return this.ret(core, memcpy(this.ram, this.a0(core), this.a1(core), this.a2(core)));
    }
    if (fn === 0x2B) {
      return this.ret(core, memset(this.ram, this.a0(core), this.a1(core), this.a2(core)));
    }
    if (fn === 0x2C) {
      return this.ret(core, memmove(this.ram, this.a0(core), this.a1(core), this.a2(core)));
    }
    if (fn === 0x2E) {
      return this.ret(core, memchr(this.ram, this.a0(core), this.a1(core), this.a2(core)));
    }
    if (fn === 0x2F) {
      const acc = (this.rngState.acc * 1103515245 + 12345) >>> 0;
      this.rngState.acc = acc;

      return this.ret(core, (acc >>> 16) & 0x7FFF);
    }

    return this.unknown(core, 'A', fn);
  }

  private a0(core: CpuRegAccess): number {
    return core.getReg(4) >>> 0;
  }

  private a1(core: CpuRegAccess): number {
    return core.getReg(5) >>> 0;
  }

  private a2(core: CpuRegAccess): number {
    return core.getReg(6) >>> 0;
  }

  private a3(core: CpuRegAccess): number {
    return core.getReg(7) >>> 0;
  }

  private dispatchALibcTail(core: CpuRegAccess, fn: number): boolean {
    if (fn === 0x30) {
      this.rngState.acc = this.a0(core);

      return this.ret(core, 0);
    }
    if (fn === 0x31) {
      this.log.debug('bios', 'qsort callback unsupported; data left unsorted');

      return this.ret(core, 0);
    }
    if (fn === 0x32) {
      this.log.debug('bios', 'strtod: broken on real hardware; returning 0');

      return this.ret(core, 0);
    }
    if (fn === 0x33 || fn === 0x37) {
      const size = fn === 0x33 ? this.a0(core) : this.a0(core) * this.a1(core);
      const base = this.allocKernelMemory(size);
      if (base !== 0 && fn === 0x37) {
        memset(this.ram, base, 0, size);
      }

      return this.ret(core, base);
    }
    if (fn === 0x34) {
      return this.ret(core, 0);
    }
    if (fn === 0x35 || fn === 0x36) {
      this.log.debug('bios', 'lsearch/bsearch callback unsupported');

      return this.ret(core, 0);
    }
    if (fn === 0x38) {
      return this.ret(core, this.allocKernelMemory(this.a1(core)));
    }
    if (fn === 0x39) {
      this.log.debug('bios', 'InitHeap ignored (kernel heap fixed)');

      return this.ret(core, this.a0(core));
    }
    if (fn === 0x3A) {
      this.log.warn('bios', 'SystemErrorExit');
      core.suspend();

      return this.ret(core, 0);
    }
    if (fn === 0x3B) {
      return this.ret(core, 0);
    }
    if (fn === 0x3C) {
      this.log.debug('bios', `tty: ${JSON.stringify(String.fromCharCode(this.a0(core) & 0xFF))}`);

      return this.ret(core, 0);
    }
    if (fn === 0x3D) {
      this.writeRamByte(this.a0(core), 0);

      return this.ret(core, 0);
    }
    if (fn === 0x3E) {
      this.log.debug('bios', `tty: ${JSON.stringify(readString(this.ram, physOf(this.a0(core)), 128))}`);

      return this.ret(core, 0);
    }
    if (fn === 0x3F) {
      this.log.debug('bios', `printf: ${JSON.stringify(readString(this.ram, physOf(this.a0(core)), 128))}`);

      return this.ret(core, 0);
    }

    return this.unknown(core, 'A', fn);
  }

  private dispatchAExecGpu(core: CpuRegAccess, fn: number): boolean {
    if (fn === 0x40) {
      this.log.error('bios', 'SystemErrorUnresolvedException');
      core.suspend();

      return this.ret(core, 0);
    }
    if (fn === 0x41) {
      return this.loadExeHeader(core);
    }
    if (fn === 0x42) {
      return this.loadExeFile(core);
    }
    if (fn === 0x43) {
      return this.doExecute(this.a0(core), this.a1(core), this.a2(core), core);
    }
    if (fn === 0x44) {
      return this.ret(core, 0);
    }
    if (fn === 0x45) {
      writeKernelImage(this.ram, { evcbCount: this.confEvcb, tcbCount: this.confTcb });
      this.fillCallTables();
      this.files.remirrorAll();

      return this.ret(core, 0);
    }
    if (fn >= 0x46 && fn <= 0x4E) {
      if (!this.onceWarn.gpuFn) {
        this.onceWarn.gpuFn = true;
        this.log.warn('bios', 'BIOS GPU helper called; stubbed (game should drive the GPU directly)');
      }

      return this.ret(core, 0);
    }
    if (fn === 0x4F || fn === 0x50 || fn === 0x52 || fn === 0x53) {
      this.log.error('bios', 'SystemError');
      core.suspend();

      return this.ret(core, 0);
    }
    if (fn === 0x51) {
      return this.loadAndExecute(this.regStr(core, 4), this.a1(core), this.a2(core), core);
    }

    return this.unknown(core, 'A', fn);
  }

  private loadExeHeader(core: CpuRegAccess): boolean {
    const file = this.regStr(core, 4);
    const header = this.cd.readFileBytes(file, 0, 2048);
    if (header === null) {
      return this.ret(core, 0);
    }
    for (let i = 0; i < 0x3C; i++) {
      this.writeRamByte((this.a1(core) & 0x001F_FFFF) + i, header[0x10 + i]);
    }

    return this.ret(core, 1);
  }

  private loadExeFile(core: CpuRegAccess): boolean {
    const file = this.regStr(core, 4);
    const entry = this.cd.findFile(file);
    if (entry === null) {
      return this.ret(core, 0);
    }
    const header = this.cd.readFileBytes(file, 0, 2048);
    if (header === null) {
      return this.ret(core, 0);
    }
    let exe: PsExeInfo;
    try {
      exe = parsePsExe(header);
    } catch (_e) {
      return this.ret(core, 0);
    }
    const plan = planExeLoad(exe);
    this.cd.readIntoRam(entry.lba, 2048, plan.loadSize, this.ram, plan.loadAddr);

    return this.ret(core, 1);
  }

  private doExecute(headerbuf: number, p1: number, p2: number, core: CpuRegAccess): boolean {
    const buf = headerbuf & 0x001F_FFFF;
    const entry = ramReadWord(this.ram, buf);
    const gp = ramReadWord(this.ram, buf + 4);
    const memfillAddr = ramReadWord(this.ram, buf + 0x18);
    const memfillSize = ramReadWord(this.ram, buf + 0x1C);
    const spBase = ramReadWord(this.ram, buf + 0x20);
    const spOffset = ramReadWord(this.ram, buf + 0x24);
    ramWriteWord(this.ram, buf + 0x28, core.getReg(31));
    ramWriteWord(this.ram, buf + 0x2C, core.getReg(29));
    ramWriteWord(this.ram, buf + 0x30, core.getReg(30));
    ramWriteWord(this.ram, buf + 0x34, core.getReg(28));
    ramWriteWord(this.ram, buf + 0x38, core.getReg(16));
    if (memfillSize > 0 && memfillAddr !== 0) {
      const base = memfillAddr & 0x001F_FFFF;
      const size = Math.min(memfillSize, 0x0020_0000 - base);
      for (let i = 0; i < size; i++) {
        this.writeRamByte(base + i, 0);
      }
    }
    let sp = this.spOf(core);
    if (spBase !== 0) {
      sp = (spBase + spOffset) >>> 0;
    }

    return this.jumpToExe(core, entry, sp, gp, p1 >>> 0, p2 >>> 0);
  }

  private loadAndExecute(file: string, stackbase: number, stackoffset: number, core: CpuRegAccess): boolean {
    const cnf = {
      boot: file,
      tcb: this.confTcb,
      event: this.confEvcb,
      stack: stackbase !== 0 ? (stackbase + stackoffset) >>> 0 : this.confStack,
    };
    const plan = new ExeLoader(this.ram, this.cd, this.log).load(cnf);
    if (plan === null) {
      return this.ret(core, 0);
    }

    return this.jumpToExe(core, plan.entryPc, plan.sp, plan.gp, BOOT_ARG1, BOOT_ARG2);
  }

  private jumpToExe(core: CpuRegAccess, entry: number, sp: number, gp: number, bootArg1: number, bootArg2: number): boolean {
    core.setReg(4, bootArg1);
    core.setReg(5, bootArg2);
    core.setReg(6, 0);
    core.setReg(7, BOOT_ARG4);
    core.setReg(8, sp);
    core.setReg(11, entry);
    core.setReg(15, BOOT_T7);
    core.setReg(28, gp);
    core.setReg(29, sp);
    core.setReg(30, sp);
    core.setReg(31, VEC_RET);
    core.setPc(entry >>> 0);
    core.setNextPc((entry + 4) >>> 0);

    return true;
  }

  private dispatchADevices(core: CpuRegAccess, fn: number): boolean {
    if (fn >= 0x54 && fn <= 0x5A) {
      return this.dispatchAMeta(core, fn);
    }
    if (fn >= 0x70 && fn <= 0x77) {
      return this.dispatchAMeta(core, fn);
    }
    if (fn >= 0x5B && fn <= 0x5E) {
      if (!this.onceWarn.devTty) {
        this.onceWarn.devTty = true;
        this.log.warn('bios', 'dev_tty function called; stubbed');
      }

      return this.ret(core, 0);
    }
    if (fn >= 0x65 && fn <= 0x6F) {
      if (!this.onceWarn.devCard) {
        this.onceWarn.devCard = true;
        this.log.warn('bios', 'dev_card function called; no memcard support');
      }

      return this.ret(core, -1);
    }
    if (fn === 0x5F) {
      return this.ret(core, this.files.openInto(this.a0(core), this.regStr(core, 5), this.a2(core)));
    }
    if (fn === 0x60) {
      return this.ret(core, this.files.read(this.a0(core), this.a1(core), this.a2(core)));
    }
    if (fn === 0x61) {
      return this.ret(core, this.files.close(this.a0(core)));
    }
    if (fn === 0x62) {
      return this.ret(core, this.files.firstfile(this.regStr(core, 5), this.a2(core)));
    }
    if (fn === 0x63) {
      return this.ret(core, this.files.nextfile(this.a1(core)));
    }
    if (fn === 0x64) {
      return this.ret(core, this.files.chdir(this.regStr(core, 5)));
    }
    if (fn === 0x98 || fn === 0x99) {
      return this.ret(core, 0);
    }
    if (fn === 0x9A || fn === 0x9B) {
      this.log.error('bios', 'SystemError');
      core.suspend();

      return this.ret(core, 0);
    }
    if (fn === 0xA2) {
      this.intr.enqueueInternal(0, 'cdIo');
      this.intr.enqueueInternal(0, 'cdDma');

      return this.ret(core, 0);
    }
    if (fn === 0xA3) {
      this.intr.removeInternal(0, 'cdIo');
      this.intr.removeInternal(0, 'cdDma');

      return this.ret(core, 0);
    }
    if (fn === 0x9C) {
      this.applyConf(this.a0(core), this.a1(core), this.a2(core));

      return this.ret(core, 0);
    }
    if (fn === 0x9D) {
      ramWriteWord(this.ram, this.a0(core), this.confEvcb);
      ramWriteWord(this.ram, this.a1(core), this.confTcb);
      ramWriteWord(this.ram, this.a2(core), this.confStack);

      return this.ret(core, 0);
    }
    if (fn === 0x9E) {
      this.cdAutoAbort[this.a0(core) & 3] = this.a1(core) >>> 0;

      return this.ret(core, 0);
    }
    if (fn === 0x9F) {
      this.log.debug('bios', `SetMemSize(${this.a0(core)})`);

      return this.ret(core, 0);
    }
    if (fn >= 0x78 && fn <= 0x88) {
      return this.dispatchACdAsync(core, fn);
    }
    if (fn >= 0x90 && fn <= 0x95) {
      return this.dispatchACdAsync(core, fn);
    }
    if (fn === 0x96 || fn === 0x97) {
      return this.dispatchACdAsync(core, fn);
    }
    if (fn >= 0xA0 && fn <= 0xB4) {
      this.log.warn('bios', `DTL-H2000-only A(${fn.toString(16)}) called; returning 0`);

      return this.ret(core, 0);
    }

    return this.unknown(core, 'A', fn);
  }

  private dispatchACdAsync(core: CpuRegAccess, fn: number): boolean {
    if (fn === 0x78) {
      return this.cdAsyncSeekL(core);
    }
    if (fn === 0x7C) {
      return this.cdAsyncGetStatus(core);
    }
    if (fn === 0x7E) {
      return this.cdAsyncReadSector(core);
    }
    if (fn === 0x81) {
      return this.cdAsyncSetMode(core);
    }
    if (fn === 0x88) {
      return this.cdSetAudioVolume(core);
    }
    if (fn === 0x94) {
      ramWriteWord(this.ram, this.a0(core), 0);
      ramWriteWord(this.ram, this.a1(core), 0);
      this.logCdAsyncOnce();

      return this.ret(core, 0);
    }
    if (fn === 0x9D) {
      this.logCdAsyncOnce();

      return this.ret(core, 0);
    }

    return this.ret(core, 0);
  }

  private logCdAsyncOnce(): void {
    if (this.onceWarn.cdAsync) {
      return;
    }
    this.onceWarn.cdAsync = true;
    this.log.warn('bios', 'BIOS cd-async/meta helpers used (HLE-guessed semantics; check integration log)');
  }

  private cdAsyncSeekL(core: CpuRegAccess): boolean {
    const lba = this.a0(core) >>> 0;
    this.cdSeekLba = lba;
    this.scheduleCdCompletion(0x0020, 200_000);

    return this.ret(core, 0);
  }

  private cdAsyncGetStatus(core: CpuRegAccess): boolean {
    const dst = this.a0(core);
    this.writeRamByte(dst & 0x001F_FFFF, 0x02);
    this.scheduleCdCompletion(0x0010, 40_000);

    return this.ret(core, 0);
  }

  private cdAsyncReadSector(core: CpuRegAccess): boolean {
    const count = Math.min(this.a0(core) >>> 0, 1024);
    const dst = this.a1(core) >>> 0;
    const lba = this.cdSeekLba;
    this.sched.at(600_000, () => {
      this.cd.readIntoRam(lba, 0, count * 0x800, this.ram, dst);
      this.cdSeekLba = (lba + count) >>> 0;
      this.logCdAsyncOnce();
      this.collectDeliveries(EV_CLASS_CDROM, EV_SPEC_DMA_DONE);
      this.maybeResumeWaiter();
    });

    return this.ret(core, 0);
  }

  private cdAsyncSetMode(core: CpuRegAccess): boolean {
    this.cdSysMode = this.a0(core) >>> 0;
    this.scheduleCdCompletion(0x0020, 30_000);

    return this.ret(core, 0);
  }

  private cdSetAudioVolume(core: CpuRegAccess): boolean {
    void core;
    this.logCdAsyncOnce();

    return this.ret(core, 0);
  }

  private scheduleCdCompletion(spec: number, cycles: number): void {
    if (this.cdAsyncHandle !== null) {
      this.sched.cancel(this.cdAsyncHandle);
    }
    this.cdAsyncHandle = this.sched.at(cycles, () => {
      this.cdAsyncHandle = null;
      this.logCdAsyncOnce();
      this.collectDeliveries(EV_CLASS_CDROM, spec);
      this.maybeResumeWaiter();
    });
  }

  private dispatchAMeta(core: CpuRegAccess, fn: number): boolean {
    if (fn === 0x54 || fn === 0x71) {
      return this.ret(core, 0);
    }
    if (fn === 0x55 || fn === 0x70) {
      return this.ret(core, 0);
    }
    if (fn === 0x56 || fn === 0x72) {
      return this.ret(core, 0);
    }
    if (fn >= 0x73 && fn <= 0x77) {
      return this.ret(core, 0);
    }

    return this.unknown(core, 'A', fn);
  }

  private unknown(core: CpuRegAccess, table: string, fn: number): boolean {
    if (fn < 0x40) {
      this.log.warn('bios', `${table}(${fn.toString(16)}) not implemented`);
    }

    return this.ret(core, 0);
  }

  private dispatchB(core: CpuRegAccess, fn: number): boolean {
    if (fn <= 0x11) {
      return this.dispatchBMem(core, fn);
    }
    if (fn <= 0x20) {
      return this.dispatchBEvents(core, fn);
    }
    if (fn <= 0x31) {
      if (fn === 0x21 || fn === 0x22 || fn === 0x23 || fn === 0x2A || fn === 0x2B) {
        return this.systemErrorAt(core, `B(${fn.toString(16)})`);
      }

      return this.ret(core, 0);
    }
    if (fn <= 0x3F) {
      return this.dispatchBAliases(core, fn);
    }

    return this.dispatchBDev(core, fn);
  }

  private systemErrorAt(core: CpuRegAccess, what: string): boolean {
    this.log.error('bios', `SystemError at ${what}`);
    core.suspend();

    return this.ret(core, 0);
  }

  private dispatchBMem(core: CpuRegAccess, fn: number): boolean {
    if (fn === 0x00) {
      return this.ret(core, this.allocKernelMemory(this.a0(core)));
    }
    if (fn === 0x01) {
      return this.ret(core, 1);
    }
    if (fn === 0x02) {
      return this.initTimer(core);
    }
    if (fn === 0x03) {
      return this.getTimer(core);
    }
    if (fn === 0x04) {
      return this.changeTimerIrq(core, true);
    }
    if (fn === 0x05) {
      return this.changeTimerIrq(core, false);
    }
    if (fn === 0x06) {
      this.hwStore(RC_REG_BASE + this.timerSlot(core) * 0x10, 0);

      return this.ret(core, 0);
    }
    if (fn === 0x07) {
      return this.deliverFromGame(this.a0(core), this.a1(core), core);
    }
    if (fn === 0x08) {
      return this.ret(core, this.events.open(this.a0(core), this.a1(core), this.a2(core), this.a3(core)));
    }
    if (fn === 0x09) {
      return this.ret(core, this.events.close(this.a0(core)));
    }
    if (fn === 0x0A) {
      return this.waitEvent(this.a0(core), core);
    }
    if (fn === 0x0B) {
      return this.ret(core, this.events.test(this.a0(core)));
    }
    if (fn === 0x0C) {
      return this.ret(core, this.events.enable(this.a0(core)));
    }
    if (fn === 0x0D) {
      return this.ret(core, this.events.disable(this.a0(core)));
    }
    if (fn === 0x0E) {
      return this.openThread(core);
    }
    if (fn === 0x0F) {
      return this.closeThread(core);
    }
    if (fn === 0x10) {
      return this.changeThread(core, this.a0(core) & 0xFFFF);
    }

    return this.unknown(core, 'B', fn);
  }

  private timerSlot(core: CpuRegAccess): number {
    return Math.min(this.a0(core), 3);
  }

  private initTimer(core: CpuRegAccess): boolean {
    const t = this.timerSlot(core);
    const flags = this.a2(core);
    const mode = ((flags & 0x10) !== 0 ? 0x49 : 0x48) | ((flags & 0x001) !== 0 ? 0x100 : 0) | ((flags & 0x1000) !== 0 ? 0x010 : 0);
    this.hwStore(RC_REG_BASE + t * 0x10 + RC_REG_MODE_OFF, mode);
    this.hwStore(RC_REG_BASE + t * 0x10 + RC_REG_TARGET_OFF, this.a1(core));

    return this.ret(core, 0);
  }

  private getTimer(core: CpuRegAccess): boolean {
    const t = this.timerSlot(core);

    return this.ret(core, this.hwLoad(RC_REG_BASE + t * 0x10));
  }

  private changeTimerIrq(core: CpuRegAccess, enable: boolean): boolean {
    const t = this.timerSlot(core);
    const bit = t <= 2 ? 1 << (4 + t) : 1;
    const mask = this.hwLoad(IRQ_MASK_REG);
    if (enable) {
      this.hwStore(IRQ_MASK_REG, (mask | bit) >>> 0);
    } else {
      this.hwStore(IRQ_MASK_REG, (mask & ~bit) >>> 0);
    }

    return this.ret(core, 0);
  }

  private hwLoad(addr: number): number {
    const f = this.hwRead32;
    if (f === null) {
      this.warnNoHw();

      return 0;
    }

    return f(addr) >>> 0;
  }

  private hwStore(addr: number, value: number): void {
    const f = this.hwWrite32;
    if (f === null) {
      this.warnNoHw();

      return;
    }
    f(addr, value >>> 0);
  }

  private warnNoHw(): void {
    if (this.onceWarn.hwRegs) {
      return;
    }
    this.onceWarn.hwRegs = true;
    this.log.warn('bios', 'hw register access without wiring (system.bios.hwRead32/hwWrite32)');
  }

  private openThread(core: CpuRegAccess): boolean {
    for (let i = 0; i < this.tcbStatus.length; i++) {
      if (this.tcbStatus[i] === TCB_STATUS_FREE) {
        this.tcbStatus[i] = 0x4000;
        ramWriteWord(this.ram, TCB_ADDR + i * TCB_SIZE, 0x4000);
        this.threadContexts[i] = this.newThreadContext(core);

        return this.ret(core, (0xFF00_0000 | i) >>> 0);
      }
    }

    return this.ret(core, 0xFFFF_FFFF);
  }

  private newThreadContext(core: CpuRegAccess): CpuContext {
    const ctx = core.save();
    const entry = this.a0(core);
    const stack = this.a1(core);
    ctx.pc = entry;
    ctx.nextPc = (entry + 4) >>> 0;
    ctx.regs[28] = this.a2(core);
    ctx.regs[29] = stack;
    ctx.regs[30] = stack;
    ctx.regs[31] = 0;
    ctx.branchDelay = false;

    return ctx;
  }

  private changeThread(core: CpuRegAccess, target: number): boolean {
    const next = this.threadContexts[target];
    if (target === this.currentThread || next === undefined || next === null || this.tcbStatus[target] !== 0x4000) {
      return this.ret(core, 1);
    }
    if (this.runner.depth > 0) {
      this.log.warn('bios', 'ChangeThread inside exception context ignored');

      return this.ret(core, 1);
    }
    const caller = core.save();
    const resume = caller.regs[31] >>> 0;
    caller.pc = resume;
    caller.nextPc = (resume + 4) >>> 0;
    caller.regs[2] = 1;
    this.threadContexts[this.currentThread] = caller;
    this.threadContexts[target] = null;
    this.currentThread = target;
    ramWriteWord(this.ram, PCB_ADDR, TCB_ADDR + target * TCB_SIZE);
    next.sr = caller.sr;
    core.restore(next);

    return true;
  }

  private closeThread(core: CpuRegAccess): boolean {
    const handle = this.a0(core);
    const i = handle & 0xF;
    if (i < this.tcbStatus.length && this.tcbStatus[i] === 0x4000) {
      this.tcbStatus[i] = TCB_STATUS_FREE;
      ramWriteWord(this.ram, TCB_ADDR + i * TCB_SIZE, TCB_STATUS_FREE);
    }

    return this.ret(core, 1);
  }

  private waitEvent(handle: number, core: CpuRegAccess): boolean {
    if (this.events.isReady(handle)) {
      return this.ret(core, this.events.test(handle));
    }
    if (!this.events.isBlockedWaitCandidate(handle)) {
      return this.ret(core, 0);
    }
    const slot = this.events.slotOf(handle);
    this.waitCore = core;
    if (!this.runner.beginWait(slot, core)) {
      return this.ret(core, 0);
    }
    this.sched.at(FRAME_CYCLES, () => this.fallbackWaitWakeup());

    return true;
  }

  private fallbackWaitWakeup(): void {
    if (this.runner.isWaiting && this.waitCore !== null) {
      this.runner.resumeWait(this.waitCore);
    }
  }

  private dispatchBEvents(core: CpuRegAccess, fn: number): boolean {
    if (fn === 0x12) {
      return this.initPad(core);
    }
    if (fn === 0x13) {
      if (!this.padOn) {
        this.intr.enqueueInternal(2, 'padcard');
      }
      this.padOn = true;

      return this.ret(core, 0);
    }
    if (fn === 0x14) {
      this.padOn = false;
      this.intr.removeInternal(2, 'padcard');

      return this.ret(core, 0);
    }
    if (fn === 0x15) {
      this.outdatedDest = this.a1(core);
      this.padOn = true;

      return this.ret(core, 0);
    }
    if (fn === 0x16) {
      const v = this.padInput === null ? 0xFFFF : this.padInput.buttons & 0xFFFF;

      return this.ret(core, v);
    }
    if (fn === 0x17) {
      if (this.runner.depth === 0) {
        this.log.error('bios', 'ReturnFromException outside exception context');
        core.suspend();

        return this.ret(core, 0);
      }

      return this.runner.shortCircuitReturn(core);
    }
    if (fn === 0x18) {
      this.writeExitStruct();
      this.exitHookFn = 0;

      return this.ret(core, EXIT_STRUCT_ADDR);
    }
    if (fn === 0x19) {
      this.exitHookFn = this.a0(core);

      return this.ret(core, 0);
    }
    if (fn >= 0x1A && fn <= 0x1F) {
      return this.systemErrorAt(core, `B(${fn.toString(16)})`);
    }
    if (fn === 0x20) {
      this.events.unDeliver(this.a0(core), this.a1(core));

      return this.ret(core, 0);
    }

    return this.unknown(core, 'B', fn);
  }

  private writeExitStruct(): void {
    ramWriteWord(this.ram, EXIT_STRUCT_ADDR + 0x00, VEC_RET);
    ramWriteWord(this.ram, EXIT_STRUCT_ADDR + 0x04, (KERNEL_STACK_TOP - 4) >>> 0);
    ramWriteWord(this.ram, EXIT_STRUCT_ADDR + 0x08, 0);
    for (let i = 0; i < 8; i++) {
      ramWriteWord(this.ram, EXIT_STRUCT_ADDR + 0x0C + i * 4, 0);
    }
    ramWriteWord(this.ram, EXIT_STRUCT_ADDR + 0x2C, 0);
  }

  private initPad(core: CpuRegAccess): boolean {
    this.padBuf1 = this.a0(core);
    this.padBuf2 = this.a2(core);
    const z1 = Math.min(this.a1(core), 0x22);
    const z2 = Math.min(this.a3(core), 0x22);
    if (this.padBuf1 !== 0) {
      memset(this.ram, this.padBuf1, 0, z1);
      this.writeRamByte(this.padBuf1, 0xFF);
    }
    if (this.padBuf2 !== 0) {
      memset(this.ram, this.padBuf2, 0, z2);
      this.writeRamByte(this.padBuf2, 0xFF);
    }

    return this.ret(core, 0);
  }

  private dispatchBAliases(core: CpuRegAccess, fn: number): boolean {
    if (fn <= 0x3B) {
      return this.dispatchA(core, fn - 0x32);
    }

    return this.dispatchA(core, fn - 1);
  }

  private dispatchBDev(core: CpuRegAccess, fn: number): boolean {
    if (fn === 0x40) {
      return this.ret(core, this.files.chdir(this.regStr(core, 4)));
    }
    if (fn === 0x41) {
      return this.ret(core, this.files.formatDevice());
    }
    if (fn === 0x42) {
      return this.ret(core, this.files.firstfile(this.regStr(core, 4), this.a1(core)));
    }
    if (fn === 0x43) {
      return this.ret(core, this.files.nextfile(this.a0(core)));
    }
    if (fn === 0x44) {
      return this.ret(core, this.files.rename(this.regStr(core, 4), this.regStr(core, 5)));
    }
    if (fn === 0x45) {
      return this.ret(core, this.files.deleteFile(this.regStr(core, 4)));
    }
    if (fn === 0x46) {
      return this.ret(core, this.files.undelete(this.regStr(core, 4)));
    }
    if (fn === 0x47 || fn === 0x48 || fn === 0x49) {
      this.log.debug('bios', `B(${fn.toString(16)}) device-table helper stub`);

      return this.ret(core, 0);
    }
    if (fn === 0x4A) {
      return this.ret(core, 1);
    }
    if (fn === 0x4B || fn === 0x4C) {
      return this.ret(core, 0);
    }
    if (fn >= 0x4D && fn <= 0x50) {
      return this.ret(core, -1);
    }
    if (fn === 0x51 || fn === 0x53) {
      return this.ret(core, 0xFFFF_FFFF);
    }
    if (fn === 0x52) {
      return this.systemErrorAt(core, 'B(52h)');
    }
    if (fn === 0x54) {
      return this.ret(core, this.files.lastFileError());
    }
    if (fn === 0x55) {
      return this.ret(core, this.files.errorOf(this.a0(core)));
    }
    if (fn === 0x56) {
      return this.ret(core, C0_TABLE_ADDR);
    }
    if (fn === 0x57) {
      return this.ret(core, B0_TABLE_ADDR);
    }
    if (fn === 0x58) {
      return this.ret(core, 0);
    }
    if (fn === 0x59) {
      return this.ret(core, this.files.probeDevice(this.regStr(core, 4)).known ? 1 : 0);
    }
    if (fn === 0x5A) {
      return this.systemErrorAt(core, 'B(5Ah)');
    }
    if (fn === 0x5B) {
      const old = this.changeClearPad;
      this.changeClearPad = this.a0(core);

      return this.ret(core, old);
    }
    if (fn === 0x5C || fn === 0x5D) {
      return this.ret(core, 0x11);
    }

    return this.unknown(core, 'B', fn);
  }

  private dispatchC(core: CpuRegAccess, fn: number): boolean {
    if (fn >= 0x80) {
      return this.dispatchB(core, fn - 0x80);
    }
    if (fn === 0x00) {
      const p = Math.min(this.a0(core), 3);
      this.intr.enqueueInternal(p, 'timer0');
      this.intr.enqueueInternal(p, 'timer1');
      this.intr.enqueueInternal(p, 'timer2');
      this.intr.enqueueInternal(p, 'vblank');
      this.intr.enqueueInternal(p, 'card');

      return this.ret(core, 0);
    }
    if (fn === 0x01) {
      this.intr.enqueueInternal(Math.min(this.a0(core), 3), 'syscall');

      return this.ret(core, 0);
    }
    if (fn === 0x02) {
      const prio = Math.min(this.a0(core), 3);
      const struc = this.a1(core);
      this.intr.enqueueGame(prio, struc, this.ram, (prev) => ramWriteWord(this.ram, struc, prev));

      return this.ret(core, 1);
    }
    if (fn === 0x03) {
      return this.ret(core, this.intr.dequeueGame(Math.min(this.a0(core), 3), this.a1(core)));
    }
    if (fn === 0x04) {
      const slot = this.events.firstFreeSlot();
      if (slot < 0) {
        return this.ret(core, 0xFFFF_FFFF);
      }

      return this.ret(core, slot);
    }
    if (fn === 0x05) {
      for (let i = 0; i < this.tcbStatus.length; i++) {
        if (this.tcbStatus[i] === TCB_STATUS_FREE) {
          return this.ret(core, i);
        }
      }

      return this.ret(core, 0xFFFF_FFFF);
    }
    if (fn === 0x06) {
      return this.ret(core, 0x8000_0080);
    }
    if (fn === 0x07) {
      installExceptionHandlerStubs(this.ram);

      return this.ret(core, 0);
    }
    if (fn === 0x08) {
      this.log.debug('bios', `SysInitMemory(${this.a0(core).toString(16)}, ${this.a1(core).toString(16)})`);

      return this.ret(core, 0);
    }
    if (fn === 0x09) {
      return this.ret(core, 0);
    }
    if (fn === 0x0A) {
      const t = Math.min(this.a0(core), 3);
      const old = this.intr.autoAckRcnt[t];
      this.intr.autoAckRcnt[t] = this.a1(core) >>> 0;

      return this.ret(core, old);
    }
    if (fn === 0x0B) {
      this.log.error('bios', 'SystemError (C(0Bh))');
      core.suspend();

      return this.ret(core, 0);
    }
    if (fn === 0x0C) {
      this.intr.enqueueInternal(Math.min(this.a0(core), 3), 'defint');

      return this.ret(core, 0);
    }
    if (fn === 0x0D) {
      const irq = Math.min(this.a0(core), 10);
      const old = this.intr.autoAckIrq[irq];
      this.intr.autoAckIrq[irq] = this.a1(core) >>> 0;

      return this.ret(core, old);
    }
    if (fn >= 0x0E && fn <= 0x18) {
      return this.ret(core, 0);
    }
    if (fn === 0x19) {
      this.log.warn('bios', `ioabort ${this.a0(core).toString(16)} ${this.a1(core).toString(16)}`);

      return this.ret(core, 0);
    }
    if (fn === 0x1A) {
      this.cardFindMode = this.a0(core);

      return this.ret(core, 0);
    }
    if (fn === 0x1B) {
      this.kernelRedirectFlag = this.a0(core);

      return this.ret(core, 0);
    }
    if (fn === 0x1C) {
      return this.ret(core, 0);
    }
    if (fn === 0x1D) {
      return this.ret(core, this.cardFindMode);
    }

    return this.ret(core, 0);
  }
}