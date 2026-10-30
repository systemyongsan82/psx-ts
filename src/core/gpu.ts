import { VRAM_H, VRAM_W } from './contracts';
import type { DmaChannel, DmaConfig, DisplayFrame, Gpu, IrqController, Logger, Scheduler } from './contracts';

const VRAM_HALFWORDS = VRAM_W * VRAM_H;
const RAM_WORD_MASK = 0x0007_ffff;
const LINK_END = 0x00ff_ffff;
const LINK_STEP_LIMIT = 1 << 16;

const MODE_COMMAND = 0;
const MODE_LINE_STRIP = 1;
const MODE_VRAM_WRITE = 2;

const TEX_OFF = 0;
const TEX_BLEND = 1;
const TEX_RAW = 2;

const DEPTH_4BPP = 0;
const DEPTH_8BPP = 1;
const DEPTH_15BPP = 2;

const FIX = 1 << 17;
const FIX_HALF = FIX >> 1;

const GPUSTAT_READY = 0x0400_0000;
const GPUSTAT_READ_AVAILABLE = 0x0800_0000;
const GPUSTAT_FIFO_EMPTY = 0x1000_0000;
const GPUSTAT_INTERLACE_FIELD = 0x0000_2000;

const DITHER_OFFSETS = new Int32Array([-4, 0, -3, 1, 2, -2, 3, -1, -3, 1, -4, 0, 3, -1, 2, -2]);

function sext11(value: number): number {
  return (value << 21) >> 21;
}

function clamp255(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 255) {
    return 255;
  }

  return value;
}

function clamp31(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 31) {
    return 31;
  }

  return value;
}

function ceilFix(value: number): number {
  return -((-value) >> 17);
}

export class GpuCore implements Gpu {
  readonly vram = new Uint16Array(VRAM_HALFWORDS);

  private readonly sched: Scheduler;
  private readonly log: Logger;
  private readonly irq: IrqController;

  private mode = MODE_COMMAND;
  private cmd = 0;
  private need = 0;
  private got = 0;
  private readonly params = new Int32Array(16);

  private drawOffX = 0;
  private drawOffY = 0;
  private areaX1 = 0;
  private areaY1 = 0;
  private areaX2 = 1023;
  private areaY2 = 511;

  private texPageX = 0;
  private texPageY = 0;
  private texPageYHigh = 0;
  private clutX = 0;
  private clutY = 0;
  private colorDepth = DEPTH_4BPP;
  private stMode = 0;
  private dither = 0;
  private interlaceDraw = 0;
  private rectFlipX = 0;
  private rectFlipY = 0;
  private forceMask = 0;
  private checkMask = 0;

  private twMaskX = 0;
  private twMaskY = 0;
  private twOffsetX = 0;
  private twOffsetY = 0;
  private twKeepX = 0xff;
  private twKeepY = 0xff;
  private twSetX = 0;
  private twSetY = 0;

  private texMode = TEX_OFF;
  private drawDepth = DEPTH_4BPP;
  private semiCmd = false;

  private dmaDirection = 0;
  private irqPending = false;
  private interlaceField = 0;
  private infoLatch = 0;

  private displayEnabled = false;
  private displayX = 0;
  private displayY = 0;
  private horizX1 = 0x200;
  private horizX2 = 0xc00;
  private vertY1 = 0x10;
  private vertY2 = 0x100;
  private horizMode = 0;
  private horiz368 = 0;
  private vert480 = 0;
  private palMode = 0;
  private depth24 = 0;
  private interlace = 0;
  private reverseFlag = 0;

  private writeLeft = 0;
  private writeX = 0;
  private writeY = 0;
  private writeBaseX = 0;
  private writeWidth = 0;

  private readActive = false;
  private readHalfLeft = 0;
  private readX = 0;
  private readY = 0;
  private readBaseX = 0;
  private readWidth = 0;

  private stripStarted = false;
  private stripShaded = false;
  private stripSemi = false;
  private stripColorPending = false;
  private stripX = 0;
  private stripY = 0;
  private stripR = 0;
  private stripG = 0;
  private stripB = 0;

  private readonly vx = new Int32Array(4);
  private readonly vy = new Int32Array(4);
  private readonly vr = new Int32Array(4);
  private readonly vg = new Int32Array(4);
  private readonly vb = new Int32Array(4);
  private readonly vu = new Int32Array(4);
  private readonly vv = new Int32Array(4);

  private readonly edgeY0 = new Int32Array(3);
  private readonly edgeX0 = new Float64Array(3);
  private readonly edgeXStep = new Float64Array(3);
  private readonly edgeP0 = new Float64Array(15);
  private readonly edgePStep = new Float64Array(15);
  private readonly rowA = new Float64Array(6);
  private readonly rowB = new Float64Array(6);

  private readonly outRgba = new Uint8Array(VRAM_HALFWORDS * 4);

  constructor(sched: Scheduler, log: Logger, irq: IrqController) {
    this.sched = sched;
    this.log = log;
    this.irq = irq;
  }

  load32(addr: number): number {
    if (((addr >>> 2) & 1) === 0) {
      return this.gpuread();
    }

    return this.gpuStat();
  }

  load16(addr: number): number {
    if (((addr >>> 2) & 1) === 0) {
      const value = this.gpuread();

      return ((addr & 2) === 0 ? value : (value >>> 16)) & 0xffff;
    }

    return this.gpuStat() & 0xffff;
  }

  load8(addr: number): number {
    return (this.load32(addr) >>> ((addr & 3) * 8)) & 0xff;
  }

  store32(addr: number, value: number): void {
    if (((addr >>> 2) & 1) === 0) {
      this.gp0(value >>> 0);

      return;
    }
    this.gp1(value >>> 0);
  }

  store16(addr: number, value: number): void {
    this.store32(addr, value & 0xffff);
  }

  store8(addr: number, value: number): void {
    this.store32(addr, value & 0xff);
  }

  frameBoundary(): void {
    this.interlaceField ^= 1;
  }

  dmaStart(channel: DmaChannel, config: DmaConfig, ram: Uint32Array): void {
    if (channel.id !== 2) {
      return;
    }
    if (config.direction === 'toRam') {
      this.dmaFromGpu(config, ram);
      this.irq.dmaDone(2);

      return;
    }
    if (config.mode === 'linked') {
      this.dmaLinked(config, ram);
    } else {
      this.dmaToGpu(config, ram);
    }
    this.irq.dmaDone(2);
  }

