import { test, expect } from 'bun:test';
import { GpuCore } from './gpu';
import { RingLogger } from './logger';
import { IrqRouter } from './irq';
import type { DmaChannel, DmaConfig, Scheduler } from './contracts';

const noopScheduler: Scheduler = {
  get now(): number {
    return 0;
  },
  at(): object {
    return {};
  },
  cancel(): void {},
};

const GPU_DMA_CHANNEL: DmaChannel = { id: 2 };

function make(): GpuCore {
  return new GpuCore(noopScheduler, new RingLogger(), new IrqRouter());
}

function px(gpu: GpuCore, x: number, y: number): number {
  return gpu.vram[((y & 511) << 10) | (x & 1023)];
}

function put(gpu: GpuCore, x: number, y: number, value: number): void {
  gpu.vram[((y & 511) << 10) | (x & 1023)] = value;
}

function gp0(gpu: GpuCore, words: Array<number>): void {
  for (const word of words) {
    gpu.store32(0x1f80_1810, word >>> 0);
  }
}

function gp1(gpu: GpuCore, word: number): void {
  gpu.store32(0x1f80_1814, word >>> 0);
}

function gpustat(gpu: GpuCore): number {
  return gpu.load32(0x1f80_1814) >>> 0;
}

function gpuread(gpu: GpuCore): number {
  return gpu.load32(0x1f80_1810) >>> 0;
}

function setArea(gpu: GpuCore, x1: number, y1: number, x2: number, y2: number): void {
  gp0(gpu, [0xe3_000000 | (y1 << 10) | x1, 0xe4_000000 | (y2 << 10) | x2]);
}

function vertex(x: number, y: number): number {
  return ((y << 16) | x) >>> 0;
}

function texcoord(u: number, v: number, attr: number): number {
  return (((attr & 0xffff) << 16) | ((v & 0xff) << 8) | (u & 0xff)) >>> 0;
}

const CLUT_ATTR = 1 | (100 << 6);
const TPAGE_4BPP = 1;
const TPAGE_8BPP = 0x01 | (1 << 4) | (1 << 7);
const TPAGE_15BPP = 0x01 | (2 << 7);

function setup4bppPage(gpu: GpuCore): void {
  gp0(gpu, [0xe1_000001]);
  for (let i = 0; i < 16; i++) {
    put(gpu, 16 + i, 100, 0);
  }
  put(gpu, 16, 100, 0x001f);
  put(gpu, 17, 100, 0x03e0);
  put(gpu, 18, 100, 0x7c00);
  put(gpu, 19, 100, 0x7fff);
  put(gpu, 31, 100, 0x03ff);
  for (let y = 0; y < 41; y++) {
    for (let i = 0; i < 64; i++) {
      put(gpu, 64 + i, y, 0x3210);
    }
  }
}

function setup8bppPage(gpu: GpuCore): void {
  for (let i = 0; i < 256; i++) {
    put(gpu, 16 + i, 100, 0);
  }
  put(gpu, 18, 100, 0x001f);
  put(gpu, 19, 100, 0x7fff);
  put(gpu, 20, 100, 0x7c00);
  put(gpu, 21, 100, 0x03e0);
  for (let y = 0; y < 41; y++) {
    for (let i = 0; i < 45; i++) {
      put(gpu, 64 + i, 256 + y, (i & 1) === 0 ? 0x0302 : 0x0504);
    }
  }
}

function setup15bppPage(gpu: GpuCore): void {
  for (let y = 0; y < 41; y++) {
    for (let i = 0; i < 45; i++) {
      put(gpu, 64 + i, y, 0);
    }
  }
}

function drawTexturedTriangle(gpu: GpuCore, cmd: number, color: number, tpage: number): void {
  gp0(gpu, [
    (cmd << 24) | color,
    vertex(0, 0),
    texcoord(0, 0, CLUT_ATTR),
    vertex(40, 0),
    texcoord(40, 0, tpage),
    vertex(0, 40),
    texcoord(0, 40, 0),
  ]);
}

test('fill rectangle applies the documented masking and rounding', () => {
  const gpu = make();
  gp0(gpu, [0x02_0000ff, 0x0000_0123, (1 << 16) | 0x21]);
  expect(px(gpu, 0x11f, 0)).toBe(0);
  expect(px(gpu, 0x120, 0)).toBe(0x001f);
  expect(px(gpu, 0x120 + 0x2f, 0)).toBe(0x001f);
  expect(px(gpu, 0x120 + 0x30, 0)).toBe(0);
});

