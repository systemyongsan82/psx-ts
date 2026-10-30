import { SPU_RAM_SIZE, SPU_SAMPLE_CYCLES } from './contracts';
import type {
  AudioSink,
  DmaChannel,
  DmaConfig,
  IrqController,
  Logger,
  Scheduler,
  Spu,
  SpuXaIn,
} from './contracts';

const VOICES = 24;
const OUT_RING_FLOATS = 0x4000;
const CD_RING_FLOATS = 0x4000;
const FIFO_HALFWORDS = 32;
const BLOCK_SAMPLES = 28;
const BLOCK_BYTES = 16;
const BLOCK_MAX_POS = BLOCK_SAMPLES << 12;
const XA_PORTION_BYTES = 128;
const XA_PORTION_COUNT = 18;
const XA_DATA_BYTES = XA_PORTION_BYTES * XA_PORTION_COUNT;
const DAC_RATE = 44100;
const CD_RATE_37800 = 37800;
const CD_RATE_18900 = 18900;

const PH_ATTACK = 0;
const PH_DECAY = 1;
const PH_SUSTAIN = 2;
const PH_RELEASE = 3;
const PH_DONE = 4;

const XA_FILTER_POS: Array<number> = [0, 60, 115, 98, 122];
const XA_FILTER_NEG: Array<number> = [0, 0, -52, -55, -60];

const GAUSS: Int16Array = new Int16Array([
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3, 3,
  3, 4, 4, 5, 5, 6, 7, 7, 8, 9, 9, 10, 11, 12, 13, 14,
  15, 16, 17, 18, 19, 21, 22, 24, 25, 27, 28, 30, 32, 33, 35, 37,
  39, 41, 44, 46, 48, 51, 53, 56, 58, 61, 64, 67, 70, 73, 77, 80,
  84, 87, 91, 95, 99, 103, 107, 111, 116, 120, 125, 130, 135, 140, 145, 150,
  156, 161, 167, 173, 179, 186, 192, 199, 205, 212, 219, 227, 234, 242, 250, 257,
  266, 274, 283, 291, 300, 309, 319, 328, 338, 348, 358, 369, 379, 390, 401, 412,
  424, 436, 448, 460, 473, 485, 498, 512, 525, 539, 553, 567, 582, 597, 612, 627,
  643, 659, 675, 692, 708, 726, 743, 761, 779, 797, 816, 835, 854, 874, 894, 914,
  935, 956, 977, 999, 1020, 1043, 1066, 1089, 1112, 1136, 1160, 1184, 1209, 1234, 1260, 1286,
  1312, 1339, 1366, 1394, 1422, 1450, 1479, 1508, 1537, 1567, 1598, 1628, 1660, 1691, 1723, 1756,
  1789, 1822, 1856, 1890, 1924, 1959, 1995, 2031, 2067, 2104, 2141, 2179, 2217, 2256, 2295, 2334,
  2374, 2415, 2456, 2497, 2539, 2582, 2624, 2668, 2712, 2756, 2801, 2846, 2892, 2938, 2985, 3032,
  3079, 3128, 3176, 3225, 3275, 3325, 3376, 3427, 3479, 3531, 3584, 3637, 3691, 3745, 3799, 3855,
  3910, 3967, 4023, 4081, 4138, 4197, 4255, 4315, 4374, 4435, 4495, 4557, 4619, 4681, 4744, 4807,
  4871, 4935, 5000, 5065, 5131, 5197, 5264, 5332, 5399, 5468, 5536, 5606, 5676, 5746, 5817, 5888,
  5959, 6032, 6104, 6177, 6251, 6325, 6400, 6475, 6550, 6626, 6702, 6779, 6856, 6934, 7012, 7091,
  7170, 7249, 7329, 7409, 7490, 7571, 7653, 7735, 7817, 7900, 7983, 8066, 8150, 8234, 8319, 8404,
  8489, 8575, 8661, 8748, 8834, 8922, 9009, 9097, 9185, 9273, 9362, 9451, 9541, 9630, 9720, 9811,
  9901, 9992, 10083, 10174, 10266, 10358, 10450, 10542, 10635, 10727, 10820, 10913, 11007, 11100, 11194, 11288,
  11382, 11476, 11571, 11665, 11760, 11855, 11950, 12045, 12140, 12236, 12331, 12427, 12522, 12618, 12714, 12809,
  12905, 13001, 13097, 13193, 13289, 13385, 13481, 13577, 13673, 13769, 13865, 13961, 14056, 14152, 14248, 14343,
  14439, 14534, 14630, 14725, 14820, 14915, 15010, 15104, 15199, 15293, 15387, 15481, 15575, 15669, 15762, 15855,
  15948, 16041, 16133, 16226, 16317, 16409, 16500, 16592, 16682, 16773, 16863, 16953, 17042, 17131, 17220, 17308,
  17396, 17484, 17571, 17658, 17744, 17830, 17916, 18001, 18086, 18170, 18254, 18337, 18420, 18502, 18584, 18665,
  18746, 18826, 18905, 18985, 19063, 19141, 19219, 19295, 19372, 19447, 19522, 19597, 19671, 19744, 19816, 19888,
  19959, 20030, 20100, 20169, 20238, 20306, 20373, 20439, 20505, 20570, 20634, 20698, 20760, 20822, 20884, 20944,
  21004, 21063, 21121, 21178, 21235, 21290, 21345, 21399, 21452, 21505, 21556, 21607, 21657, 21706, 21754, 21801,
  21848, 21893, 21938, 21982, 22025, 22066, 22107, 22148, 22187, 22225, 22262, 22299, 22334, 22369, 22402, 22435,
  22467, 22498, 22527, 22556, 22584, 22611, 22637, 22662, 22686, 22709, 22731, 22752, 22772, 22791, 22809, 22826,
  22842, 22857, 22872, 22885, 22897, 22908, 22918, 22927, 22935, 22942, 22948, 22953, 22957, 22960, 22962, 22963,
]);

