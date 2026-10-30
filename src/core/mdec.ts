import type {
  DmaChannel,
  DmaConfig,
  IrqController,
  Logger,
  MdecUnit,
  Scheduler,
} from './contracts';
import { RAM_SIZE } from './contracts';

const RAM_WORD_MASK = (RAM_SIZE - 1) >>> 2;
const OUT_RING_WORDS = 1 << 18;
const OUT_RING_MASK = OUT_RING_WORDS - 1;
const EOB_HALFWORD = 0xFE00;
const S11_MIN = -0x400;
const S11_MAX = 0x3FF;
const MAX_DMA_WORDS = 1 << 21;
const BLOCK_WORDS_15BPP = 32;
const BLOCK_WORDS_24BPP = 48;
const BLOCK_WORDS_MONO_8BPP = 16;
const BLOCK_WORDS_MONO_4BPP = 8;

const SCALEFACTOR: Array<number> = [
  1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.541196100, 0.275899379,
];

const ZIGZAG_SCAN_OF_FREQ: Array<number> = [
  0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18,
  24, 31, 40, 44, 53, 10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47,
  50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
];

const ZAGZIG = buildZagZig();
const FACTOR_AT_FREQ = buildFactorAtFreq();

const DEFAULT_QUANT: Uint8Array = Uint8Array.of(
  0x02, 0x10, 0x10, 0x13, 0x10, 0x13, 0x16, 0x16, 0x16, 0x16, 0x16, 0x16, 0x1A, 0x18, 0x1A, 0x1B,
  0x1B, 0x1B, 0x1A, 0x1A, 0x1A, 0x1A, 0x1B, 0x1B, 0x1B, 0x1D, 0x1D, 0x1D, 0x22, 0x22, 0x22, 0x1D,
  0x1D, 0x1D, 0x1B, 0x1B, 0x1D, 0x1D, 0x20, 0x20, 0x22, 0x22, 0x25, 0x26, 0x25, 0x23, 0x23, 0x22,
  0x23, 0x26, 0x26, 0x28, 0x28, 0x28, 0x30, 0x30, 0x2E, 0x2E, 0x38, 0x38, 0x3A, 0x45, 0x45, 0x53,
);

const STANDARD_SCALE: Uint16Array = Uint16Array.of(
  0x5A82, 0x5A82, 0x5A82, 0x5A82, 0x5A82, 0x5A82, 0x5A82, 0x5A82, 0x7D8A, 0x6A6D, 0x471C, 0x18F8,
  0xE707, 0xB8E3, 0x9592, 0x8275, 0x7641, 0x30FB, 0xCF04, 0x89BE, 0x89BE, 0xCF04, 0x30FB, 0x7641,
  0x6A6D, 0xE707, 0x8275, 0xB8E3, 0x471C, 0x7D8A, 0x18F8, 0x9592, 0x5A82, 0xA57D, 0xA57D, 0x5A82,
  0x5A82, 0xA57D, 0xA57D, 0x5A82, 0x471C, 0x8275, 0x18F8, 0x6A6D, 0x9592, 0xE707, 0x7D8A, 0xB8E3,
  0x30FB, 0x89BE, 0x7641, 0xCF04, 0xCF04, 0x7641, 0x89BE, 0x30FB, 0x18F8, 0xB8E3, 0x6A6D, 0x8275,
  0x7D8A, 0x9592, 0x471C, 0xE707,
);

type MdecState = 'idle' | 'decode' | 'quantLum' | 'quantUV' | 'scale';

const INCOMING_BLOCK_DISPLAY: Array<number> = [4, 5, 0, 1, 2, 3];

function buildZagZig(): Uint8Array {
  const t = new Uint8Array(64);
  for (let f = 0; f < 64; f++) {
    t[ZIGZAG_SCAN_OF_FREQ[f]] = f;
  }

  return t;
}

function buildFactorAtFreq(): Float64Array {
  const t = new Float64Array(64);
  for (let f = 0; f < 64; f++) {
    t[f] = (SCALEFACTOR[f & 7] * SCALEFACTOR[f >>> 3]) / 8;
  }

  return t;
}

function minmaxInt(v: number, lo: number, hi: number): number {
  if (v < lo) {
    return lo;
  }

  return v > hi ? hi : v;
}

