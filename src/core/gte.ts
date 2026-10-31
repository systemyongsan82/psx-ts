import type { GteUnit } from './contracts';

const FLAG_ERROR = 0x7F87E000;
const MAC_POS_MAX = 0x7FFFFFFFFFF;
const MAC_NEG_MIN = -0x80000000000;

const UNR = new Uint8Array([
  0xFF, 0xFD, 0xFB, 0xF9, 0xF7, 0xF5, 0xF3, 0xF1, 0xEF, 0xEE, 0xEC, 0xEA, 0xE8, 0xE6, 0xE4, 0xE3,
  0xE1, 0xDF, 0xDD, 0xDC, 0xDA, 0xD8, 0xD6, 0xD5, 0xD3, 0xD1, 0xD0, 0xCE, 0xCD, 0xCB, 0xC9, 0xC8,
  0xC6, 0xC5, 0xC3, 0xC1, 0xC0, 0xBE, 0xBD, 0xBB, 0xBA, 0xB8, 0xB7, 0xB5, 0xB4, 0xB2, 0xB1, 0xB0,
  0xAE, 0xAD, 0xAB, 0xAA, 0xA9, 0xA7, 0xA6, 0xA4, 0xA3, 0xA2, 0xA0, 0x9F, 0x9E, 0x9C, 0x9B, 0x9A,
  0x99, 0x97, 0x96, 0x95, 0x94, 0x92, 0x91, 0x90, 0x8F, 0x8D, 0x8C, 0x8B, 0x8A, 0x89, 0x87, 0x86,
  0x85, 0x84, 0x83, 0x82, 0x81, 0x7F, 0x7E, 0x7D, 0x7C, 0x7B, 0x7A, 0x79, 0x78, 0x77, 0x75, 0x74,
  0x73, 0x72, 0x71, 0x70, 0x6F, 0x6E, 0x6D, 0x6C, 0x6B, 0x6A, 0x69, 0x68, 0x67, 0x66, 0x65, 0x64,
  0x63, 0x62, 0x61, 0x60, 0x5F, 0x5E, 0x5D, 0x5D, 0x5C, 0x5B, 0x5A, 0x59, 0x58, 0x57, 0x56, 0x55,
  0x54, 0x53, 0x53, 0x52, 0x51, 0x50, 0x4F, 0x4E, 0x4D, 0x4D, 0x4C, 0x4B, 0x4A, 0x49, 0x48, 0x48,
  0x47, 0x46, 0x45, 0x44, 0x43, 0x43, 0x42, 0x41, 0x40, 0x3F, 0x3F, 0x3E, 0x3D, 0x3C, 0x3C, 0x3B,
  0x3A, 0x39, 0x39, 0x38, 0x37, 0x36, 0x36, 0x35, 0x34, 0x33, 0x33, 0x32, 0x31, 0x31, 0x30, 0x2F,
  0x2E, 0x2E, 0x2D, 0x2C, 0x2C, 0x2B, 0x2A, 0x2A, 0x29, 0x28, 0x28, 0x27, 0x26, 0x26, 0x25, 0x24,
  0x24, 0x23, 0x22, 0x22, 0x21, 0x20, 0x20, 0x1F, 0x1E, 0x1E, 0x1D, 0x1D, 0x1C, 0x1B, 0x1B, 0x1A,
  0x19, 0x19, 0x18, 0x18, 0x17, 0x16, 0x16, 0x15, 0x15, 0x14, 0x14, 0x13, 0x12, 0x12, 0x11, 0x11,
  0x10, 0x0F, 0x0F, 0x0E, 0x0E, 0x0D, 0x0D, 0x0C, 0x0C, 0x0B, 0x0A, 0x0A, 0x09, 0x09, 0x08, 0x08,
  0x07, 0x07, 0x06, 0x06, 0x05, 0x05, 0x04, 0x04, 0x03, 0x03, 0x02, 0x02, 0x01, 0x01, 0x00, 0x00,
  0x00,
]);

function s16(v: number): number {
  return (v << 16) >> 16;
}

