import type {
  Bios,
  BootInfo,
  CdromUnit,
  CpuExceptionKind,
  CpuRegAccess,
  Iso9660,
  Logger,
  Scheduler,
} from './contracts';

export class HleBios implements Bios {
  constructor(
    _sched: Scheduler,
    _log: Logger,
    _ram: Uint32Array,
    _iso: Iso9660,
    _cd: CdromUnit,
  ) {
    throw new Error('HleBios under construction — BIOS agent owns src/core/bios.ts');
  }

  boot(): BootInfo {
    throw new Error('HleBios under construction');
  }

  kuserCall(_pc: number, _core: CpuRegAccess): boolean {
    return false;
  }

  exception(_kind: CpuExceptionKind, _code: number, _addr: number, _core: CpuRegAccess): void {}
}
