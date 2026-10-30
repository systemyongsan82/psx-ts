import type { Cpu, CpuContext, CpuDeps } from './contracts';

export class CpuR3000A implements Cpu {
  constructor(_deps: CpuDeps) {
    throw new Error('CpuR3000A under construction — CPU agent owns src/core/cpu.ts');
  }

  reset(_entryPc: number): void {}

  run(_budget: number): number {
    return 0;
  }

  get pc(): number {
    return 0;
  }

  save(): CpuContext {
    throw new Error('CpuR3000A under construction');
  }

  restore(_ctx: CpuContext): void {}

  getReg(_index: number): number {
    return 0;
  }

  setReg(_index: number, _value: number): void {}

  readonly halted = false;
}