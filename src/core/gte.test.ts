import { describe, expect, test } from 'bun:test';
import { Gte, gteCycles } from './gte';

function mtc2(reg: number): number {
  return (0x48800000 | (reg << 11)) >>> 0;
}

function mfc2(reg: number): number {
  return (0x48000000 | (reg << 11)) >>> 0;
}

function cfc2(reg: number): number {
  return (0x48400000 | (reg << 11)) >>> 0;
}

function ctc2(reg: number): number {
  return (0x48C00000 | (reg << 11)) >>> 0;
}

function cmd(imm25: number): number {
  return (0x4A000000 | imm25) >>> 0;
}

const RTPS = cmd(0x0180001);
const RTPT = cmd(0x0280030);
const NCLIP = cmd(0x1400006);
const AVSZ3 = cmd(0x158002D);
const AVSZ4 = cmd(0x168002E);
const SQR = cmd(0x0A00428 | (1 << 19));
const NCS = cmd(0x0C8041E);
const NCCS = cmd(0x108041B);
const CDP = cmd(0x1280414);
const DPCS = cmd(0x0780010);
const INTPL = cmd(0x0980011);
const DCPL = cmd(0x0680029);
const GPF = cmd(0x190003D | (1 << 19));
const GPL = cmd(0x1A0003E | (1 << 19));
const MVMVA_RT_V0_TR_SF1 = cmd(0x0400012 | (1 << 19));
const MVMVA_RT_V0_BK_SF1 = MVMVA_RT_V0_TR_SF1 | (1 << 13);

function identityRt(g: Gte): void {
  g.cop2(ctc2(0), 0x00001000);
  g.cop2(ctc2(1), 0);
  g.cop2(ctc2(2), 0x00001000);
  g.cop2(ctc2(3), 0);
  g.cop2(ctc2(4), 0x1000);
}

function flagBits(g: Gte): number {
  return g.cop2(cfc2(31), 0) >>> 0;
}

describe('Gte cycles', () => {
  test('per-command clock counts', () => {
    expect(gteCycles(RTPS)).toBe(15);
    expect(gteCycles(RTPT)).toBe(23);
    expect(gteCycles(cmd(0x0F80416))).toBe(44);
    expect(gteCycles(cfc2(31))).toBe(4);
    expect(gteCycles(0x00000000)).toBe(4);
  });
});

describe('Gte projections', () => {
  test('RTPS identity matrix: hand-checked fixed point', () => {
    const g = new Gte();
    identityRt(g);
    g.cop2(mtc2(0), 0x0C00);
    g.cop2(mtc2(1), 0x0800);
    g.cop2(ctc2(26), 0x0200);
    expect(g.cop2(cfc2(26), 0)).toBe(0x200);
    g.cop2(RTPS, 0);
    expect(g.cop2(mfc2(9), 0)).toBe(3072);
    expect(g.cop2(mfc2(11), 0)).toBe(2048);
    expect(g.cop2(mfc2(14), 0)).toBe(768);
    expect(g.cop2(mfc2(19), 0)).toBe(2048);
    expect(g.cop2(mfc2(27), 0)).toBe(2048);
    expect(flagBits(g)).toBe(0);
  });

  test('RTPS distant vertex saturates SX2 (FLAG.14)', () => {
    const g = new Gte();
    identityRt(g);
    g.cop2(mtc2(0), 0x3000);
    g.cop2(mtc2(1), 0x0800);
    g.cop2(ctc2(26), 0x0200);
    g.cop2(RTPS, 0);
    expect(g.cop2(mfc2(9), 0)).toBe(12288);
    expect(g.cop2(mfc2(14), 0)).toBe(0x3FF);
    expect(flagBits(g)).toBe(0x80004000);
  });

  test('RTPS behind camera: SZ3 clamps, divide overflow, FLAG.17+31', () => {
    const g = new Gte();
    identityRt(g);
    g.cop2(mtc2(0), 0x0C00);
    g.cop2(mtc2(1), 0x0001);
    g.cop2(ctc2(26), 0x0200);
    g.cop2(RTPS, 0);
    expect(g.cop2(mfc2(19), 0)).toBe(1);
    expect(g.cop2(mfc2(14), 0)).toBe(0x3FF);
    expect(flagBits(g)).toBe(0x80024000);
  });

  test('RTPT three vertices fill SZ/SXY fifos in order', () => {
    const g = new Gte();
    identityRt(g);
    g.cop2(ctc2(26), 0x0200);
    g.cop2(mtc2(0), 0x0C00);
    g.cop2(mtc2(1), 0x0800);
    g.cop2(mtc2(2), 0x0C00 << 16);
    g.cop2(mtc2(3), 0x0800);
    g.cop2(mtc2(5), 0x0800);
    g.cop2(RTPT, 0);
    expect(g.cop2(mfc2(12), 0)).toBe(768);
    expect(g.cop2(mfc2(13), 0)).toBe(768 << 16);
    expect(g.cop2(mfc2(16), 0)).toBe(0);
    expect(g.cop2(mfc2(17), 0)).toBe(2048);
    expect(g.cop2(mfc2(19), 0)).toBe(2048);
    expect(flagBits(g)).toBe(0);
  });
});