test('fill rectangle rounds widths up to 0x400 and wraps inside the row', () => {
  const gpu = make();
  gp0(gpu, [0x02_0000ff, 0x0000_0010, (1 << 16) | 0x3f1]);
  expect(px(gpu, 0x10, 0)).toBe(0x001f);
  expect(px(gpu, 0x10 + 0x3ee, 0)).toBe(0x001f);
  expect(px(gpu, 0x0f, 0)).toBe(0x001f);
  expect(px(gpu, 0, 0)).toBe(0x001f);
  expect(px(gpu, 0x10, 1)).toBe(0);
});

test('fill rectangle is a no-op for zero sized widths and heights', () => {
  const gpu = make();
  put(gpu, 0, 0, 0x1234);
  gp0(gpu, [0x02_0000ff, 0, (1 << 16) | 0]);
  expect(px(gpu, 0, 0)).toBe(0x1234);
  gp0(gpu, [0x02_0000ff, 0, 0x0001_0000]);
  expect(px(gpu, 0, 0)).toBe(0x1234);
});

test('fill ignores the drawing area and the write mask', () => {
  const gpu = make();
  setArea(gpu, 10, 10, 20, 20);
  gp0(gpu, [0xe6_000003]);
  gp0(gpu, [0x02_00ff00, 0, (1 << 16) | 0x20]);
  expect(px(gpu, 0, 0)).toBe(0x03e0);
  expect(px(gpu, 0x1f, 0)).toBe(0x03e0);
});

test('solid triangle keeps the top-left edge and excludes the lower right', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  gp0(gpu, [0x20_0000ff, vertex(0, 0), vertex(10, 0), vertex(0, 10)]);
  expect(px(gpu, 0, 0)).toBe(0x001f);
  expect(px(gpu, 8, 0)).toBe(0x001f);
  expect(px(gpu, 9, 0)).toBe(0);
  expect(px(gpu, 10, 0)).toBe(0);
  expect(px(gpu, 0, 8)).toBe(0x001f);
  expect(px(gpu, 1, 8)).toBe(0);
  expect(px(gpu, 0, 10)).toBe(0);
  expect(px(gpu, 4, 4)).toBe(0x001f);
  expect(px(gpu, 5, 4)).toBe(0);
  expect(px(gpu, 9, 9)).toBe(0);
});

test('triangles exceeding the maximum vertex distance are not rendered', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  gp0(gpu, [0x20_0000ff, vertex(0, 0), vertex(0, 512), vertex(200, 0)]);
  expect(px(gpu, 0, 0)).toBe(0);
  gp0(gpu, [0x20_0000ff, vertex(0, 0), vertex(0, 511), vertex(300, 0)]);
  expect(px(gpu, 0, 0)).toBe(0x001f);
});

test('triangles clip to the drawing area', () => {
  const gpu = make();
  setArea(gpu, 4, 4, 7, 7);
  gp0(gpu, [0x20_0000ff, vertex(0, 0), vertex(100, 0), vertex(0, 100)]);
  expect(px(gpu, 3, 4)).toBe(0);
  expect(px(gpu, 4, 4)).toBe(0x001f);
  expect(px(gpu, 7, 7)).toBe(0x001f);
  expect(px(gpu, 8, 7)).toBe(0);
});

test('textured quad maps 4bpp texels through the clut', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  setup4bppPage(gpu);
  drawTexturedTriangle(gpu, 0x24, 0x808080, TPAGE_4BPP);
  expect(px(gpu, 0, 8)).toBe(0x001f);
  expect(px(gpu, 1, 8)).toBe(0x03e0);
  expect(px(gpu, 2, 8)).toBe(0x7c00);
  expect(px(gpu, 3, 8)).toBe(0x7fff);
  expect(px(gpu, 4, 8)).toBe(0x001f);
  expect(px(gpu, 5, 8)).toBe(0x03e0);
});

test('texture blending scales texels by the command color', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  setup4bppPage(gpu);
  drawTexturedTriangle(gpu, 0x24, 0x404040, TPAGE_4BPP);
  expect(px(gpu, 3, 8)).toBe(0x3def);
});

test('raw texture polygons ignore the command color', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  setup4bppPage(gpu);
  drawTexturedTriangle(gpu, 0x25, 0x204060, TPAGE_4BPP);
  expect(px(gpu, 3, 8)).toBe(0x7fff);
});

