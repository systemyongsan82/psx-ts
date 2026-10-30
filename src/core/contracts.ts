// Shared contracts — every component in src/core conforms to these.
// Ownership: system.ts assembles implementations; components own internals.

export const CPU_HZ = 33_868_800;
export const CYCLES_PER_LINE = 2_150;
export const LINES_PER_FRAME = 263;
export const FRAME_CYCLES = CYCLES_PER_LINE * LINES_PER_FRAME;
export const VBLANK_LINE = 243;
export const CD_SECTOR_CYCLES = 451_584;
export const SPU_SAMPLE_CYCLES = 768;
export const RAM_SIZE = 0x0020_0000;
export const SCRATCH_SIZE = 0x400;
export const SPU_RAM_SIZE = 0x0080_0000;
export const VRAM_W = 1024;
export const VRAM_H = 512;

export const RAM_ALIAS_MASK = 0x001F_FFFF & ~0x7FF;

type IrqLineValue = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type IrqLine = IrqLineValue;

export type CpuExceptionKind =
  | 'interrupt'
  | 'syscall'
  | 'breakpoint'
  | 'addressLoad'
  | 'addressStore'
  | 'busErrorData'
  | 'busErrorInst'
  | 'overflow'
  | 'coprocessorError';

export interface Scheduler {
  readonly now: number;
  at(cyclesFromNow: number, fn: () => void): object;
  cancel(handle: object): void;
}

export type LogTag =
  | 'cpu' | 'gte' | 'bus' | 'timer' | 'dma' | 'gpu' | 'cdrom' | 'spu'
  | 'mdec' | 'bios' | 'disc' | 'iso' | 'sys' | 'sio' | 'ui';

export interface Logger {
  debug(tag: LogTag, msg: string): void;
  warn(tag: LogTag, msg: string): void;
  error(tag: LogTag, msg: string): void;
  dump(limit: number): string;
}

export interface MemAccess {
  load8(addr: number): number;
  load16(addr: number): number;
  load32(addr: number): number;
  store8(addr: number, value: number): void;
  store16(addr: number, value: number): void;
  store32(addr: number, value: number): void;
}

export interface DmaChannel {
  readonly id: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

export type DmaMode = 'manual' | 'blockFill' | 'linked' | 'reverseTable';

export interface DmaConfig {
  readonly base: number;
  readonly wordsPerBlock: number;
  readonly blockCount: number;
  readonly step: 1 | 4;
  readonly direction: 'toDevice' | 'toRam';
  readonly mode: DmaMode;
  readonly chopper: boolean;
  readonly enable: boolean;
}

export interface DmaDevice {
  dmaStart(channel: DmaChannel, config: DmaConfig, ram: Uint32Array): void;
}

export interface IrqController {
  raise(line: IrqLine): void;
}

export interface IoDevice {
  load32(addr: number): number;
  load16(addr: number): number;
  load8(addr: number): number;
  store32(addr: number, value: number): void;
  store16(addr: number, value: number): void;
  store8(addr: number, value: number): void;
}

export interface CpuContext {
  pc: number;
  nextPc: number;
  regs: Array<number>;
  hi: number;
  lo: number;
  sr: number;
  cause: number;
  epc: number;
  branchDelay: boolean;
  branchTarget: number;
}

export interface CpuRegAccess {
  getReg(index: number): number;
  setReg(index: number, value: number): void;
  pc(): number;
  setPc(value: number): void;
  readonly nextPc: number;
  setNextPc(value: number): void;
  save(): CpuContext;
  restore(ctx: CpuContext): void;
}

export interface CpuHooks {
  irqActive(): boolean;
  kuserCall(pc: number, core: CpuRegAccess): boolean;
  exception(kind: CpuExceptionKind, code: number, addr: number, core: CpuRegAccess): void;
}

export interface GteUnit {
  exec(instr: number): void;
  data(index: number): number;
  setData(index: number, value: number): void;
  ctl(index: number): number;
  setCtl(index: number, value: number): void;
}

export interface CpuDeps {
  bus: MemAccess;
  gte: GteUnit;
  irqCheck(): boolean;
  hooks: CpuHooks;
}

export interface Cpu {
  reset(entryPc: number): void;
  run(budget: number): number;
  readonly pc: number;
  save(): CpuContext;
  restore(ctx: CpuContext): void;
  getReg(index: number): number;
  setReg(index: number, value: number): void;
  haltRequest(): void;
}

export interface DisplayFrame {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export interface Gpu extends IoDevice, DmaDevice {
  readonly vram: Uint16Array;
  frameBoundary(): void;
  present(): DisplayFrame;
}

export type CdCommandResult = number;

export interface CdFileEntry {
  readonly lba: number;
  readonly size: number;
}

export interface CdRomHle {
  findFile(path: string): CdFileEntry | null;
  readFileBytes(path: string, byteOffset: number, length: number): Uint8Array | null;
  readIntoRam(lba: number, byteOffset: number, length: number, ram: Uint32Array, dstAddr: number): void;
}

export interface SpuXaIn {
  xaSector(channel: number, subheader: number, payload: Uint8Array): void;
  cddaSector(payload: Uint8Array): void;
}

export interface AudioSink {
  readonly availableFrames: number;
  read(dst: Float32Array, frames: number): void;
}

export interface CdromUnit extends IoDevice, DmaDevice, CdRomHle {
  tick(cycles: number): void;
}

export interface Spu extends IoDevice, DmaDevice {
  tick(cycles: number): void;
  xaSink: SpuXaIn;
  readonly sink: AudioSink;
}

export interface MdecUnit extends IoDevice, DmaDevice {
  readonly busy: boolean;
}

export interface RawSectorIo {
  readonly totalSectors: number;
  readonly baseOffset: number;
  readRawSectors(startLba: number, count: number, dst: Uint8Array): boolean;
}

export interface IsoEntry {
  readonly name: string;
  readonly path: string;
  readonly lba: number;
  readonly size: number;
  readonly isDirectory: boolean;
}

export interface Iso9660 {
  find(path: string): IsoEntry | null;
  list(path: string): Array<IsoEntry>;
}

export interface PsExeInfo {
  readonly magic: string;
  readonly textAddr: number;
  readonly textSize: number;
  readonly pc: number;
  readonly gp: number;
  readonly dataAddr: number;
  readonly dataSize: number;
  readonly bssAddr: number;
  readonly bssSize: number;
  readonly payload: Uint8Array;
}

export interface PadInput {
  buttons: number;
}

export interface BootInfo {
  readonly entryPc: number;
  readonly sp: number;
  readonly gp: number;
}

export interface Bios {
  boot(): BootInfo;
  kuserCall(pc: number, core: CpuRegAccess): boolean;
  exception(kind: CpuExceptionKind, code: number, addr: number, core: CpuRegAccess): void;
}

export interface SystemOptions {
  readonly binPath: string;
  readonly cuePath: string | null;
  readonly log: Logger;
}

export interface System {
  readonly cpu: Cpu;
  readonly bus: MemAccess;
  readonly gpu: Gpu;
  readonly cd: CdromUnit;
  readonly spu: Spu;
  readonly mdec: MdecUnit;
  readonly sched: Scheduler;
  readonly log: Logger;
  readonly pad: PadInput;
  readonly frameNumber: number;
  boot(): void;
  runFrames(count: number): void;
  runCycles(cycles: number): void;
}