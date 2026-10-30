import { describe, expect, it } from 'bun:test';
import type { DmaChannel, DmaConfig, IrqController, IrqLine, Scheduler } from './contracts';
import { RAM_SIZE } from './contracts';
import { RingLogger } from './logger';
import { MdecCore } from './mdec';

const DATA = 0x1F801820;
const CTRL = 0x1F801824;
const DMA_BASE = 0x0010_0000;
const MB_WORDS_15BPP = 128;
const MB_WORDS_24BPP = 192;
const MB_WORDS_MONO_8BPP = 16;

class NullScheduler implements Scheduler {
  now = 0;

  at(_cyclesFromNow: number, _fn: () => void): object {
    return {};
  }

  cancel(_handle: object): void {}
}

class SpyIrq implements IrqController {
  readonly dmaCompletions: Array<number> = [];

  raise(_line: IrqLine): void {}

  dmaDone(channel: number): void {
    this.dmaCompletions.push(channel);
  }
}

interface Fixture {
  mdec: MdecCore;
  irq: SpyIrq;
}

function makeMdec(): Fixture {
  const irq = new SpyIrq();

  return { mdec: new MdecCore(new NullScheduler(), new RingLogger(), irq), irq };
}

const CH0: DmaChannel = { id: 0 };
const CH1: DmaChannel = { id: 1 };

function makeCfg(base: number, words: number): DmaConfig {
  return {
    base,
    wordsPerBlock: words,
    blockCount: 1,
    step: 4,
    direction: 'toDevice',
    mode: 'manual',
    chopper: false,
    enable: true,
  };
}

function makeRam(): Uint32Array {
  return new Uint32Array(RAM_SIZE / 4);
}

function drain(mdec: MdecCore): Array<number> {
  const out: Array<number> = [];
  while (mdec.busy && out.length < 1_000_000) {
    out.push(mdec.dmaReadWord());
  }

  return out;
}

