import { RAM_SIZE } from '../core/contracts';
import { HARDWARE_CD_TIMING } from '../core/timingProfile';
import type { CdTiming } from '../core/timingProfile';
import { seekCycles } from './seektime';
import type {
  CdFileEntry,
  CdromUnit,
  DmaChannel,
  DmaConfig,
  IrqController,
  Iso9660,
  Logger,
  Scheduler,
  Spu,
} from '../core/contracts';
import type { PsxBinImage } from './image';

const RAW_SECTOR_SIZE = 2352;
const HEADER_OFFSET = 12;
const HEADER_SIZE = 12;
const USER_DATA_OFFSET = 24;
const USER_DATA_SIZE = 0x800;
const RAW_MINUS_SYNC_SIZE = 0x924;
const XA_PAYLOAD_SIZE = 2304;
const FIFO_SIZE = 16;


const IRQ_LINE = 2;
const STOPS_READING_AT_WRITE: ReadonlySet<number> = new Set([0x02, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x1B, 0x1C]);

const ERR_INVALID_PARAM = 0x10;
const ERR_WRONG_PARAMS = 0x20;
const ERR_INVALID_COMMAND = 0x40;

const ST_ERROR = 0x01;
const ST_SPINDLE = 0x02;
const ST_READING = 0x20;
const ST_SEEKING = 0x40;

const SUBMODE_AUDIO = 0x04;
const SUBMODE_REALTIME = 0x40;

const REQ_BFRD = 0x80;

function bcdByte(v: number): number {
  return (v >> 4) * 10 + (v & 0x0F);
}

function toBcd(v: number): number {
  return (((v / 10) | 0) << 4) | (v % 10);
}

function msfToLba(min: number, sec: number, frame: number): number {
  return min * 60 * 75 + sec * 75 + frame - 150;
}

interface PendingInt {
  readonly num: number;
  readonly bytes: Array<number>;
}

export class Cdrom implements CdromUnit {
  private readonly sched: Scheduler;
  private readonly log: Logger;
  private readonly image: PsxBinImage;
  private readonly iso: Iso9660;
  private readonly spu: Spu;
  private readonly irq: IrqController;
  private readonly timing: CdTiming;

  private readonly params = new Uint8Array(FIFO_SIZE);
  private paramCount = 0;
  private readonly respWin = new Uint8Array(FIFO_SIZE);
  private respPos = 0;
  private respLen = 0;
  private respExhausted = false;
  private readonly cmdParams = new Uint8Array(FIFO_SIZE);

  private readonly pendingInts: Array<PendingInt> = [];
  private readonly locCache = new Uint8Array(HEADER_SIZE);
  private readonly xaRaw = new Uint8Array(RAW_SECTOR_SIZE);
  private readonly dataBuf = new Uint8Array(RAW_MINUS_SYNC_SIZE);
  private readonly hleChunk = new Uint8Array(RAW_SECTOR_SIZE);

  private index = 0;
  private irqEnable = 0x1F;
  private dataPending = false;
  private dataDone = false;
  private dataIdx = 0;
  private dataLen = USER_DATA_SIZE;

  private reading = false;
  private seeking = false;
  private spindleOff = false;
  private errLatch = false;
  private locDirty = false;
  private seekTarget = 0;
  private nextSectorLba = 0;
  private sectorTimer = 0;

  private modeByte = 0x40;
  private filterFile = 0;
  private filterChan = 0;
  private muted = false;
  private resultReady = false;

  private firstHandle: object | null = null;
  private secondHandle: object | null = null;
  private seekHandle: object | null = null;
  private readHandle: object | null = null;

  constructor(
    sched: Scheduler,
    log: Logger,
    image: PsxBinImage,
    iso: Iso9660,
    spu: Spu,
    irq: IrqController,
    timing: CdTiming = HARDWARE_CD_TIMING,
  ) {
    this.timing = timing;
    this.sched = sched;
    this.log = log;
    this.image = image;
    this.iso = iso;
    this.spu = spu;
    this.irq = irq;
    this.snapToSector(0);
  }