describe('Gte general purpose', () => {
  test('MVMVA RT rotation with BK translation (X gets +1.0)', () => {
    const g = new Gte();
    identityRt(g);
    g.cop2(ctc2(13), 0x1000);
    g.cop2(mtc2(0), 0x1000);
    g.cop2(MVMVA_RT_V0_BK_SF1, 0);
    expect(g.cop2(mfc2(25), 0)).toBe(8192);
    expect(g.cop2(mfc2(26), 0)).toBe(0);
    expect(g.cop2(mfc2(27), 0)).toBe(0);
    expect(flagBits(g)).toBe(0);
  });

  test('MVMVA lm=1 clamps negative IR result to 0 with FLAG.23', () => {
    const g = new Gte();
    g.cop2(ctc2(2), 0x2000);
    g.cop2(mtc2(0), ((-0x7FFF) << 16) | 0);
    g.cop2(MVMVA_RT_V0_TR_SF1 | (1 << 10), 0);
    expect(g.cop2(mfc2(26), 0)).toBe(-65534);
    expect(g.cop2(mfc2(10), 0)).toBe(0);
    expect((flagBits(g) >>> 0) & 0x800000).toBe(0x800000);
  });

  test('MVMVA bogus FC translation contributes flags only', () => {
    const g = new Gte();
    identityRt(g);
    g.cop2(ctc2(21), 0x1000000);
    g.cop2(mtc2(0), 0x1000);
    g.cop2(MVMVA_RT_V0_TR_SF1 | (2 << 13), 0);
    expect(g.cop2(mfc2(25), 0)).toBe(0);
    expect((flagBits(g) >>> 0) & 0x1000000).toBe(0x1000000);
  });

  test('MVMVA 44-bit positive overflow sets FLAG.30 and saturates IR', () => {
    const g = new Gte();
    g.cop2(ctc2(0), 0x7FFF7FFF);
    g.cop2(ctc2(1), 0x7FFF7FFF);
    g.cop2(ctc2(2), 0x7FFF7FFF);
    g.cop2(ctc2(3), 0x7FFF7FFF);
    g.cop2(ctc2(4), 0x7FFF);
    g.cop2(ctc2(5), 0x7FFFFFFF);
    g.cop2(ctc2(6), 0x7FFFFFFF);
    g.cop2(ctc2(7), 0x7FFFFFFF);
    g.cop2(mtc2(0), 0x7FFF7FFF);
    g.cop2(mtc2(1), 0x7FFF);
    g.cop2(MVMVA_RT_V0_TR_SF1, 0);
    expect(g.cop2(mfc2(25), 0)).toBe(-2146697265);
    expect(g.cop2(mfc2(9), 0)).toBe(0x7FFF);
    expect((flagBits(g) >>> 0) & 0x40000000).toBe(0x40000000);
    expect((flagBits(g) >>> 0) & 0x1000000).toBe(0x1000000);
  });

  test('NCLIP winding sign, negative and degenerate', () => {
    const g = new Gte();
    g.cop2(mtc2(12), 0);
    g.cop2(mtc2(13), 10);
    g.cop2(mtc2(14), 10 << 16);
    g.cop2(NCLIP, 0);
    expect(g.cop2(mfc2(24), 0)).toBe(100);
    g.cop2(mtc2(13), 10 << 16);
    g.cop2(mtc2(14), 10);
    g.cop2(NCLIP, 0);
    expect(g.cop2(mfc2(24), 0)).toBe(-100);
    g.cop2(mtc2(13), 0);
    g.cop2(mtc2(14), 0);
    g.cop2(NCLIP, 0);
    expect(g.cop2(mfc2(24), 0)).toBe(0);
  });

  test('AVSZ3/AVSZ4 average and round OTZ', () => {
    const g = new Gte();
    g.cop2(mtc2(16), 10);
    g.cop2(mtc2(17), 20);
    g.cop2(mtc2(18), 30);
    g.cop2(mtc2(19), 40);
    g.cop2(ctc2(29), 1366);
    g.cop2(ctc2(30), 1366);
    g.cop2(AVSZ3, 0);
    expect(g.cop2(mfc2(24), 0)).toBe(81960);
    expect(g.cop2(mfc2(7), 0)).toBe(20);
    g.cop2(AVSZ4, 0);
    expect(g.cop2(mfc2(24), 0)).toBe(136600);
    expect(g.cop2(mfc2(7), 0)).toBe(33);
  });

  test('SQR squares IR vector (sf=1)', () => {
    const g = new Gte();
    g.cop2(mtc2(9), 3000);
    g.cop2(mtc2(10), -4000);
    g.cop2(mtc2(11), 7000);
    g.cop2(SQR, 0);
    expect(g.cop2(mfc2(25), 0)).toBe(2197);
    expect(g.cop2(mfc2(26), 0)).toBe(3906);
    expect(g.cop2(mfc2(27), 0)).toBe(11962);
    expect(g.cop2(mfc2(9), 0)).toBe(2197);
    expect(g.cop2(mfc2(10), 0)).toBe(3906);
    expect(g.cop2(mfc2(11), 0)).toBe(11962);
  });

  test('GPF scales (IR*IR0); GPL adds MAC base', () => {
    const g = new Gte();
    g.cop2(mtc2(8), 8192);
    g.cop2(mtc2(9), 4096);
    g.cop2(mtc2(10), 2048);
    g.cop2(mtc2(11), 0);
    g.cop2(GPF, 0);
    expect(g.cop2(mfc2(25), 0)).toBe(8192);
    expect(g.cop2(mfc2(26), 0)).toBe(4096);
    expect(g.cop2(mfc2(27), 0)).toBe(0);
    expect(g.cop2(mfc2(9), 0)).toBe(8192);
    const w = g.cop2(mfc2(22), 0) >>> 0;
    expect(w & 0xFF).toBe(255);
    expect((w >>> 8) & 0xFF).toBe(255);
    expect((w >>> 16) & 0xFF).toBe(0);
    expect((flagBits(g) >>> 0) & 0x300000).toBe(0x300000);
    g.cop2(mtc2(25), 4096);
    g.cop2(GPL, 0);
    expect(g.cop2(mfc2(25), 0)).toBe(20480);
    expect(g.cop2(mfc2(26), 0)).toBe(12288);
    expect(g.cop2(mfc2(9), 0)).toBe(20480);
  });
});

