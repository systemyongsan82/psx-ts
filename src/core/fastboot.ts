import { parsePsExe } from '../disc/psxexe';
import { ExeLoader, parseSystemCnf } from './kernel/cnf';
import type { CdRomHle, CpuContext, Logger } from './contracts';

export const SHELL_ENTRY_PC = 0x8003_0000;

export interface ExeHandoff {
  readonly entryPc: number;
  readonly gp: number;
  readonly sp: number | null;
}

export function loadDiscExe(cd: CdRomHle, ram: Uint32Array, log: Logger): ExeHandoff | null {
  const cnfEntry = cd.findFile('SYSTEM.CNF');
  if (cnfEntry === null) {
    log.warn('sys', 'fast boot: SYSTEM.CNF not on disc');

    return null;
  }
  const cnfBytes = cd.readFileBytes('SYSTEM.CNF', 0, Math.min(Math.max(1, cnfEntry.size), 4096));
  if (cnfBytes === null) {
    log.warn('sys', 'fast boot: SYSTEM.CNF unreadable');

    return null;
  }
  const cnf = { ...parseSystemCnf(cnfBytes), stack: 0 };
  const plan = new ExeLoader(ram, cd, log).load(cnf);
  if (plan === null) {
    return null;
  }
  const path = cnf.boot.includes(':') ? cnf.boot : `cdrom:${cnf.boot}`;
  const headerBytes = cd.readFileBytes(path, 0, 2048);
  if (headerBytes === null) {
    return null;
  }
  const exe = parsePsExe(headerBytes);

  return {
    entryPc: exe.entryPc,
    gp: exe.gp,
    sp: exe.spBase !== 0 ? (exe.spBase + exe.spOffset) >>> 0 : null,
  };
}

export function applyExeHandoff(ctx: CpuContext, handoff: ExeHandoff): CpuContext {
  const regs = ctx.regs.slice();
  regs[4] = 1;
  regs[5] = 0;
  regs[28] = handoff.gp | 0;
  if (handoff.sp !== null) {
    regs[29] = handoff.sp | 0;
    regs[30] = handoff.sp | 0;
  }

  return {
    ...ctx,
    pc: handoff.entryPc >>> 0,
    nextPc: (handoff.entryPc + 4) >>> 0,
    regs,
    branchDelay: false,
    branchTarget: 0,
  };
}