function minmaxSigned8(v: number): number {
  if (v < -128) {
    return -128;
  }

  return v > 127 ? 127 : v;
}

function sign10(v: number): number {
  return (v & 0x200) !== 0 ? v - 1024 : v;
}

function sign16(v: number): number {
  return ((v & 0xFFFF) << 16) >> 16;
}

function wrapSigned9(v: number): number {
  return ((v + 256) & 0x1FF) - 256;
}

export class MdecCore implements MdecUnit {
  private readonly log: Logger;
  private readonly irq: IrqController;

  private state: MdecState = 'idle';
  private remainWords = 0;
  private counter = 0;
  private inFifoFull = false;
  private depth = 0;
  private signedOut = 0;
  private bit15Out = 0;
  private inReqEnable = false;
  private outReqEnable = false;
  private mono = false;
  private inBlock = 0;
  private rlePhase: 'needDct' | 'wantN' = 'needDct';
  private rleK = 0;
  private rleQscale = 0;
  private quantBoth = false;
  private tableByte = 0;
  private scaleHalf = 0;
  private fastIdct = true;
  private overflowLogged = false;

  private readonly qtY = new Uint8Array(64);
  private readonly qtUV = new Uint8Array(64);
  private readonly scaleTab = new Int16Array(64);
  private readonly crblk = new Float64Array(64);
  private readonly cbblk = new Float64Array(64);
  private readonly blk = new Float64Array(64);
  private readonly idctScratch = new Float64Array(64);
  private readonly pxR = new Int32Array(64);
  private readonly pxG = new Int32Array(64);
  private readonly pxB = new Int32Array(64);
  private readonly rowBytes = new Uint8Array(24);

  private readonly outRing = new Uint32Array(OUT_RING_WORDS);
  private outHead = 0;
  private outTail = 0;
  private outCount = 0;
  private outMono = false;
  private outBlockIdx = 0;
  private outBlockWpb = BLOCK_WORDS_15BPP;
  private outBlockLeft = BLOCK_WORDS_15BPP;
  private outMacroSize = 4 * BLOCK_WORDS_15BPP;
  private outMacroLeft = 4 * BLOCK_WORDS_15BPP;

  constructor(_sched: Scheduler, log: Logger, irq: IrqController) {
    this.log = log;
    this.irq = irq;
    this.qtY.set(DEFAULT_QUANT);
    this.qtUV.set(DEFAULT_QUANT);
    for (let i = 0; i < 64; i++) {
      this.scaleTab[i] = sign16(STANDARD_SCALE[i]);
    }
    this.softReset();
  }

  get busy(): boolean {
    return this.state !== 'idle' || this.outCount > 0;
  }

  dmaReadWord(): number {
    return this.popOut();
  }

  load32(addr: number): number {
    const r = addr & 0x1F;
    if (r === 0) {
      return this.popOut();
    }
    if (r === 4) {
      return this.statusWord();
    }

    return 0xFFFF_FFFF;
  }

  load16(addr: number): number {
    if ((addr & 0x1F) === 4) {
      return this.statusWord() & 0xFFFF;
    }

    return 0xFFFF;
  }

  load8(addr: number): number {
    if ((addr & 0x1F) === 4) {
      return this.statusWord() & 0xFF;
    }

    return 0xFF;
  }

  store32(addr: number, value: number): void {
    const r = addr & 0x1F;
    const v = value >>> 0;
    if (r === 0) {
      this.feedWord(v);

      return;
    }
    if (r === 4) {
      this.writeControl(v);
    }
  }

  store16(_addr: number, _value: number): void {}

  store8(_addr: number, _value: number): void {}

  dmaStart(channel: DmaChannel, config: DmaConfig, ram: Uint32Array): void {
    if (channel.id !== 0 || config.direction !== 'toDevice') {
      return;
    }

    const count = this.dmaTotalWords(config);
    if (count > 0 && this.inReqEnable) {
      const start = ((config.base & (RAM_SIZE - 1)) >>> 2) & RAM_WORD_MASK;
      for (let i = 0; i < count; i++) {
        this.feedWord(ram[(start + i) & RAM_WORD_MASK]);
      }
    }
    this.irq.dmaDone(channel.id);
  }