  private dmaLinked(config: DmaConfig, ram: Uint32Array): void {
    const words = ram;
    let addr = (config.base >>> 2) & RAM_WORD_MASK;
    for (let step = 0; step < LINK_STEP_LIMIT; step++) {
      const link = words[addr];
      const count = link >>> 24;
      const next = link & LINK_END;
      for (let k = 1; k <= count; k++) {
        this.gp0(words[(addr + k) & RAM_WORD_MASK]);
      }
      if (next === LINK_END) {
        return;
      }
      addr = (next >>> 2) & RAM_WORD_MASK;
    }
    this.log.warn('gpu', 'dma2 linked list exceeded step limit');
  }

  private dmaToGpu(config: DmaConfig, ram: Uint32Array): void {
    const words = config.wordsPerBlock * config.blockCount;
    const delta = config.step === 4 ? 1 : -1;
    let addr = (config.base >>> 2) & RAM_WORD_MASK;
    for (let i = 0; i < words; i++) {
      this.gp0(ram[addr]);
      addr = (addr + delta) & RAM_WORD_MASK;
    }
  }

  private dmaFromGpu(config: DmaConfig, ram: Uint32Array): void {
    const words = config.mode === 'linked' ? 0 : config.wordsPerBlock * config.blockCount;
    let addr = (config.base >>> 2) & RAM_WORD_MASK;
    for (let i = 0; i < words; i++) {
      ram[addr] = this.nextReadWord() >>> 0;
      addr = (addr + 1) & RAM_WORD_MASK;
    }
  }

  private gpuStat(): number {
    let stat = 0;
    stat |= (this.texPageX >> 6) & 0xf;
    stat |= ((this.texPageY >> 8) & 1) << 4;
    stat |= (this.stMode & 3) << 5;
    stat |= (this.colorDepth & 3) << 7;
    stat |= (this.dither & 1) << 9;
    stat |= (this.interlaceDraw & 1) << 10;
    stat |= (this.forceMask & 1) << 11;
    stat |= (this.checkMask & 1) << 12;
    if (this.interlace === 0 || this.interlaceField === 1) {
      stat |= GPUSTAT_INTERLACE_FIELD;
    }
    stat |= (this.reverseFlag & 1) << 14;
    stat |= (this.texPageYHigh & 1) << 15;
    stat |= (this.horiz368 & 1) << 16;
    stat |= (this.horizMode & 3) << 17;
    stat |= (this.vert480 & 1) << 19;
    stat |= (this.palMode & 1) << 20;
    stat |= (this.depth24 & 1) << 21;
    stat |= (this.interlace & 1) << 22;
    if (!this.displayEnabled) {
      stat |= 0x0080_0000;
    }
    if (this.irqPending) {
      stat |= 0x0100_0000;
    }
    if (this.dmaDirection === 1) {
      stat |= 0x0200_0000;
    } else if (this.dmaDirection === 2) {
      stat |= 0x0200_0000 | GPUSTAT_FIFO_EMPTY;
    } else if (this.dmaDirection === 3 && this.readActive) {
      stat |= 0x0200_0000 | GPUSTAT_READ_AVAILABLE;
    }
    stat |= GPUSTAT_READY;
    if (this.readActive) {
      stat |= GPUSTAT_READ_AVAILABLE;
    }
    if (this.need === 0) {
      stat |= GPUSTAT_FIFO_EMPTY;
    }
    stat |= (this.dmaDirection & 3) << 29;

    return stat >>> 0;
  }

  private gpuread(): number {
    if (!this.readActive) {
      return this.infoLatch;
    }

    return this.nextReadWord() >>> 0;
  }

  private nextReadWord(): number {
    if (!this.readActive) {
      return 0;
    }
    const low = this.vram[((this.readY & 0x1ff) << 10) | (this.readX & 0x3ff)];
    this.readStep();
    const high = this.readHalfLeft > 0
      ? this.vram[((this.readY & 0x1ff) << 10) | (this.readX & 0x3ff)]
      : 0;
    if (this.readHalfLeft > 0) {
      this.readStep();
    }
    if (this.readHalfLeft === 0) {
      this.readActive = false;
    }

    return ((low & 0xffff) | ((high & 0xffff) << 16)) >>> 0;
  }

  private readStep(): void {
    this.readX++;
    if (this.readX >= this.readBaseX + this.readWidth) {
      this.readX = this.readBaseX;
      this.readY++;
    }
    this.readHalfLeft--;
  }

  private gp1(value: number): void {
    const cmd = (value >>> 24) & 0xff;
    if (cmd === 0x00) {
      this.resetGpu();

      return;
    }
    if (cmd === 0x01) {
      this.mode = MODE_COMMAND;
      this.need = 0;
      this.got = 0;
      this.stripStarted = false;
      this.readActive = false;
      this.readHalfLeft = 0;

      return;
    }
    if (cmd === 0x02) {
      this.irqPending = false;

      return;
    }
    if (cmd === 0x03) {
      this.displayEnabled = (value & 1) === 0;

      return;
    }
    if (cmd === 0x04) {
      this.dmaDirection = value & 3;

      return;
    }
    if (cmd === 0x05) {
      this.displayX = value & 0x3ff;
      this.displayY = (value >>> 10) & 0x1ff;

      return;
    }
    if (cmd === 0x06) {
      this.horizX1 = value & 0xfff;
      this.horizX2 = (value >>> 12) & 0xfff;

      return;
    }
    if (cmd === 0x07) {
      this.vertY1 = value & 0x3ff;
      this.vertY2 = (value >>> 10) & 0x3ff;

      return;
    }
    if (cmd === 0x08) {
      this.horizMode = value & 3;
      this.vert480 = (value >>> 2) & 1;
      this.palMode = (value >>> 3) & 1;
      this.depth24 = (value >>> 4) & 1;
      this.interlace = (value >>> 5) & 1;
      this.horiz368 = (value >>> 6) & 1;
      this.reverseFlag = (value >>> 7) & 1;
      this.interlaceField = 0;

      return;
    }
    if (cmd === 0x09) {
      return;
    }
    if ((cmd & 0xf0) === 0x10) {
      this.readInfo(value & 0x0f);

      return;
    }
  }