test('8bpp textures read the clut by texel byte', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  gp0(gpu, [0xe1_000091]);
  setup8bppPage(gpu);
  drawTexturedTriangle(gpu, 0x24, 0x808080, TPAGE_8BPP);
  expect(px(gpu, 0, 8)).toBe(0x001f);
  expect(px(gpu, 1, 8)).toBe(0x7fff);
  expect(px(gpu, 2, 8)).toBe(0x7c00);
  expect(px(gpu, 3, 8)).toBe(0x03e0);
});

test('15bpp textures are read directly and keep the semi transparency bit', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  gp0(gpu, [0xe1_000101]);
  setup15bppPage(gpu);
  put(gpu, 64, 8, 0x7c00);
  put(gpu, 65, 8, 0x8000);
  put(gpu, 66, 8, 0x03e0);
  drawTexturedTriangle(gpu, 0x24, 0x808080, TPAGE_15BPP);
  expect(px(gpu, 0, 8)).toBe(0x7c00);
  expect(px(gpu, 1, 8)).toBe(0x8000);
  expect(px(gpu, 2, 8)).toBe(0x03e0);
  expect(px(gpu, 3, 8)).toBe(0);
});

function blendCase(stMode: number, destination: number, texel: number, expected: number): void {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  setup15bppPage(gpu);
  put(gpu, 64, 8, texel);
  put(gpu, 0, 8, destination);
  drawTexturedTriangle(gpu, 0x26, 0x808080, TPAGE_15BPP | (stMode << 5));
  expect(px(gpu, 0, 8)).toBe(expected);
}

test('semi transparency mode 0 averages destination and source', () => {
  blendCase(0, 0x001f, 0xffff, 0xbdff);
});

test('semi transparency mode 1 adds and saturates', () => {
  blendCase(1, 0x03e0, 0xffff, 0xffff);
});

test('semi transparency mode 2 subtracts and clamps at zero', () => {
  blendCase(2, 0x7fff, 0x801f, 0xffe0);
});

test('semi transparency mode 3 adds a quarter of the source', () => {
  blendCase(3, 0x001f, 0xffff, 0x9cff);
});

test('opaque texture commands never blend', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  gp0(gpu, [0xe1_000101]);
  setup15bppPage(gpu);
  put(gpu, 64, 8, 0xffff);
  put(gpu, 0, 8, 0x001f);
  drawTexturedTriangle(gpu, 0x24, 0x808080, TPAGE_15BPP);
  expect(px(gpu, 0, 8)).toBe(0xffff);
});

test('force mask sets bit 15 on every drawn pixel', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  gp0(gpu, [0xe6_000001]);
  gp0(gpu, [0x60_0000ff, vertex(0, 0), (1 << 16) | 2]);
  expect(px(gpu, 0, 0)).toBe(0x801f);
  expect(px(gpu, 1, 0)).toBe(0x801f);
  expect(px(gpu, 2, 0)).toBe(0);
});

test('mask check protects pixels with bit 15 set', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  put(gpu, 0, 0, 0x801f);
  gp0(gpu, [0xe6_000002]);
  gp0(gpu, [0x60_00ff00, vertex(0, 0), (1 << 16) | 2]);
  expect(px(gpu, 0, 0)).toBe(0x801f);
  expect(px(gpu, 1, 0)).toBe(0x03e0);
});

test('texture window folds texture coordinates back into the window', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  setup4bppPage(gpu);
  put(gpu, 66, 8, 0x0001);
  drawTexturedTriangle(gpu, 0x24, 0x808080, TPAGE_4BPP);
  expect(px(gpu, 8, 8)).toBe(0x03e0);
  gp0(gpu, [0xe2_000000 | 0x1f]);
  drawTexturedTriangle(gpu, 0x24, 0x808080, TPAGE_4BPP);
  expect(px(gpu, 8, 8)).toBe(0x001f);
});

test('cpu to vram then vram to cpu roundtrip keeps halfword order', () => {
  const gpu = make();
  gp0(gpu, [0xa0_000000, vertex(0x40, 0x20), (2 << 16) | 3]);
  gp0(gpu, [0x2222_1111, 0x4444_3333, 0x6666_5555]);
  expect(px(gpu, 0x40, 0x20)).toBe(0x1111);
  expect(px(gpu, 0x41, 0x20)).toBe(0x2222);
  expect(px(gpu, 0x42, 0x20)).toBe(0x3333);
  expect(px(gpu, 0x40, 0x21)).toBe(0x4444);
  expect(px(gpu, 0x42, 0x21)).toBe(0x6666);

  gp0(gpu, [0xc0_000000, vertex(0x40, 0x20), (2 << 16) | 3]);
  expect(gpuread(gpu)).toBe(0x2222_1111);
  expect(gpuread(gpu)).toBe(0x4444_3333);
  expect(gpuread(gpu)).toBe(0x6666_5555);
  expect((gpustat(gpu) & 0x0800_0000) === 0).toBe(true);
});