function sign16(v: number): number {
  return (v << 16) >> 16;
}

function clamp16(v: number): number {
  if (v > 32767) {
    return 32767;
  }
  if (v < -32768) {
    return -32768;
  }

  return v;
}

function decodeAdpcmSample(t: number, hdr: number, old: number, older: number): number {
  const storedShift = hdr & 0xF;
  const shifter = storedShift > 12 ? 3 : 12 - storedShift;
  let filter = (hdr >>> 4) & 0x7;
  if (filter > 4) {
    filter = 4;
  }

  const prediction = (XA_FILTER_POS[filter] * old + XA_FILTER_NEG[filter] * older + 32) >> 6;
  const sample = ((t << 12) >> shifter) + prediction;

  return clamp16(sample);
}

function volumeEffective(reg: number): number {
  return sign16((reg & 0x7FFF) << 1);
}

function applyVolume(sample: number, volume: number): number {
  return clamp16((sample * volume) >> 15);
}

function dmaWordCount(config: DmaConfig): number {
  if (config.mode === 'manual') {
    return config.blockCount > 0 ? config.blockCount : config.wordsPerBlock;
  }

  return config.wordsPerBlock * config.blockCount;
}

export class SpuCore implements Spu {
  readonly spuRam = new Uint8Array(SPU_RAM_SIZE);

  private readonly log: Logger;
  private readonly irq: IrqController;
  private readonly vVolL = new Int16Array(VOICES);
  private readonly vVolR = new Int16Array(VOICES);
  private readonly vPitch = new Uint16Array(VOICES);
  private readonly vStart = new Uint16Array(VOICES);
  private readonly vAdsr1 = new Uint16Array(VOICES);
  private readonly vAdsr2 = new Uint16Array(VOICES);
  private readonly vRepeat = new Uint16Array(VOICES);
  private readonly vBlockAddr = new Int32Array(VOICES);
  private readonly vSamplePos = new Int16Array(VOICES);
  private readonly vCounter = new Int32Array(VOICES);
  private readonly vSamples = new Int16Array(BLOCK_SAMPLES * VOICES);
  private readonly vHist = new Int16Array(4 * VOICES);
  private readonly vPrev1 = new Int16Array(VOICES);
  private readonly vPrev2 = new Int16Array(VOICES);
  private readonly vPhase = new Uint8Array(VOICES);
  private readonly vLevel = new Uint16Array(VOICES);
  private readonly vWait = new Int32Array(VOICES);
  private readonly vBaseStep = new Int32Array(VOICES);
  private readonly vStepCycles = new Int32Array(VOICES);
  private readonly vExpInc = new Uint8Array(VOICES);
  private readonly vExpDec = new Uint8Array(VOICES);
  private readonly vEnvOut = new Int16Array(VOICES);
  private readonly vCurOutL = new Int16Array(VOICES);
  private readonly vCurOutR = new Int16Array(VOICES);

  private mainVolL = 0;
  private mainVolR = 0;
  private revVolL = 0;
  private revVolR = 0;
  private cdVolL = 0;
  private cdVolR = 0;
  private extVolL = 0;
  private extVolR = 0;
  private unkDbcL = 0;
  private unkDbcR = 0;
  private reverbBase = 0;
  private irqAddrReg = 0;
  private xferAddrReg = 0;
  private xferByte = 0;
  private spuDtc = 0;
  private spucnt = 0;
  private statMode = 0;
  private irqFlag = false;
  private konLow = 0;
  private konHigh = 0;
  private koffLow = 0;
  private koffHigh = 0;
  private pmonLow = 1;
  private pmonHigh = 0;
  private nonLow = 0;
  private nonHigh = 0;
  private eonLow = 0;
  private eonHigh = 0;
  private endxLow = 0;
  private endxHigh = 0;
  private readonly reverbCfg = new Uint16Array(32);
  private readonly fifo = new Int16Array(FIFO_HALFWORDS);
  private fifoCount = 0;

  private noiseLevel = 0;
  private noiseTimer = 0;
  private accum = 0;
  private capturePos = 0;
  private cdCapL = 0;
  private cdCapR = 0;

  private readonly cdRing = new Int16Array(CD_RING_FLOATS);
  private cdWIdx = 0;
  private cdRIdx = 0;
  private cdCount = 0;
  private cdPos = 0;
  private cdRate = CD_RATE_37800;
  private cdL = 0;
  private cdR = 0;

  private readonly outRing = new Float32Array(OUT_RING_FLOATS);
  private outW = 0;
  private outR = 0;
  private outCount = 0;

  private readonly xaScratchL = new Int16Array(4 * BLOCK_SAMPLES);
  private readonly xaScratchR = new Int16Array(4 * BLOCK_SAMPLES);
  private readonly xaScratchMono = new Int16Array(8 * BLOCK_SAMPLES);
  private cdChainOldL = 0;
  private cdChainOlderL = 0;
  private cdChainOldR = 0;
  private cdChainOlderR = 0;

  private xa8BitWarned = false;
  private readonly _sink: AudioSink;

  readonly xaSink: SpuXaIn;