  private readInfo(index: number): void {
    if (index === 2) {
      this.readActive = false;
      this.readHalfLeft = 0;
      this.infoLatch = (((this.twOffsetY & 0x1f) << 15) | ((this.twOffsetX & 0x1f) << 10)
        | ((this.twMaskY & 0x1f) << 5) | (this.twMaskX & 0x1f)) & 0xffff_ffff;

      return;
    }
    if (index === 3) {
      this.readActive = false;
      this.readHalfLeft = 0;
      this.infoLatch = (((this.areaY1 & 0x3ff) << 10) | (this.areaX1 & 0x3ff)) & 0xffff_ffff;

      return;
    }
    if (index === 4) {
      this.readActive = false;
      this.readHalfLeft = 0;
      this.infoLatch = (((this.areaY2 & 0x3ff) << 10) | (this.areaX2 & 0x3ff)) & 0xffff_ffff;

      return;
    }
    if (index === 5) {
      this.readActive = false;
      this.readHalfLeft = 0;
      this.infoLatch = (((this.drawOffY & 0x7ff) << 11) | (this.drawOffX & 0x7ff)) & 0x3f_ffff;

      return;
    }
    if (index === 7 || index === 8) {
      this.readActive = false;
      this.readHalfLeft = 0;
      this.infoLatch = index === 7 ? 2 : 0;

      return;
    }
    this.infoLatch = 0;
  }

  private resetGpu(): void {
    this.mode = MODE_COMMAND;
    this.need = 0;
    this.got = 0;
    this.stripStarted = false;
    this.readActive = false;
    this.readHalfLeft = 0;
    this.irqPending = false;
    this.infoLatch = 0;
    this.dmaDirection = 0;
    this.displayEnabled = false;
    this.displayX = 0;
    this.displayY = 0;
    this.horizX1 = 0x200;
    this.horizX2 = 0xc00;
    this.vertY1 = 0x10;
    this.vertY2 = 0x100;
    this.horizMode = 0;
    this.horiz368 = 0;
    this.vert480 = 0;
    this.palMode = 0;
    this.depth24 = 0;
    this.interlace = 0;
    this.reverseFlag = 0;
    this.interlaceField = 0;
    this.areaX1 = 0;
    this.areaY1 = 0;
    this.areaX2 = 0;
    this.areaY2 = 0;
    this.drawOffX = 0;
    this.drawOffY = 0;
    this.texPageX = 0;
    this.texPageY = 0;
    this.texPageYHigh = 0;
    this.clutX = 0;
    this.clutY = 0;
    this.colorDepth = DEPTH_4BPP;
    this.stMode = 0;
    this.dither = 0;
    this.interlaceDraw = 0;
    this.rectFlipX = 0;
    this.rectFlipY = 0;
    this.forceMask = 0;
    this.checkMask = 0;
    this.setTextureWindow(0);
  }

  private gp0(word: number): void {
    if (this.mode === MODE_VRAM_WRITE) {
      this.writeVramWord(word);

      return;
    }
    if (this.mode === MODE_LINE_STRIP) {
      this.lineStripWord(word);

      return;
    }
    if (this.need > 0) {
      this.params[this.got + 1] = word >>> 0;
      this.got++;
      if (this.got >= this.need) {
        this.need = 0;
        this.got = 0;
        this.executeCommand();
      }

      return;
    }
    this.beginCommand(word >>> 0);
  }

  private beginCommand(word: number): void {
    const cmd = (word >>> 24) & 0xff;
    this.cmd = cmd;
    this.params[0] = word;
    this.got = 0;
    this.need = 0;

    if (cmd >= 0x20 && cmd <= 0x3f) {
      const gouraud = (cmd & 0x10) !== 0;
      const textured = (cmd & 4) !== 0;
      const quad = (cmd & 8) !== 0;
      if (gouraud && textured) {
        this.need = quad ? 11 : 8;
      } else if (textured) {
        this.need = quad ? 8 : 6;
      } else if (gouraud) {
        this.need = quad ? 7 : 5;
      } else {
        this.need = quad ? 4 : 3;
      }

      return;
    }
    if (cmd >= 0x40 && cmd <= 0x5f) {
      if ((cmd & 8) !== 0) {
        this.startLineStrip(cmd, word);

        return;
      }
      this.need = (cmd & 0x10) !== 0 ? 3 : 2;

      return;
    }
    if (cmd >= 0x60 && cmd <= 0x7f) {
      const textured = (cmd & 4) !== 0;
      const variable = ((cmd >>> 3) & 3) === 0;
      this.need = (textured ? 2 : 1) + (variable ? 1 : 0);

      return;
    }
    if (cmd === 0x01) {
      return;
    }
    if (cmd === 0x02) {
      this.need = 2;

      return;
    }
    if (cmd === 0x03) {
      return;
    }
    if (cmd === 0x1f) {
      this.irqPending = true;
      this.irq.raise(1);

      return;
    }
    if (cmd >= 0x80 && cmd <= 0x9f) {
      this.need = 3;

      return;
    }
    if (cmd >= 0xa0 && cmd <= 0xbf) {
      this.need = 2;

      return;
    }
    if (cmd >= 0xc0 && cmd <= 0xdf) {
      this.need = 2;

      return;
    }
    if (cmd === 0xe1) {
      this.applyDrawMode(word & 0x3fff);

      return;
    }
    if (cmd === 0xe2) {
      this.setTextureWindow(word & 0x1f_ffff);

      return;
    }
    if (cmd === 0xe3) {
      this.areaX1 = word & 0x3ff;
      this.areaY1 = (word >>> 10) & 0x1ff;

      return;
    }
    if (cmd === 0xe4) {
      this.areaX2 = word & 0x3ff;
      this.areaY2 = (word >>> 10) & 0x1ff;

      return;
    }
    if (cmd === 0xe5) {
      this.drawOffX = sext11(word & 0x7ff);
      this.drawOffY = sext11((word >>> 11) & 0x7ff);

      return;
    }
    if (cmd === 0xe6) {
      this.forceMask = word & 1;
      this.checkMask = (word >>> 1) & 1;

      return;
    }
  }

  private executeCommand(): void {
    const cmd = this.cmd;
    if (cmd >= 0x20 && cmd <= 0x3f) {
      this.execPolygon(cmd);

      return;
    }
    if (cmd >= 0x40 && cmd <= 0x5f) {
      this.execLine(cmd);

      return;
    }
    if (cmd >= 0x60 && cmd <= 0x7f) {
      this.execRect(cmd);

      return;
    }
    if (cmd === 0x02) {
      this.execFill();

      return;
    }
    if (cmd >= 0x80 && cmd <= 0x9f) {
      this.execVramCopy();

      return;
    }
    if (cmd >= 0xa0 && cmd <= 0xbf) {
      this.beginCpuToVram();

      return;
    }
    if (cmd >= 0xc0 && cmd <= 0xdf) {
      this.beginVramToCpu();
    }
  }