  private dmaTotalWords(config: DmaConfig): number {
    const n = config.wordsPerBlock * config.blockCount;
    if (n > MAX_DMA_WORDS) {
      this.log.warn('mdec', `mdec dma0 transfer oversized (${n} words), clamped`);

      return MAX_DMA_WORDS;
    }

    return n;
  }

  private statusWord(): number {
    let s = 0;
    if (this.outCount === 0) {
      s |= 1 << 31;
    }
    if (this.inFifoFull) {
      s |= 1 << 30;
    }
    if (this.state !== 'idle') {
      s |= 1 << 29;
    }
    if (this.inReqEnable && this.state !== 'idle' && this.remainWords > 0) {
      s |= 1 << 28;
    }
    if (this.outReqEnable && this.outCount > 0) {
      s |= 1 << 27;
    }
    s |= (this.depth & 3) << 25;
    s |= this.signedOut << 24;
    s |= this.bit15Out << 23;
    s |= (this.blockDisplay() & 7) << 16;
    s |= this.counter & 0xFFFF;

    return s >>> 0;
  }

  private blockDisplay(): number {
    if (this.outCount > 0) {
      if (this.outMono) {
        return 4;
      }

      return this.outBlockLeft === 0 ? (this.outBlockIdx + 1) & 3 : this.outBlockIdx;
    }
    if (this.state === 'decode' && this.mono) {
      return 4;
    }

    return INCOMING_BLOCK_DISPLAY[this.inBlock];
  }

  private writeControl(v: number): void {
    if ((v >>> 31) === 1) {
      this.softReset();
    }
    this.inReqEnable = (v >>> 30) === 1;
    this.outReqEnable = (v >>> 29) === 1;
  }

  private softReset(): void {
    this.state = 'idle';
    this.remainWords = 0;
    this.counter = 0;
    this.inFifoFull = false;
    this.depth = 0;
    this.signedOut = 0;
    this.bit15Out = 0;
    this.mono = false;
    this.inBlock = 0;
    this.rlePhase = 'needDct';
    this.rleK = 0;
    this.rleQscale = 0;
    this.quantBoth = false;
    this.fastIdct = this.scaleIsStandard();
    this.outCount = 0;
    this.outHead = 0;
    this.outTail = 0;
    this.initOutBookkeeping();
  }

  private initOutBookkeeping(): void {
    this.outMono = this.mono;
    this.outBlockIdx = 0;
    const wpb = this.outBlockWords();
    this.outBlockWpb = wpb;
    this.outMacroSize = this.mono ? wpb : 4 * wpb;
    this.outBlockLeft = wpb;
    this.outMacroLeft = this.outMacroSize;
  }

  private outBlockWords(): number {
    if (this.mono) {
      return this.depth === 1 ? BLOCK_WORDS_MONO_8BPP : BLOCK_WORDS_MONO_4BPP;
    }

    return this.depth === 3 ? BLOCK_WORDS_15BPP : BLOCK_WORDS_24BPP;
  }

  private feedWord(w: number): void {
    if (this.state === 'idle') {
      this.execCommand(w);

      return;
    }
    this.stepWord(w);
  }

  private activeQuant(): Uint8Array {
    if (!this.mono && this.inBlock <= 1) {
      return this.qtUV;
    }

    return this.qtY;
  }

  private execCommand(w: number): void {
    const cmd = (w >>> 29) & 7;
    this.depth = (w >>> 27) & 3;
    this.signedOut = (w >>> 26) & 1;
    this.bit15Out = (w >>> 25) & 1;
    this.inFifoFull = false;

    if (cmd === 1) {
      this.mono = this.depth <= 1;
      this.remainWords = w & 0xFFFF;
      this.counter = (this.remainWords - 1) & 0xFFFF;
      this.inBlock = 0;
      this.rlePhase = 'needDct';
      this.rleK = 0;
      if (this.outCount === 0) {
        this.initOutBookkeeping();
      } else if (this.outBlockWords() !== this.outBlockWpb) {
        this.log.warn('mdec', 'mdec depth changed while macroblock output still draining');
        this.initOutBookkeeping();
      }
      this.state = 'decode';

      return;
    }
    if (cmd === 2) {
      this.quantBoth = (w & 1) === 1;
      this.remainWords = this.quantBoth ? 32 : 16;
      this.counter = (this.remainWords - 1) & 0xFFFF;
      this.tableByte = 0;
      this.state = 'quantLum';

      return;
    }
    if (cmd === 3) {
      this.remainWords = 32;
      this.counter = 31;
      this.scaleHalf = 0;
      this.state = 'scale';

      return;
    }

    this.counter = w & 0xFFFF;
  }