describe('Gte color chain', () => {
  test('NCS with identity LLM/LCM emits R*IR byte', () => {
    const g = new Gte();
    identityRt(g);
    g.cop2(ctc2(8), 0x1000);
    g.cop2(ctc2(16), 0x1000);
    g.cop2(mtc2(0), 0x1000);
    g.cop2(mtc2(6), 0x10);
    g.cop2(NCS, 0);
    expect(g.cop2(mfc2(22), 0)).toBe(0x10);
    expect(g.cop2(mfc2(25), 0)).toBe(256);
    expect(g.cop2(mfc2(9), 0)).toBe(256);
    expect(flagBits(g)).toBe(0);
  });

  test('NCCS identity chain same numbers', () => {
    const g = new Gte();
    identityRt(g);
    g.cop2(ctc2(8), 0x1000);
    g.cop2(ctc2(16), 0x1000);
    g.cop2(mtc2(0), 0x1000);
    g.cop2(mtc2(6), 0x10);
    g.cop2(NCCS, 0);
    expect(g.cop2(mfc2(22), 0)).toBe(0x10);
    expect(g.cop2(mfc2(25), 0)).toBe(256);
    expect(g.cop2(mfc2(9), 0)).toBe(256);
  });

  test('CDP depth-cue color with IR0=1.0 pulls to far color', () => {
    const g = new Gte();
    g.cop2(ctc2(21), 2048);
    g.cop2(ctc2(22), 2048);
    g.cop2(ctc2(23), 2048);
    g.cop2(mtc2(8), 4096);
    g.cop2(mtc2(9), 4096);
    g.cop2(mtc2(10), 4096);
    g.cop2(mtc2(11), 4096);
    g.cop2(mtc2(6), 0x10);
    g.cop2(CDP, 0);
    expect(g.cop2(mfc2(22), 0)).toBe(0x808080);
    expect(g.cop2(mfc2(9), 0)).toBe(2048);
    expect(g.cop2(mfc2(25), 0)).toBe(2048);
  });

  test('INTPL blends IR toward far color', () => {
    const g = new Gte();
    g.cop2(ctc2(21), 0x10);
    g.cop2(ctc2(22), 0x10);
    g.cop2(ctc2(23), 0x10);
    g.cop2(mtc2(8), 4096);
    g.cop2(mtc2(9), 4096);
    g.cop2(mtc2(10), 4096);
    g.cop2(mtc2(11), 4096);
    g.cop2(mtc2(6), 0x12000000);
    g.cop2(INTPL, 0);
    expect(g.cop2(mfc2(22), 0)).toBe(0x12010101);
    expect(g.cop2(mfc2(25), 0)).toBe(16);
    expect(g.cop2(mfc2(9), 0)).toBe(16);
    expect(flagBits(g)).toBe(0);
  });

  test('DCPL scales by RGBC bytes with zero far color and IR0=0', () => {
    const g = new Gte();
    g.cop2(ctc2(21), 0);
    g.cop2(ctc2(22), 0);
    g.cop2(ctc2(23), 0);
    g.cop2(mtc2(8), 0);
    g.cop2(mtc2(9), 4096);
    g.cop2(mtc2(10), 4096);
    g.cop2(mtc2(11), 4096);
    g.cop2(mtc2(6), 0x10);
    g.cop2(DCPL, 0);
    expect(g.cop2(mfc2(22), 0)).toBe(16);
    expect(g.cop2(mfc2(25), 0)).toBe(256);
    expect(g.cop2(mfc2(9), 0)).toBe(256);
  });

  test('DPCS runs RGB through depth cue with zero weight', () => {
    const g = new Gte();
    g.cop2(ctc2(21), 0);
    g.cop2(ctc2(22), 0);
    g.cop2(ctc2(23), 0);
    g.cop2(mtc2(8), 0);
    g.cop2(mtc2(6), (0x30 << 16) | (0x20 << 8) | 0x10);
    g.cop2(DPCS, 0);
    expect(g.cop2(mfc2(25), 0)).toBe(256);
    expect(g.cop2(mfc2(26), 0)).toBe(512);
    expect(g.cop2(mfc2(27), 0)).toBe(768);
    expect(g.cop2(mfc2(9), 0)).toBe(256);
    const w = g.cop2(mfc2(22), 0);
    expect(w & 0xFF).toBe(16);
    expect((w >>> 8) & 0xFF).toBe(32);
    expect((w >>> 16) & 0xFF).toBe(48);
    expect(flagBits(g)).toBe(0);
  });
});