test('odd width vram to cpu transfer pads with one halfword', () => {
  const gpu = make();
  put(gpu, 0, 0, 0xaaaa);
  put(gpu, 1, 0, 0xbbbb);
  put(gpu, 2, 0, 0xcccc);
  gp0(gpu, [0xc0_000000, vertex(0, 0), (1 << 16) | 3]);
  expect((gpustat(gpu) & 0x0800_0000) !== 0).toBe(true);
  expect(gpuread(gpu)).toBe(0xbbbb_aaaa);
  expect(gpuread(gpu)).toBe(0x0000_cccc);
  expect((gpustat(gpu) & 0x0800_0000) === 0).toBe(true);
});

test('vram to vram copy handles overlap and the copy size masking', () => {
  const gpu = make();
  for (let i = 0; i < 8; i++) {
    put(gpu, i, 0, 0x100 + i);
  }
  gp0(gpu, [0x80_000000, vertex(0, 0), vertex(4, 0), (1 << 16) | 4]);
  expect(px(gpu, 4, 0)).toBe(0x100);
  expect(px(gpu, 5, 0)).toBe(0x101);
  expect(px(gpu, 6, 0)).toBe(0x102);
  expect(px(gpu, 7, 0)).toBe(0x103);

  gp0(gpu, [0x80_000000, vertex(4, 0), vertex(0, 0), (1 << 16) | 4]);
  expect(px(gpu, 0, 0)).toBe(0x100);
  expect(px(gpu, 3, 0)).toBe(0x103);
  expect(px(gpu, 4, 0)).toBe(0x100);

  gp0(gpu, [0x80_000000, vertex(0, 0), vertex(0, 5), (1 << 16) | 0]);
  expect(px(gpu, 0, 5)).toBe(0x100);
  expect(px(gpu, 7, 5)).toBe(0x103);
  expect(px(gpu, 8, 5)).toBe(0);
});

test('gp1 info reads return the latched attribute registers', () => {
  const gpu = make();
  gp0(gpu, [0xe3_000000 | (12 << 10) | 34, 0xe4_000000 | (200 << 10) | 300]);
  gp0(gpu, [0xe5_000000 | (0x400 | 5) | (6 << 11)]);
  gp0(gpu, [0xe2_000000 | (0x0f | (0x07 << 5) | (0x1f << 10) | (0x03 << 15))]);
  gp1(gpu, 0x1000_0003);
  expect(gpuread(gpu)).toBe((12 << 10) | 34);
  gp1(gpu, 0x1000_0004);
  expect(gpuread(gpu)).toBe((200 << 10) | 300);
  gp1(gpu, 0x1000_0005);
  expect(gpuread(gpu)).toBe(((6 & 0x7ff) << 11) | ((0x400 | 5) & 0x7ff));
  gp1(gpu, 0x1000_0002);
  expect(gpuread(gpu)).toBe((0x03 << 15) | (0x1f << 10) | (0x07 << 5) | 0x0f);
  gp1(gpu, 0x1000_0007);
  expect(gpuread(gpu)).toBe(2);
});

test('reset produces the documented gpustat and draw mode mirrors it', () => {
  const gpu = make();
  gp1(gpu, 0);
  expect(gpustat(gpu)).toBe(0x1480_2000);
  gp0(gpu, [0xe1_000000 | 0x0321]);
  const stat = gpustat(gpu);
  expect(stat & 0x1f).toBe(1);
  expect((stat >>> 5) & 3).toBe(1);
  expect((stat >>> 7) & 3).toBe(2);
  expect((stat >>> 9) & 1).toBe(1);
  expect((stat >>> 13) & 1).toBe(1);
  gp1(gpu, 0x0400_0002);
  const dma = gpustat(gpu);
  expect((dma >>> 29) & 3).toBe(2);
  expect((dma >>> 25) & 1).toBe(1);
  expect((dma >>> 28) & 1).toBe(1);
  gp1(gpu, 0x0300_0000);
  expect((gpustat(gpu) >>> 23) & 1).toBe(0);
});