  private applyDrawMode(value: number): void {
    this.texPageX = (value & 0xf) << 6;
    this.texPageY = ((value >>> 4) & 1) << 8;
    this.texPageYHigh = (value >>> 11) & 1;
    this.texPageY |= this.texPageYHigh << 9;
    this.stMode = (value >>> 5) & 3;
    this.colorDepth = (value >>> 7) & 3;
    this.dither = (value >>> 9) & 1;
    this.interlaceDraw = (value >>> 10) & 1;
    this.rectFlipX = (value >>> 12) & 1;
    this.rectFlipY = (value >>> 13) & 1;
  }

  private applyTexpage(attr: number): void {
    this.texPageX = (attr & 0xf) << 6;
    this.texPageYHigh = (attr >>> 11) & 1;
    this.texPageY = (((attr >>> 4) & 1) << 8) | (this.texPageYHigh << 9);
    this.stMode = (attr >>> 5) & 3;
    this.colorDepth = (attr >>> 7) & 3;
  }

  private applyClut(attr: number): void {
    this.clutX = (attr & 0x3f) << 4;
    this.clutY = (((attr >>> 6) & 0x1ff) | (((attr >>> 15) & 1) << 9)) & 0x1ff;
  }

  private setTextureWindow(value: number): void {
    this.twMaskX = value & 0x1f;
    this.twMaskY = (value >>> 5) & 0x1f;
    this.twOffsetX = (value >>> 10) & 0x1f;
    this.twOffsetY = (value >>> 15) & 0x1f;
    this.twKeepX = (~(this.twMaskX << 3)) & 0xff;
    this.twKeepY = (~(this.twMaskY << 3)) & 0xff;
    this.twSetX = ((this.twOffsetX & this.twMaskX) << 3) & 0xff;
    this.twSetY = ((this.twOffsetY & this.twMaskY) << 3) & 0xff;
  }

  private screenX(raw: number): number {
    return sext11((sext11(raw & 0x7ff) + this.drawOffX) & 0x7ff);
  }

  private screenY(raw: number): number {
    return sext11((sext11((raw >>> 16) & 0x7ff) + this.drawOffY) & 0x7ff);
  }

  private execPolygon(cmd: number): void {
    const gouraud = (cmd & 0x10) !== 0;
    const textured = (cmd & 4) !== 0;
    const quad = (cmd & 8) !== 0;
    const raw = (cmd & 1) !== 0;
    const semi = (cmd & 2) !== 0;
    const count = quad ? 4 : 3;
    const params = this.params;

    this.vr[0] = params[0] & 0xff;
    this.vg[0] = (params[0] >>> 8) & 0xff;
    this.vb[0] = (params[0] >>> 16) & 0xff;

    let clut = 0;
    let tpage = 0;
    let index = 1;
    for (let k = 0; k < count; k++) {
      if (k > 0 && gouraud) {
        const color = params[index];
        index++;
        this.vr[k] = color & 0xff;
        this.vg[k] = (color >>> 8) & 0xff;
        this.vb[k] = (color >>> 16) & 0xff;
      }
      const vertex = params[index];
      index++;
      this.vx[k] = this.screenX(vertex);
      this.vy[k] = this.screenY(vertex);
      if (textured) {
        const texcoord = params[index];
        index++;
        if (k === 0) {
          clut = (texcoord >>> 16) & 0xffff;
        } else if (k === 1) {
          tpage = (texcoord >>> 16) & 0xffff;
        }
        this.vu[k] = texcoord & 0xff;
        this.vv[k] = (texcoord >>> 8) & 0xff;
      }
    }

    if (!gouraud) {
      for (let k = 1; k < count; k++) {
        this.vr[k] = this.vr[0];
        this.vg[k] = this.vg[0];
        this.vb[k] = this.vb[0];
      }
    }

    if (textured) {
      this.applyTexpage(tpage);
      this.applyClut(clut);
      this.texMode = raw ? TEX_RAW : TEX_BLEND;
      this.drawDepth = this.colorDepth;
    } else {
      this.texMode = TEX_OFF;
    }
    this.semiCmd = semi;

    this.rasterizeTriangle(0, 1, 2, gouraud);
    if (quad) {
      this.rasterizeTriangle(1, 2, 3, gouraud);
    }
  }

  private setupEdge(slot: number, from: number, to: number): void {
    const x0 = this.vx[from];
    const y0 = this.vy[from];
    const dy = this.vy[to] - y0;
    this.edgeY0[slot] = y0;
    this.edgeX0[slot] = x0 * (FIX * 2);
    this.edgeXStep[slot] = dy !== 0 ? ((this.vx[to] - x0) * FIX) / dy : 0;

    const base = slot * 5;
    const pu = this.vu[from];
    const pv = this.vv[from];
    const pr = this.vr[from] * 65536;
    const pg = this.vg[from] * 65536;
    const pb = this.vb[from] * 65536;
    this.edgeP0[base] = pu * FIX;
    this.edgeP0[base + 1] = pv * FIX;
    this.edgeP0[base + 2] = pr * 2;
    this.edgeP0[base + 3] = pg * 2;
    this.edgeP0[base + 4] = pb * 2;
    if (dy !== 0) {
      this.edgePStep[base] = ((this.vu[to] - pu) * 65536) / dy;
      this.edgePStep[base + 1] = ((this.vv[to] - pv) * 65536) / dy;
      this.edgePStep[base + 2] = (this.vr[to] * 65536 - pr) / dy;
      this.edgePStep[base + 3] = (this.vg[to] * 65536 - pg) / dy;
      this.edgePStep[base + 4] = (this.vb[to] * 65536 - pb) / dy;
    } else {
      this.edgePStep[base] = 0;
      this.edgePStep[base + 1] = 0;
      this.edgePStep[base + 2] = 0;
      this.edgePStep[base + 3] = 0;
      this.edgePStep[base + 4] = 0;
    }
  }

  private evalEdge(slot: number, y: number, out: Float64Array): void {
    const span = 2 * (y - this.edgeY0[slot]) + 1;
    out[0] = Math.floor((this.edgeX0[slot] + this.edgeXStep[slot] * span) / 2) - FIX_HALF;
    const base = slot * 5;
    for (let k = 0; k < 5; k++) {
      out[k + 1] = Math.floor((this.edgeP0[base + k] + this.edgePStep[base + k] * span) / 2);
    }
  }

