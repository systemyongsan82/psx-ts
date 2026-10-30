import type { GteUnit } from './contracts';

export class Gte implements GteUnit {
  constructor() {
    throw new Error('Gte under construction — CPU agent owns src/core/gte.ts');
  }

  cop2(_instr: number, _gprValue: number): number {

    return 0;
  }
}
