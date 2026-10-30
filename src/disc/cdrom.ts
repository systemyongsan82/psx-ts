import { CD_SECTOR_CYCLES, RAM_SIZE } from '../core/contracts';
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
const USER_DATA_SIZE = 2048;
const XA_PAYLOAD_SIZE = RAW_SECTOR_SIZE - USER_DATA_OFFSET;
const FIFO_SIZE = 16;
const HLE_CHUNK_SECTORS = 40;

const COMMAND_RESPONSE_CYCLES = 20_000;
const COMMAND_SECOND_CYCLES = 80_000;
const SEEK_CYCLES = 13_547_520;

const INT1_DATA = 0x01;
const INT2_COMPLETE = 0x02;
const INT3_ACK = 0x04;
const INT4_READY = 0x08;
const INT5_ERROR = 0x10;
const IRQ_LINE = 2;

const ST_ERROR = 0x01;
const ST_MOTOR = 0x02;
const ST_READING = 0x20;
const ST_SEEKING = 0x40;

const SUBMODE_AUDIO = 0x04;

function bcdByte(v: number): number {
  return (v >> 4) * 10 + (v & 0x0F);
}

function toBcd(v: number): number {
  return (((v / 10) | 0) << 4) | (v % 10);
}

function cacheLba(cache: Uint8Array): number {
  return (bcdByte(cache[0]) * 60 + bcdByte(cache[1])) * 75 + bcdByte(cache[2]) - 150;
}

export class Cdrom implements CdromUnit {
  private readonly sched: Scheduler;
  private readonly log: Logger;
  private readonly image: PsxBinImage;
  private readonly iso: Iso9660;
  private readonly spu: Spu;
  private readonly irq: IrqController;

  private readonly params = new Uint8Array(FIFO_SIZE);
  private paramCount = 0;
  private readonly resp = new Uint8Array(FIFO_SIZE);
  private respPos = 0;
  private respLen = 0;
  private readonly cmdParams = new Uint8Array(FIFO_SIZE);

  private intFlags = 0;
  private readonly locCache = new Uint8Array(HEADER_SIZE);
  private readonly xaRaw = new Uint8Array(RAW_SECTOR_SIZE);
  private readonly dataBuf = new Uint8Array(USER_DATA_SIZE);
  private readonly hleChunk = new Uint8Array(HLE_CHUNK_SECTORS * RAW_SECTOR_SIZE);

  private errLatch = false;
  private reading = false;
  private seeking = false;
  private seekTarget = 0;
  private nextSectorLba = 0;
  private sectorTimer = 0;
  private dataPending = false;
  private dataIdx = 0;

  private modeByte = 0;
  private filterFile = 0;
  private filterChan = 0;
  private filterOn = false;
  private muted = false;

  private firstHandle: object | null = null;
  private secondHandle: object | null = null;
  private seekHandle: object | null = null;

  constructor(
    sched: Scheduler,
    log: Logger,
    image: PsxBinImage,
    iso: Iso9660,
    spu: Spu,
    irq: IrqController,
  ) {
    this.sched = sched;
    this.log = log;
    this.image = image;
    this.iso = iso;
    this.spu = spu;
    this.irq = irq;
    if (image.readRawSectors(0, 1, this.xaRaw)) {
      this.locCache.set(this.xaRaw.subarray(HEADER_OFFSET, HEADER_OFFSET + HEADER_SIZE), 0);
    }
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
        break;
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
    let skip = byteOffset % USER_DATA_SIZE;
    if (skip < 0) {
      skip += USER_DATA_SIZE;
      sector -= 1;
    }
    let done = 0;
    while (done < length) {
      const remaining = length - done;
      const count = Math.min(HLE_CHUNK_SECTORS, Math.ceil(remaining / USER_DATA_SIZE));
      if (!this.image.readRawSectors(sector, count, this.hleChunk)) {
        this.log.warn('cdrom', `hle bulk read out of range at lba ${sector}`);
        break;
      }
      const take = Math.min(count * USER_DATA_SIZE - skip, remaining);
      this.spreadWrite(ram, dstAddr + done, this.hleChunk, USER_DATA_OFFSET + skip, take);
      done += take;
      skip = 0;
      sector += count;
    }
  }

  // ---- device registers (1F801800..1F8018FF, decoded on addr & 0x1F) ----

  load32(addr: number): number {
    return (
      (this.load8(addr) | (this.load8(addr + 1) << 8) | (this.load8(addr + 2) << 16) | (this.load8(addr + 3) << 24)) >>> 0
    );
  }