test('irq1 is requested by gp0 1f and acknowledged by gp1 02', () => {
  const gpu = make();
  gp0(gpu, [0x1f_000000]);
  expect((gpustat(gpu) >>> 24) & 1).toBe(1);
  gp1(gpu, 0x0200_0000);
  expect((gpustat(gpu) >>> 24) & 1).toBe(0);
});

test('present crops the display area and converts 15bit to 8bit', () => {
  const gpu = make();
  gp1(gpu, 0);
  gp1(gpu, 0x0500_0000);
  gp1(gpu, 0x0600_0000 | (0x0c60 << 12) | 0x260);
  gp1(gpu, 0x0700_0000 | (0x100 << 10) | 0x10);
  gp1(gpu, 0x0800_0001);
  gp1(gpu, 0x0300_0000);
  put(gpu, 0, 0, 0x7fff);
  put(gpu, 319, 0, 0x001f);
  put(gpu, 0, 239, 0x03e0);
  const frame = gpu.present();
  expect(frame.width).toBe(320);
  expect(frame.height).toBe(240);
  expect(frame.rgba[0]).toBe(255);
  expect(frame.rgba[1]).toBe(255);
  expect(frame.rgba[2]).toBe(255);
  expect(frame.rgba[3]).toBe(255);
  expect(frame.rgba[319 * 4]).toBe(255);
  expect(frame.rgba[319 * 4 + 1]).toBe(0);
  expect(frame.rgba[239 * 320 * 4 + 1]).toBe(255);
  expect(frame.rgba[240 * 320 * 4]).toBe(0);
});

test('present supports 368 wide fmv mode and 24bit color depth', () => {
  const gpu = make();
  gp1(gpu, 0);
  gp1(gpu, 0x0500_0000);
  gp1(gpu, 0x0600_0000 | (0x0c70 << 12) | 0x260);
  gp1(gpu, 0x0700_0000 | (0x100 << 10) | 0x10);
  gp1(gpu, 0x0800_0041);
  gp1(gpu, 0x0300_0000);
  expect(gpu.present().width).toBe(368);

  gp1(gpu, 0x0800_0011);
  put(gpu, 0, 0, 0x2211);
  put(gpu, 1, 0, 0x0033);
  const frame = gpu.present();
  expect(frame.rgba[0]).toBe(0x11);
  expect(frame.rgba[1]).toBe(0x22);
  expect(frame.rgba[2]).toBe(0x33);
  expect(frame.rgba[3]).toBe(255);
});

test('display off presents a black frame', () => {
  const gpu = make();
  gp1(gpu, 0);
  put(gpu, 0, 0, 0x7fff);
  const frame = gpu.present();
  expect(frame.rgba[0]).toBe(0);
  expect(frame.rgba[1]).toBe(0);
});

function linkedConfig(base: number): DmaConfig {
  return {
    base: base,
    wordsPerBlock: 0,
    blockCount: 0,
    step: 4,
    direction: 'toDevice',
    mode: 'linked',
    chopper: false,
    enable: true,
  };
}

test('dma2 linked list executes packets and stops at the end code', () => {
  const irq = new IrqRouter();
  const done: Array<number> = [];
  irq.dmaDoneSink = (channel: number): void => {
    done.push(channel);
  };
  const gpu = new GpuCore(noopScheduler, new RingLogger(), irq);
  setArea(gpu, 0, 0, 1023, 511);
  const ram = new Uint32Array(0x0008_0000);
  const head = 0x1000;
  const tail = 0x2000;
  const prim = [0x20_0000ff, vertex(0, 0), vertex(10, 0), vertex(0, 10)];
  ram[head >> 2] = ((4 << 24) | tail) >>> 0;
  for (let i = 0; i < prim.length; i++) {
    ram[(head >> 2) + 1 + i] = prim[i] >>> 0;
  }
  ram[tail >> 2] = 0x00ff_ffff;
  gpu.dmaStart(GPU_DMA_CHANNEL, linkedConfig(head), ram);
  expect(px(gpu, 0, 0)).toBe(0x001f);
  expect(px(gpu, 8, 0)).toBe(0x001f);
  expect(px(gpu, 9, 0)).toBe(0);
  expect(done).toEqual([2]);
});