  // ---- HLE fast paths (synchronous, used by the HLE BIOS kernel) ----

  findFile(path: string): CdFileEntry | null {
    const e = this.iso.find(path);
    if (e === null) {
      return null;
    }

    return { lba: e.lba, size: e.size };
  }

  readFileBytes(path: string, byteOffset: number, length: number): Uint8Array | null {
    const e = this.iso.find(path);
    if (e === null) {
      return null;
    }
    const off = Math.max(0, byteOffset);
    const len = Math.max(0, Math.min(length, e.size - off));

    return this.isoFileRead(e.lba, off, len);
  }

  private isoFileRead(lba: number, byteOffset: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    if (length <= 0) {
      return out;
    }
    let sector = lba + Math.floor(byteOffset / USER_DATA_SIZE);
    let skip = byteOffset % USER_DATA_SIZE;
    let done = 0;
    while (done < length) {
      if (!this.image.readRawSectors(sector, 1, this.xaRaw)) {
        this.log.warn('cdrom', `hle read out of range at lba ${sector}`);
        return out;
      }
      const take = Math.min(USER_DATA_SIZE - skip, length - done);
      out.set(this.xaRaw.subarray(USER_DATA_OFFSET + skip, USER_DATA_OFFSET + skip + take), done);
      done += take;
      skip = 0;
      sector += 1;
    }

    return out;
  }

  readIntoRam(lba: number, byteOffset: number, length: number, ram: Uint32Array, dstAddr: number): void {
    if (length <= 0 || ram.length === 0) {
      return;
    }
    let sector = lba + Math.floor(Math.max(0, byteOffset) / USER_DATA_SIZE);
    let skip = Math.max(0, byteOffset) % USER_DATA_SIZE;
    let done = 0;
    while (done < length) {
      if (!this.image.readRawSectors(sector, 1, this.hleChunk)) {
        this.log.warn('cdrom', `hle bulk read out of range at lba ${sector}`);
        return;
      }
      const take = Math.min(USER_DATA_SIZE - skip, length - done);
      this.spreadWrite(ram, dstAddr + done, this.hleChunk, USER_DATA_OFFSET + skip, take);
      done += take;
      skip = 0;
      sector += 1;
    }
  }

  // ---- device registers (banks selected by 1F801800 bit0-1) ----

  load32(addr: number): number {
    if ((addr & 0x1F) === 0x02) {
      return (this.popDataByte() | (this.popDataByte() << 8) | (this.popDataByte() << 16) | (this.popDataByte() << 24)) >>> 0;
    }
    const lo = this.load8(addr) & 0xFF;

    return (lo | (lo << 8) | (lo << 16) | (lo << 24)) >>> 0;
  }

  load16(addr: number): number {
    if ((addr & 0x1F) === 0x02) {
      return (this.popDataByte() | (this.popDataByte() << 8)) & 0xFFFF;
    }
    const lo = this.load8(addr) & 0xFF;

    return (lo | (lo << 8)) & 0xFFFF;
  }

  load8(addr: number): number {
    const a = addr & 0x1F;
    if (a === 0x01) {
      const v = this.respWin[this.respPos];
      this.respPos = (this.respPos + 1) & 0x0F;
      if (this.respPos >= this.respLen) {
        this.respExhausted = true;
        this.resultReady = false;
      }

      return v;
    }
    if (a === 0x02) {
      return this.popDataByte();
    }
    if (a === 0x00) {
      let f = this.index;
      if (this.paramCount === 0) {
        f |= 0x08;
      }
      if (this.paramCount < FIFO_SIZE) {
        f |= 0x10;
      }
      if (this.respBytesReady()) {
        f |= 0x20;
      }
      if (this.dataPending && !this.dataDone) {
        f |= 0x40;
      }
      if (this.firstHandle !== null) {
        f |= 0x80;
      }

      return f;
    }
    if (a === 0x03) {
      if (this.index === 0 || this.index === 2) {
        return (this.irqEnable & 0x1F) | 0xE0;
      }
      const num = this.pendingInts.length > 0 ? this.pendingInts[0].num : 0;

      return num | 0xE0;
    }

    return 0;
  }