  private rasterizeTriangle(ia: number, ib: number, ic: number, gouraud: boolean): void {
    const vx = this.vx;
    const vy = this.vy;
    let minX = vx[ia];
    let maxX = minX;
    let minY = vy[ia];
    let maxY = minY;
    for (let k = 0; k < 3; k++) {
      const index = k === 0 ? ib : ic;
      const x = vx[index];
      const y = vy[index];
      if (x < minX) {
        minX = x;
      }
      if (x > maxX) {
        maxX = x;
      }
      if (y < minY) {
        minY = y;
      }
      if (y > maxY) {
        maxY = y;
      }
    }
    if (maxY - minY > 511 || maxX - minX > 1023) {
      return;
    }
    if (maxY <= minY || maxX <= minX) {
      return;
    }

    let i0 = ia;
    let i1 = ib;
    let i2 = ic;
    if (vy[i1] < vy[i0]) {
      const swap = i0;
      i0 = i1;
      i1 = swap;
    }
    if (vy[i2] < vy[i1]) {
      const swap = i1;
      i1 = i2;
      i2 = swap;
    }
    if (vy[i1] < vy[i0]) {
      const swap = i0;
      i0 = i1;
      i1 = swap;
    }

    const yTop = vy[i0];
    const yMid = vy[i1];
    const yBot = vy[i2];
    const rowStart = yTop > this.areaY1 ? yTop : this.areaY1;
    const rowEnd = yBot - 1 < this.areaY2 ? yBot - 1 : this.areaY2;
    if (rowEnd < rowStart) {
      return;
    }

    this.setupEdge(0, i0, i2);
    this.setupEdge(1, i0, i1);
    this.setupEdge(2, i1, i2);

    const textured = this.texMode !== TEX_OFF;
    const ditherOn = this.dither === 1 && (this.texMode === TEX_BLEND || gouraud);
    const areaX1 = this.areaX1;
    const areaX2 = this.areaX2 + 1;
    const keepX = this.twKeepX;
    const keepY = this.twKeepY;
    const setX = this.twSetX;
    const setY = this.twSetY;
    const flatR = this.vr[i0] >> 3;
    const flatG = this.vg[i0] >> 3;
    const flatB = this.vb[i0] >> 3;
    const interlaceSkip = this.interlaceDraw === 1;

    for (let y = rowStart; y <= rowEnd; y++) {
      if (interlaceSkip && (y & 1) !== 0) {
        continue;
      }
      const other = y < yMid ? 1 : 2;
      this.evalEdge(0, y, this.rowA);
      this.evalEdge(other, y, this.rowB);
      let left = this.rowA;
      let right = this.rowB;
      if (left[0] > right[0]) {
        const swap = left;
        left = right;
        right = swap;
      }
      const span = right[0] - left[0];
      if (span <= 0) {
        continue;
      }
      let xs = ceilFix(left[0]);
      let xe = ceilFix(right[0]);
      if (xs < areaX1) {
        xs = areaX1;
      }
      if (xe > areaX2) {
        xe = areaX2;
      }
      if (xe <= xs) {
        continue;
      }
      const offset = xs * FIX - left[0];

      if (textured) {
        const du = right[1] - left[1];
        const dv = right[2] - left[2];
        let u = left[1] + Math.floor((du * offset) / span);
        let v = left[2] + Math.floor((dv * offset) / span);
        const uStep = Math.floor((du * FIX) / span);
        const vStep = Math.floor((dv * FIX) / span);
        const dr = right[3] - left[3];
        const dg = right[4] - left[4];
        const db = right[5] - left[5];
        let r = left[3] + Math.floor((dr * offset) / span);
        let g = left[4] + Math.floor((dg * offset) / span);
        let b = left[5] + Math.floor((db * offset) / span);
        const rStep = Math.floor((dr * FIX) / span);
        const gStep = Math.floor((dg * FIX) / span);
        const bStep = Math.floor((db * FIX) / span);
        const colorR = this.vr[i0];
        const colorG = this.vg[i0];
        const colorB = this.vb[i0];

        for (let x = xs; x < xe; x++) {
          const tu = ((u >> 16) & keepX) | setX;
          const tv = ((v >> 16) & keepY) | setY;
          const texel = this.sampleTexel(tu, tv);
          u += uStep;
          v += vStep;
          const cr = gouraud ? (r >> 16) & 0xff : colorR;
          const cg = gouraud ? (g >> 16) & 0xff : colorG;
          const cb = gouraud ? (b >> 16) & 0xff : colorB;
          r += rStep;
          g += gStep;
          b += bStep;
          if (texel === 0) {
            continue;
          }
          const dith = ditherOn && this.texMode === TEX_BLEND
            ? DITHER_OFFSETS[((y & 3) << 2) | (x & 3)]
            : 0;
          let outR = 0;
          let outG = 0;
          let outB = 0;
          if (this.texMode === TEX_RAW) {
            outR = clamp255(((texel & 0x1f) << 3) + dith);
            outG = clamp255((((texel >>> 5) & 0x1f) << 3) + dith);
            outB = clamp255((((texel >>> 10) & 0x1f) << 3) + dith);
          } else {
            outR = clamp255(((((texel & 0x1f) << 3) * cr) >> 7) + dith);
            outG = clamp255((((((texel >>> 5) & 0x1f) << 3) * cg) >> 7) + dith);
            outB = clamp255((((((texel >>> 10) & 0x1f) << 3) * cb) >> 7) + dith);
          }
          const stp = texel >>> 15;
          this.storePixel(x, y, outR >> 3, outG >> 3, outB >> 3, this.semiCmd && stp === 1, stp);
        }

        continue;
      }

      if (gouraud) {
        const dr = right[3] - left[3];
        const dg = right[4] - left[4];
        const db = right[5] - left[5];
        let r = left[3] + Math.floor((dr * offset) / span);
        let g = left[4] + Math.floor((dg * offset) / span);
        let b = left[5] + Math.floor((db * offset) / span);
        const rStep = Math.floor((dr * FIX) / span);
        const gStep = Math.floor((dg * FIX) / span);
        const bStep = Math.floor((db * FIX) / span);

        for (let x = xs; x < xe; x++) {
          const dith = ditherOn ? DITHER_OFFSETS[((y & 3) << 2) | (x & 3)] : 0;
          const outR = clamp255((r >> 16) + dith);
          const outG = clamp255((g >> 16) + dith);
          const outB = clamp255((b >> 16) + dith);
          r += rStep;
          g += gStep;
          b += bStep;
          this.storePixel(x, y, outR >> 3, outG >> 3, outB >> 3, this.semiCmd, 0);
        }

        continue;
      }

      for (let x = xs; x < xe; x++) {
        this.storePixel(x, y, flatR, flatG, flatB, this.semiCmd, 0);
      }
    }
  }