test('dma2 linked list follows the chain through several packets', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  const ram = new Uint32Array(0x0008_0000);
  const first = 0x1000;
  const second = 0x1100;
  ram[second >> 2] = ((4 << 24) | 0x00ff_ffff) >>> 0;
  const primA = [0x60_0000ff, vertex(0, 0), (1 << 16) | 2];
  const primB = [0x60_00ff00, vertex(4, 0), (1 << 16) | 2];
  for (let i = 0; i < primA.length; i++) {
    ram[(second >> 2) + 1 + i] = primA[i] >>> 0;
  }
  ram[first >> 2] = ((3 << 24) | second) >>> 0;
  for (let i = 0; i < primB.length; i++) {
    ram[(first >> 2) + 1 + i] = primB[i] >>> 0;
  }
  gpu.dmaStart(GPU_DMA_CHANNEL, linkedConfig(first), ram);
  expect(px(gpu, 0, 0)).toBe(0x001f);
  expect(px(gpu, 4, 0)).toBe(0x03e0);
});

test('dma2 continuous mode feeds gp0 words and records completion', () => {
  const irq = new IrqRouter();
  const done: Array<number> = [];
  irq.dmaDoneSink = (channel: number): void => {
    done.push(channel);
  };
  const gpu = new GpuCore(noopScheduler, new RingLogger(), irq);
  setArea(gpu, 0, 0, 1023, 511);
  const ram = new Uint32Array(0x0008_0000);
  const prim = [0x20_0000ff, vertex(0, 0), vertex(10, 0), vertex(0, 10)];
  for (let i = 0; i < prim.length; i++) {
    ram[(0x3000 >> 2) + i] = prim[i] >>> 0;
  }
  gpu.dmaStart(GPU_DMA_CHANNEL, {
    base: 0x3000,
    wordsPerBlock: 4,
    blockCount: 1,
    step: 4,
    direction: 'toDevice',
    mode: 'manual',
    chopper: false,
    enable: true,
  }, ram);
  expect(px(gpu, 0, 0)).toBe(0x001f);
  expect(done).toEqual([2]);
});

test('dma2 to gpu feeds consecutive ram words into a cpu-to-vram upload', () => {
  const gpu = make();
  const ram = new Uint32Array(0x0008_0000);
  const upload = [0xa0_000000, vertex(0, 0), (2 << 16) | 4, 0x2222_1111, 0x4444_3333, 0x6666_5555, 0x8888_7777];
  for (let i = 0; i < upload.length; i++) {
    ram[(0x5000 >> 2) + i] = upload[i] >>> 0;
  }
  gpu.dmaStart(GPU_DMA_CHANNEL, {
    base: 0x5000,
    wordsPerBlock: upload.length,
    blockCount: 1,
    step: 4,
    direction: 'toDevice',
    mode: 'manual',
    chopper: false,
    enable: true,
  }, ram);
  expect([px(gpu, 0, 0), px(gpu, 1, 0), px(gpu, 2, 0), px(gpu, 3, 0)]).toEqual([0x1111, 0x2222, 0x3333, 0x4444]);
  expect([px(gpu, 0, 1), px(gpu, 1, 1), px(gpu, 2, 1), px(gpu, 3, 1)]).toEqual([0x5555, 0x6666, 0x7777, 0x8888]);
});

test('dma2 from gpu drains a pending vram read into ram', () => {
  const gpu = make();
  const ram = new Uint32Array(0x0008_0000);
  put(gpu, 0, 0, 0x1111);
  put(gpu, 1, 0, 0x2222);
  put(gpu, 2, 0, 0x3333);
  put(gpu, 3, 0, 0x4444);
  gp0(gpu, [0xc0_000000, vertex(0, 0), (1 << 16) | 4]);
  gpu.dmaStart(GPU_DMA_CHANNEL, {
    base: 0x4000,
    wordsPerBlock: 2,
    blockCount: 1,
    step: 4,
    direction: 'toRam',
    mode: 'manual',
    chopper: false,
    enable: true,
  }, ram);
  expect(ram[0x1000]).toBe(0x2222_1111);
  expect(ram[0x1001]).toBe(0x4444_3333);
});

test('rectangles honour the odd texcoord x bug for 4bpp sources', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  setup4bppPage(gpu);
  put(gpu, 127, 0, 0xf000);
  gp0(gpu, [0x64_808080, vertex(0, 0), texcoord(0, 0, CLUT_ATTR), (1 << 16) | 4]);
  expect(px(gpu, 0, 0)).toBe(0x03ff);
  expect(px(gpu, 1, 0)).toBe(0x001f);
  expect(px(gpu, 2, 0)).toBe(0x03e0);
  expect(px(gpu, 3, 0)).toBe(0x7c00);

  gp0(gpu, [0x64_808080, vertex(10, 0), texcoord(1, 0, CLUT_ATTR), (1 << 16) | 4]);
  expect(px(gpu, 10, 0)).toBe(0x03e0);
  expect(px(gpu, 11, 0)).toBe(0x7c00);
  expect(px(gpu, 12, 0)).toBe(0x7fff);
  expect(px(gpu, 13, 0)).toBe(0x001f);
});