describe('Gte data registers', () => {
  test('IRGB write expands to IR1..3, ORGB mirror', () => {
    const g = new Gte();
    g.cop2(mtc2(28), 0x7FFF);
    expect(g.cop2(mfc2(9), 0)).toBe(0xF80);
    expect(g.cop2(mfc2(10), 0)).toBe(0xF80);
    expect(g.cop2(mfc2(11), 0)).toBe(0xF80);
    expect(g.cop2(mfc2(29), 0)).toBe(0x7FFF);
  });

  test('LZCS/LZCR leading counts', () => {
    const g = new Gte();
    g.cop2(mtc2(30), 0x00010000);
    expect(g.cop2(mfc2(31), 0)).toBe(15);
    g.cop2(mtc2(30), -2);
    expect(g.cop2(mfc2(31), 0)).toBe(31);
    g.cop2(mtc2(30), 0);
    expect(g.cop2(mfc2(31), 0)).toBe(32);
  });

  test('matrix pair packing; RT33 sign-expanded read', () => {
    const g = new Gte();
    g.cop2(ctc2(0), 0x70000010);
    expect(g.cop2(cfc2(0), 0)).toBe(0x70000010);
    g.cop2(ctc2(4), 0x8123);
    expect(g.cop2(cfc2(4), 0)).toBe(-32477);
  });

  test('MTC2/MFC2 roundtrip; SXYP move-on-write', () => {
    const g = new Gte();
    g.cop2(mtc2(0), 0x12345678);
    expect(g.cop2(mfc2(0), 0)).toBe(0x12345678);
    g.cop2(mtc2(3), 0xABCDEF00);
    expect(g.cop2(mfc2(3), 0)).toBe(-4352);
    g.cop2(mtc2(14), (0x4444 << 16) | 0x3333);
    g.cop2(mtc2(13), (0x2222 << 16) | 0x1111);
    g.cop2(mtc2(15), (0x6666 << 16) | 0x5555);
    expect(g.cop2(mfc2(12), 0)).toBe((0x2222 << 16) | 0x1111);
    expect(g.cop2(mfc2(13), 0)).toBe((0x4444 << 16) | 0x3333);
    expect(g.cop2(mfc2(14), 0)).toBe((0x6666 << 16) | 0x5555);
    expect(g.cop2(mfc2(15), 0)).toBe((0x6666 << 16) | 0x5555);
  });

  test('LWC2 writes data reg, SWC2 reads it back', () => {
    const g = new Gte();
    const lwc2 = ((0x32 << 26) | (0 << 21) | (4 << 16) | 0) >>> 0;
    const swc2 = ((0x3A << 26) | (0 << 21) | (4 << 16) | 0) >>> 0;
    g.cop2(lwc2, 0x40);
    expect(g.cop2(mfc2(4), 0)).toBe(0x40);
    expect(g.cop2(swc2, 0)).toBe(0x40);
  });
});