  private startLineStrip(cmd: number, word: number): void {
    this.mode = MODE_LINE_STRIP;
    this.stripStarted = false;
    this.stripShaded = (cmd & 0x10) !== 0;
    this.stripSemi = (cmd & 2) !== 0;
    this.stripColorPending = false;
    this.stripR = word & 0xff;
    this.stripG = (word >>> 8) & 0xff;
    this.stripB = (word >>> 16) & 0xff;
  }

  private lineStripWord(word: number): void {
    if ((word >>> 28) === 5) {
      this.mode = MODE_COMMAND;
      this.stripStarted = false;
      this.stripColorPending = false;

      return;
    }
    if (this.stripColorPending) {
      this.stripColorPending = false;
      this.stripR = word & 0xff;
      this.stripG = (word >>> 8) & 0xff;
      this.stripB = (word >>> 16) & 0xff;

      return;
    }
    const x = this.screenX(word);
    const y = this.screenY(word);
    if (!this.stripStarted) {
      this.stripStarted = true;
      this.stripX = x;
      this.stripY = y;

      return;
    }
    this.drawLine(this.stripX, this.stripY, x, y,
      this.stripR, this.stripG, this.stripB,
      this.stripR, this.stripG, this.stripB,
      this.stripShaded, this.stripSemi);
    this.stripX = x;
    this.stripY = y;
    this.stripColorPending = this.stripShaded;
  }

  private execLine(cmd: number): void {
    const shaded = (cmd & 0x10) !== 0;
    const semi = (cmd & 2) !== 0;
    const params = this.params;
    const x0 = this.screenX(params[1]);
    const y0 = this.screenY(params[1]);
    const r0 = params[0] & 0xff;
    const g0 = (params[0] >>> 8) & 0xff;
    const b0 = (params[0] >>> 16) & 0xff;
    if (shaded) {
      const color = params[2];
      this.drawLine(x0, y0, this.screenX(params[3]), this.screenY(params[3]),
        r0, g0, b0, color & 0xff, (color >>> 8) & 0xff, (color >>> 16) & 0xff, true, semi);

      return;
    }
    this.drawLine(x0, y0, this.screenX(params[2]), this.screenY(params[2]),
      r0, g0, b0, r0, g0, b0, false, semi);
  }

  private drawLine(
    x0: number, y0: number, x1: number, y1: number,
    r0: number, g0: number, b0: number,
    r1: number, g1: number, b1: number,
    shaded: boolean, semi: boolean,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const adx = dx < 0 ? -dx : dx;
    const ady = dy < 0 ? -dy : dy;
    if (adx > 1023 || ady > 511) {
      return;
    }

    const ditherOn = this.dither === 1;
    if (adx === 0 && ady === 0) {
      this.linePixel(x0, y0, r0, g0, b0, semi, ditherOn);

      return;
    }

    if (adx >= ady) {
      const stepX = dx > 0 ? 1 : -1;
      const slope = (dy * 65536) / adx;
      let yf = y0 * 65536 + 32768;
      const dR = shaded ? ((r1 - r0) * 65536) / adx : 0;
      const dG = shaded ? ((g1 - g0) * 65536) / adx : 0;
      const dB = shaded ? ((b1 - b0) * 65536) / adx : 0;
      let rf = 0;
      let gf = 0;
      let bf = 0;
      let x = x0;
      for (let i = 0; i <= adx; i++) {
        const r = shaded ? r0 + (rf >> 16) : r0;
        const g = shaded ? g0 + (gf >> 16) : g0;
        const b = shaded ? b0 + (bf >> 16) : b0;
        this.linePixel(x, yf >> 16, r, g, b, semi, ditherOn);
        x += stepX;
        yf += slope;
        rf += dR;
        gf += dG;
        bf += dB;
      }

      return;
    }

    const stepY = dy > 0 ? 1 : -1;
    const slopeY = (dx * 65536) / ady;
    let xf = x0 * 65536 + 32768;
    const dR = shaded ? ((r1 - r0) * 65536) / ady : 0;
    const dG = shaded ? ((g1 - g0) * 65536) / ady : 0;
    const dB = shaded ? ((b1 - b0) * 65536) / ady : 0;
    let rf = 0;
    let gf = 0;
    let bf = 0;
    let y = y0;
    for (let i = 0; i <= ady; i++) {
      const r = shaded ? r0 + (rf >> 16) : r0;
      const g = shaded ? g0 + (gf >> 16) : g0;
      const b = shaded ? b0 + (bf >> 16) : b0;
      this.linePixel(xf >> 16, y, r, g, b, semi, ditherOn);
      y += stepY;
      xf += slopeY;
      rf += dR;
      gf += dG;
      bf += dB;
    }
  }

  private linePixel(
    x: number, y: number, r: number, g: number, b: number, semi: boolean, ditherOn: boolean,
  ): void {
    if (x < this.areaX1 || x > this.areaX2 || y < this.areaY1 || y > this.areaY2) {
      return;
    }
    if (this.interlaceDraw === 1 && (y & 1) !== 0) {
      return;
    }
    const dith = ditherOn ? DITHER_OFFSETS[((y & 3) << 2) | (x & 3)] : 0;
    const outR = clamp255(r + dith);
    const outG = clamp255(g + dith);
    const outB = clamp255(b + dith);
    this.storePixel(x, y, outR >> 3, outG >> 3, outB >> 3, semi, 0);
  }