const CYCLES = new Uint8Array(64);
{
  CYCLES[0x01] = 15;
  CYCLES[0x06] = 8;
  CYCLES[0x0C] = 6;
  CYCLES[0x10] = 8;
  CYCLES[0x11] = 8;
  CYCLES[0x12] = 8;
  CYCLES[0x13] = 19;
  CYCLES[0x14] = 13;
  CYCLES[0x16] = 44;
  CYCLES[0x1B] = 17;
  CYCLES[0x1C] = 11;
  CYCLES[0x1E] = 14;
  CYCLES[0x20] = 30;
  CYCLES[0x28] = 5;
  CYCLES[0x29] = 8;
  CYCLES[0x2A] = 17;
  CYCLES[0x2D] = 5;
  CYCLES[0x2E] = 6;
  CYCLES[0x30] = 23;
  CYCLES[0x3D] = 5;
  CYCLES[0x3E] = 5;
  CYCLES[0x3F] = 39;
}

export function gteCycles(instr: number): number {
  if ((instr >>> 25) !== 0x25) {
    return 4;
  }
  const c = CYCLES[instr & 0x3F];

  return c === 0 ? 1 : c;
}

export class Gte implements GteUnit {
  private flag = 0;
  private vec = new Array<number>(9).fill(0);
  private sxy = new Array<number>(6).fill(0);
  private sz = new Array<number>(4).fill(0);
  private rgb = new Array<number>(3).fill(0);
  private ir = new Array<number>(4).fill(0);
  private mac = new Array<number>(4).fill(0);
  private rt = new Array<number>(9).fill(0);
  private llm = new Array<number>(9).fill(0);
  private lcm = new Array<number>(9).fill(0);
  private bogusM = new Array<number>(9).fill(0);
  private rgbc = 0;
  private trx = 0;
  private tryy = 0;
  private trz = 0;
  private rbk = 0;
  private gbk = 0;
  private bbk = 0;
  private rfc = 0;
  private gfc = 0;
  private bfc = 0;
  private ofx = 0;
  private ofy = 0;
  private h = 0;
  private dqa = 0;
  private dqb = 0;
  private zsf3 = 0;
  private zsf4 = 0;
  private otz = 0;
  private irgb = 0;
  private lzcs = 0;
  private res1 = 0;

  constructor() {}

  cop2(instr: number, gprValue: number): number {
    const primary = (instr >>> 26) & 0x3F;
    if (primary === 0x32) {
      this.writeData((instr >>> 16) & 0x1F, gprValue);

      return 0;
    }
    if (primary === 0x3A) {
      return this.readData((instr >>> 16) & 0x1F);
    }
    const rs = (instr >>> 21) & 0x1F;
    if (rs === 0x00) {
      return this.readData((instr >>> 11) & 0x1F);
    }
    if (rs === 0x02) {
      return this.readCnt((instr >>> 11) & 0x1F);
    }
    if (rs === 0x04) {
      this.writeData((instr >>> 11) & 0x1F, gprValue);

      return 0;
    }
    if (rs === 0x06) {
      this.writeCnt((instr >>> 11) & 0x1F, gprValue);

      return 0;
    }
    if ((rs & 0x10) !== 0) {
      this.execute(instr & 0x3F, (instr >>> 19) & 1, (instr >>> 10) & 1, instr);
    }

    return 0;
  }

  private readData(i: number): number {
    switch (i) {
      case 0:
        return (this.vec[1] << 16) | (this.vec[0] & 0xFFFF);
      case 1:
        return this.vec[2];
      case 2:
        return (this.vec[4] << 16) | (this.vec[3] & 0xFFFF);
      case 3:
        return this.vec[5];
      case 4:
        return (this.vec[7] << 16) | (this.vec[6] & 0xFFFF);
      case 5:
        return this.vec[8];
      case 6:
        return this.rgbc;
      case 7:
        return this.otz;
      case 8:
        return this.ir[0];
      case 9:
        return this.ir[1];
      case 10:
        return this.ir[2];
      case 11:
        return this.ir[3];
      case 12:
        return (this.sxy[1] << 16) | (this.sxy[0] & 0xFFFF);
      case 13:
        return (this.sxy[3] << 16) | (this.sxy[2] & 0xFFFF);
      case 14:
      case 15:
        return (this.sxy[5] << 16) | (this.sxy[4] & 0xFFFF);
      case 16:
        return this.sz[0];
      case 17:
        return this.sz[1];
      case 18:
        return this.sz[2];
      case 19:
        return this.sz[3];
      case 20:
        return this.rgb[0];
      case 21:
        return this.rgb[1];
      case 22:
        return this.rgb[2];
      case 23:
        return this.res1;
      case 24:
        return this.mac[0];
      case 25:
        return this.mac[1];
      case 26:
        return this.mac[2];
      case 27:
        return this.mac[3];
      case 28:
        return this.irgb;
      case 29:
        return (
          (this.orComponent(this.ir[3]) << 10) |
          (this.orComponent(this.ir[2]) << 5) |
          this.orComponent(this.ir[1])
        );
      case 30:
        return this.lzcs;
      default:
        return this.lzcrCount(this.lzcs);
    }
  }