function encodeTable(bytes: Array<number>): Array<number> {
  const words: Array<number> = [];
  for (let i = 0; i < bytes.length; i += 4) {
    words.push((((bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) | bytes[i]) >>> 0);
  }

  return words;
}

const DEFAULT_TABLE: Array<number> = [
  0x02, 0x10, 0x10, 0x13, 0x10, 0x13, 0x16, 0x16, 0x16, 0x16, 0x16, 0x16, 0x1a, 0x18, 0x1a, 0x1b,
  0x1b, 0x1b, 0x1a, 0x1a, 0x1a, 0x1a, 0x1b, 0x1b, 0x1b, 0x1d, 0x1d, 0x1d, 0x22, 0x22, 0x22, 0x1d,
  0x1d, 0x1d, 0x1b, 0x1b, 0x1d, 0x1d, 0x20, 0x20, 0x22, 0x22, 0x25, 0x26, 0x25, 0x23, 0x23, 0x22,
  0x23, 0x26, 0x26, 0x28, 0x28, 0x28, 0x30, 0x30, 0x2e, 0x2e, 0x38, 0x38, 0x3a, 0x45, 0x45, 0x53,
];

function tableWith0(v: number): Array<number> {
  const t = DEFAULT_TABLE.slice();
  t[0] = v;

  return t;
}

function uploadTables(mdec: MdecCore, lum: Array<number>, uv: Array<number> | null): void {
  const cmd = uv === null ? 0x40000000 : 0x40000001;

  mdec.store32(DATA, cmd >>> 0);
  for (const w of encodeTable(lum)) {
    mdec.store32(DATA, w >>> 0);
  }
  if (uv !== null) {
    for (const w of encodeTable(uv)) {
      mdec.store32(DATA, w >>> 0);
    }
  }
}

function decodeCmd(depthBits: number, words: number): number {
  return ((0x2000_0000 | (depthBits << 27)) | words) >>> 0;
}

function dmaIn(mdec: MdecCore, ram: Uint32Array, base: number, words: number): void {
  mdec.dmaStart(CH0, makeCfg(base, words), ram);
}

function fillRam(ram: Uint32Array, index: number, words: Array<number>): void {
  const start = (DMA_BASE >>> 2) + index;
  for (let i = 0; i < words.length; i++) {
    ram[(start + i) % ram.length] = words[i] >>> 0;
  }
}

describe('mdec status & reset', () => {
  it('control reset leaves the documented idle status 0x80040000', () => {
    const { mdec } = makeMdec();

    mdec.store32(CTRL, 0x8000_0000);

    expect(mdec.load32(CTRL)).toBe(0x80040000);
  });

  it('MDEC(0)-class words reflect bits 25-28 and 0-15 into status without staying busy', () => {
    const { mdec } = makeMdec();

    mdec.store32(CTRL, 0x6000_0000);
    mdec.store32(DATA, 0x9E00_1234);

    expect(mdec.load32(CTRL)).toBe(0x8784_1234);
    expect(mdec.busy).toBe(false);
  });

  it('decode command drives busy, parameter counter and request bits, then settles with the last-word flag', () => {
    const { mdec } = makeMdec();

    mdec.store32(CTRL, 0x6000_0000);
    mdec.store32(DATA, decodeCmd(1, 2));

    let s = mdec.load32(CTRL);
    expect((s >>> 29) & 1).toBe(1);
    expect((s >>> 28) & 1).toBe(1);
    expect((s >>> 25) & 3).toBe(1);
    expect((s >>> 16) & 7).toBe(4);
    expect(s & 0xFFFF).toBe(1);

    mdec.store32(DATA, 0xFE00_0400);
    mdec.store32(DATA, 0xFE00_FE00);

    expect(mdec.busy).toBe(true);
    const out = drain(mdec);
    expect(out.length).toBe(MB_WORDS_MONO_8BPP);
    for (const w of out) {
      expect(w).toBe(0x80808080);
    }
    expect(mdec.busy).toBe(false);
    s = mdec.load32(CTRL);
    expect(s >>> 31).toBe(1);
    expect((s >>> 30) & 1).toBe(1);
    expect(s & 0xFFFF).toBe(0xFFFF);
    expect((s >>> 28) & 1).toBe(0);
  });

  it('control reset aborts an open decode mid-stream and zeroes the output fifo', () => {
    const { mdec } = makeMdec();

    mdec.store32(CTRL, 0x6000_0000);
    mdec.store32(DATA, decodeCmd(1, 4));
    mdec.store32(DATA, 0xFE00_0400);
    mdec.store32(DATA, 0xFE00_0400);
    mdec.store32(CTRL, 0x8000_0000);

    expect(mdec.busy).toBe(false);
    expect(mdec.dmaReadWord()).toBe(0);
    expect(mdec.load32(CTRL)).toBe(0x80040000);
  });
});

describe('mdec block decode vectors', () => {
  it('RL-dequant + zigzag + IDCT on a mono macroblock (8bpp unsigned)', () => {
    const { mdec } = makeMdec();

    mdec.store32(CTRL, 0x6000_0000);
    mdec.store32(DATA, decodeCmd(1, 2));
    mdec.store32(DATA, 0x0464_0BFD);
    mdec.store32(DATA, 0xFE00_FE00);

    expect(drain(mdec)).toEqual([
      0xC5C5C5C5, 0xC5C5C5C5, 0xBABABABA, 0xBABABABA, 0xA7A7A7A7, 0xA7A7A7A7, 0x8D8D8D8D,
      0x8D8D8D8D, 0x71717171, 0x71717171, 0x58585858, 0x58585858, 0x44444444, 0x44444444,
      0x3A3A3A3A, 0x3A3A3A3A,
    ]);
  });

  it('halfword phase carries across word boundaries into a second macroblock', () => {
    const { mdec } = makeMdec();

    mdec.store32(CTRL, 0x6000_0000);
    mdec.store32(DATA, decodeCmd(1, 3));
    mdec.store32(DATA, 0x0464_0BFD);

    mdec.store32(DATA, 0x0405_FE00);
    mdec.store32(DATA, 0xFE00_FE00);

    const out = drain(mdec);
    expect(out.length).toBe(MB_WORDS_MONO_8BPP * 2);
    expect(out.slice(0, MB_WORDS_MONO_8BPP)).toEqual([
      0xC5C5C5C5, 0xC5C5C5C5, 0xBABABABA, 0xBABABABA, 0xA7A7A7A7, 0xA7A7A7A7, 0x8D8D8D8D,
      0x8D8D8D8D, 0x71717171, 0x71717171, 0x58585858, 0x58585858, 0x44444444, 0x44444444,
      0x3A3A3A3A, 0x3A3A3A3A,
    ]);

    const second = Array<number>(MB_WORDS_MONO_8BPP).fill(0x81818181);
    expect(out.slice(MB_WORDS_MONO_8BPP)).toEqual(second);
  });

  it('q_scale=0 special mode dequantizes *2 and places coefficients in natural order', () => {
    const { mdec } = makeMdec();

    mdec.store32(CTRL, 0x6000_0000);
    mdec.store32(DATA, decodeCmd(1, 2));
    mdec.store32(DATA, 0x0FCE_0002);
    mdec.store32(DATA, 0xFE00_FE00);

    const out = drain(mdec);
    expect(out.length).toBe(MB_WORDS_MONO_8BPP);
    for (const w of out) {
      expect(w).toBe(0x748D8D74);
    }
  });

  it('MDEC(2) luminance table upload shifts the dequant result', () => {
    const { mdec } = makeMdec();

    mdec.store32(CTRL, 0x6000_0000);
    uploadTables(mdec, tableWith0(6), null);

    expect((mdec.load32(CTRL) >>> 29) & 1).toBe(0);

    mdec.store32(DATA, decodeCmd(1, 1));
    mdec.store32(DATA, 0xFE00_040A);

    const out = drain(mdec);
    expect(out.length).toBe(MB_WORDS_MONO_8BPP);
    for (const w of out) {
      expect(w).toBe(0x88888888);
    }
  });

  it('non-standard scale table routes blocks through the 1024-multiply IDCT path', () => {
    const { mdec } = makeMdec();

    mdec.store32(CTRL, 0x6000_0000);
    mdec.store32(DATA, 0x6000_0000);
    for (let i = 0; i < 32; i++) {
      mdec.store32(DATA, 0x4000_4000);
    }

    mdec.store32(DATA, decodeCmd(1, 1));
    mdec.store32(DATA, 0xFE00_05FF);

    const out = drain(mdec);
    expect(out.length).toBe(MB_WORDS_MONO_8BPP);
    for (const w of out) {
      expect(w).toBe(0xC0C0C0C0);
    }
  });

  it('EOB-less stream-final block completes via word padding', () => {
    const { mdec } = makeMdec();

    mdec.store32(CTRL, 0x6000_0000);
    mdec.store32(DATA, decodeCmd(1, 2));

    mdec.store32(DATA, 0x0C32_0400);
    mdec.store32(DATA, 0xFE00_FE00);

    expect(drain(mdec)).toEqual([
      0x858E9498, 0x686C727B, 0x848C9194, 0x6C6F747C, 0x83888C8E, 0x7274787D, 0x81838485,
      0x7B7C7D7F, 0x7F7D7C7B, 0x85848381, 0x7D787472, 0x8E8C8883, 0x7C746F6C, 0x94918C84,
      0x7B726C68, 0x98948E85,
    ]);
  });
});

describe('mdec macroblock & DMA flow', () => {
  it('colored 15bpp macroblock yields 128 words; neutral chroma gives 0x4210, uv quant shapes chroma', () => {
    const { mdec } = makeMdec();

    mdec.store32(CTRL, 0x6000_0000);
    uploadTables(mdec, DEFAULT_TABLE, tableWith0(0x40));
    mdec.store32(DATA, decodeCmd(3, 18));
    const mbChroma: Array<Array<number>> = [
      [0xFE00_07FD, 0xFE00_07FD],
      [0xFE00_07FD, 0xFE00_0400],
      [0xFE00_0400, 0xFE00_07FD],
    ];
    for (const [cr, cb] of mbChroma) {
      mdec.store32(DATA, cr);
      mdec.store32(DATA, cb);
      for (let y = 0; y < 4; y++) {
        mdec.store32(DATA, 0xFE00_0400);
      }
    }

    const out = drain(mdec);
    expect(out.length).toBe(MB_WORDS_15BPP * 3);
    const mb1 = out.slice(0, MB_WORDS_15BPP);
    for (const w of mb1) {
      expect(w).toBe(0x2A6B2A6B);
    }
    const mb2 = out.slice(MB_WORDS_15BPP, 2 * MB_WORDS_15BPP);
    for (const w of mb2) {
      expect(w).toBe(0x424B424B);
    }
    const mb3 = out.slice(2 * MB_WORDS_15BPP);
    for (const w of mb3) {
      expect(w).toBe(0x2A302A30);
    }
  });

  it('15bpp macroblock is emitted as 16 raster rows of 16 pixels, with Y1..Y4 as the four quadrants', () => {
    const { mdec } = makeMdec();
    const gray15 = (level: number): number => {
      const c = (level + 128) >> 3;

      return (c << 10) | (c << 5) | c;
    };
    const quadrantDc = [0x00, 0x40, 0x80, 0xC0];

    mdec.store32(CTRL, 0x6000_0000);
    uploadTables(mdec, DEFAULT_TABLE, null);
    mdec.store32(DATA, decodeCmd(3, 6));
    mdec.store32(DATA, 0xFE00_0400);
    mdec.store32(DATA, 0xFE00_0400);
    for (const dc of quadrantDc) {
      mdec.store32(DATA, ((0xFE00 << 16) | dc) >>> 0);
    }

    const out = drain(mdec);
    const quadrantWord = (dc: number): number => {
      const half = gray15(dc / 4);

      return (half | (half << 16)) >>> 0;
    };
    expect(out.length).toBe(MB_WORDS_15BPP);
    for (let row = 0; row < 16; row++) {
      const left = quadrantWord(quadrantDc[row < 8 ? 0 : 2]);
      const right = quadrantWord(quadrantDc[row < 8 ? 1 : 3]);
      for (let j = 0; j < 4; j++) {
        expect(out[row * 8 + j]).toBe(left);
        expect(out[row * 8 + 4 + j]).toBe(right);
      }
    }
  });

  it('24bpp macroblock is emitted as 16 raster rows of 48 bytes', () => {
    const { mdec } = makeMdec();

    mdec.store32(CTRL, 0x6000_0000);
    uploadTables(mdec, DEFAULT_TABLE, null);
    mdec.store32(DATA, decodeCmd(2, 6));
    mdec.store32(DATA, 0xFE00_0400);
    mdec.store32(DATA, 0xFE00_0400);
    for (const dc of [0x00, 0x40, 0x80, 0xC0]) {
      mdec.store32(DATA, ((0xFE00 << 16) | dc) >>> 0);
    }

    const out = drain(mdec);
    const gray24 = (level: number): number => (level + 128) & 0xFF;
    expect(out.length).toBe(MB_WORDS_24BPP);
    const byteAt = (i: number): number => (out[i >> 2] >>> ((i & 3) * 8)) & 0xFF;
    const levels = [[0, 16], [32, 48]];
    for (let row = 0; row < 16; row++) {
      for (let x = 0; x < 16; x++) {
        const level = levels[row >> 3][x >> 3];
        const base = row * 48 + x * 3;
        expect([byteAt(base), byteAt(base + 1), byteAt(base + 2)]).toEqual([gray24(level), gray24(level), gray24(level)]);
      }
    }
  });

  it('status current-block bits walk Y1..Y4 while the macroblock output drains', () => {
    const { mdec } = makeMdec();

    mdec.store32(CTRL, 0x6000_0000);
    uploadTables(mdec, DEFAULT_TABLE, null);
    mdec.store32(DATA, decodeCmd(3, 6));
    for (let b = 0; b < 6; b++) {
      mdec.store32(DATA, 0xFE00_0400);
    }

    expect(mdec.busy).toBe(true);
    for (let j = 0; j < 32; j++) {
      expect((mdec.load32(CTRL) >>> 16) & 7).toBe(0);
      mdec.dmaReadWord();
    }
    for (let j = 0; j < 32; j++) {
      expect((mdec.load32(CTRL) >>> 16) & 7).toBe(1);
      mdec.dmaReadWord();
    }
    for (let j = 0; j < 64; j++) {
      mdec.dmaReadWord();
    }

    expect(mdec.busy).toBe(false);
  });

  it('the whole 320x240 STR frame streams through chunked DMA0 and produces 38400 gray words, quant re-set between frames', () => {
    const { mdec, irq } = makeMdec();
    const ram = makeRam();

    mdec.store32(CTRL, 0x6000_0000);

    const frameWords: Array<number> = [];
    frameWords.push(0x4000_0001);
    frameWords.push(...encodeTable(DEFAULT_TABLE));
    frameWords.push(...encodeTable(tableWith0(0x40)));
    frameWords.push(decodeCmd(3, 1800));
    for (let mb = 0; mb < 300; mb++) {
      frameWords.push(0xFE00_07FD);
      frameWords.push(0xFE00_07FD);
      for (let y = 0; y < 4; y++) {
        frameWords.push(0xFE00_0400);
      }
    }
    fillRam(ram, 0, frameWords);
    dmaIn(mdec, ram, DMA_BASE, 33);
    expect(mdec.busy).toBe(false);

    dmaIn(mdec, ram, DMA_BASE + 33 * 4, 1801);
    const out = drain(mdec);
    expect(out.length).toBe(38400);
    for (let i = 0; i < out.length; i += 2047) {
      expect(out[i]).toBe(0x2A6B2A6B);
    }
    expect(out[38399]).toBe(0x2A6B2A6B);
    expect(mdec.busy).toBe(false);
    expect(irq.dmaCompletions).toEqual([0, 0]);
  });

  it('24bpp mode emits 192 words per macroblock as RGB byte pairs', () => {
    const { mdec } = makeMdec();

    mdec.store32(CTRL, 0x6000_0000);
    uploadTables(mdec, DEFAULT_TABLE, tableWith0(0x40));
    mdec.store32(DATA, decodeCmd(2, 12));
    for (let b = 0; b < 6; b++) {
      mdec.store32(DATA, 0xFE00_0400);
    }
    mdec.store32(DATA, 0xFE00_07FD);
    for (let b = 0; b < 5; b++) {
      mdec.store32(DATA, 0xFE00_0400);
    }

    const out = drain(mdec);
    expect(out.length).toBe(MB_WORDS_24BPP * 2);
    for (const w of out.slice(0, MB_WORDS_24BPP)) {
      expect(w).toBe(0x80808080);
    }
    const pattern = [0x5E80915E, 0x915E8091, 0x80915E80];
    for (let i = 0; i < MB_WORDS_24BPP; i++) {
      expect(out[MB_WORDS_24BPP + i]).toBe(pattern[i % 3]);
    }
  });

  it('dma0 is refused until the data-in request enable is set, but still completes the channel', () => {
    const { mdec, irq } = makeMdec();
    const ram = makeRam();

    fillRam(ram, 0, [decodeCmd(1, 1), 0xFE00_0464]);
    mdec.store32(CTRL, 0x2000_0000);
    dmaIn(mdec, ram, DMA_BASE, 2);

    expect(mdec.busy).toBe(false);
    expect(mdec.dmaReadWord()).toBe(0);
    expect(irq.dmaCompletions).toEqual([0]);

    mdec.store32(CTRL, 0x4000_0000);
    dmaIn(mdec, ram, DMA_BASE, 2);
    const out = drain(mdec);
    expect(out.length).toBe(MB_WORDS_MONO_8BPP);
    for (const w of out) {
      expect(w).toBe(0x99999999);
    }
  });

  it('dmaReadWord on an empty fifo returns 0 repeatedly without corrupting later decodes', () => {
    const { mdec } = makeMdec();

    for (let i = 0; i < 10; i++) {
      expect(mdec.dmaReadWord()).toBe(0);
    }
    expect(mdec.busy).toBe(false);

    mdec.store32(CTRL, 0x6000_0000);
    mdec.store32(DATA, decodeCmd(1, 1));
    mdec.store32(DATA, 0xFE00_0464);

    const out = drain(mdec);
    expect(out.length).toBe(MB_WORDS_MONO_8BPP);
    for (const w of out) {
      expect(w).toBe(0x99999999);
    }
  });

  it('dmaStart on channels other than 0 is a no-op (bus bridges ch1 via dmaReadWord)', () => {
    const { mdec } = makeMdec();

    mdec.dmaStart(CH1, makeCfg(DMA_BASE, 8), makeRam());

    expect(mdec.busy).toBe(false);
    expect(mdec.dmaReadWord()).toBe(0);
  });
});

describe('mdec saturation edges', () => {
  it('dequant clamps to the signed 11-bit range before the scale premultiply', () => {
    const { mdec } = makeMdec();

    mdec.store32(CTRL, 0x6000_0000);
    mdec.store32(DATA, decodeCmd(1, 2));
    mdec.store32(DATA, 0x05FF_FC00);
    mdec.store32(DATA, 0xFE00_FE00);

    expect(drain(mdec)).toEqual([
      0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xE4E4E4E4, 0xE4E4E4E4, 0xA3A3A3A3,
      0xA3A3A3A3, 0x5D5D5D5D, 0x5D5D5D5D, 0x1C1C1C1C, 0x1C1C1C1C, 0x00000000, 0x00000000,
      0x00000000, 0x00000000,
    ]);
  });
});