test('rectangles support x flip and never dither', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  setup4bppPage(gpu);
  gp0(gpu, [0xe1_000001 | (1 << 9) | (1 << 12)]);
  gp0(gpu, [0x64_808080, vertex(20, 0), texcoord(3, 0, CLUT_ATTR), (1 << 16) | 4]);
  expect(px(gpu, 20, 0)).toBe(0x7fff);
  expect(px(gpu, 21, 0)).toBe(0x7c00);
  expect(px(gpu, 22, 0)).toBe(0x03e0);
  expect(px(gpu, 23, 0)).toBe(0x001f);
});

test('fixed size rectangle variants draw their documented sizes', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  gp0(gpu, [0x68_0000ff, vertex(0, 0)]);
  expect(px(gpu, 0, 0)).toBe(0x001f);
  expect(px(gpu, 1, 0)).toBe(0);
  gp0(gpu, [0x70_0000ff, vertex(4, 4)]);
  expect(px(gpu, 4, 4)).toBe(0x001f);
  expect(px(gpu, 11, 11)).toBe(0x001f);
  expect(px(gpu, 12, 12)).toBe(0);
  gp0(gpu, [0x78_0000ff, vertex(20, 20)]);
  expect(px(gpu, 35, 35)).toBe(0x001f);
  expect(px(gpu, 36, 36)).toBe(0);
});

test('rectangles clip to the drawing area', () => {
  const gpu = make();
  setArea(gpu, 2, 2, 5, 5);
  gp0(gpu, [0x60_0000ff, vertex(0, 0), (10 << 16) | 10]);
  expect(px(gpu, 1, 1)).toBe(0);
  expect(px(gpu, 2, 2)).toBe(0x001f);
  expect(px(gpu, 5, 5)).toBe(0x001f);
  expect(px(gpu, 6, 6)).toBe(0);
});

test('dithering follows the hardware 4x4 matrix on gouraud polygons', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  gp0(gpu, [0xe1_000000 | (1 << 9)]);
  gp0(gpu, [
    0x30_909090,
    vertex(0, 0), 0x00_909090,
    vertex(100, 0), 0x00_909090,
    vertex(0, 100),
  ]);
  const high = 18 | (18 << 5) | (18 << 10);
  const low = 17 | (17 << 5) | (17 << 10);
  expect(px(gpu, 0, 0)).toBe(low);
  expect(px(gpu, 1, 0)).toBe(high);
  expect(px(gpu, 2, 0)).toBe(low);
  expect(px(gpu, 3, 0)).toBe(high);
  expect(px(gpu, 0, 1)).toBe(high);
  expect(px(gpu, 1, 1)).toBe(low);
  expect(px(gpu, 2, 1)).toBe(high);
  expect(px(gpu, 3, 1)).toBe(low);
});

test('monochrome polygons are never dithered', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  gp0(gpu, [0xe1_000000 | (1 << 9)]);
  gp0(gpu, [0x20_909090, vertex(0, 0), vertex(100, 0), vertex(0, 100)]);
  const flat = 18 | (18 << 5) | (18 << 10);
  expect(px(gpu, 0, 0)).toBe(flat);
  expect(px(gpu, 2, 1)).toBe(flat);
});

test('lines are drawn inclusive of the lower right end point', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  gp0(gpu, [0x40_0000ff, vertex(0, 5), vertex(9, 5)]);
  expect(px(gpu, 0, 5)).toBe(0x001f);
  expect(px(gpu, 9, 5)).toBe(0x001f);
  expect(px(gpu, 10, 5)).toBe(0);
  gp0(gpu, [0x48_0000ff, vertex(0, 10), vertex(4, 10), vertex(4, 14), 0x5555_5555]);
  expect(px(gpu, 4, 10)).toBe(0x001f);
  expect(px(gpu, 4, 14)).toBe(0x001f);
  expect(px(gpu, 2, 10)).toBe(0x001f);
  expect(px(gpu, 5, 14)).toBe(0);
});