  private writeData(i: number, v: number): void {
    switch (i) {
      case 0:
        this.vec[0] = s16(v);
        this.vec[1] = s16(v >>> 16);
        break;
      case 1:
        this.vec[2] = s16(v);
        break;
      case 2:
        this.vec[3] = s16(v);
        this.vec[4] = s16(v >>> 16);
        break;
      case 3:
        this.vec[5] = s16(v);
        break;
      case 4:
        this.vec[6] = s16(v);
        this.vec[7] = s16(v >>> 16);
        break;
      case 5:
        this.vec[8] = s16(v);
        break;
      case 6:
        this.rgbc = v;
        break;
      case 8:
        this.ir[0] = s16(v);
        break;
      case 9:
        this.ir[1] = s16(v);
        break;
      case 10:
        this.ir[2] = s16(v);
        break;
      case 11:
        this.ir[3] = s16(v);
        break;
      case 12:
        this.sxy[0] = s16(v);
        this.sxy[1] = s16(v >>> 16);
        break;
      case 13:
        this.sxy[2] = s16(v);
        this.sxy[3] = s16(v >>> 16);
        break;
      case 14:
        this.sxy[4] = s16(v);
        this.sxy[5] = s16(v >>> 16);
        break;
      case 15:
        this.sxy[0] = this.sxy[2];
        this.sxy[1] = this.sxy[3];
        this.sxy[2] = this.sxy[4];
        this.sxy[3] = this.sxy[5];
        this.sxy[4] = s16(v);
        this.sxy[5] = s16(v >>> 16);
        break;
      case 16:
        this.sz[0] = v & 0xFFFF;
        break;
      case 17:
        this.sz[1] = v & 0xFFFF;
        break;
      case 18:
        this.sz[2] = v & 0xFFFF;
        break;
      case 19:
        this.sz[3] = v & 0xFFFF;
        break;
      case 20:
        this.rgb[0] = v | 0;
        break;
      case 21:
        this.rgb[1] = v | 0;
        break;
      case 22:
        this.rgb[2] = v | 0;
        break;
      case 23:
        this.res1 = v;
        break;
      case 24:
        this.mac[0] = v;
        break;
      case 25:
        this.mac[1] = v;
        break;
      case 26:
        this.mac[2] = v;
        break;
      case 27:
        this.mac[3] = v;
        break;
      case 28:
        this.irgb = v & 0x7FFF;
        this.ir[1] = (v & 0x1F) << 7;
        this.ir[2] = ((v >>> 5) & 0x1F) << 7;
        this.ir[3] = ((v >>> 10) & 0x1F) << 7;
        break;
      case 30:
        this.lzcs = v;
        break;
      default:
        break;
    }
  }

  private readCnt(i: number): number {
    switch (i) {
      case 0:
        return (this.rt[1] << 16) | (this.rt[0] & 0xFFFF);
      case 1:
        return (this.rt[3] << 16) | (this.rt[2] & 0xFFFF);
      case 2:
        return (this.rt[5] << 16) | (this.rt[4] & 0xFFFF);
      case 3:
        return (this.rt[7] << 16) | (this.rt[6] & 0xFFFF);
      case 4:
        return this.rt[8];
      case 5:
        return this.trx;
      case 6:
        return this.tryy;
      case 7:
        return this.trz;
      case 8:
        return (this.llm[1] << 16) | (this.llm[0] & 0xFFFF);
      case 9:
        return (this.llm[3] << 16) | (this.llm[2] & 0xFFFF);
      case 10:
        return (this.llm[5] << 16) | (this.llm[4] & 0xFFFF);
      case 11:
        return (this.llm[7] << 16) | (this.llm[6] & 0xFFFF);
      case 12:
        return this.llm[8];
      case 13:
        return this.rbk;
      case 14:
        return this.gbk;
      case 15:
        return this.bbk;
      case 16:
        return (this.lcm[1] << 16) | (this.lcm[0] & 0xFFFF);
      case 17:
        return (this.lcm[3] << 16) | (this.lcm[2] & 0xFFFF);
      case 18:
        return (this.lcm[5] << 16) | (this.lcm[4] & 0xFFFF);
      case 19:
        return (this.lcm[7] << 16) | (this.lcm[6] & 0xFFFF);
      case 20:
        return this.lcm[8];
      case 21:
        return this.rfc;
      case 22:
        return this.gfc;
      case 23:
        return this.bfc;
      case 24:
        return this.ofx;
      case 25:
        return this.ofy;
      case 26:
        return (this.h << 16) >> 16;
      case 27:
        return this.dqa;
      case 28:
        return this.dqb;
      case 29:
        return this.zsf3;
      case 30:
        return this.zsf4;
      default:
        return this.flag | ((this.flag & FLAG_ERROR) !== 0 ? 0x80000000 : 0);
    }
  }

