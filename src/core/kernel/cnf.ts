import { parsePsExe, planExeLoad } from '../../disc/psxexe';
import { writeByte } from './strmem';
import type { CdRomHle, Logger, PsExeInfo } from '../contracts';

export interface CnfInfo {
  readonly boot: string;
  readonly tcb: number;
  readonly event: number;
  readonly stack: number;
}

export const CNF_DEFAULTS: CnfInfo = { boot: '', tcb: 4, event: 0x10, stack: 0 };

const CNF_TEXT_MAX = 4096;

export function parseSystemCnf(bytes: Uint8Array): CnfInfo {
  let boot = '';
  let tcb = CNF_DEFAULTS.tcb;
  let event = CNF_DEFAULTS.event;
  let stack = CNF_DEFAULTS.stack;
  const text = asciiText(bytes, CNF_TEXT_MAX);
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== '\n') {
      continue;
    }
    const line = (lineStart <= i ? text.slice(lineStart, i) : '').replace(/\r$/, '').trim();
    lineStart = i + 1;
    const eq = line.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key === 'boot') {
      boot = value;
    } else if (key === 'tcb') {
      tcb = hexValue(value);
    } else if (key === 'event') {
      event = hexValue(value);
    } else if (key === 'stack') {
      stack = hexValue(value);
    }
  }

  return { boot, tcb, event, stack };
}

function hexValue(text: string): number {
  const body = text.replace(/^0[xX]/, '').replace(/[^0-9a-fA-F]/g, '');
  if (body.length === 0) {
    return 0;
  }
  const v = parseInt(body, 16);

  return Number.isNaN(v) ? 0 : v >>> 0;
}

function asciiText(bytes: Uint8Array, max: number): string {
  let s = '';
  const n = Math.min(bytes.length, max);
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) {
      break;
    }
    s += String.fromCharCode(b);
  }

  return s;
}

export interface ExePlan {
  readonly entryPc: number;
  readonly sp: number;
  readonly gp: number;
  readonly loadAddr: number;
  readonly loadSize: number;
  readonly memfillAddr: number;
  readonly memfillSize: number;
  readonly exeLba: number;
  readonly exeSize: number;
}

export class ExeLoader {
  constructor(
    private readonly ram: Uint32Array,
    private readonly cd: CdRomHle,
    private readonly log: Logger,
  ) {}

  load(cnf: CnfInfo): ExePlan | null {
    const path = cnf.boot.includes(':') ? cnf.boot : `cdrom:${cnf.boot}`;
    if (path === 'cdrom:') {
      this.log.warn('bios', 'SYSTEM.CNF has no BOOT entry');

      return null;
    }
    const entry = this.cd.findFile(path);
    if (entry === null) {
      this.log.warn('bios', `SYSTEM.CNF BOOT file not found: ${path}`);

      return null;
    }
    const headerBytes = this.cd.readFileBytes(path, 0, 2048);
    if (headerBytes === null || headerBytes.length < 2048) {
      this.log.warn('bios', `PS-EXE header unreadable: ${path}`);

      return null;
    }
    let exe: PsExeInfo;
    try {
      exe = parsePsExe(headerBytes);
    } catch (_err) {
      this.log.warn('bios', `PS-EXE magic mismatch: ${path}`);

      return null;
    }
    const plan = planExeLoad(exe);
    this.cd.readIntoRam(entry.lba, 2048, plan.loadSize, this.ram, plan.loadAddr);
    if (plan.memfillSize > 0 && plan.memfillAddr !== 0) {
      const base = plan.memfillAddr & 0x001F_FFFF;
      const size = Math.min(plan.memfillSize, 0x0020_0000 - base);
      for (let i = 0; i < size; i++) {
        writeByte(this.ram, base + i, 0);
      }
    }
    const sp = cnf.stack !== 0
      ? cnf.stack
      : (exe.spBase !== 0 ? (exe.spBase + exe.spOffset) >>> 0 : (plan.loadAddr + plan.loadSize) >>> 0);

    return {
      entryPc: plan.entryPc,
      sp,
      gp: exe.gp,
      loadAddr: plan.loadAddr,
      loadSize: plan.loadSize,
      memfillAddr: plan.memfillAddr,
      memfillSize: plan.memfillSize,
      exeLba: entry.lba,
      exeSize: entry.size,
    };
  }
}