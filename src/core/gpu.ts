import { VRAM_H, VRAM_W } from './contracts';
import type { DmaChannel, DmaConfig, DisplayFrame, Gpu, IrqController, Logger, Scheduler } from './contracts';

export class GpuCore implements Gpu {
  readonly vram = new Uint16Array(VRAM_W * VRAM_H);

  constructor(_sched: Scheduler, _log: Logger, _irq: IrqController) {
    throw new Error('GpuCore under construction — GPU agent owns src/core/gpu.ts');
  }

  load32(_addr: number): number {
    return 0;
  }

  load16(_addr: number): number {
    return 0;
  }

  load8(_addr: number): number {
    return 0;
  }

  store32(_addr: number, _value: number): void {}

  store16(_addr: number, _value: number): void {}

  store8(_addr: number, _value: number): void {}

  dmaStart(_channel: DmaChannel, _config: DmaConfig, _ram: Uint32Array): void {}

  frameBoundary(): void {}

  present(): DisplayFrame {
    throw new Error('GpuCore under construction');
  }
}