  private writeCnt(i: number, v: number): void {
    switch (i) {
      case 0:
        this.rt[0] = s16(v);
        this.rt[1] = s16(v >>> 16);
        break;
      case 1:
        this.rt[2] = s16(v);
        this.rt[3] = s16(v >>> 16);
        break;
      case 2:
        this.rt[4] = s16(v);
        this.rt[5] = s16(v >>> 16);
        break;
      case 3:
        this.rt[6] = s16(v);
        this.rt[7] = s16(v >>> 16);
        break;
      case 4:
        this.rt[8] = s16(v);
        break;
      case 5:
        this.trx = v;
        break;
      case 6:
        this.tryy = v;
        break;
      case 7:
        this.trz = v;
        break;
      case 8:
        this.llm[0] = s16(v);
        this.llm[1] = s16(v >>> 16);
        break;
      case 9:
        this.llm[2] = s16(v);
        this.llm[3] = s16(v >>> 16);
        break;
      case 10:
        this.llm[4] = s16(v);
        this.llm[5] = s16(v >>> 16);
        break;
      case 11:
        this.llm[6] = s16(v);
        this.llm[7] = s16(v >>> 16);
        break;
      case 12:
        this.llm[8] = s16(v);
        break;
      case 13:
        this.rbk = v;
        break;
      case 14:
        this.gbk = v;
        break;
      case 15:
        this.bbk = v;
        break;
      case 16:
        this.lcm[0] = s16(v);
        this.lcm[1] = s16(v >>> 16);
        break;
      case 17:
        this.lcm[2] = s16(v);
        this.lcm[3] = s16(v >>> 16);
        break;
      case 18:
        this.lcm[4] = s16(v);
        this.lcm[5] = s16(v >>> 16);
        break;
      case 19:
        this.lcm[6] = s16(v);
        this.lcm[7] = s16(v >>> 16);
        break;
      case 20:
        this.lcm[8] = s16(v);
        break;
      case 21:
        this.rfc = v;
        break;
      case 22:
        this.gfc = v;
        break;
      case 23:
        this.bfc = v;
        break;
      case 24:
        this.ofx = v;
        break;
      case 25:
        this.ofy = v;
        break;
      case 26:
        this.h = v & 0xFFFF;
        break;
      case 27:
        this.dqa = s16(v);
        break;
      case 28:
        this.dqb = v;
        break;
      case 29:
        this.zsf3 = s16(v);
        break;
      case 30:
        this.zsf4 = s16(v);
        break;
      default:
        this.flag = (v & 0x7FFFF000) & 0x7FFFFFFF;
        break;
    }
  }

  private lzcrCount(v: number): number {
    let n = v < 0 ? ~v : v;
    if (n === 0) {
      return 32;
    }
    let count = 0;
    if ((n & 0xFFFF0000) === 0) {
      count = 16;
      n = n << 16;
    }
    if ((n & 0xFF000000) === 0) {
      count += 8;
      n = n << 8;
    }
    if ((n & 0xF0000000) === 0) {
      count += 4;
      n = n << 4;
    }
    if ((n & 0xC0000000) === 0) {
      count += 2;
      n = n << 2;
    }
    if ((n & 0x80000000) === 0) {
      count += 1;
    }

    return count;
  }

  private orComponent(v: number): number {
    const c = v >> 7;
    if (c < 0) {
      return 0;
    }
    if (c > 0x1F) {
      return 0x1F;
    }

    return c;
  }

  private matFor(mx: number): Array<number> {
    if (mx === 0) {
      return this.rt;
    }
    if (mx === 1) {
      return this.llm;
    }
    if (mx === 2) {
      return this.lcm;
    }
    const r = this.rgbc & 0xFF;
    const rm = this.bogusM;
    rm[0] = -(r << 4);
    rm[1] = r << 4;
    rm[2] = this.ir[0];
    rm[3] = this.rt[2];
    rm[4] = this.rt[2];
    rm[5] = this.rt[2];
    rm[6] = this.rt[4];
    rm[7] = this.rt[4];
    rm[8] = this.rt[4];

    return rm;
  }