  store32(addr: number, value: number): void {
    if ((addr & 0x1F) === 0x02) {
      this.writeDataPort(value);

      return;
    }
    this.store8(addr, value & 0xFF);
  }

  store16(addr: number, value: number): void {
    if ((addr & 0x1F) === 0x02) {
      if (this.index === 0) {
        this.pushParam(value & 0xFF);
        this.pushParam((value >>> 8) & 0xFF);
      }

      return;
    }
    this.store8(addr, value & 0xFF);
  }

  private writeDataPort(v: number): void {
    if (this.index === 0) {
      this.pushParam(v & 0xFF);
      this.pushParam((v >>> 8) & 0xFF);
      this.pushParam((v >>> 16) & 0xFF);
      this.pushParam((v >>> 24) & 0xFF);
    }
  }

  store8(addr: number, value: number): void {
    const a = addr & 0x1F;
    if (a === 0x00) {
      this.index = value & 0x03;

      return;
    }
    if (a === 0x01) {
      if (this.index === 0) {
        this.beginCommand(value & 0xFF);
      }

      return;
    }
    if (a === 0x02) {
      if (this.index === 0) {
        this.pushParam(value & 0xFF);
      } else if (this.index === 1) {
        this.irqEnable = value & 0x1F;
      }

      return;
    }
    if (a === 0x03) {
      if (this.index === 0) {
        this.writeRequest(value);
      } else {
        this.writeIrqFlags(value);
      }
    }
  }

  private pushParam(v: number): void {
    if (this.paramCount < FIFO_SIZE) {
      this.params[this.paramCount] = v & 0xFF;
      this.paramCount += 1;
    }
  }

  private writeRequest(value: number): void {
    if ((value & REQ_BFRD) === 0) {
      this.dataPending = false;
      this.dataDone = false;
      this.dataIdx = 0;
    } else if (!this.dataPending) {
      this.stageDataFifo();
    }
  }

  private writeIrqFlags(value: number): void {
    const ackBits = value & 0x1F;
    if (ackBits !== 0 && this.pendingInts.length > 0 && (ackBits & (1 << (this.pendingInts[0].num - 1))) !== 0) {
      this.pendingInts.shift();
      this.respLen = 0;
      this.respPos = 0;
      this.respExhausted = false;
      this.respWin.fill(0);
      if (this.pendingInts.length > 0) {
        this.presentHeadInt();
      }
    }
    if ((value & 0x40) !== 0) {
      this.paramCount = 0;
    }
    if (value === 0x07 && this.timing.sectorRetryCycles !== null) {
      this.rescheduleReadOnAck();
    }
  }

  private rescheduleReadOnAck(): void {
    if (!this.reading) {
      return;
    }
    const xaMuted = this.muted && (this.modeByte & 0x40) !== 0;
    if (xaMuted ? !this.resultReady : this.resultReady) {
      return;
    }
    if (this.readHandle !== null) {
      this.sched.cancel(this.readHandle);
    }
    this.readHandle = this.sched.at(xaMuted ? 0 : this.sectorPeriod(), () => {
      this.onReadDue();
    });
  }

  private respBytesReady(): boolean {
    return !this.respExhausted && this.respPos < this.respLen;
  }

  // ---- interrupts ----

  private deliver(num: number, bytes: Array<number>): void {
    if (this.pendingInts.length >= 8) {
      this.log.warn('cdrom', 'response interrupt queue overflow');

      return;
    }
    this.pendingInts.push({ num, bytes });
    this.resultReady = true;
    if (this.pendingInts.length === 1) {
      this.presentHeadInt();
    }
  }