  load16(addr: number): number {
    return (this.load8(addr) | (this.load8(addr + 1) << 8)) & 0xFFFF;
  }

  load8(addr: number): number {
    const r = addr & 0x1F;
    if (r === 0x00) {
      let f = 0;
      if (this.paramCount === 0) {
        f |= 0x01;
      }
      if (this.firstHandle !== null) {
        f |= 0x02;
      }
      if (this.respLen > 0) {
        f |= 0x04;
      }
      if (this.dataPending) {
        f |= 0x08;
      }

      return f;
    }
    if (r === 0x01) {
      if (this.respLen > 0) {
        const v = this.resp[this.respPos];
        this.respPos = (this.respPos + 1) % FIFO_SIZE;
        this.respLen -= 1;

        return v;
      }
      if (this.dataPending && this.dataIdx < USER_DATA_SIZE) {
        const v = this.dataBuf[this.dataIdx];
        this.dataIdx += 1;
        if (this.dataIdx >= USER_DATA_SIZE) {
          this.dataPending = false;
          this.dataIdx = 0;
        }

        return v;
      }

      return 0xFF;
    }
    if (r === 0x02) {
      return this.intFlags & 0x1F;
    }

    return 0;
  }

  store32(addr: number, value: number): void {
    for (let i = 0; i < 4; i++) {
      this.store8(addr + i, (value >>> (i * 8)) & 0xFF);
    }
  }

  store16(addr: number, value: number): void {
    this.store8(addr, value & 0xFF);
    this.store8(addr + 1, (value >>> 8) & 0xFF);
  }

  store8(addr: number, value: number): void {
    const r = addr & 0x1F;
    if (r === 0x00) {
      this.beginCommand(value & 0xFF);

      return;
    }
    if (r === 0x01) {
      if (this.paramCount < FIFO_SIZE) {
        this.params[this.paramCount] = value & 0xFF;
        this.paramCount += 1;
      }

      return;
    }
    if (r === 0x03) {
      this.acknowledge(value);

      return;
    }
  }

  private acknowledge(value: number): void {
    this.intFlags &= ~(value & 0x1F) & 0x1F;
    if ((value & 0xC0) !== 0) {
      this.paramCount = 0;
    }
  }

  private setInt(mask: number): void {
    const before = this.intFlags;
    this.intFlags |= mask & 0x1F;
    if (before !== this.intFlags) {
      this.irq.raise(IRQ_LINE);
    }
  }

  // ---- command state machine ----

  private beginCommand(id: number): void {
    if (this.firstHandle !== null) {
      this.log.warn('cdrom', `command 0x${id.toString(16)} while response pending, dropped`);

      return;
    }
    for (let i = 0; i < this.paramCount; i++) {
      this.cmdParams[i] = this.params[i];
    }
    const argc = this.paramCount;
    this.paramCount = 0;
    this.cancelSideEffectHandles();
    this.firstHandle = this.sched.at(COMMAND_RESPONSE_CYCLES, () => {
      this.firstHandle = null;
      this.errLatch = false;
      this.runCommand(id, argc);
    });
  }

  private cancelSideEffectHandles(): void {
    if (this.secondHandle !== null) {
      this.sched.cancel(this.secondHandle);
      this.secondHandle = null;
    }
    if (this.seekHandle !== null) {
      this.sched.cancel(this.seekHandle);
      this.seekHandle = null;
      this.seeking = false;
    }
  }

  private pushResponse(bytes: Array<number>): void {
    for (let i = 0; i < bytes.length; i++) {
      if (this.respLen >= FIFO_SIZE) {
        this.log.warn('cdrom', 'response fifo overflow, bytes dropped');

        return;
      }
      this.resp[(this.respPos + this.respLen) % FIFO_SIZE] = bytes[i] & 0xFF;
      this.respLen += 1;
    }
  }

  private respondAck(bytes: Array<number>): void {
    this.pushResponse(bytes);
    this.setInt(INT3_ACK);
  }

  private respondError(): void {
    this.errLatch = true;
    this.pushResponse([this.driveStat() | ST_ERROR]);
    this.setInt(INT5_ERROR);
  }

  private respondLater(mask: number, cycles: number, bytes: Array<number>): void {
    this.secondHandle = this.sched.at(cycles, () => {
      this.secondHandle = null;
      this.pushResponse(bytes);
      this.setInt(mask);
    });
  }

  private driveStat(): number {
    let s = ST_MOTOR;
    if (this.reading) {
      s |= ST_READING;
    }
    if (this.seeking) {
      s |= ST_SEEKING;
    }
    if (this.errLatch) {
      s |= ST_ERROR;
    }

    return s;
  }