  private setMacIr(slot: number, raw: number, sf: number, lm: number): void {
    if (raw > MAC_POS_MAX) {
      this.flag |= 0x40000000 >> (slot - 1);
    } else if (raw < MAC_NEG_MIN) {
      this.flag |= 0x08000000 >> (slot - 1);
    }
    const mac = sf === 0 ? raw : Math.floor(raw / 4096);
    const lo = lm === 0 ? -0x8000 : 0;
    let irv = mac;
    if (irv < lo) {
      this.flag |= 0x1000000 >> (slot - 1);
      irv = lo;
    } else if (irv > 0x7FFF) {
      this.flag |= 0x1000000 >> (slot - 1);
      irv = 0x7FFF;
    }
    this.mac[slot] = mac | 0;
    this.ir[slot] = irv;
  }

  private setMac0(v: number): void {
    if (v > 0x7FFFFFFF) {
      this.flag |= 0x10000;
    } else if (v < -0x80000000) {
      this.flag |= 0x8000;
    }
    this.mac[0] = v | 0;
  }

  private satIrLm0(v: number, slot: number): number {
    if (v < -0x8000) {
      this.flag |= 0x1000000 >> (slot - 1);

      return -0x8000;
    }
    if (v > 0x7FFF) {
      this.flag |= 0x1000000 >> (slot - 1);

      return 0x7FFF;
    }

    return v;
  }

  private divide(h: number, sz3: number): number {
    if (sz3 === 0 || h >= sz3 * 2) {
      this.flag |= 0x20000;

      return 0x1FFFF;
    }
    let z = 0;
    let m = 0x8000;
    while ((sz3 & m) === 0) {
      z++;
      m >>= 1;
    }
    const n0 = h << z;
    let d = sz3 << z;
    const u = UNR[(d - 0x7FC0) >>> 7] + 0x101;
    const d1 = (0x2000080 - d * u) >>> 8;
    d = (0x80 + d1 * u) >>> 8;

    return Math.min(0x1FFFF, Math.floor((n0 * d + 0x8000) / 0x10000));
  }

  private project(base: number, sf: number, withDepth: boolean): void {
    const v1 = this.vec[base];
    const v2 = this.vec[base + 1];
    const v3 = this.vec[base + 2];
    const m = this.rt;
    const raw1 = this.trx * 0x1000 + m[0] * v1 + m[1] * v2 + m[2] * v3;
    const raw2 = this.tryy * 0x1000 + m[3] * v1 + m[4] * v2 + m[5] * v3;
    const raw3 = this.trz * 0x1000 + m[6] * v1 + m[7] * v2 + m[8] * v3;
    this.setMacIr(1, raw1, sf, 0);
    this.setMacIr(2, raw2, sf, 0);
    this.setMacIr(3, raw3, sf, 0);
    const szPre = Math.floor(raw3 / 4096);
    if (szPre < -0x8000) {
      this.flag |= 0x400000;
      this.flag |= 0x40000;
    } else if (szPre > 0x7FFF) {
      this.flag |= 0x400000;
      if (szPre > 0xFFFF) {
        this.flag |= 0x40000;
      }
    }
    const sz3 = szPre < 0 ? 0 : szPre > 0xFFFF ? 0xFFFF : szPre;
    this.sz[0] = this.sz[1];
    this.sz[1] = this.sz[2];
    this.sz[2] = this.sz[3];
    this.sz[3] = sz3;
    const n = this.divide(this.h, sz3);
    let mac0 = n * this.ir[1] + this.ofx;
    this.setMac0(mac0);
    let sxPre = Math.floor(mac0 / 0x10000);
    if (sxPre < -0x400) {
      this.flag |= 0x4000;
      sxPre = -0x400;
    } else if (sxPre > 0x3FF) {
      this.flag |= 0x4000;
      sxPre = 0x3FF;
    }
    mac0 = n * this.ir[2] + this.ofy;
    this.setMac0(mac0);
    let syPre = Math.floor(mac0 / 0x10000);
    if (syPre < -0x400) {
      this.flag |= 0x2000;
      syPre = -0x400;
    } else if (syPre > 0x3FF) {
      this.flag |= 0x2000;
      syPre = 0x3FF;
    }
    if (withDepth) {
      mac0 = n * this.dqa + this.dqb;
      this.setMac0(mac0);
      let ir0Pre = Math.floor(mac0 / 0x1000);
      if (ir0Pre < 0) {
        this.flag |= 0x1000;
        ir0Pre = 0;
      } else if (ir0Pre > 0x1000) {
        this.flag |= 0x1000;
        ir0Pre = 0x1000;
      }
      this.ir[0] = ir0Pre;
    }
    this.sxy[0] = this.sxy[2];
    this.sxy[1] = this.sxy[3];
    this.sxy[2] = this.sxy[4];
    this.sxy[3] = this.sxy[5];
    this.sxy[4] = sxPre;
    this.sxy[5] = syPre;
  }