  private execRect(cmd: number): void {
    const textured = (cmd & 4) !== 0;
    const raw = (cmd & 1) !== 0;
    const semi = (cmd & 2) !== 0;
    const size = (cmd >>> 3) & 3;
    const params = this.params;
    const x0 = this.screenX(params[1]);
    const y0 = this.screenY(params[1]);
    let width = 1;
    let height = 1;
    if (size === 0) {
      const sizeWord = params[textured ? 3 : 2];
      width = sizeWord & 0x3ff;
      height = (sizeWord >>> 16) & 0x1ff;
    } else if (size === 2) {
      width = 8;
      height = 8;
    } else if (size === 3) {
      width = 16;
      height = 16;
    }
    if (width === 0 || height === 0) {
      return;
    }

    const colorR = params[0] & 0xff;
    const colorG = (params[0] >>> 8) & 0xff;
    const colorB = (params[0] >>> 16) & 0xff;

    if (!textured) {
      const areaX1 = this.areaX1;
      const areaX2 = this.areaX2;
      const areaY1 = this.areaY1;
      const areaY2 = this.areaY2;
      for (let row = 0; row < height; row++) {
        const y = y0 + row;
        if (y < areaY1 || y > areaY2) {
          continue;
        }
        if (this.interlaceDraw === 1 && (y & 1) !== 0) {
          continue;
        }
        for (let col = 0; col < width; col++) {
          const x = x0 + col;
          if (x < areaX1 || x > areaX2) {
            continue;
          }
          this.storePixel(x, y, colorR >> 3, colorG >> 3, colorB >> 3, semi, 0);
        }
      }

      return;
    }

    this.texMode = raw ? TEX_RAW : TEX_BLEND;
    this.drawDepth = this.colorDepth;
    this.applyClut((params[2] >>> 16) & 0xffff);
    let baseU = params[2] & 0xff;
    const baseV = (params[2] >>> 8) & 0xff;
    const flipX = this.rectFlipX === 1;
    const flipY = this.rectFlipY === 1;
    const texelErrorMask = this.drawDepth === DEPTH_15BPP ? 3 : 7;

    if (flipX) {
      baseU = (baseU | 1) & 0xff;
    } else if ((baseU & texelErrorMask) === 0) {
      let fixed = this.windowX((baseU - 1) & 0xff);
      if (this.drawDepth === DEPTH_4BPP && (fixed & 8) === 0) {
        fixed = (fixed + 1) & 0xff;
      }
      baseU = fixed;
    } else {
      baseU = this.windowX(baseU);
    }

    const areaX1 = this.areaX1;
    const areaX2 = this.areaX2;
    const areaY1 = this.areaY1;
    const areaY2 = this.areaY2;
    const keepX = this.twKeepX;
    const keepY = this.twKeepY;
    const setX = this.twSetX;
    const setY = this.twSetY;

    for (let row = 0; row < height; row++) {
      const y = y0 + row;
      if (y < areaY1 || y > areaY2) {
        continue;
      }
      if (this.interlaceDraw === 1 && (y & 1) !== 0) {
        continue;
      }
      const ty = ((flipY ? (baseV - row) & 0xff : (baseV + row) & 0xff) & keepY) | setY;
      for (let col = 0; col < width; col++) {
        const x = x0 + col;
        if (x < areaX1 || x > areaX2) {
          continue;
        }
        const tu = ((flipX ? (baseU - col) & 0xff : (baseU + col) & 0xff) & keepX) | setX;
        const texel = this.sampleTexel(tu, ty);
        if (texel === 0) {
          continue;
        }
        let outR = 0;
        let outG = 0;
        let outB = 0;
        if (this.texMode === TEX_RAW) {
          outR = (texel & 0x1f) << 3;
          outG = ((texel >>> 5) & 0x1f) << 3;
          outB = ((texel >>> 10) & 0x1f) << 3;
        } else {
          outR = (((texel & 0x1f) << 3) * colorR) >> 7;
          outG = ((((texel >>> 5) & 0x1f) << 3) * colorG) >> 7;
          outB = ((((texel >>> 10) & 0x1f) << 3) * colorB) >> 7;
        }
        const stp = texel >>> 15;
        this.storePixel(x, y, clamp31(outR >> 3), clamp31(outG >> 3), clamp31(outB >> 3),
          semi && stp === 1, stp);
      }
    }
  }

  private windowX(value: number): number {
    return (value & this.twKeepX) | this.twSetX;
  }

  private sampleTexel(tu: number, tv: number): number {
    const vram = this.vram;
    const rowBase = ((this.texPageY + tv) & 511) << 10;
    if (this.drawDepth === DEPTH_15BPP) {
      return vram[rowBase | ((this.texPageX + tu) & 1023)];
    }
    let index = 0;
    if (this.drawDepth === DEPTH_8BPP) {
      const half = vram[rowBase | ((this.texPageX + (tu >> 1)) & 1023)];
      index = (half >>> ((tu & 1) << 3)) & 0xff;
    } else {
      const half = vram[rowBase | ((this.texPageX + (tu >> 2)) & 1023)];
      index = (half >>> ((tu & 3) << 2)) & 0xf;
    }

    return vram[(this.clutY << 10) | ((this.clutX + index) & 1023)];
  }

  private storePixel(
    x: number, y: number, r5: number, g5: number, b5: number, semi: boolean, stp: number,
  ): void {
    const index = (y << 10) | x;
    const vram = this.vram;
    const dst = vram[index];
    if (this.checkMask === 1 && (dst & 0x8000) !== 0) {
      return;
    }
    let r = r5;
    let g = g5;
    let b = b5;
    if (semi) {
      const dr = dst & 0x1f;
      const dg = (dst >>> 5) & 0x1f;
      const db = (dst >>> 10) & 0x1f;
      if (this.stMode === 0) {
        r = (dr + r) >> 1;
        g = (dg + g) >> 1;
        b = (db + b) >> 1;
      } else if (this.stMode === 1) {
        r = clamp31(dr + r);
        g = clamp31(dg + g);
        b = clamp31(db + b);
      } else if (this.stMode === 2) {
        r = clamp31(dr - r);
        g = clamp31(dg - g);
        b = clamp31(db - b);
      } else {
        r = clamp31(dr + (r >> 2));
        g = clamp31(dg + (g >> 2));
        b = clamp31(db + (b >> 2));
      }
    }
    const mask = this.forceMask === 1 ? 0x8000 : (stp << 15);
    vram[index] = r | (g << 5) | (b << 10) | mask;
  }

  private execFill(): void {
    const params = this.params;
    const color = params[0] & 0xff_ffff;
    const x = params[1] & 0x3f0;
    const y = (params[1] >>> 16) & 0x1ff;
    const width = (((params[2] & 0x3ff) + 0x0f) & ~0x0f) & 0x7ff;
    const height = (params[2] >>> 16) & 0x1ff;
    if (width === 0 || height === 0) {
      return;
    }
    const value = (((color & 0xff) >> 3) | ((((color >>> 8) & 0xff) >> 3) << 5)
      | ((((color >>> 16) & 0xff) >> 3) << 10)) & 0x7fff;
    const vram = this.vram;
    for (let row = 0; row < height; row++) {
      const rowBase = ((y + row) & 0x1ff) << 10;
      let column = x;
      for (let i = 0; i < width; i++) {
        vram[rowBase | (column & 1023)] = value;
        column++;
      }
    }
  }