  constructor(sched: Scheduler, log: Logger, irq: IrqController) {
    this.log = log;
    this.irq = irq;
    const self = this;
    this.xaSink = {
      xaSector(channel: number, subheader: number, payload: Uint8Array): void {
        self.onXaSector(channel, subheader, payload);
      },
      cddaSector(payload: Uint8Array): void {
        self.onCdda(payload);
      },
    };
    const sinkObj: AudioSink = {
      get availableFrames(): number {
        return self.outCount;
      },
      read(dst: Float32Array, frames: number): void {
        self.readSamples(dst, frames);
      },
    };
    this._sink = sinkObj;
    let nextDue = sched.now + SPU_SAMPLE_CYCLES;
    const tickCb = (): void => {
      self.tick(SPU_SAMPLE_CYCLES);
      nextDue += SPU_SAMPLE_CYCLES;
      const from = nextDue - sched.now;
      sched.at(from > 0 ? from : 0, tickCb);
    };
    sched.at(SPU_SAMPLE_CYCLES, tickCb);
  }

  get sink(): AudioSink {
    return this._sink;
  }

  load32(addr: number): number {
    const lo = this.load16(addr);

    return (lo | (this.load16(addr + 2) << 16)) >>> 0;
  }

  load16(addr: number): number {
    const rel = addr & 0x3FF;
    if ((rel & 1) !== 0) {
      return 0;
    }

    if (rel < 0x180) {
      const v = rel >>> 4;

      switch (rel & 0xF) {
        case 0:
          return this.vVolL[v] & 0xFFFF;
        case 2:
          return this.vVolR[v] & 0xFFFF;
        case 4:
          return this.vPitch[v];
        case 6:
          return this.vStart[v];
        case 8:
          return this.vAdsr1[v];
        case 10:
          return this.vAdsr2[v];
        case 12:
          return this.vLevel[v];
        case 14:
          return this.vRepeat[v];
      }
    }

    if (rel >= 0x1C0 && rel < 0x200) {
      return this.reverbCfg[(rel - 0x1C0) >>> 1];
    }
    if (rel >= 0x200 && rel < 0x260) {
      const v = (rel - 0x200) >>> 2;
      if ((rel & 2) === 0) {
        return this.vCurOutL[v] & 0xFFFF;
      }

      return this.vCurOutR[v] & 0xFFFF;
    }

    switch (rel) {
      case 0x180:
        return this.mainVolL;
      case 0x182:
        return this.mainVolR;
      case 0x184:
        return this.revVolL;
      case 0x186:
        return this.revVolR;
      case 0x188:
        return this.konLow;
      case 0x18A:
        return this.konHigh;
      case 0x18C:
        return this.koffLow;
      case 0x18E:
        return this.koffHigh;
      case 0x190:
        return this.pmonLow;
      case 0x192:
        return this.pmonHigh;
      case 0x194:
        return this.nonLow;
      case 0x196:
        return this.nonHigh;
      case 0x198:
        return this.eonLow;
      case 0x19A:
        return this.eonHigh;
      case 0x19C:
        return this.endxLow;
      case 0x19E:
        return this.endxHigh;
      case 0x1A0:
        return 0;
      case 0x1A2:
        return this.reverbBase;
      case 0x1A4:
        return this.irqAddrReg;
      case 0x1A6:
        return this.xferAddrReg;
      case 0x1A8:
        return this.fifoPeek();
      case 0x1AA:
        return this.spucnt;
      case 0x1AC:
        return this.spuDtc;
      case 0x1AE:
        return this.buildSpuStat();
      case 0x1B0:
        return this.cdVolL;
      case 0x1B2:
        return this.cdVolR;
      case 0x1B4:
        return this.extVolL;
      case 0x1B6:
        return this.extVolR;
      case 0x1B8:
        return this.mainVolL;
      case 0x1BA:
        return this.mainVolR;
      case 0x1BC:
        return this.unkDbcL;
      case 0x1BE:
        return this.unkDbcR;
    }

    return 0;
  }

  load8(addr: number): number {
    const half = this.load16(addr & ~1);
    if ((addr & 1) === 0) {
      return half & 0xFF;
    }

    return (half >>> 8) & 0xFF;
  }

  store32(addr: number, value: number): void {
    this.store16(addr, value & 0xFFFF);
    this.store16(addr + 2, (value >>> 16) & 0xFFFF);
  }

  store16(addr: number, value: number): void {
    const rel = addr & 0x3FF;
    const val = value & 0xFFFF;
    if ((rel & 1) !== 0 || rel > 0x25F) {
      return;
    }

    if (rel < 0x180) {
      this.storeVoice(rel >>> 4, rel & 0xF, val);

      return;
    }

    if (rel >= 0x1C0 && rel < 0x200) {
      this.reverbCfg[(rel - 0x1C0) >>> 1] = val;

      return;
    }
    if (rel >= 0x200) {
      return;
    }

    switch (rel) {
      case 0x180:
        this.mainVolL = val;
        return;
      case 0x182:
        this.mainVolR = val;
        return;
      case 0x184:
        this.revVolL = val;
        return;
      case 0x186:
        this.revVolR = val;
        return;
      case 0x188:
      case 0x18A: {
        if (rel === 0x188) {
          this.konLow = val;
        } else {
          this.konHigh = val;
        }
        const bits = rel === 0x188 ? val : ((val << 16) >>> 0);
        this.keyOnWrite(bits);
        return;
      }
      case 0x18C:
      case 0x18E: {
        if (rel === 0x18C) {
          this.koffLow = val;
        } else {
          this.koffHigh = val;
        }
        const bits = rel === 0x18C ? val : ((val << 16) >>> 0);
        this.keyOffWrite(bits);
        return;
      }
      case 0x190:
        this.pmonLow = val;
        return;
      case 0x192:
        this.pmonHigh = val;
        return;
      case 0x194:
        this.nonLow = val;
        return;
      case 0x196:
        this.nonHigh = val;
        return;
      case 0x198:
        this.eonLow = val;
        return;
      case 0x19A:
        this.eonHigh = val;
        return;
      case 0x19C:
      case 0x19E:
        return;
      case 0x1A0:
        return;
      case 0x1A2:
        this.reverbBase = val;
        return;
      case 0x1A4:
        this.irqAddrReg = val;
        return;
      case 0x1A6:
        this.xferAddrReg = val;
        this.xferByte = (this.xferAddrReg << 3) & 0x7FFFF;
        return;
      case 0x1A8:
        this.fifoPush(val);
        return;
      case 0x1AA:
        this.writeSpuCnt(val);
        return;
      case 0x1AC:
        this.spuDtc = val;
        return;
      case 0x1AE:
        return;
      case 0x1B0:
        this.cdVolL = val;
        return;
      case 0x1B2:
        this.cdVolR = val;
        return;
      case 0x1B4:
        this.extVolL = val;
        return;
      case 0x1B6:
        this.extVolR = val;
        return;
      case 0x1BC:
        this.unkDbcL = val;
        return;
      case 0x1BE:
        this.unkDbcR = val;
        return;
    }
  }

