import type { GteUnit } from './contracts';

export class Gte implements GteUnit {
  constructor() {
    throw new Error('Gte under construction — CPU agent owns src/core/gte.ts');
  }

  exec(_instr: number): void {}

  data(_index: number): number {
    return 0;
  }

  setData(_index: number, _value: number): void {}

  ctl(_index: number): number {
    return 0;
  }

  setCtl(_index: number, _value: number): void {}
}