  private presentHeadInt(): void {
    const head = this.pendingInts[0];
    this.respWin.fill(0);
    this.respPos = 0;
    this.respExhausted = false;
    if (head.bytes.length > FIFO_SIZE) {
      this.log.warn('cdrom', 'response fifo overflow, bytes dropped');
    }
    this.respLen = Math.min(head.bytes.length, FIFO_SIZE);
    for (let i = 0; i < this.respLen; i++) {
      this.respWin[i] = head.bytes[i] & 0xFF;
    }
    if ((this.irqEnable & (1 << (head.num - 1))) !== 0) {
      this.irq.raise(IRQ_LINE);
    }
  }

  private respondAck(bytes: Array<number>): void {
    this.deliver(3, bytes);
  }

  private respondOne(byte: number, num: number): void {
    this.deliver(num, [byte]);
  }

  private respondSecond(num: number, cycles: number, makeBytes: () => Array<number>): void {
    this.secondHandle = this.sched.at(cycles, () => {
      this.secondHandle = null;
      this.deliver(num, makeBytes());
    });
  }

  private respondError(code: number): void {
    this.errLatch = true;
    this.deliver(5, [0x11, code]);
  }

  // ---- drive state helpers ----

  private snapToSector(lba: number): void {
    if (lba < 0 || lba >= this.image.totalSectors) {
      return;
    }
    if (this.image.readRawSectors(lba, 1, this.xaRaw)) {
      this.locCache.set(this.xaRaw.subarray(HEADER_OFFSET, HEADER_OFFSET + HEADER_SIZE), 0);
    }
  }

  private cacheLba(): number {
    return (bcdByte(this.locCache[0]) * 60 + bcdByte(this.locCache[1])) * 75 + bcdByte(this.locCache[2]) - 150;
  }

  private driveStat(): number {
    let s = this.spindleOff ? 0 : ST_SPINDLE;
    if (this.reading) {
      s |= ST_READING;
    }
    if (this.seeking) {
      s = ST_SEEKING;
    }
    if (this.errLatch) {
      s |= ST_ERROR;
    }

    return s;
  }

  private sectorPeriod(): number {
    return (this.modeByte & 0x80) !== 0 ? Math.floor(this.timing.sectorCycles / 2) : this.timing.sectorCycles;
  }

  // ---- command handlers ----

  private firstResponseCycles(id: number): number {
    if (id === 0x0A || id === 0x1E) {
      return this.timing.initFirst;
    }
    if (id === 0x09) {
      return this.timing.pauseFirst;
    }

    return this.timing.firstResponse;
  }

  private beginCommand(id: number): void {
    if (this.firstHandle !== null) {
      this.sched.cancel(this.firstHandle);
      this.firstHandle = null;
    }
    for (let i = 0; i < this.paramCount; i++) {
      this.cmdParams[i] = this.params[i];
    }
    const argc = this.paramCount;
    this.paramCount = 0;
    if (this.timing.sectorRetryCycles !== null && STOPS_READING_AT_WRITE.has(id)) {
      this.haltReading();
    }
    if (this.secondHandle !== null) {
      this.sched.cancel(this.secondHandle);
      this.secondHandle = null;
    }
    if (this.seekHandle !== null) {
      this.sched.cancel(this.seekHandle);
      this.seekHandle = null;
      this.seeking = false;
    }
    this.firstHandle = this.sched.at(this.firstResponseCycles(id), () => {
      this.firstHandle = null;
      this.errLatch = false;
      this.runCommand(id, argc);
    });
  }