  store8(addr: number, value: number): void {
    if ((addr & 1) === 0) {
      const prev = this.load16(addr);
      this.store16(addr, ((value << 8) | ((prev >>> 8) & 0xFF)) & 0xFFFF);
    }
  }

  dmaStart(channel: DmaChannel, config: DmaConfig, ram: Uint32Array): void {
    if (channel.id !== 4) {
      return;
    }

    const words = dmaWordCount(config);
    if (words <= 0) {
      this.irq.dmaDone(4);

      return;
    }

    if (config.direction === 'toDevice') {
      this.dmaToDevice(config, ram, words);
    } else {
      this.dmaToRam(config, ram, words);
    }
    this.irq.dmaDone(4);
  }

  tick(cycles: number): void {
    this.accum += cycles;
    while (this.accum >= SPU_SAMPLE_CYCLES) {
      this.accum -= SPU_SAMPLE_CYCLES;
      this.mixFrame();
    }
  }

  private storeVoice(v: number, off: number, value: number): void {
    switch (off) {
      case 0:
        this.vVolL[v] = value;
        return;
      case 2:
        this.vVolR[v] = value;
        return;
      case 4:
        this.vPitch[v] = value;
        return;
      case 6:
        this.vStart[v] = value;
        return;
      case 8:
        this.vAdsr1[v] = value;
        return;
      case 10:
        this.vAdsr2[v] = value;
        return;
      case 12:
        this.vLevel[v] = value & 0x7FFF;
        return;
      case 14:
        this.vRepeat[v] = value;
        return;
    }
  }

  private keyOnWrite(bits: number): void {
    if ((this.spucnt & 0x8000) === 0) {
      return;
    }

    for (let v = 0; v < VOICES; v++) {
      if ((bits & (1 << v)) !== 0) {
        this.keyOn(v);
      }
    }
  }

  private keyOn(v: number): void {
    this.vWait[v] = 0;
    this.vCounter[v] = 0;
    this.vSamplePos[v] = -1;
    this.vPrev1[v] = 0;
    this.vPrev2[v] = 0;
    this.vHist[(v << 2)] = 0;
    this.vHist[(v << 2) + 1] = 0;
    this.vHist[(v << 2) + 2] = 0;
    this.vHist[(v << 2) + 3] = 0;
    const start = this.vStart[v];
    this.vRepeat[v] = start;
    this.vBlockAddr[v] = (start << 3) & 0x7FFF0;
    this.vLevel[v] = 0;
    this.envEnter(v, PH_ATTACK);
    this.clearEndx(v);
    this.decodeBlock(v);
  }

  private keyOffWrite(bits: number): void {
    for (let v = 0; v < VOICES; v++) {
      if ((bits & (1 << v)) !== 0 && this.vPhase[v] < PH_RELEASE) {
        this.envEnter(v, PH_RELEASE);
      }
    }
  }

  private clearEndx(v: number): void {
    if (v < 16) {
      this.endxLow &= ~(1 << v) & 0xFFFF;
    } else {
      this.endxHigh &= ~(1 << (v - 16)) & 0xFFFF;
    }
  }

  private setEndx(v: number): void {
    if (v < 16) {
      this.endxLow |= (1 << v) & 0xFFFF;
    } else {
      this.endxHigh |= (1 << (v - 16)) & 0xFFFF;
    }
  }

  private envEnter(v: number, phase: number): void {
    const a1 = this.vAdsr1[v];
    const a2 = this.vAdsr2[v];
    this.vPhase[v] = phase;
    this.vWait[v] = 0;
    this.vExpInc[v] = 0;
    this.vExpDec[v] = 0;
    let step = 0;
    let shift = 0;
    if (phase === PH_ATTACK) {
      shift = (a1 >>> 10) & 0x1F;
      step = 7 - ((a1 >>> 8) & 3);
      this.vExpInc[v] = a1 >>> 15;
    } else if (phase === PH_DECAY) {
      shift = (a1 >>> 4) & 0xF;
      step = -8;
      this.vExpDec[v] = 1;
    } else if (phase === PH_SUSTAIN) {
      shift = (a2 >>> 8) & 0x1F;
      const stepVal = (a2 >>> 6) & 3;
      const decrease = (a2 >>> 14) & 1;
      if (decrease === 0) {
        step = 7 - stepVal;
        this.vExpInc[v] = a2 >>> 15;
      } else {
        step = -(8 - stepVal);
        this.vExpDec[v] = a2 >>> 15;
      }
    } else {
      shift = a2 & 0x1F;
      step = -8;
      this.vExpDec[v] = (a2 >>> 5) & 1;
    }

    this.vBaseStep[v] = step << Math.max(0, 11 - shift);
    this.vStepCycles[v] = 1 << Math.max(0, shift - 11);
  }

