import type { DmaChannel, DmaConfig, IrqController, Logger, MdecUnit, Scheduler } from './contracts';

export class MdecCore implements MdecUnit {
  get busy(): boolean {
    return false;
  }

  constructor(_sched: Scheduler, _log: Logger, _irq: IrqController) {
    throw new Error('MdecCore under construction — MDEC agent owns src/core/mdec.ts');
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
}