  private runCommand(id: number, argc: number): void {
    const need = (n: number): boolean => {
      if (argc < n) {
        this.respondError(ERR_WRONG_PARAMS);

        return true;
      }

      return false;
    };

    switch (id) {
      case 0x01:
        this.respondAck([this.driveStat()]);

        return;
      case 0x02:
        if (need(3)) {
          return;
        }
        this.commandSetLoc();
        this.respondAck([this.driveStat()]);

        return;
      case 0x03:
      case 0x04:
      case 0x05:
        this.respondAck([this.driveStat()]);
        this.respondSecond(4, this.timing.secondResponse, (): Array<number> => [this.driveStat()]);

        return;
      case 0x06:
      case 0x1B:
        this.commandRead();
        this.respondAck([this.driveStat()]);

        return;
      case 0x07:
        if (this.spindleOff) {
          this.spindleOff = false;
          this.respondAck([this.driveStat()]);
          this.respondSecond(2, this.timing.motorOnSecond, (): Array<number> => [this.driveStat()]);
        } else {
          this.respondError(ERR_WRONG_PARAMS);
        }

        return;
      case 0x08:
        this.haltReading();
        this.respondAck([this.driveStat() & ~ST_READING]);
        this.respondSecond(2, this.timing.stopSecond, (): Array<number> => {
          this.spindleOff = true;
          this.snapToSector(0);

          return [this.driveStat()];
        });

        return;
      case 0x09:
        this.respondAck([this.driveStat()]);
        this.haltReading();
        this.respondSecond(2, this.timing.pauseSecond, (): Array<number> => [this.driveStat()]);

        return;
      case 0x0A:
        this.commandInit();
        this.respondAck([this.driveStat()]);
        this.respondSecond(2, this.timing.initSecond, (): Array<number> => [this.driveStat()]);

        return;
      case 0x0B:
        this.muted = true;
        this.respondAck([this.driveStat()]);

        return;
      case 0x0C:
        this.muted = false;
        this.respondAck([this.driveStat()]);

        return;
      case 0x0D:
        if (need(2)) {
          return;
        }
        this.filterFile = this.cmdParams[0];
        this.filterChan = this.cmdParams[1];
        this.respondAck([this.driveStat()]);

        return;
      case 0x0E:
        if (need(1)) {
          return;
        }
        this.modeByte = this.cmdParams[0] & 0xFF;
        this.respondAck([this.driveStat()]);

        return;
      case 0x0F:
        this.respondAck([this.driveStat(), this.modeByte, 0, this.filterFile, this.filterChan]);

        return;
      case 0x10:
        this.respondAck(this.buildLocL());

        return;
      case 0x11:
        this.respondAck(this.buildLocP());

        return;
      case 0x12:
        if (need(1)) {
          return;
        }
        this.respondAck([this.driveStat()]);
        this.respondSecond(2, this.timing.setSessionSecond, (): Array<number> => [this.driveStat()]);

        return;
      case 0x13:
        this.respondAck([this.driveStat(), 0x01, 0x01]);

        return;
      case 0x14:
        if (need(1)) {
          return;
        }
        if (bcdByte(this.cmdParams[0]) !== 1) {
          this.respondError(ERR_INVALID_PARAM);

          return;
        }
        this.respondAck([this.driveStat(), 0x00, 0x02]);

        return;
      case 0x15:
      case 0x16:
        this.commandSeek();
        this.respondAck([this.driveStat()]);

        return;
      case 0x19:
        this.runTest(argc);

        return;
      case 0x1A:
        this.respondAck([this.driveStat()]);
        this.respondSecond(2, this.timing.getIdSecond, (): Array<number> => [0x02, 0x00, 0x20, 0x00, 0x53, 0x43, 0x45, 0x41]);

        return;
      case 0x1C:
        this.commandInit();
        this.respondAck([this.driveStat()]);

        return;
      case 0x1D:
        if (need(2)) {
          return;
        }
        this.respondAck([this.driveStat()]);
        this.respondSecond(2, this.timing.secondResponse, (): Array<number> => this.buildSubQ());

        return;
      case 0x1E:
        this.commandInit();
        this.respondAck([this.driveStat()]);
        this.respondSecond(2, this.timing.readTocSecond, (): Array<number> => [this.driveStat()]);

        return;
      default:
        this.respondError(ERR_INVALID_COMMAND);
    }
  }

  private commandSetLoc(): void {
    const min = bcdByte(this.cmdParams[0]);
    const sec = bcdByte(this.cmdParams[1]);
    const frame = bcdByte(this.cmdParams[2]);
    const lba = msfToLba(min, sec, frame);
    if (lba < 0 || lba >= this.image.totalSectors) {
      this.log.warn('cdrom', `setloc to invalid msf ${min}:${sec}:${frame}`);

      return;
    }
    this.seekTarget = lba;
    this.locDirty = true;
  }