  private envStep(v: number): void {
    if (this.vPhase[v] === PH_DONE) {
      return;
    }

    if (this.vWait[v] > 0) {
      this.vWait[v]--;
      return;
    }

    const base = this.vBaseStep[v];
    let step = base;
    if (this.vExpDec[v] === 1) {
      step = (base * this.vLevel[v]) >> 15;
      if (step === 0 && base < 0 && this.vLevel[v] > 0) {
        step = -1;
      }
    }

    let cycles = this.vStepCycles[v];
    if (this.vExpInc[v] === 1 && this.vLevel[v] > 0x6000) {
      cycles *= 4;
    }

    let next = this.vLevel[v] + step;
    if (next > 0x7FFF) {
      next = 0x7FFF;
    }
    if (next < 0) {
      next = 0;
    }
    this.vLevel[v] = next;
    this.vWait[v] = cycles;

    if (this.vPhase[v] === PH_RELEASE && next === 0) {
      this.vPhase[v] = PH_DONE;
      return;
    }
    if (this.vPhase[v] === PH_ATTACK && next >= 0x7FFF) {
      this.envEnter(v, PH_DECAY);
      return;
    }
    if (this.vPhase[v] === PH_DECAY) {
      const sl = ((this.vAdsr1[v] & 0xF) + 1) << 11;
      if (next <= sl) {
        this.vLevel[v] = Math.min(sl, 0x7FFF);
        this.envEnter(v, PH_SUSTAIN);
      }
    }
  }

  private decodeBlock(v: number): void {
    const base = this.vBlockAddr[v] & 0x7FFF0;
    const irqByte = (this.irqAddrReg << 3) >>> 0;
    if (this.irqAddrReg !== 0 && irqByte >= base && irqByte < base + BLOCK_BYTES) {
      this.raiseIrq9();
    }
    const hdr = this.spuRam[base];
    const flagsByte = this.spuRam[(base + 1) & 0x7FFFF];
    if ((flagsByte & 2) !== 0) {
      this.vRepeat[v] = (base >>> 3) & 0xFFFF;
    }

    for (let j = 0; j < BLOCK_SAMPLES; j++) {
      const b = this.spuRam[(base + 2 + (j >>> 1)) & 0x7FFFF];
      const nib = (j & 1) === 0 ? b & 0xF : b >>> 4;
      const t = (nib << 28) >> 28;
      const s = decodeAdpcmSample(t, hdr, this.vPrev1[v], this.vPrev2[v]);
      this.vSamples[v * BLOCK_SAMPLES + j] = s;
      this.vPrev2[v] = this.vPrev1[v];
      this.vPrev1[v] = s;
    }
  }

  private finishBlock(v: number): void {
    const base = this.vBlockAddr[v];
    const flagsByte = this.spuRam[(base + 1) & 0x7FFFF];
    if ((flagsByte & 1) !== 0) {
      this.setEndx(v);
      if ((flagsByte & 2) === 0) {
        this.vLevel[v] = 0;
        this.envEnter(v, PH_RELEASE);
      }
      this.vBlockAddr[v] = (this.vRepeat[v] << 3) & 0x7FFF0;
    } else {
      this.vBlockAddr[v] = (base + BLOCK_BYTES) & 0x7FFFF;
    }
    this.vSamplePos[v] = -1;
    this.decodeBlock(v);
  }

  private advanceVoice(v: number): void {
    let pitch = this.vPitch[v];
    if (v > 0) {
      const pmBit = v < 16 ? this.pmonLow & (1 << v) : this.pmonHigh & (1 << (v - 16));
      if (pmBit !== 0) {
        const factor = this.vEnvOut[v - 1] + 0x8000;
        const signed = (pitch << 16) >> 16;
        pitch = ((signed * factor) >> 15) & 0xFFFF;
      }
    }
    const step = pitch > 0x3FFF ? 0x4000 : pitch;

    let counter = this.vCounter[v] + step;
    while (counter >= BLOCK_MAX_POS) {
      counter = (counter - BLOCK_MAX_POS) | 0;
      this.finishBlock(v);
    }
    this.vCounter[v] = counter;

    const newPos = counter >>> 12;
    while (this.vSamplePos[v] < newPos) {
      this.vSamplePos[v]++;
      this.pushHist(v, this.vSamples[v * BLOCK_SAMPLES + this.vSamplePos[v]]);
    }
  }

  private pushHist(v: number, s: number): void {
    const h = v << 2;
    this.vHist[h + 3] = this.vHist[h + 2];
    this.vHist[h + 2] = this.vHist[h + 1];
    this.vHist[h + 1] = this.vHist[h];
    this.vHist[h] = s;
  }

  private gaussOut(v: number): number {
    const h = v << 2;
    const i = (this.vCounter[v] >>> 4) & 0xFF;
    const oldest = this.vHist[h + 3];
    const older = this.vHist[h + 2];
    const old = this.vHist[h + 1];
    const newest = this.vHist[h];
    const out =
      ((GAUSS[0xFF - i] * oldest) >> 15) +
      ((GAUSS[0x1FF - i] * older) >> 15) +
      ((GAUSS[0x100 + i] * old) >> 15) +
      ((GAUSS[i] * newest) >> 15);

    return clamp16(out);
  }