  private msfToLba(min: number, sec: number, frame: number): number {
    return min * 60 * 75 + sec * 75 + frame - 150;
  }

  private runCommand(id: number, argc: number): void {
    const p0 = argc > 0 ? this.cmdParams[0] : 0;
    const p1 = argc > 1 ? this.cmdParams[1] : 0;
    const p2 = argc > 2 ? this.cmdParams[2] : 0;

    switch (id) {
      case 0x01:
        this.respondAck([this.driveStat()]);

        return;
      case 0x0E:
        this.commandSetLoc(p0, p1, p2);
        this.respondAck([this.driveStat()]);

        return;
      case 0x06:
        this.commandRead();
        this.respondAck([this.driveStat()]);

        return;
      case 0x08:
        this.haltRead();
        this.respondAck([this.driveStat()]);
        this.respondLater(INT2_COMPLETE, COMMAND_SECOND_CYCLES, [this.driveStat()]);

        return;
      case 0x09:
        this.haltRead();
        this.respondAck([this.driveStat()]);
        this.respondLater(INT2_COMPLETE, COMMAND_SECOND_CYCLES, [this.driveStat()]);

        return;
      case 0x0A:
        this.commandInit();
        this.respondAck([this.driveStat()]);
        this.respondLater(INT2_COMPLETE, COMMAND_SECOND_CYCLES, [this.driveStat()]);

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
        this.filterFile = p0;
        this.filterChan = p1;
        this.filterOn = p0 !== 0 || p1 !== 0;
        this.respondAck([this.driveStat()]);

        return;
      case 0x0F:
        this.respondAck([this.driveStat(), this.modeByte, this.filterFile, this.filterChan]);

        return;
      case 0x10:
        this.respondAck(this.buildLocL());

        return;
      case 0x11:
        this.respondAck(this.buildLocP());

        return;
      case 0x12:
      case 0x16:
        this.respondAck([this.driveStat()]);
        this.respondLater(INT2_COMPLETE, COMMAND_SECOND_CYCLES, [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);

        return;
      case 0x14:
      case 0x19:
        this.runTest(p0);

        return;
      case 0x15:
      case 0x1A:
        this.respondAck([this.driveStat()]);
        this.respondLater(INT2_COMPLETE, COMMAND_SECOND_CYCLES, [0xFF, 0x53, 0x43, 0x45, 0x41]);

        return;
      case 0x17:
        this.commandSeek();
        this.respondAck([this.driveStat()]);

        return;
      default:
        this.respondError();
    }
  }

  private runTest(sub: number): void {
    if (sub === 0x20) {
      this.respondAck([0x94, 0x03, 0x1F]);

      return;
    }
    this.respondError();
  }

  private commandSetLoc(p0: number, p1: number, p2: number): void {
    const min = bcdByte(p0);
    const sec = bcdByte(p1);
    const frame = bcdByte(p2);
    const lba = this.msfToLba(min, sec, frame);
    if (lba < 0 || lba >= this.image.totalSectors) {
      this.log.warn('cdrom', `setloc to invalid msf ${min}:${sec}:${frame}`);

      return;
    }
    this.seekTarget = lba;
  }

  private commandRead(): void {
    if (this.seekHandle !== null) {
      this.sched.cancel(this.seekHandle);
      this.seekHandle = null;
    }
    this.seeking = false;
    this.reading = true;
    this.nextSectorLba = this.seekTarget;
    const catchUp = this.seekTarget === cacheLba(this.locCache) ? CD_SECTOR_CYCLES : SEEK_CYCLES;
    this.sectorTimer = CD_SECTOR_CYCLES - catchUp;
  }

  private haltRead(): void {
    if (this.seekHandle !== null) {
      this.sched.cancel(this.seekHandle);
      this.seekHandle = null;
    }
    this.reading = false;
    this.seeking = false;
    this.sectorTimer = 0;
  }

  private commandSeek(): void {
    this.haltRead();
    const target = this.seekTarget;
    this.seeking = true;
    const latency = target === cacheLba(this.locCache) ? COMMAND_SECOND_CYCLES : SEEK_CYCLES;
    this.seekHandle = this.sched.at(latency, () => {
      this.seekHandle = null;
      this.finishSeek(target);
    });
  }

  private finishSeek(target: number): void {
    this.seeking = false;
    if (this.image.readRawSectors(target, 1, this.xaRaw)) {
      this.locCache.set(this.xaRaw.subarray(HEADER_OFFSET, HEADER_OFFSET + HEADER_SIZE), 0);
    } else {
      this.log.warn('cdrom', `seek to invalid target lba ${target}`);
    }
    this.pushResponse([this.driveStat()]);
    this.setInt(INT4_READY);
  }

  private commandInit(): void {
    this.haltRead();
    this.dataPending = false;
    this.dataIdx = 0;
    this.modeByte = 0;
    this.filterOn = false;
    this.filterFile = 0;
    this.filterChan = 0;
    this.muted = false;
    this.errLatch = false;
  }

  // ---- sector delivery (tick is the drive clock) ----

  tick(cycles: number): void {
    if (!this.reading) {
      return;
    }
    this.sectorTimer += cycles;
    while (this.sectorTimer >= CD_SECTOR_CYCLES) {
      this.sectorTimer -= CD_SECTOR_CYCLES;
      this.deliverNextSector();
    }
  }

  private deliverNextSector(): void {
    const lba = this.nextSectorLba;
    if (lba >= this.image.totalSectors || !this.image.readRawSectors(lba, 1, this.xaRaw)) {
      this.log.warn('cdrom', `read reached end of disc at lba ${lba}`);
      this.haltRead();
      this.pushResponse([this.driveStat()]);
      this.setInt(INT4_READY);

      return;
    }
    this.nextSectorLba = lba + 1;
    this.routeSector();
  }

  // Test seam: behaves exactly like one sector delivered by the drive.
  deliverSector(raw: Uint8Array): void {
    this.xaRaw.set(raw.subarray(0, RAW_SECTOR_SIZE));
    this.routeSector();
  }

  private routeSector(): void {
    const raw = this.xaRaw;
    this.locCache.set(raw.subarray(HEADER_OFFSET, HEADER_OFFSET + HEADER_SIZE), 0);
    if (raw[15] !== 2) {
      return;
    }
    const submode = raw[18];
    if ((submode & SUBMODE_AUDIO) !== 0) {
      if (this.muted) {
        return;
      }
      if (this.filterOn && !(raw[16] === this.filterFile && raw[17] === this.filterChan)) {
        return;
      }
      const subhead = ((raw[16] << 24) | (raw[17] << 16) | (raw[18] << 8) | raw[19]) >>> 0;
      this.spu.xaSink.xaSector(raw[17], subhead, raw.subarray(USER_DATA_OFFSET, USER_DATA_OFFSET + XA_PAYLOAD_SIZE));

      return;
    }
    this.dataBuf.set(raw.subarray(USER_DATA_OFFSET, USER_DATA_OFFSET + USER_DATA_SIZE), 0);
    this.dataPending = true;
    this.dataIdx = 0;
    this.pushResponse([this.driveStat()]);
    this.setInt(INT1_DATA);
  }

  // ---- GetlocL / GetlocP responses ----

  private buildLocL(): Array<number> {
    return [
      this.locCache[0], this.locCache[1], this.locCache[2], this.locCache[3],
      this.locCache[4], this.locCache[5], this.locCache[6], this.locCache[7],
      this.locCache[8], this.locCache[9], this.locCache[10], this.locCache[11],
    ];
  }

  private buildLocP(): Array<number> {
    const clamped = Math.max(0, cacheLba(this.locCache));
    const abs = clamped + 150;
    return [
      0x01,
      0x01,
      toBcd(Math.floor(clamped / 4500)),
      toBcd(Math.floor((clamped - Math.floor(clamped / 4500) * 4500) / 75)),
      toBcd(clamped - Math.floor(clamped / 4500) * 4500 - Math.floor((clamped - Math.floor(clamped / 4500) * 4500) / 75) * 75),
      toBcd(Math.floor(abs / 4500)),
      toBcd(Math.floor((abs - Math.floor(abs / 4500) * 4500) / 75)),
      toBcd(abs - Math.floor(abs / 4500) * 4500 - Math.floor((abs - Math.floor(abs / 4500) * 4500) / 75) * 75),
      0,
      0,
      0,
      0,
    ];
  }

  // ---- DMA (channel 3, toRam) ----

  dmaStart(channel: DmaChannel, config: DmaConfig, ram: Uint32Array): void {
    if (channel.id !== 3) {
      return;
    }
    if (config.direction === 'toRam' && this.dataPending && config.wordsPerBlock > 0) {
      const bytes = Math.min(config.wordsPerBlock * 4, USER_DATA_SIZE);
      this.spreadWrite(ram, config.base, this.dataBuf, 0, bytes);
      this.dataPending = false;
      this.dataIdx = 0;
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