  private nclip(): void {
    const mac0 =
      this.sxy[0] * (this.sxy[3] - this.sxy[5]) +
      this.sxy[2] * (this.sxy[5] - this.sxy[1]) +
      this.sxy[4] * (this.sxy[1] - this.sxy[3]);
    this.setMac0(mac0);
  }

  private op(sf: number, lm: number): void {
    const d1 = this.rt[0];
    const d2 = this.rt[4];
    const d3 = this.rt[8];
    const r1 = this.ir[3] * d2 - this.ir[2] * d3;
    const r2 = this.ir[1] * d3 - this.ir[3] * d1;
    const r3 = this.ir[2] * d1 - this.ir[1] * d2;
    this.setMacIr(1, r1, sf, lm);
    this.setMacIr(2, r2, sf, lm);
    this.setMacIr(3, r3, sf, lm);
  }

  private mvmvaCore(
    m: Array<number>,
    v1: number,
    v2: number,
    v3: number,
    t1: number,
    t2: number,
    t3: number,
    sf: number,
    lm: number,
    split: boolean,
  ): void {
    if (split) {
      this.setMacIr(1, t1 * 0x1000 + m[0] * v1, sf, 0);
      this.setMacIr(2, t2 * 0x1000 + m[3] * v1, sf, 0);
      this.setMacIr(3, t3 * 0x1000 + m[6] * v1, sf, 0);
      this.setMacIr(1, m[1] * v2 + m[2] * v3, sf, lm);
      this.setMacIr(2, m[4] * v2 + m[5] * v3, sf, lm);
      this.setMacIr(3, m[7] * v2 + m[8] * v3, sf, lm);

      return;
    }
    this.setMacIr(1, t1 * 0x1000 + m[0] * v1 + m[1] * v2 + m[2] * v3, sf, lm);
    this.setMacIr(2, t2 * 0x1000 + m[3] * v1 + m[4] * v2 + m[5] * v3, sf, lm);
    this.setMacIr(3, t3 * 0x1000 + m[6] * v1 + m[7] * v2 + m[8] * v3, sf, lm);
  }

  private mvmva(instr: number): void {
    const lm = (instr >>> 10) & 1;
    const mx = (instr >>> 17) & 3;
    const mv = (instr >>> 15) & 3;
    const cv = (instr >>> 13) & 3;
    const m = this.matFor(mx);
    let v1 = 0;
    let v2 = 0;
    let v3 = 0;
    if (mv === 3) {
      v1 = this.ir[1];
      v2 = this.ir[2];
      v3 = this.ir[3];
    } else {
      v1 = this.vec[mv * 3];
      v2 = this.vec[mv * 3 + 1];
      v3 = this.vec[mv * 3 + 2];
    }
    let t1 = 0;
    let t2 = 0;
    let t3 = 0;
    if (cv === 0) {
      t1 = this.trx;
      t2 = this.tryy;
      t3 = this.trz;
    } else if (cv === 1) {
      t1 = this.rbk;
      t2 = this.gbk;
      t3 = this.bbk;
    } else if (cv === 2) {
      t1 = this.rfc;
      t2 = this.gfc;
      t3 = this.bfc;
    }
    this.mvmvaCore(m, v1, v2, v3, t1, t2, t3, (instr >>> 19) & 1, lm, cv === 2);
  }