  private noiseUpdate(): void {
    const noiseShift = (this.spucnt >>> 10) & 0xF;
    const step = 4 + ((this.spucnt >>> 8) & 3);
    this.noiseTimer -= step;
    if (this.noiseTimer < 0) {
      const lvl = this.noiseLevel & 0xFFFF;
      const parity = ((lvl >>> 15) ^ (lvl >>> 12) ^ (lvl >>> 11) ^ (lvl >>> 10) ^ 1) & 1;
      this.noiseLevel = (((lvl << 1) + parity) & 0xFFFF);
      this.noiseTimer += 0x20000 >> noiseShift;
      if (this.noiseTimer < 0) {
        this.noiseTimer += 0x20000 >> noiseShift;
      }
    }
  }

  private mixFrame(): void {
    this.statMode = this.spucnt & 0x3F;
    let accL = 0;
    let accR = 0;
    if ((this.spucnt & 0x8000) !== 0) {
      this.noiseUpdate();
      for (let v = 0; v < VOICES; v++) {
        this.advanceVoice(v);
        this.envStep(v);
        const nz = v < 16 ? this.nonLow & (1 << v) : this.nonHigh & (1 << (v - 16));
        const raw = nz !== 0 ? sign16(this.noiseLevel) : this.gaussOut(v);
        const envOut = applyVolume(raw, this.vLevel[v]);
        this.vEnvOut[v] = envOut;
        const outL = (envOut * volumeEffective(this.vVolL[v])) >> 15;
        const outR = (envOut * volumeEffective(this.vVolR[v])) >> 15;
        this.vCurOutL[v] = clamp16(outL);
        this.vCurOutR[v] = clamp16(outR);
        accL += this.vCurOutL[v];
        accR += this.vCurOutR[v];
      }
    }

    this.consumeCdInput();
    if ((this.spucnt & 1) === 1) {
      accL += (this.cdL * sign16(this.cdVolL)) >> 15;
      accR += (this.cdR * sign16(this.cdVolR)) >> 15;
    }

    const muted = (this.spucnt & 0x4000) === 0;
    const outL = muted ? 0 : clamp16((accL * volumeEffective(this.mainVolL)) >> 15);
    const outR = muted ? 0 : clamp16((accR * volumeEffective(this.mainVolR)) >> 15);

    const w = this.outW;
    this.outRing[w] = outL / 32768;
    this.outRing[w + 1] = outR / 32768;
    this.outW = (w + 2) & (OUT_RING_FLOATS - 1);
    if (this.outCount >= OUT_RING_FLOATS >> 1) {
      this.outR = (this.outR + 2) & (OUT_RING_FLOATS - 1);
    } else {
      this.outCount++;
    }

    this.updateCaptures();
  }

  private consumeCdInput(): void {
    let pos = this.cdPos + this.cdRate;
    let consumed = false;
    while (pos >= DAC_RATE && this.cdCount > 0) {
      pos -= DAC_RATE;
      const l = this.cdRing[this.cdRIdx];
      const r = this.cdRing[this.cdRIdx + 1];
      this.cdRIdx = (this.cdRIdx + 2) & (CD_RING_FLOATS - 1);
      this.cdCount--;
      this.cdL = l;
      this.cdR = r;
      consumed = true;
    }
    if (pos >= DAC_RATE * 4) {
      pos = DAC_RATE - 1;
    }
    this.cdPos = pos;
    if (consumed) {
      this.cdCapL = this.cdL;
      this.cdCapR = this.cdR;
    }
  }

  private updateCaptures(): void {
    if ((this.spuDtc & 0x0C) === 0) {
      return;
    }

    const pos = (this.capturePos & 0x1FF) << 1;
    this.spuRam[pos] = this.cdCapL & 0xFF;
    this.spuRam[pos + 1] = (this.cdCapL >>> 8) & 0xFF;
    this.spuRam[0x400 + pos] = this.cdCapR & 0xFF;
    this.spuRam[0x401 + pos] = (this.cdCapR >>> 8) & 0xFF;
    const v1 = this.vEnvOut[1];
    const v3 = this.vEnvOut[3];
    this.spuRam[0x800 + pos] = v1 & 0xFF;
    this.spuRam[0x801 + pos] = (v1 >>> 8) & 0xFF;
    this.spuRam[0xC00 + pos] = v3 & 0xFF;
    this.spuRam[0xC01 + pos] = (v3 >>> 8) & 0xFF;

    this.capturePos = (this.capturePos + 1) & 0x3FF;
    if ((this.capturePos & 0x1FF) === 0) {
      this.captureIrqCheck();
    }
  }

  private captureIrqCheck(): void {
    if (this.irqAddrReg > 0 && this.irqAddrReg <= 0x1FF) {
      this.raiseIrq9();
    }
  }

  private raiseIrq9(): void {
    if ((this.spucnt & 0x8040) !== 0x8040) {
      return;
    }

    this.irqFlag = true;
    this.irq.raise(9);
  }

  private buildSpuStat(): number {
    const mode = (this.spucnt >>> 4) & 3;
    let stat = this.statMode & 0x3F;
    if (this.irqFlag) {
      stat |= 0x40;
    }
    if (mode === 2) {
      stat |= 0x180;
    } else if (mode === 3) {
      stat |= 0x280;
    }
    if (this.fifoCount > 0 && mode === 1) {
      stat |= 0x400;
    }
    if ((this.capturePos & 0x200) !== 0) {
      stat |= 0x800;
    }

    return stat;
  }