  private stepWord(w: number): void {
    switch (this.state) {
      case 'decode':
        this.decodeHalf(w & 0xFFFF);
        this.decodeHalf(w >>> 16);
        break;
      case 'quantLum':
        this.stepQuantWord(w, this.qtY);
        if (this.tableByte === 0 && this.quantBoth) {
          this.state = 'quantUV';
        }
        break;
      case 'quantUV':
        this.stepQuantWord(w, this.qtUV);
        break;
      case 'scale':
        this.scaleTab[this.scaleHalf++] = sign16(w & 0xFFFF);
        this.scaleTab[this.scaleHalf++] = sign16(w >>> 16);
        break;
      case 'idle':
        return;
    }

    this.remainWords = (this.remainWords - 1) >>> 0;
    this.counter = (this.counter - 1) & 0xFFFF;
    if (this.remainWords === 0) {
      this.closeCommand();
    }
  }

  private stepQuantWord(w: number, into: Uint8Array): void {
    for (let k = 0; k < 4; k++) {
      into[this.tableByte] = (w >>> (k * 8)) & 0xFF;
      this.tableByte = (this.tableByte + 1) & 63;
    }
  }

  private closeCommand(): void {
    if (this.state === 'scale') {
      this.fastIdct = this.scaleIsStandard();
    }
    if (this.state === 'decode' && this.rlePhase === 'wantN') {
      if (this.rleK === 63) {
        this.completeBlock();
      } else {
        this.log.warn('mdec', 'mdec decode stream ended mid-block');
      }
    }
    this.state = 'idle';
    this.inFifoFull = true;
  }

  private scaleIsStandard(): boolean {
    for (let i = 0; i < 64; i++) {
      if (this.scaleTab[i] >> 3 !== sign16(STANDARD_SCALE[i]) >> 3) {
        return false;
      }
    }

    return true;
  }

  private decodeHalf(n: number): void {
    const h = n & 0xFFFF;
    if (this.rlePhase === 'needDct') {
      if (h === EOB_HALFWORD) {
        return;
      }
      this.blk.fill(0);
      this.rleQscale = (h >>> 10) & 0x3F;
      const dc = sign10(h & 0x3FF);
      this.rleK = 0;
      this.placeCoeff(0, this.rleQscale === 0 ? dc * 2 : dc * this.activeQuant()[0]);
      this.rlePhase = 'wantN';

      return;
    }

    const k2 = this.rleK + (((h >>> 10) & 0x3F) + 1);
    if (k2 > 63) {
      this.completeBlock();

      return;
    }
    this.rleK = k2;
    const raw = sign10(h & 0x3FF);
    const qs = this.rleQscale;
    this.placeCoeff(k2, qs === 0 ? raw * 2 : (raw * this.activeQuant()[k2] * qs + 4) >> 3);
  }

  private placeCoeff(scanK: number, val: number): void {
    const freq = this.rleQscale === 0 ? scanK : ZAGZIG[scanK];
    const clamped = minmaxInt(val, S11_MIN, S11_MAX);
    this.blk[freq] = this.fastIdct ? clamped * FACTOR_AT_FREQ[freq] : clamped;
  }

  private completeBlock(): void {
    this.rlePhase = 'needDct';
    this.rleK = 0;
    if (this.mono) {
      this.runIdct();
      this.pushMonoBlock();
      this.inBlock = 0;

      return;
    }
    switch (this.inBlock) {
      case 0:
        this.runIdct();
        this.crblk.set(this.blk);
        break;
      case 1:
        this.runIdct();
        this.cbblk.set(this.blk);
        break;
      case 2:
        this.runIdct();
        this.pushLumaQuad(0, 0);
        break;
      case 3:
        this.runIdct();
        this.pushLumaQuad(8, 0);
        break;
      case 4:
        this.runIdct();
        this.pushLumaQuad(0, 8);
        break;
      case 5:
        this.runIdct();
        this.pushLumaQuad(8, 8);
        break;
    }
    this.inBlock = (this.inBlock + 1) % 6;
  }