test('shaded lines interpolate colors between the end points', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  gp0(gpu, [0x50_000000, vertex(0, 3), 0x00_0000ff, vertex(8, 3)]);
  expect(px(gpu, 0, 3)).toBe(0x0000);
  expect(px(gpu, 8, 3)).toBe(0x001f);
  expect(px(gpu, 4, 3) & 0x1f).toBeGreaterThan(0);
  expect(px(gpu, 4, 3) & 0x1f).toBeLessThan(0x1f);
});

function drawBenchTriangles(gpu: GpuCore): void {
  for (let i = 0; i < 2000; i++) {
    const x = (i % 30) * 32;
    const y = (Math.floor(i / 30) % 15) * 16;
    gp0(gpu, [
      0x24_808080,
      vertex(x, y),
      texcoord(0, 0, CLUT_ATTR),
      vertex(x + 32, y),
      texcoord(32, 0, TPAGE_4BPP),
      vertex(x, y + 16),
      texcoord(0, 16, 0),
    ]);
  }
}

test('2000 textured triangles rasterize within the frame budget', () => {
  const gpu = make();
  setArea(gpu, 0, 0, 1023, 511);
  setup4bppPage(gpu);
  drawBenchTriangles(gpu);
  const start = performance.now();
  drawBenchTriangles(gpu);
  const elapsed = performance.now() - start;
  const texels = 2000 * 32 * 16 / 2;
  console.log(`bench: 2000 textured triangles (${texels} texels) ${elapsed.toFixed(2)}ms`);
  expect(elapsed).toBeLessThan(500);
});

function enter480i(gpu: GpuCore): void {
  gp1(gpu, 0x08_000027);
  gp1(gpu, 0x07_000000 | (0x10 << 10) | 0x10);
  gp1(gpu, 0x07_000000 | ((0x10 + 240) << 10) | 0x10);
}

test('480i with draw-to-display-field cleared skips the lines of the displayed field only', () => {
  const gpu = make();
  gp1(gpu, 0x08_000024 | 0x20);
  gp0(gpu, [0xe1_000000]);
  setArea(gpu, 0, 0, 63, 63);
  const rect = (y: number): void => gp0(gpu, [0x60_0000ff, vertex(0, y), (1 << 16) | 8]);
  for (let y = 0; y < 4; y++) {
    rect(y);
  }
  const drawn = [0, 1, 2, 3].filter((y) => px(gpu, 0, y) !== 0);
  expect(drawn.length).toBe(2);
  expect(drawn[1] - drawn[0]).toBe(2);
});

test('480i draws every line when draw-to-display-field is set', () => {
  const gpu = make();
  gp1(gpu, 0x08_000024 | 0x20);
  gp0(gpu, [0xe1_000400]);
  setArea(gpu, 0, 0, 63, 63);
  for (let y = 0; y < 4; y++) {
    gp0(gpu, [0x60_0000ff, vertex(0, y), (1 << 16) | 8]);
  }
  expect([0, 1, 2, 3].every((y) => px(gpu, 0, y) !== 0)).toBe(true);
});

test('non-interlaced modes never skip lines whatever E1 bit 10 says', () => {
  const gpu = make();
  gp0(gpu, [0xe1_000000]);
  setArea(gpu, 0, 0, 63, 63);
  for (let y = 0; y < 4; y++) {
    gp0(gpu, [0x60_0000ff, vertex(0, y), (1 << 16) | 8]);
  }
  expect([0, 1, 2, 3].every((y) => px(gpu, 0, y) !== 0)).toBe(true);
});

test('gpustat bit 31 toggles per frame only in 480i and presents the full field pair', () => {
  const gpu = make();
  enter480i(gpu);
  const first = gpustat(gpu) >>> 31;
  gpu.frameBoundary();
  const second = gpustat(gpu) >>> 31;
  expect(first).not.toBe(second);
  expect(gpu.present().height).toBe(480);
  const flat = make();
  expect(gpustat(flat) >>> 31).toBe(0);
  flat.frameBoundary();
  expect(gpustat(flat) >>> 31).toBe(0);
});

test('re-sending the display mode every frame does not pin the interlace field, so both line parities get drawn', () => {
  const gpu = make();
  gp0(gpu, [0xe1_000000]);
  setArea(gpu, 0, 0, 63, 63);
  for (let frame = 0; frame < 2; frame++) {
    gp1(gpu, 0x08_000027);
    for (let y = 0; y < 4; y++) {
      gp0(gpu, [0x60_0000ff, vertex(0, y), (1 << 16) | 8]);
    }
    gpu.frameBoundary();
  }
  expect([0, 1, 2, 3].every((y) => px(gpu, 0, y) !== 0)).toBe(true);
});