  private fifoPeek(): number {
    if (this.fifoCount === 0) {
      return 0;
    }

    return this.fifo[this.fifoCount - 1] & 0xFFFF;
  }

  private fifoPush(value: number): void {
    if (((this.spucnt >>> 4) & 3) === 1) {
      this.writeSpuRamHalf(value);

      return;
    }
    if (this.fifoCount >= FIFO_HALFWORDS) {
      return;
    }

    this.fifo[this.fifoCount] = value;
    this.fifoCount++;
  }

  private writeSpuCnt(value: number): void {
    const prevMode = (this.spucnt >>> 4) & 3;
    const nowMode = (value >>> 4) & 3;
    this.spucnt = value;
    if ((value & 0x40) === 0) {
      this.irqFlag = false;
    }
    if ((value & 0x8000) === 0) {
      for (let v = 0; v < VOICES; v++) {
        this.vPhase[v] = PH_DONE;
        this.vLevel[v] = 0;
        this.vWait[v] = 0;
      }
    }
    if (nowMode === 1 && prevMode !== 1 && this.fifoCount > 0) {
      this.fifoFlush();
    }
  }

  private fifoFlush(): void {
    const type = (this.spuDtc >>> 1) & 7;
    if (this.fifoCount === 0) {
      return;
    }

    if (type === 0 || type === 1 || type === 6 || type === 7) {
      const last = this.fifo[this.fifoCount - 1];
      for (let i = 0; i < this.fifoCount; i++) {
        this.writeSpuRamHalf(last);
      }
    } else {
      for (let i = 0; i < this.fifoCount; i++) {
        const h = this.fifo[i];
        if (type === 2) {
          this.writeSpuRamHalf(h);
        } else if (type === 3) {
          if ((i & 1) === 0) {
            this.writeSpuRamHalf(h);
            this.writeSpuRamHalf(h);
          }
        } else if (type === 4) {
          if ((i & 3) === 0) {
            this.writeSpuRamHalf(h);
            this.writeSpuRamHalf(h);
            this.writeSpuRamHalf(h);
            this.writeSpuRamHalf(h);
          }
        } else if ((i & 3) === 3) {
          for (let k = 0; k < 8; k++) {
            this.writeSpuRamHalf(h);
          }
        }
      }
    }

    this.fifoCount = 0;
  }

  private writeSpuRamHalf(half: number): void {
    const p = this.xferByte;
    this.spuRam[p & 0x7FFFF] = half & 0xFF;
    this.spuRam[(p + 1) & 0x7FFFF] = (half >>> 8) & 0xFF;
    this.xferByte = (p + 2) & 0x7FFFF;
  }

  private readSpuRamHalf(addr: number): number {
    const p = addr & 0x7FFFF;

    return this.spuRam[p] | (this.spuRam[(p + 1) & 0x7FFFF] << 8);
  }

  private dmaToDevice(config: DmaConfig, ram: Uint32Array, words: number): void {
    const type = (this.spuDtc >>> 1) & 7;
    const startByte = this.xferByte;
    const srcBase = config.base >>> 2;
    const fill = type === 0 || type === 1 || type === 6 || type === 7;
    const fillValue = fill ? ((ram[srcBase + words - 1] >>> 16) & 0xFFFF) : 0;

    for (let i = 0; i < words; i++) {
      const w = ram[srcBase + i] >>> 0;
      const lo = w & 0xFFFF;
      const hi = (w >>> 16) & 0xFFFF;
      if (fill) {
        this.writeSpuRamHalf(fillValue);
        this.writeSpuRamHalf(fillValue);
      } else if (type === 2) {
        this.writeSpuRamHalf(lo);
        this.writeSpuRamHalf(hi);
      } else if (type === 3) {
        this.writeSpuRamHalf(lo);
        this.writeSpuRamHalf(lo);
      } else if (type === 4) {
        if ((i & 1) === 0) {
          this.writeSpuRamHalf(lo);
          this.writeSpuRamHalf(lo);
          this.writeSpuRamHalf(lo);
          this.writeSpuRamHalf(lo);
        }
      } else if ((i & 3) === 3) {
        this.writeSpuRamHalf(hi);
        this.writeSpuRamHalf(hi);
        this.writeSpuRamHalf(hi);
        this.writeSpuRamHalf(hi);
        this.writeSpuRamHalf(hi);
        this.writeSpuRamHalf(hi);
        this.writeSpuRamHalf(hi);
        this.writeSpuRamHalf(hi);
      }
    }

    this.irqCrossCheck(startByte, words * 4);
  }

  private dmaToRam(config: DmaConfig, ram: Uint32Array, words: number): void {
    const type = (this.spuDtc >>> 1) & 7;
    const startByte = this.xferByte;
    const srcBase = config.base >>> 2;
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < words; i++) {
      if (type === 3) {
        if ((i & 1) === 0) {
          lo = this.readSpuRamHalf(this.xferByte);
          this.xferByte = (this.xferByte + 2) & 0x7FFFF;
        }
        hi = lo;
      } else if (type === 4) {
        if ((i & 3) === 0) {
          lo = this.readSpuRamHalf(this.xferByte);
          this.xferByte = (this.xferByte + 2) & 0x7FFFF;
        }
        hi = lo;
      } else if (type === 5) {
        if ((i & 7) === 0) {
          lo = this.readSpuRamHalf(this.xferByte);
          this.xferByte = (this.xferByte + 2) & 0x7FFFF;
        }
        hi = lo;
      } else {
        lo = this.readSpuRamHalf(this.xferByte);
        hi = this.readSpuRamHalf((this.xferByte + 2) & 0x7FFFF);
        this.xferByte = (this.xferByte + 4) & 0x7FFFF;
      }
      ram[srcBase + i] = ((lo | (hi << 16)) >>> 0);
    }