  private pushLumaQuad(qx: number, qy: number): void {
    if (this.depth === 2) {
      this.pushRgb24(qx, qy);
    } else {
      this.pushRgb15(qx, qy);
    }
  }

  private runIdct(): void {
    if (this.fastIdct) {
      this.idctPass(this.blk, this.idctScratch);
      this.idctPass(this.idctScratch, this.blk);

      return;
    }
    this.idctReal();
  }

  private idctPass(src: Float64Array, dst: Float64Array): void {
    for (let i = 0; i < 8; i++) {
      let columnOnlyDc = true;
      for (let j = 1; j < 8; j++) {
        if (src[j * 8 + i] !== 0) {
          columnOnlyDc = false;
          break;
        }
      }
      if (columnOnlyDc) {
        const d = src[i];
        for (let j = 0; j < 8; j++) {
          dst[i * 8 + j] = d;
        }
        continue;
      }

      let z10 = src[0 * 8 + i] + src[4 * 8 + i];
      let z11 = src[0 * 8 + i] - src[4 * 8 + i];
      let z13 = src[2 * 8 + i] + src[6 * 8 + i];
      let z12 = 1.414213562 * (src[2 * 8 + i] - src[6 * 8 + i]) - z13;
      const tmp0 = z10 + z13;
      const tmp3 = z10 - z13;
      const tmp1 = z11 + z12;
      const tmp2 = z11 - z12;
      z13 = src[3 * 8 + i] + src[5 * 8 + i];
      z10 = src[3 * 8 + i] - src[5 * 8 + i];
      z11 = src[1 * 8 + i] + src[7 * 8 + i];
      z12 = src[1 * 8 + i] - src[7 * 8 + i];
      const z5 = 1.847759065 * (z12 - z10);
      const tmp7 = z11 + z13;
      const tmp6 = 2.61312593 * z10 + z5 - tmp7;
      const tmp5 = 1.414213562 * (z11 - z13) - tmp6;
      const tmp4 = 1.0823922 * z12 - z5 + tmp5;
      dst[i * 8 + 0] = tmp0 + tmp7;
      dst[i * 8 + 7] = tmp0 - tmp7;
      dst[i * 8 + 1] = tmp1 + tmp6;
      dst[i * 8 + 6] = tmp1 - tmp6;
      dst[i * 8 + 2] = tmp2 + tmp5;
      dst[i * 8 + 5] = tmp2 - tmp5;
      dst[i * 8 + 4] = tmp3 + tmp4;
      dst[i * 8 + 3] = tmp3 - tmp4;
    }
  }

  private idctReal(): void {
    this.idctRealPass(this.blk, this.idctScratch);
    this.idctRealPass(this.idctScratch, this.blk);
  }

