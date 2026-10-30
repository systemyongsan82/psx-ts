import type { IrqLine, Logger, MemAccess, Scheduler } from './contracts';
import type { IoDeviceSet } from './system';

export class Bus implements MemAccess {
  line = 0;

  constructor(_sched: Scheduler, _log: Logger, _ram: Uint32Array, _devices: IoDeviceSet) {
    throw new Error('Bus under construction — Bus agent owns src/core/bus.ts');
  }

  load8(_addr: number): number {
    return 0;
  }

  load16(_addr: number): number {
    return 0;
  }

  load32(_addr: number): number {
    return 0;
  }

  store8(_addr: number, _v: number): void {}

  store16(_addr: number, _v: number): void {}

  store32(_addr: number, _v: number): void {}

  raiseIrq(_line: IrqLine): void {}

  irqActive(): boolean {
    return false;
  }

  lineTick(): void {}
}