  private commandRead(): void {
    if (this.seekHandle !== null) {
      this.sched.cancel(this.seekHandle);
      this.seekHandle = null;
    }
    this.seeking = false;
    this.spindleOff = false;
    const period = this.sectorPeriod();
    if (this.timing.sectorRetryCycles !== null) {
      this.haltReading();
      if (this.locDirty) {
        this.locDirty = false;
        this.nextSectorLba = this.seekTarget;
      } else {
        this.nextSectorLba = Math.max(0, this.nextSectorLba - 1);
      }
      this.reading = true;
      this.readHandle = this.sched.at(this.timing.firstSectorCycles ?? period, () => {
        this.onReadDue();
      });

      return;
    }
    if (this.locDirty) {
      this.locDirty = false;
      this.nextSectorLba = this.seekTarget;
      const firstDelay = this.timing.firstSectorCycles ?? seekCycles(this.cacheLba(), this.seekTarget, period) + period;
      this.sectorTimer = period - firstDelay;
    } else {
      this.nextSectorLba = Math.max(0, this.nextSectorLba - 1);
      this.sectorTimer = 0;
    }
    this.reading = true;
  }

  private commandSeek(): void {
    this.haltReading();
    this.spindleOff = false;
    this.seeking = true;
    const target = this.seekTarget;
    const latency = this.timing.fixedSeekCycles ?? seekCycles(this.cacheLba(), target, this.sectorPeriod());
    this.seekHandle = this.sched.at(latency, () => {
      this.seekHandle = null;
      this.finishSeek(target);
    });
  }

  private finishSeek(target: number): void {
    this.seeking = false;
    this.snapToSector(target);
    this.respondOne(this.driveStat(), 2);
  }

  private commandInit(): void {
    if (this.seekHandle !== null) {
      this.sched.cancel(this.seekHandle);
      this.seekHandle = null;
    }
    this.haltReading();
    this.seeking = false;
    this.spindleOff = false;
    this.dataPending = false;
    this.dataDone = false;
    this.dataIdx = 0;
    this.modeByte = 0x20;
    this.filterFile = 0;
    this.filterChan = 0;
    this.muted = false;
    this.errLatch = false;
    this.locDirty = false;
    this.sectorTimer = 0;
  }

  private runTest(argc: number): void {
    if (argc === 0) {
      this.respondError(ERR_INVALID_PARAM);

      return;
    }
    const sub = this.cmdParams[0] & 0xFF;
    switch (sub) {
      case 0x01:
      case 0x02:
      case 0x03:
      case 0x04:
      case 0x10:
      case 0x11:
      case 0x12:
      case 0x13:
      case 0x14:
      case 0x15:
      case 0x16:
      case 0x17:
      case 0x18:
      case 0x19:
        this.respondAck([this.driveStat()]);

        return;
      case 0x05:
        this.respondAck([0x00, 0x00]);

        return;
      case 0x20:
        this.respondAck([0x94, 0x03, 0x1F, 0xC0]);

        return;
      case 0x21:
        this.respondAck([0x00]);

        return;
      case 0x22:
        this.respondAck([0x66, 0x6F, 0x72, 0x20, 0x55]);

        return;
      case 0x23:
      case 0x24:
      case 0x25:
        this.respondAck([0x43, 0x58, 0x44, sub]);

        return;
      default:
        if (sub >= 0x30 && sub <= 0x4F) {
          this.respondError(ERR_INVALID_PARAM);

          return;
        }
        if (argc > 1) {
          this.respondError(ERR_WRONG_PARAMS);

          return;
        }
        this.respondError(ERR_INVALID_PARAM);
    }
  }

  // ---- subchannel / loc reports ----