    this.irqCrossCheck(startByte, words * 4);
  }

  private irqCrossCheck(startByte: number, bytes: number): void {
    if (this.irqAddrReg === 0) {
      return;
    }

    const irqByte = (this.irqAddrReg << 3) >>> 0;
    if (irqByte >= startByte && irqByte < startByte + bytes) {
      this.raiseIrq9();
    }
  }

  private onXaSector(channel: number, subheader: number, payload: Uint8Array): void {
    void channel;
    const coding = (subheader >>> 24) & 0xFF;
    if (((coding >>> 4) & 3) !== 0) {
      if (!this.xa8BitWarned) {
        this.log.warn('spu', 'XA 8-bit ADPCM unsupported, sector dropped');
        this.xa8BitWarned = true;
      }

      return;
    }

    const stereo = (coding & 3) === 1;
    this.cdRate = ((coding >>> 2) & 1) === 1 ? CD_RATE_18900 : CD_RATE_37800;
    const portions = payload.length >= XA_DATA_BYTES ? XA_PORTION_COUNT : payload.length >>> 7;
    let monoOld = 0;
    let monoOlder = 0;

    for (let p = 0; p < portions; p++) {
      const off = p * XA_PORTION_BYTES;
      if (stereo) {
        let chainOldL = this.cdChainOldL;
        let chainOlderL = this.cdChainOlderL;
        for (let i = 0; i < 4; i++) {
          const hdr = payload[off + 4 + i * 2];
          for (let j = 0; j < BLOCK_SAMPLES; j++) {
            const w = xaWord(payload, off + 16 + j * 4);
            const nib = (w >>> (i * 8)) & 0xF;
            const t = (nib << 28) >> 28;
            const s = decodeAdpcmSample(t, hdr, chainOldL, chainOlderL);
            this.xaScratchL[i * BLOCK_SAMPLES + j] = s;
            chainOlderL = chainOldL;
            chainOldL = s;
          }
        }
        this.cdChainOldL = chainOldL;
        this.cdChainOlderL = chainOlderL;
        let chainOldR = this.cdChainOldR;
        let chainOlderR = this.cdChainOlderR;
        for (let i = 0; i < 4; i++) {
          const hdr = payload[off + 5 + i * 2];
          for (let j = 0; j < BLOCK_SAMPLES; j++) {
            const w = xaWord(payload, off + 16 + j * 4);
            const nib = (w >>> (i * 8 + 4)) & 0xF;
            const t = (nib << 28) >> 28;
            const s = decodeAdpcmSample(t, hdr, chainOldR, chainOlderR);
            this.xaScratchR[i * BLOCK_SAMPLES + j] = s;
            chainOlderR = chainOldR;
            chainOldR = s;
          }
        }
        this.cdChainOldR = chainOldR;
        this.cdChainOlderR = chainOlderR;
        for (let j = 0; j < 4 * BLOCK_SAMPLES; j++) {
          this.pushCdSample(this.xaScratchL[j], this.xaScratchR[j]);
        }
      } else {
        const monoScratch = this.xaScratchMono;
        let n = 0;
        for (let i = 0; i < 8; i++) {
          const hdr = payload[off + 4 + i];
          for (let j = 0; j < BLOCK_SAMPLES; j++) {
            const w = xaWord(payload, off + 16 + j * 4);
            const nib = (w >>> (i * 4)) & 0xF;
            const t = (nib << 28) >> 28;
            const s = decodeAdpcmSample(t, hdr, monoOld, monoOlder);
            monoScratch[n++] = s;
            monoOlder = monoOld;
            monoOld = s;
          }
        }
        for (let m = 0; m < 8 * BLOCK_SAMPLES; m++) {
          const s = monoScratch[m];
          this.pushCdSample(s, s);
        }
      }
    }
  }

  private pushCdSample(l: number, r: number): void {
    if (this.cdCount >= CD_RING_FLOATS >> 1) {
      return;
    }

    const w = this.cdWIdx;
    this.cdRing[w] = l;
    this.cdRing[w + 1] = r;
    this.cdWIdx = (w + 2) & (CD_RING_FLOATS - 1);
    this.cdCount++;
  }

  private onCdda(payload: Uint8Array): void {
    const frames = payload.length >>> 2;
    for (let f = 0; f < frames; f++) {
      const o = f << 2;
      const l = (payload[o] | (payload[o + 1] << 8)) << 16 >> 16;
      const r = (payload[o + 2] | (payload[o + 3] << 8)) << 16 >> 16;
      this.pushCdSample(l, r);
    }
  }

  readSamples(dst: Float32Array, frames: number): void {
    const limit = Math.min(frames, dst.length >>> 1, this.outCount);
    let o = 0;
    for (let i = 0; i < limit; i++) {
      dst[o] = this.outRing[this.outR];
      dst[o + 1] = this.outRing[(this.outR + 1) & (OUT_RING_FLOATS - 1)];
      o += 2;
      this.outR = (this.outR + 2) & (OUT_RING_FLOATS - 1);
    }
    this.outCount -= limit;
    if (o < dst.length) {
      dst.fill(0, o);
    }
  }
}

function xaWord(payload: Uint8Array, off: number): number {
  return (payload[off] | (payload[off + 1] << 8) | (payload[off + 2] << 16) | (payload[off + 3] << 24)) >>> 0;
}