  private pushColor(c1: number, c2: number, c3: number, lm: number): void {
    const cc = this.rgbc;
    let r = c1 >> 4;
    if (r < 0) {
      this.flag |= 0x200000;
      r = 0;
    } else if (r > 0xFF) {
      this.flag |= 0x200000;
      r = 0xFF;
    }
    let g = c2 >> 4;
    if (g < 0) {
      this.flag |= 0x100000;
      g = 0;
    } else if (g > 0xFF) {
      this.flag |= 0x100000;
      g = 0xFF;
    }
    let b = c3 >> 4;
    if (b < 0) {
      this.flag |= 0x80000;
      b = 0;
    } else if (b > 0xFF) {
      this.flag |= 0x80000;
      b = 0xFF;
    }
    this.rgb[0] = this.rgb[1];
    this.rgb[1] = this.rgb[2];
    this.rgb[2] = ((cc >>> 24) << 24) | (b << 16) | (g << 8) | r;
    const lo = lm === 0 ? -0x8000 : 0;
    let i1 = c1;
    if (i1 < lo) {
      this.flag |= 0x1000000;
      i1 = lo;
    } else if (i1 > 0x7FFF) {
      this.flag |= 0x1000000;
      i1 = 0x7FFF;
    }
    let i2 = c2;
    if (i2 < lo) {
      this.flag |= 0x800000;
      i2 = lo;
    } else if (i2 > 0x7FFF) {
      this.flag |= 0x800000;
      i2 = 0x7FFF;
    }
    let i3 = c3;
    if (i3 < lo) {
      this.flag |= 0x400000;
      i3 = lo;
    } else if (i3 > 0x7FFF) {
      this.flag |= 0x400000;
      i3 = 0x7FFF;
    }
    this.ir[1] = i1;
    this.ir[2] = i2;
    this.ir[3] = i3;
  }

  private depthCueStep(sf: number): void {
    const shift = sf === 0 ? 1 : 4096;
    const t1 = this.satIrLm0(Math.floor((this.rfc * 0x1000 - this.mac[1]) / shift), 1);
    const t2 = this.satIrLm0(Math.floor((this.gfc * 0x1000 - this.mac[2]) / shift), 2);
    const t3 = this.satIrLm0(Math.floor((this.bfc * 0x1000 - this.mac[3]) / shift), 3);
    this.ir[1] = t1;
    this.ir[2] = t2;
    this.ir[3] = t3;
    const m1 = this.mac[1] + t1 * this.ir[0];
    const m2 = this.mac[2] + t2 * this.ir[0];
    const m3 = this.mac[3] + t3 * this.ir[0];
    if (m1 > MAC_POS_MAX) {
      this.flag |= 0x40000000;
    } else if (m1 < MAC_NEG_MIN) {
      this.flag |= 0x08000000;
    }
    if (m2 > MAC_POS_MAX) {
      this.flag |= 0x20000000;
    } else if (m2 < MAC_NEG_MIN) {
      this.flag |= 0x04000000;
    }
    if (m3 > MAC_POS_MAX) {
      this.flag |= 0x10000000;
    } else if (m3 < MAC_NEG_MIN) {
      this.flag |= 0x02000000;
    }
    this.mac[1] = m1 | 0;
    this.mac[2] = m2 | 0;
    this.mac[3] = m3 | 0;
  }

  private colorTail(depth: boolean, sf: number, lm: number): void {
    if (depth) {
      this.depthCueStep(sf);
    }
    if (sf !== 0) {
      this.mac[1] = Math.floor(this.mac[1] / 4096) | 0;
      this.mac[2] = Math.floor(this.mac[2] / 4096) | 0;
      this.mac[3] = Math.floor(this.mac[3] / 4096) | 0;
    }
    this.pushColor(this.mac[1], this.mac[2], this.mac[3], lm);
  }

  private colorStep(base: number, depth: boolean, sf: number, lm: number): void {
    if (base >= 0) {
      this.mvmvaCore(
        this.llm,
        this.vec[base],
        this.vec[base + 1],
        this.vec[base + 2],
        0,
        0,
        0,
        sf,
        lm,
        false,
      );
    }
    this.mvmvaCore(this.lcm, this.ir[1], this.ir[2], this.ir[3], this.rbk, this.gbk, this.bbk, sf, lm, false);
    const cc = this.rgbc;
    this.mac[1] = ((cc & 0xFF) * this.ir[1]) << 4;
    this.mac[2] = (((cc >>> 8) & 0xFF) * this.ir[2]) << 4;
    this.mac[3] = (((cc >>> 16) & 0xFF) * this.ir[3]) << 4;
    this.colorTail(depth, sf, lm);
  }

  private dcplBase(sf: number, lm: number): void {
    const cc = this.rgbc;
    this.mac[1] = ((cc & 0xFF) * this.ir[1]) << 4;
    this.mac[2] = (((cc >>> 8) & 0xFF) * this.ir[2]) << 4;
    this.mac[3] = (((cc >>> 16) & 0xFF) * this.ir[3]) << 4;
    this.colorTail(true, sf, lm);
  }

