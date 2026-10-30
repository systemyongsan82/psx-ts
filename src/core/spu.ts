import type { AudioSink, DmaChannel, DmaConfig, IrqController, Logger, Scheduler, Spu, SpuXaIn } from './contracts';

export class SpuCore implements Spu {
  readonly xaSink: SpuXaIn = {
    xaSector: (_channel: number, _subheader: number, _payload: Uint8Array): void => {},
    cddaSector: (_payload: Uint8Array): void => {},
  };
  readonly sink: AudioSink = {
    availableFrames: 0,
    read: (_dst: Float32Array, _frames: number): void => {},
  };

  constructor(_sched: Scheduler, _log: Logger, _irq: IrqController) {
    throw new Error('SpuCore under construction — SPU agent owns src/core/spu.ts');
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

  tick(_cycles: number): void {}
}