  private buildLocL(): Array<number> {
    const c = this.locCache;

    return [c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]];
  }

  private buildLocP(): Array<number> {
    const rel = Math.max(0, this.cacheLba());
    const abs = rel + 150;
    const relM = Math.floor(rel / 4500);
    const relS = Math.floor((rel - relM * 4500) / 75);
    const relF = rel - relM * 4500 - relS * 75;
    const absM = Math.floor(abs / 4500);
    const absS = Math.floor((abs - absM * 4500) / 75);
    const absF = abs - absM * 4500 - absS * 75;

    return [
      0x01,
      0x01,
      toBcd(relM),
      toBcd(relS),
      toBcd(relF),
      toBcd(absM),
      toBcd(absS),
      toBcd(absF),
    ];
  }

  private buildSubQ(): Array<number> {
    const rel = Math.max(0, this.cacheLba());
    const abs = rel + 150;
    const absM = Math.floor(abs / 4500);
    const absS = Math.floor((abs - absM * 4500) / 75);
    const absF = abs - absM * 4500 - absS * 75;

    return [
      0x01,
      0x01,
      0x01,
      toBcd(absM),
      toBcd(absS),
      toBcd(absF),
      toBcd(absM),
      toBcd(absS),
      toBcd(absF),
      0x00,
      0x00,
    ];
  }

  // ---- sector delivery (tick is the drive clock) ----

  tick(cycles: number): void {
    if (!this.reading || this.timing.sectorRetryCycles !== null) {
      return;
    }
    this.sectorTimer += cycles;
    const period = this.sectorPeriod();
    const retry = this.timing.sectorRetryCycles;
    while (this.sectorTimer >= period) {
      if (retry !== null) {
        if (this.pendingInts.length > 0) {
          this.sectorTimer = period - retry;

          return;
        }
        this.sectorTimer = 0;
        this.deliverNextSector();

        return;
      }
      this.sectorTimer -= period;
      this.deliverNextSector();
    }
  }

  private haltReading(): void {
    this.reading = false;
    if (this.readHandle !== null) {
      this.sched.cancel(this.readHandle);
      this.readHandle = null;
    }
  }

  private onReadDue(): void {
    this.readHandle = null;
    const retry = this.timing.sectorRetryCycles;
    if (!this.reading || retry === null) {
      return;
    }
    if (this.pendingInts.length > 0) {
      this.readHandle = this.sched.at(retry, () => {
        this.onReadDue();
      });

      return;
    }
    this.deliverNextSector();
    if (this.reading) {
      this.readHandle = this.sched.at(this.sectorPeriod(), () => {
        this.onReadDue();
      });
    }
  }

  private deliverNextSector(): void {
    const lba = this.nextSectorLba;
    if (lba >= this.image.totalSectors || !this.image.readRawSectors(lba, 1, this.xaRaw)) {
      this.log.warn('cdrom', `read reached end of disc at lba ${lba}`);
      this.haltReading();
      this.sectorTimer = 0;
      this.respondOne(this.driveStat(), 4);

      return;
    }
    this.nextSectorLba = lba + 1;
    this.routeSector();
  }

  deliverSector(raw: Uint8Array): void {
    this.xaRaw.set(raw.subarray(0, RAW_SECTOR_SIZE));
    this.routeSector();
  }

  private routeSector(): void {
    const raw = this.xaRaw;
    this.locCache.set(raw.subarray(HEADER_OFFSET, HEADER_OFFSET + HEADER_SIZE), 0);
    const mode = raw[15];
    const submode = raw[18];
    if (mode === 0) {
      return;
    }
    if (mode === 2 && (submode & SUBMODE_AUDIO) !== 0 && (submode & SUBMODE_REALTIME) !== 0) {
      const filterActive = (this.modeByte & 0x08) !== 0;
      const filterMatch = raw[16] === this.filterFile && raw[17] === this.filterChan;
      const xaEnabled = (this.modeByte & 0x40) !== 0;
      if (xaEnabled && (!filterActive || filterMatch)) {
        if (!this.muted) {
          const subhead = ((raw[16] << 24) | (raw[17] << 16) | (raw[18] << 8) | raw[19]) >>> 0;
          this.spu.xaSink.xaSector(raw[17], subhead, raw.subarray(USER_DATA_OFFSET, USER_DATA_OFFSET + XA_PAYLOAD_SIZE));
        }
        if (!this.timing.xaSectorsRaiseData) {
          return;
        }
      } else if (filterActive && !this.timing.xaSectorsRaiseData) {
        return;
      }
    }
    this.stageDataFifo();
    this.respondOne(this.driveStat(), 1);
  }

  private stageDataFifo(): void {
    if (this.xaRaw[15] === 0) {
      return;
    }
    if ((this.modeByte & 0x20) !== 0) {
      this.dataBuf.set(this.xaRaw.subarray(HEADER_OFFSET, RAW_SECTOR_SIZE), 0);
      this.dataLen = RAW_MINUS_SYNC_SIZE;
    } else if (this.xaRaw[15] === 1) {
      this.dataBuf.set(this.xaRaw.subarray(HEADER_SIZE, HEADER_SIZE + USER_DATA_SIZE), 0);
      this.dataLen = USER_DATA_SIZE;
    } else {
      this.dataBuf.set(this.xaRaw.subarray(USER_DATA_OFFSET, USER_DATA_OFFSET + USER_DATA_SIZE), 0);
      this.dataLen = USER_DATA_SIZE;
    }
    this.dataPending = true;
    this.dataDone = false;
    this.dataIdx = 0;
  }

  // ---- data fifo readout ----

  private popDataByte(): number {
    if (!this.dataPending) {
      return 0;
    }
    if (this.dataDone) {
      const pad = this.dataLen === RAW_MINUS_SYNC_SIZE ? this.dataLen - 4 : this.dataLen - 8;

      return this.dataBuf[pad];
    }
    const v = this.dataBuf[this.dataIdx];
    this.dataIdx += 1;
    if (this.dataIdx >= this.dataLen) {
      this.dataDone = true;
      this.dataIdx = 0;
    }

    return v;
  }

  // ---- DMA (channel 3, toRam) ----

  dmaStart(channel: DmaChannel, config: DmaConfig, ram: Uint32Array): void {
    if (channel.id !== 3) {
      return;
    }
    if (config.direction === 'toRam' && this.dataPending && config.wordsPerBlock > 0) {
      const bytes = Math.min(config.wordsPerBlock * 4, this.dataLen - this.dataIdx);
      this.spreadWrite(ram, config.base, this.dataBuf, this.dataIdx, bytes);
      this.dataIdx += bytes;
      if (this.dataIdx >= this.dataLen) {
        this.dataPending = false;
        this.dataDone = false;
        this.dataIdx = 0;
      }
    }
    this.irq.dmaDone(3);
  }

  // ---- RAM byte-precise write helper (no allocation) ----

  private spreadWrite(ram: Uint32Array, dstAddr: number, src: Uint8Array, srcOff: number, len: number): void {
    let a = dstAddr & 0x001F_FFFF;
    let s = srcOff;
    let n = Math.min(len, RAM_SIZE - a);
    while (n > 0 && (a & 3) !== 0) {
      const w = a >> 2;
      const sh = (a & 3) * 8;
      const clear = ~(0xFF << sh) & 0xFFFFFFFF;
      ram[w] = ((ram[w] & clear) | (src[s] << sh)) >>> 0;
      a += 1;
      s += 1;
      n -= 1;
    }
    while (n >= 4) {
      ram[a >> 2] = (src[s] | (src[s + 1] << 8) | (src[s + 2] << 16) | (src[s + 3] << 24)) >>> 0;
      a += 4;
      s += 4;
      n -= 4;
    }
    while (n > 0) {
      const w = a >> 2;
      const sh = (a & 3) * 8;
      const clear = ~(0xFF << sh) & 0xFFFFFFFF;
      ram[w] = ((ram[w] & clear) | (src[s] << sh)) >>> 0;
      a += 1;
      s += 1;
      n -= 1;
    }
  }
}