  private rgbsBase(r: number, g: number, b: number, depth: boolean, sf: number, lm: number): void {
    this.mac[1] = r << 16;
    this.mac[2] = g << 16;
    this.mac[3] = b << 16;
    this.colorTail(depth, sf, lm);
  }

  private sqrSf(sf: number): void {
    this.setMacIr(1, this.ir[1] * this.ir[1], sf, 0);
    this.setMacIr(2, this.ir[2] * this.ir[2], sf, 0);
    this.setMacIr(3, this.ir[3] * this.ir[3], sf, 0);
  }

  private gpgl(sf: number, lm: number, zeroBase: boolean): void {
    let m1 = this.mac[1];
    let m2 = this.mac[2];
    let m3 = this.mac[3];
    if (zeroBase) {
      m1 = 0;
      m2 = 0;
      m3 = 0;
    }
    const scale = sf === 0 ? 1 : 4096;
    this.setMacIr(1, m1 * scale + this.ir[1] * this.ir[0], sf, lm);
    this.setMacIr(2, m2 * scale + this.ir[2] * this.ir[0], sf, lm);
    this.setMacIr(3, m3 * scale + this.ir[3] * this.ir[0], sf, lm);
    this.pushColor(this.mac[1], this.mac[2], this.mac[3], lm);
  }

  private avsz(n: number, zsf: number): void {
    let sum = 0;
    let i = 0;
    while (i < n) {
      sum += this.sz[i];
      i++;
    }
    this.setMac0(zsf * sum);
    let otz = Math.floor((zsf * sum) / 4096);
    if (otz < 0) {
      this.flag |= 0x40000;
      otz = 0;
    } else if (otz > 0xFFFF) {
      this.flag |= 0x40000;
      otz = 0xFFFF;
    }
    this.otz = otz;
  }

  private execute(cmd: number, sf: number, lm: number, instr: number): void {
    this.flag = 0;
    switch (cmd) {
      case 0x01:
        this.project(0, sf, true);
        break;
      case 0x30:
        this.project(0, sf, false);
        this.project(3, sf, false);
        this.project(6, sf, true);
        break;
      case 0x06:
        this.nclip();
        break;
      case 0x0C:
        this.op(sf, lm);
        break;
      case 0x10:
        this.rgbsBase(this.rgbc & 0xFF, (this.rgbc >>> 8) & 0xFF, (this.rgbc >>> 16) & 0xFF, true, sf, lm);
        break;
      case 0x11:
        this.mac[1] = this.ir[1] << 12;
        this.mac[2] = this.ir[2] << 12;
        this.mac[3] = this.ir[3] << 12;
        this.colorTail(true, sf, lm);
        break;
      case 0x12:
        this.mvmva(instr);
        break;
      case 0x1C:
        this.colorStep(-1, false, sf, lm);
        break;
      case 0x14:
        this.colorStep(-1, true, sf, lm);
        break;
      case 0x29:
        this.dcplBase(sf, lm);
        break;
      case 0x2A: {
        let i = 0;
        while (i < 3) {
          const w = this.rgb[0];
          this.rgbsBase(w & 0xFF, (w >>> 8) & 0xFF, (w >>> 16) & 0xFF, true, sf, lm);
          i++;
        }
        break;
      }
      case 0x1E:
        this.colorStep(0, false, sf, lm);
        break;
      case 0x13:
        this.colorStep(0, true, sf, lm);
        break;
      case 0x1B:
        this.colorStep(0, false, sf, lm);
        break;
      case 0x20:
        this.colorStep(0, false, sf, lm);
        this.colorStep(3, false, sf, lm);
        this.colorStep(6, false, sf, lm);
        break;
      case 0x16:
        this.colorStep(0, true, sf, lm);
        this.colorStep(3, true, sf, lm);
        this.colorStep(6, true, sf, lm);
        break;
      case 0x3F:
        this.colorStep(0, false, sf, lm);
        this.colorStep(3, false, sf, lm);
        this.colorStep(6, false, sf, lm);
        break;
      case 0x28:
        this.sqrSf(sf);
        break;
      case 0x2D:
        this.avsz(3, this.zsf3);
        break;
      case 0x2E:
        this.avsz(4, this.zsf4);
        break;
      case 0x3D:
        this.gpgl(sf, lm, true);
        break;
      case 0x3E:
        this.gpgl(sf, lm, false);
        break;
      default:
        break;
    }
  }
}