  private execVramCopy(): void {
    const params = this.params;
    const srcX = params[1] & 0x3ff;
    const srcY = (params[1] >>> 16) & 0x1ff;
    const dstX = params[2] & 0x3ff;
    const dstY = (params[2] >>> 16) & 0x1ff;
    const width = (((params[3] & 0x3ff) - 1) & 0x3ff) + 1;
    const height = ((((params[3] >>> 16) & 0x1ff) - 1) & 0x1ff) + 1;
    const vram = this.vram;
    const backwards = dstY > srcY || (dstY === srcY && dstX > srcX);

    for (let row = 0; row < height; row++) {
      const srcRow = ((srcY + row) & 0x1ff) << 10;
      const dstRow = ((dstY + row) & 0x1ff) << 10;
      for (let i = 0; i < width; i++) {
        const column = backwards ? width - 1 - i : i;
        const source = vram[srcRow | ((srcX + column) & 1023)];
        const target = dstRow | ((dstX + column) & 1023);
        if (this.checkMask === 1 && (vram[target] & 0x8000) !== 0) {
          continue;
        }
        const mask = this.forceMask === 1 ? 0x8000 : (source & 0x8000);
        vram[target] = (source & 0x7fff) | mask;
      }
    }
  }

  private beginCpuToVram(): void {
    const params = this.params;
    this.writeBaseX = params[1] & 0x3ff;
    this.writeY = (params[1] >>> 16) & 0x1ff;
    this.writeX = this.writeBaseX;
    this.writeWidth = (((params[2] & 0x3ff) - 1) & 0x3ff) + 1;
    const height = ((((params[2] >>> 16) & 0x1ff) - 1) & 0x1ff) + 1;
    this.writeLeft = this.writeWidth * height;
    this.mode = MODE_VRAM_WRITE;
  }

  private writeVramWord(word: number): void {
    if (this.writeLeft > 0) {
      this.writeVramHalf(word & 0xffff);
    }
    if (this.writeLeft > 0) {
      this.writeVramHalf((word >>> 16) & 0xffff);
    }
  }

  private writeVramHalf(value: number): void {
    const index = ((this.writeY & 0x1ff) << 10) | (this.writeX & 0x3ff);
    const vram = this.vram;
    const masked = this.checkMask === 1 && (vram[index] & 0x8000) !== 0;
    if (!masked) {
      const mask = this.forceMask === 1 ? 0x8000 : (value & 0x8000);
      vram[index] = (value & 0x7fff) | mask;
    }
    this.writeLeft--;
    this.writeX++;
    if (this.writeX >= this.writeBaseX + this.writeWidth) {
      this.writeX = this.writeBaseX;
      this.writeY = (this.writeY + 1) & 0x1ff;
    }
    if (this.writeLeft === 0) {
      this.mode = MODE_COMMAND;
    }
  }

  private beginVramToCpu(): void {
    const params = this.params;
    this.readBaseX = params[1] & 0x3ff;
    this.readY = (params[1] >>> 16) & 0x1ff;
    this.readX = this.readBaseX;
    this.readWidth = (((params[2] & 0x3ff) - 1) & 0x3ff) + 1;
    const height = ((((params[2] >>> 16) & 0x1ff) - 1) & 0x1ff) + 1;
    this.readHalfLeft = this.readWidth * height;
    this.readActive = this.readHalfLeft > 0;
  }

  private dotClockCycles(): number {
    if (this.horiz368 !== 0) {
      return 7;
    }
    if (this.horizMode === 0) {
      return 10;
    }
    if (this.horizMode === 1) {
      return 8;
    }
    if (this.horizMode === 2) {
      return 5;
    }

    return 4;
  }

  private displayWidth(): number {
    const span = this.horizX2 - this.horizX1;
    if (span <= 0) {
      return 320;
    }
    let width = (Math.floor(span / this.dotClockCycles()) + 2) & ~3;
    if (width < 4) {
      width = 4;
    }
    if (width > 1024) {
      width = 1024;
    }

    return width;
  }

  private displayHeight(): number {
    let height = this.vertY2 - this.vertY1;
    if (height <= 0) {
      height = 240;
    }
    if (height > VRAM_H) {
      height = VRAM_H;
    }

    return height;
  }

  present(): DisplayFrame {
    const width = this.displayWidth();
    const height = this.displayHeight();
    const rgba = this.outRgba;
    const pixels = width * height;
    if (!this.displayEnabled) {
      rgba.fill(0, 0, pixels * 4);

      return { width: width, height: height, rgba: rgba };
    }
    const vram = this.vram;
    let out = 0;
    if (this.depth24 === 1) {
      const rowBytes = VRAM_W * 2;
      let byteBase = ((this.displayY & 0x1ff) * rowBytes) + (this.displayX & 0x3ff) * 2;
      for (let y = 0; y < height; y++) {
        let address = byteBase;
        for (let x = 0; x < width; x++) {
          const r = this.vramByte(address);
          const g = this.vramByte(address + 1);
          const b = this.vramByte(address + 2);
          rgba[out] = r;
          rgba[out + 1] = g;
          rgba[out + 2] = b;
          rgba[out + 3] = 255;
          out += 4;
          address += 3;
        }
        byteBase = (byteBase + rowBytes) & 0x0f_ffff;
      }

      return { width: width, height: height, rgba: rgba };
    }
    const baseX = this.displayX & 0x3ff;
    for (let y = 0; y < height; y++) {
      const rowBase = ((this.displayY + y) & 0x1ff) << 10;
      let x = baseX;
      for (let i = 0; i < width; i++) {
        const color = vram[rowBase | x];
        const r = color & 0x1f;
        const g = (color >>> 5) & 0x1f;
        const b = (color >>> 10) & 0x1f;
        rgba[out] = (r << 3) | (r >> 2);
        rgba[out + 1] = (g << 3) | (g >> 2);
        rgba[out + 2] = (b << 3) | (b >> 2);
        rgba[out + 3] = 255;
        out += 4;
        x = (x + 1) & 0x3ff;
      }
    }

    return { width: width, height: height, rgba: rgba };
  }

  private vramByte(address: number): number {
    const half = this.vram[(address >>> 1) & (VRAM_HALFWORDS - 1)];

    return (address & 1) === 0 ? half & 0xff : (half >>> 8) & 0xff;
  }
}