  private idctRealPass(src: Float64Array, dst: Float64Array): void {
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        let sum = 0;
        for (let z = 0; z < 8; z++) {
          sum += (src[y + z * 8] * this.scaleTab[x + z * 8]) / 8;
        }
        dst[x + y * 8] = Math.floor((sum + 0xFFF) / 0x2000);
      }
    }
  }

  private yChannel(x: number, y: number): number {
    return wrapSigned9(Math.round(this.blk[x + y * 8]));
  }

  private chromaIndex(x: number, y: number, qx: number, qy: number): number {
    return ((x + qx) >> 1) + (((y + qy) >> 1) << 3);
  }

  private pyInts(qx: number, qy: number): void {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const yy = this.yChannel(x, y);
        const ci = this.chromaIndex(x, y, qx, qy);
        const cr = this.crblk[ci];
        const cb = this.cbblk[ci];
        this.pxR[y * 8 + x] = Math.round(minmaxSigned8(yy + 1.402 * cr));
        this.pxG[y * 8 + x] = Math.round(minmaxSigned8(yy - 0.3437 * cb - 0.7143 * cr));
        this.pxB[y * 8 + x] = Math.round(minmaxSigned8(yy + 1.772 * cb));
      }
    }
  }

  private fiveBit(v: number): number {
    if (this.signedOut === 0) {
      return (((v + 128) & 0xFF) >>> 3) & 0x1F;
    }

    return v & 0x1F;
  }

  private byteOf(v: number): number {
    if (this.signedOut === 0) {
      return (v + 128) & 0xFF;
    }

    return v & 0xFF;
  }

  private pack15(r: number, g: number, b: number): number {
    const r5 = this.fiveBit(r);
    const g5 = this.fiveBit(g);
    const b5 = this.fiveBit(b);
    const bit15 = this.bit15Out === 1 ? 0x8000 : 0;

    return ((b5 << 10) | (g5 << 5) | r5 | bit15) & 0xFFFF;
  }

  private pushRgb15(qx: number, qy: number): void {
    this.pyInts(qx, qy);
    for (let y = 0; y < 8; y++) {
      const row = y * 8;
      for (let j = 0; j < 4; j++) {
        const i0 = row + j * 2;
        const i1 = i0 + 1;
        const h0 = this.pack15(this.pxR[i0], this.pxG[i0], this.pxB[i0]);
        const h1 = this.pack15(this.pxR[i1], this.pxG[i1], this.pxB[i1]);
        this.pushWord(h0 | (h1 << 16));
      }
    }
  }

  private pushRgb24(qx: number, qy: number): void {
    this.pyInts(qx, qy);
    for (let y = 0; y < 8; y++) {
      const row = y * 8;
      let bi = 0;
      for (let x = 0; x < 8; x++) {
        const i = row + x;
        this.rowBytes[bi++] = this.byteOf(this.pxR[i]);
        this.rowBytes[bi++] = this.byteOf(this.pxG[i]);
        this.rowBytes[bi++] = this.byteOf(this.pxB[i]);
      }
      for (let j = 0; j < 6; j++) {
        const k = j * 4;
        const b0 = this.rowBytes[k];
        const b1 = this.rowBytes[k + 1];
        const b2 = this.rowBytes[k + 2];
        const b3 = this.rowBytes[k + 3];
        this.pushWord(b0 | (b1 << 8) | (b2 << 16) | (b3 << 24));
      }
    }
  }

  private pushMonoBlock(): void {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        let py = minmaxSigned8(this.yChannel(x, y));
        if (this.signedOut === 0) {
          py = (py + 128) & 0xFF;
        } else {
          py = py & 0xFF;
        }
        this.rowBytes[x] = py;
      }
      if (this.depth === 1) {
        for (let j = 0; j < 2; j++) {
          const k = j * 4;
          const b0 = this.rowBytes[k];
          const b1 = this.rowBytes[k + 1];
          const b2 = this.rowBytes[k + 2];
          const b3 = this.rowBytes[k + 3];
          this.pushWord(b0 | (b1 << 8) | (b2 << 16) | (b3 << 24));
        }
      } else {
        let v = 0;
        for (let j = 0; j < 8; j++) {
          v |= (this.rowBytes[j] >>> 4) << (j * 4);
        }
        this.pushWord(v >>> 0);
      }
    }
  }

  private pushWord(v: number): void {
    if (this.outCount >= OUT_RING_WORDS) {
      if (!this.overflowLogged) {
        this.overflowLogged = true;
        this.log.error('mdec', 'mdec output fifo overflow, decoding continues, words dropped');
      }

      return;
    }
    this.outRing[this.outTail] = v >>> 0;
    this.outTail = (this.outTail + 1) & OUT_RING_MASK;
    this.outCount += 1;
  }

  private popOut(): number {
    if (this.outCount === 0) {
      return 0;
    }
    const w = this.outRing[this.outHead];
    this.outHead = (this.outHead + 1) & OUT_RING_MASK;
    this.outCount -= 1;

    if (this.outBlockLeft === 0) {
      this.outBlockIdx = (this.outBlockIdx + 1) & 3;
      this.outBlockLeft = this.outBlockWpb;
    }
    this.outBlockLeft -= 1;

    if (this.outMacroLeft === 0) {
      this.outBlockIdx = 0;
      this.outBlockLeft = this.outBlockWpb;
      this.outMacroLeft = this.outMacroSize;
    }
    this.outMacroLeft -= 1;

    return w >>> 0;
  }
}