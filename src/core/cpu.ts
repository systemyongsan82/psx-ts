import type {
  Cpu,
  CpuContext,
  CpuDeps,
  CpuExceptionKind,
  CpuHooks,
  CpuRegAccess,
  GteUnit,
  MemAccess,
} from './contracts';
import { gteCycles } from './gte';

const SR_IRQ_GATE = 0x401;
const CAUSE_KEEP = 0x3000FF00;

function sext16(v: number): number {
  return (v << 16) >> 16;
}

function destinationOf(primary: number, funct: number, rs: number, rt: number, rd: number): number {
  if (primary === 0x00) {
    if (funct <= 0x07 || funct === 0x09 || funct === 0x10 || funct === 0x12 || (funct >= 0x20 && funct <= 0x2B)) {
      return rd;
    }

    return -1;
  }
  if (primary === 0x03) {
    return 31;
  }
  if (primary === 0x01) {
    return rt >= 0x10 ? 31 : -1;
  }
  if (primary >= 0x08 && primary <= 0x0F) {
    return rt;
  }
  if (primary >= 0x20 && primary <= 0x26) {
    return rt;
  }
  if ((primary === 0x10 || primary === 0x12) && (rs === 0x00 || (primary === 0x12 && rs === 0x02))) {
    return rt;
  }

  return -1;
}

function exCodeOf(kind: CpuExceptionKind): number {
  switch (kind) {
    case 'interrupt':
      return 0x00;
    case 'addressLoad':
      return 0x04;
    case 'addressStore':
      return 0x05;
    case 'busErrorInst':
      return 0x06;
    case 'busErrorData':
      return 0x07;
    case 'syscall':
      return 0x08;
    case 'breakpoint':
      return 0x09;
    case 'coprocessorError':
      return 0x0B;
    default:
      return 0x0C;
  }
}

interface CoreAccessFull extends CpuRegAccess {
  cause(): number;
  setCause(value: number): void;
  epc(): number;
  setEpc(value: number): void;
}

export class CpuR3000A implements Cpu {
  private readonly bus: MemAccess;
  private readonly gte: GteUnit;
  private readonly irqCheck: () => number;
  private readonly hooks: CpuHooks;
  private readonly core: CpuRegAccess;
  private readonly regs: Array<number> = new Array<number>(32).fill(0);
  private readonly cp0 = new Array<number>(32).fill(0);
  private pcValue = 0;
  private nextPcValue = 4;
  private inDelay = false;
  private loadReg1T = -1;
  private loadReg1V = 0;
  private loadReg2T = -1;
  private loadReg2V = 0;
  private hiV = 0;
  private loV = 0;
  private srV = 0;
  private causeV = 0;
  private epcV = 0;
  private badVAddr = 0;
  private wasStub = false;
  private haltedFlag = false;
  private readonly realExceptions: boolean;
  private readonly unitCycles: boolean;
  private storesBlocked = false;

  constructor(deps: CpuDeps) {
    this.bus = deps.bus;
    this.gte = deps.gte;
    this.irqCheck = deps.irqCheck;
    this.hooks = deps.hooks;
    this.realExceptions = deps.realExceptions === true;
    this.unitCycles = deps.unitInstructionCycles === true;
    const self = this;
    const full: CoreAccessFull = {
      getReg: (index) => self.regs[index & 31] | 0,
      setReg: (index, value) => {
        const i = index & 31;
        if (i !== 0) {
          self.regs[i] = value | 0;
        }
      },
      pc: () => self.pcValue,
      setPc: (value) => {
        self.pcValue = value >>> 0;
      },
      get nextPc() {
        return self.nextPcValue;
      },
      set nextPc(value) {
        self.nextPcValue = value >>> 0;
      },
      setNextPc: (value) => {
        self.nextPcValue = value >>> 0;
      },
      sr: () => self.srV,
      setSr: (value) => {
        self.srV = value >>> 0;
        self.syncCacheIsolation();
      },
      save: () => self.save(),
      restore: (ctx) => self.restore(ctx),
      suspend: () => {
        self.haltedFlag = true;
      },
      resume: () => {
        self.haltedFlag = false;
      },
      cause: () => self.causeV,
      setCause: (value) => {
        self.causeV = value >>> 0;
      },
      epc: () => self.epcV,
      setEpc: (value) => {
        self.epcV = value >>> 0;
      },
    };
    this.core = full;
  }

  reset(entryPc: number): void {
    const regs = this.regs;
    let i = 0;
    while (i < 32) {
      regs[i] = 0;
      i++;
    }
    let j = 0;
    while (j < 32) {
      this.cp0[j] = 0;
      j++;
    }
    this.hiV = 0;
    this.loV = 0;
    this.srV = 0;
    this.storesBlocked = false;
    this.causeV = 0;
    this.epcV = 0;
    this.badVAddr = 0;
    this.pcValue = entryPc >>> 0;
    this.nextPcValue = (entryPc + 4) >>> 0;
    this.inDelay = false;
    this.loadReg1T = -1;
    this.loadReg2T = -1;
    this.wasStub = false;
    this.haltedFlag = false;
  }

  run(budget: number): number {
    if (this.haltedFlag) {
      return 0;
    }
    const regs = this.regs;
    const bus = this.bus;
    const unitCycles = this.unitCycles;
    let consumed = 0;
    outer: while (consumed < budget) {
      const pc0 = this.pcValue >>> 0;
      const wasBranchSlot = this.inDelay;
      this.inDelay = false;
      if (this.loadReg2T >= 0) {
        regs[this.loadReg2T] = this.loadReg2V;
        this.loadReg2T = -1;
      }
      this.loadReg2T = this.loadReg1T;
      this.loadReg2V = this.loadReg1V;
      this.loadReg1T = -1;

      const phys = (pc0 & 0x1FFFFFFF) >>> 0;
      const inStub = !this.realExceptions && (phys === 0xA0 || phys === 0xB0 || phys === 0xC0 || phys === 0xD0);
      if (inStub && !this.wasStub) {
        const nextBeforeHook = this.nextPcValue;
        const handled = this.hooks.kuserCall(pc0, this.core);
        if (handled) {
          consumed += 2;
          this.inDelay = false;
          if (this.nextPcValue === nextBeforeHook) {
            this.nextPcValue = (this.pcValue + 4) >>> 0;
          }
          this.wasStub = this.stubOf(this.pcValue);
          if (this.haltedFlag) {
            return consumed;
          }
          continue;
        }
      }

      if (!wasBranchSlot) {
        const srNow = this.srV;
        if ((srNow & 0x1) !== 0) {
          const swPen = this.causeV & srNow & 0x300;
          if (swPen !== 0) {
            consumed += 1;
            this.raise('interrupt', ((swPen >>> 8) & 3) * 0x100, pc0, pc0, false);
            return consumed;
          }
          if ((srNow & 0x400) !== 0) {
            const lines = this.irqCheck();
            if (lines !== 0) {
              consumed += 1;
              this.raise('interrupt', lines, pc0, pc0, false);
              return consumed;
            }
          }
        }
      }

      if ((pc0 & 3) !== 0) {
        this.badVAddr = pc0 >>> 0;
        consumed += 1;
        this.raise('addressLoad', 0, pc0, pc0, wasBranchSlot);
        return consumed;
      }

      const instr = (bus.load32(pc0) | 0) >>> 0;
      const rs = (instr >>> 21) & 0x1F;
      const rt = (instr >>> 16) & 0x1F;
      const rd = (instr >>> 11) & 0x1F;
      const shamt = (instr >>> 6) & 0x1F;
      const imm = instr & 0xFFFF;
      const simm = (imm << 16) >> 16;
      const funct = instr & 0x3F;
      const primary = (instr >>> 26) & 0x3F;
      const branchClass =
        primary === 0x01 ||
        (primary >= 0x02 && primary <= 0x07) ||
        (primary === 0x00 && (funct === 0x08 || funct === 0x09)) ||
        (primary === 0x12 && rs === 0x08);
      if (wasBranchSlot && branchClass) {
        consumed += 2;
        this.raise('breakpoint', instr, pc0, pc0, true);

        return consumed;
      }
      if (this.loadReg2T >= 0 && this.loadReg2T === destinationOf(primary, funct, rs, rt, rd)) {
        this.loadReg2T = -1;
      }
      let cyc = 1;
      let taken = false;
      let takenTarget = 0;
      let isBranch = false;

      switch (primary) {
        case 0x00: {
          const a = regs[rs] | 0;
          const b = regs[rt] | 0;
          switch (funct) {
            case 0x00:
              if (rd !== 0) {
                regs[rd] = (b << shamt) | 0;
              }
              break;
            case 0x02:
              if (rd !== 0) {
                regs[rd] = b >>> shamt;
              }
              break;
            case 0x03:
              if (rd !== 0) {
                regs[rd] = b >> shamt;
              }
              break;
            case 0x04:
              if (rd !== 0) {
                regs[rd] = (b << (a & 0x1F)) | 0;
              }
              break;
            case 0x06:
              if (rd !== 0) {
                regs[rd] = b >>> (a & 0x1F);
              }
              break;
            case 0x07:
              if (rd !== 0) {
                regs[rd] = b >> (a & 0x1F);
              }
              break;
            case 0x08: {
              isBranch = true;
              cyc = 2;
              taken = true;
              takenTarget = (regs[rs] | 0) >>> 0;
              break;
            }
            case 0x09: {
              isBranch = true;
              cyc = 2;
              const target = (regs[rs] | 0) >>> 0;
              if (rd !== 0) {
                regs[rd] = (pc0 + 8) | 0;
              }
              taken = true;
              takenTarget = target;
              break;
            }
            case 0x0C:
              consumed += cyc;
              this.raise('syscall', (instr >>> 6) & 0xFFFFFF, pc0, pc0, wasBranchSlot);
              return consumed;
            case 0x0D:
              consumed += cyc;
              this.raise('breakpoint', (instr >>> 6) & 0xFFFFF, pc0, pc0, wasBranchSlot);
              return consumed;
            case 0x10:
              if (rd !== 0) {
                regs[rd] = this.hiV | 0;
              }
              break;
            case 0x11:
              this.hiV = a | 0;
              break;
            case 0x12:
              if (rd !== 0) {
                regs[rd] = this.loV | 0;
              }
              break;
            case 0x13:
              this.loV = a | 0;
              break;
            case 0x18: {
              const ah = a >> 16;
              const al = a & 0xFFFF;
              const bh = b >> 16;
              const bl = b & 0xFFFF;
              const t = al * bl;
              const m = ah * bl + al * bh;
              const h = ah * bh;
              const w = m * 65536 + t;
              this.loV = w | 0;
              this.hiV = (h + Math.floor(w / 4294967296)) | 0;
              cyc = 13;
              break;
            }
            case 0x19: {
              const au = a >>> 0;
              const bu = b >>> 0;
              const ah = au >>> 16;
              const al = au & 0xFFFF;
              const bh = bu >>> 16;
              const bl = bu & 0xFFFF;
              const t = al * bl;
              const m = ah * bl + al * bh;
              const h = ah * bh;
              const w = m * 65536 + t;
              this.loV = w | 0;
              this.hiV = (h + Math.floor(w / 4294967296)) | 0;
              cyc = 13;
              break;
            }
            case 0x1A: {
              if (b === 0) {
                this.hiV = a | 0;
                this.loV = a < 0 ? 1 : -1;
              } else {
                const q = Math.trunc(a / b) | 0;
                this.loV = q;
                this.hiV = (a - q * b) | 0;
              }
              cyc = 38;
              break;
            }
            case 0x1B: {
              const au = a >>> 0;
              const bu = b >>> 0;
              if (bu === 0) {
                this.hiV = a;
                this.loV = -1;
              } else {
                this.loV = (au / bu) | 0;
                this.hiV = (au % bu) | 0;
              }
              cyc = 38;
              break;
            }
            case 0x20: {
              const r = a + b;
              if (r > 2147483647 || r < -2147483648) {
                consumed += cyc;
                this.raise('overflow', 0, 0, pc0, wasBranchSlot);

                return consumed;
              }
              if (rd !== 0) {
                regs[rd] = r | 0;
              }
              break;
            }
            case 0x21:
              if (rd !== 0) {
                regs[rd] = (a + b) | 0;
              }
              break;
            case 0x22: {
              const r = a - b;
              if (r > 2147483647 || r < -2147483648) {
                consumed += cyc;
                this.raise('overflow', 0, 0, pc0, wasBranchSlot);

                return consumed;
              }
              if (rd !== 0) {
                regs[rd] = r | 0;
              }
              break;
            }
            case 0x23:
              if (rd !== 0) {
                regs[rd] = (a - b) | 0;
              }
              break;
            case 0x24:
              if (rd !== 0) {
                regs[rd] = a & b;
              }
              break;
            case 0x25:
              if (rd !== 0) {
                regs[rd] = a | b;
              }
              break;
            case 0x26:
              if (rd !== 0) {
                regs[rd] = a ^ b;
              }
              break;
            case 0x27:
              if (rd !== 0) {
                regs[rd] = (a | b) ^ -1;
              }
              break;
            case 0x2A:
              if (rd !== 0) {
                regs[rd] = a < b ? 1 : 0;
              }
              break;
            case 0x2B:
              if (rd !== 0) {
                regs[rd] = (a >>> 0) < (b >>> 0) ? 1 : 0;
              }
              break;
            default:
              break;
          }
          break;
        }
        case 0x01: {
          const a = regs[rs] | 0;
          isBranch = true;
          cyc = 2;
          const link = (rt & 0x10) !== 0;
          if (link) {
            regs[31] = (pc0 + 8) | 0;
          }
          const negative = (rt & 1) === 0 ? a < 0 : a >= 0;
          if (negative) {
            taken = true;
            takenTarget = (pc0 + 4 + (simm << 2)) >>> 0;
          }
          break;
        }
        case 0x02: {
          const target = (((pc0 + 4) & 0xF0000000) | ((instr & 0x3FFFFFF) << 2)) >>> 0;
          isBranch = true;
          cyc = 2;
          taken = true;
          takenTarget = target;
          break;
        }
        case 0x03: {
          const target = (((pc0 + 4) & 0xF0000000) | ((instr & 0x3FFFFFF) << 2)) >>> 0;
          regs[31] = (pc0 + 8) | 0;
          isBranch = true;
          cyc = 2;
          taken = true;
          takenTarget = target;
          break;
        }
        case 0x04: {
          const eq = (regs[rs] | 0) === (regs[rt] | 0);
          isBranch = true;
          cyc = 2;
          if (eq) {
            taken = true;
            takenTarget = (pc0 + 4 + (simm << 2)) >>> 0;
          }
          break;
        }
        case 0x05: {
          const eq = (regs[rs] | 0) === (regs[rt] | 0);
          isBranch = true;
          cyc = 2;
          if (!eq) {
            taken = true;
            takenTarget = (pc0 + 4 + (simm << 2)) >>> 0;
          }
          break;
        }
        case 0x06: {
          const v = regs[rs] | 0;
          isBranch = true;
          cyc = 2;
          if (v <= 0) {
            taken = true;
            takenTarget = (pc0 + 4 + (simm << 2)) >>> 0;
          }
          break;
        }
        case 0x07: {
          const v = regs[rs] | 0;
          isBranch = true;
          cyc = 2;
          if (v > 0) {
            taken = true;
            takenTarget = (pc0 + 4 + (simm << 2)) >>> 0;
          }
          break;
        }
        case 0x08:
        case 0x09: {
          const r = (regs[rs] | 0) + simm;
          if (primary === 0x08 && (r > 2147483647 || r < -2147483648)) {
            consumed += cyc;
            this.raise('overflow', 0, 0, pc0, wasBranchSlot);

            return consumed;
          }
          if (rt !== 0) {
            regs[rt] = r | 0;
          }
          break;
        }
        case 0x0A:
          if (rt !== 0) {
            regs[rt] = (regs[rs] | 0) < simm ? 1 : 0;
          }
          break;
        case 0x0B:
          if (rt !== 0) {
            regs[rt] = (regs[rs] | 0) >>> 0 < (sext16(imm) | 0) >>> 0 ? 1 : 0;
          }
          break;
        case 0x0C:
          if (rt !== 0) {
            regs[rt] = (regs[rs] | 0) & imm;
          }
          break;
        case 0x0D:
          if (rt !== 0) {
            regs[rt] = (regs[rs] | 0) | imm;
          }
          break;
        case 0x0E:
          if (rt !== 0) {
            regs[rt] = (regs[rs] | 0) ^ imm;
          }
          break;
        case 0x0F:
          if (rt !== 0) {
            regs[rt] = (imm << 16) | 0;
          }
          break;
        case 0x10: {
          cyc = 4;
          if (((instr >>> 25) & 1) === 1) {
            if (funct === 0x10) {
              this.srV = ((this.srV & ~0xF) | ((this.srV >>> 2) & 0xF)) >>> 0;
              this.syncCacheIsolation();
            }
            break;
          }
          if (rs === 0x00) {
            const r = this.readCp0(rd);
            if (rt !== 0) {
              this.loadReg1T = rt;
              this.loadReg1V = r | 0;
            }
            break;
          }
          if (rs === 0x04) {
            this.writeCp0(rd, regs[rt] | 0);
          }
          break;
        }
        case 0x11:
        case 0x13: {
          const cop = primary & 3;
          this.causeV = (this.causeV | (cop << 28)) >>> 0;
          consumed += cyc;
          this.raise('coprocessorError', cop, 0, pc0, wasBranchSlot);

          return consumed;
        }
        case 0x12: {
          const gteRs = (instr >>> 21) & 0x1F;
          if (gteRs === 0x08) {
            const cond = (rt & 1) === 0;
            isBranch = true;
            cyc = 2;
            if (cond) {
              taken = true;
              takenTarget = (pc0 + 4 + (simm << 2)) >>> 0;
            }
            break;
          }
          const ret = this.gte.cop2(instr, regs[rt] | 0);
          cyc = (gteRs & 0x10) !== 0 ? gteCycles(instr) : 4;
          if (gteRs === 0x00 || gteRs === 0x02) {
            if (rt !== 0) {
              this.loadReg1T = rt;
              this.loadReg1V = ret | 0;
            }
          }
          break;
        }
        case 0x20: {
          const addr = (regs[rs] + simm) | 0;
          const u = bus.load8(addr >>> 0) & 0xFF;
          if (rt !== 0) {
            this.loadReg1T = rt;
            this.loadReg1V = (u << 24) >> 24;
          }
          cyc = 5;
          break;
        }
        case 0x21: {
          const addr = (regs[rs] + simm) | 0;
          if ((addr & 1) !== 0) {
            this.badVAddr = addr >>> 0;
            consumed += cyc;
            this.raise('addressLoad', 0, addr >>> 0, pc0, wasBranchSlot);

            return consumed;
          }
          const u = bus.load16(addr >>> 0) & 0xFFFF;
          if (rt !== 0) {
            this.loadReg1T = rt;
            this.loadReg1V = (u << 16) >> 16;
          }
          cyc = 5;
          break;
        }
        case 0x22: {
          const addr = (regs[rs] + simm) | 0;
          const au = addr >>> 0;
          const o = au & 3;
          const w = (bus.load32((au & 0xFFFFFFFC) >>> 0) | 0) >>> 0;
          let v: number;
          if (o === 0) {
            v = (w << 24) | ((regs[rt] | 0) & 0x00FFFFFF);
          } else if (o === 1) {
            v = (w << 16) | ((regs[rt] | 0) & 0x0000FFFF);
          } else if (o === 2) {
            v = (w << 8) | ((regs[rt] | 0) & 0xFF);
          } else {
            v = w | 0;
          }
          if (rt !== 0) {
            regs[rt] = v;
          }
          cyc = 5;
          break;
        }
        case 0x23: {
          const addr = (regs[rs] + simm) | 0;
          if ((addr & 3) !== 0) {
            this.badVAddr = addr >>> 0;
            consumed += cyc;
            this.raise('addressLoad', 0, addr >>> 0, pc0, wasBranchSlot);

            return consumed;
          }
          if (rt !== 0) {
            this.loadReg1T = rt;
            this.loadReg1V = bus.load32(addr >>> 0) | 0;
          }
          cyc = 5;
          break;
        }
        case 0x24: {
          const addr = (regs[rs] + simm) | 0;
          const u = bus.load8(addr >>> 0) & 0xFF;
          if (rt !== 0) {
            this.loadReg1T = rt;
            this.loadReg1V = u;
          }
          cyc = 5;
          break;
        }
        case 0x25: {
          const addr = (regs[rs] + simm) | 0;
          if ((addr & 1) !== 0) {
            this.badVAddr = addr >>> 0;
            consumed += cyc;
            this.raise('addressLoad', 0, addr >>> 0, pc0, wasBranchSlot);

            return consumed;
          }
          const u = bus.load16(addr >>> 0) & 0xFFFF;
          if (rt !== 0) {
            this.loadReg1T = rt;
            this.loadReg1V = u;
          }
          cyc = 5;
          break;
        }
        case 0x26: {
          const addr = (regs[rs] + simm) | 0;
          const au = addr >>> 0;
          const o = au & 3;
          const w = (bus.load32((au & 0xFFFFFFFC) >>> 0) | 0) >>> 0;
          let v: number;
          if (o === 0) {
            v = w | 0;
          } else if (o === 1) {
            v = ((w >>> 8) | ((regs[rt] | 0) & 0xFF000000)) | 0;
          } else if (o === 2) {
            v = ((w >>> 16) | ((regs[rt] | 0) & 0xFFFF0000)) | 0;
          } else {
            v = ((w >>> 24) | ((regs[rt] | 0) & 0xFFFFFF00)) | 0;
          }
          if (rt !== 0) {
            regs[rt] = v;
          }
          cyc = 5;
          break;
        }
        case 0x28: {
          const addr = (regs[rs] + simm) | 0;
          if (!this.storesBlocked) {
            bus.store8(addr >>> 0, (regs[rt] | 0) & 0xFF);
          }
          cyc = 5;
          break;
        }
        case 0x29: {
          const addr = (regs[rs] + simm) | 0;
          if ((addr & 1) !== 0) {
            this.badVAddr = addr >>> 0;
            consumed += cyc;
            this.raise('addressStore', 0, addr >>> 0, pc0, wasBranchSlot);

            return consumed;
          }
          if (!this.storesBlocked) {
            bus.store16(addr >>> 0, (regs[rt] | 0) & 0xFFFF);
          }
          cyc = 5;
          break;
        }
        case 0x2A: {
          const addr = (regs[rs] + simm) | 0;
          const au = addr >>> 0;
          const o = au & 3;
          const base = (au & 0xFFFFFFFC) >>> 0;
          if (this.storesBlocked) {
            cyc = 5;
            break;
          }
          if (o === 3) {
            bus.store32(base, regs[rt] | 0);
          } else {
            const w = (bus.load32(base) | 0) >>> 0;
            const v = (regs[rt] | 0) >>> 0;
            let nw: number;
            if (o === 0) {
              nw = (w & 0xFFFFFF00) | ((v >>> 24) & 0xFF);
            } else if (o === 1) {
              nw = (w & 0xFFFF0000) | ((v >>> 16) & 0xFFFF);
            } else {
              nw = (w & 0xFF000000) | ((v >>> 8) & 0xFFFFFF);
            }
            bus.store32(base, nw | 0);
          }
          cyc = 5;
          break;
        }
        case 0x2B: {
          const addr = (regs[rs] + simm) | 0;
          if ((addr & 3) !== 0) {
            this.badVAddr = addr >>> 0;
            consumed += cyc;
            this.raise('addressStore', 0, addr >>> 0, pc0, wasBranchSlot);

            return consumed;
          }
          if (!this.storesBlocked) {
            bus.store32(addr >>> 0, regs[rt] | 0);
          }
          cyc = 5;
          break;
        }
        case 0x2E: {
          const addr = (regs[rs] + simm) | 0;
          const au = addr >>> 0;
          const o = au & 3;
          if (this.storesBlocked) {
            cyc = 5;
            break;
          }
          if (o === 0) {
            bus.store32(au, regs[rt] | 0);
          } else {
            const base = (au & 0xFFFFFFFC) >>> 0;
            const w = (bus.load32(base) | 0) >>> 0;
            const v = (regs[rt] | 0) >>> 0;
            let nw: number;
            if (o === 1) {
              nw = (w & 0x000000FF) | ((v & 0xFFFFFF) << 8);
            } else if (o === 2) {
              nw = (w & 0x0000FFFF) | ((v & 0xFFFF) << 16);
            } else {
              nw = (w & 0x00FFFFFF) | ((v & 0xFF) << 24);
            }
            bus.store32(base, nw | 0);
          }
          cyc = 5;
          break;
        }
        case 0x32: {
          const addr = (regs[rs] + simm) | 0;
          if ((addr & 3) !== 0) {
            this.badVAddr = addr >>> 0;
            consumed += cyc;
            this.raise('addressLoad', 0, addr >>> 0, pc0, wasBranchSlot);

            return consumed;
          }
          cyc = 5;
          this.gte.cop2(instr, bus.load32(addr >>> 0) | 0);
          break;
        }
        case 0x3A: {
          const addr = (regs[rs] + simm) | 0;
          if ((addr & 3) !== 0) {
            this.badVAddr = addr >>> 0;
            consumed += cyc;
            this.raise('addressStore', 0, addr >>> 0, pc0, wasBranchSlot);

            return consumed;
          }
          cyc = 5;
          const gteWord = this.gte.cop2(instr, 0) | 0;
          if (!this.storesBlocked) {
            bus.store32(addr >>> 0, gteWord);
          }
          break;
        }
        default:
          break;
      }

      this.pcValue = this.nextPcValue >>> 0;
      this.nextPcValue = (this.pcValue + 4) >>> 0;
      if (taken) {
        this.nextPcValue = takenTarget >>> 0;
      }
      this.inDelay = isBranch;
      this.wasStub = inStub;
      consumed += unitCycles ? 1 : cyc;
    }

    return consumed;
  }

  get pc(): number {
    return this.pcValue;
  }

  get halted(): boolean {
    return this.haltedFlag;
  }

  save(): CpuContext {
    this.commitLoads();
    const regsCopy = new Array<number>(32);
    let i = 0;
    while (i < 32) {
      regsCopy[i] = this.regs[i];
      i++;
    }
    const out: CpuContext = {
      pc: this.pcValue,
      nextPc: this.nextPcValue,
      regs: regsCopy,
      hi: this.hiV,
      lo: this.loV,
      sr: this.srV,
      cause: this.causeV,
      epc: this.epcV,
      branchDelay: this.inDelay,
      branchTarget: this.inDelay ? (this.nextPcValue | 0) : 0,
    };

    return out;
  }

  restore(ctx: CpuContext): void {
    this.pcValue = ctx.pc >>> 0;
    this.nextPcValue = ctx.nextPc >>> 0;
    const regs = this.regs;
    let i = 0;
    while (i < 32) {
      regs[i] = ctx.regs[i] | 0;
      i++;
    }
    regs[0] = 0;
    this.hiV = ctx.hi | 0;
    this.loV = ctx.lo | 0;
    this.srV = ctx.sr >>> 0;
    this.syncCacheIsolation();
    this.causeV = ctx.cause >>> 0;
    this.epcV = ctx.epc >>> 0;
    this.inDelay = ctx.branchDelay;
    this.loadReg1T = -1;
    this.loadReg2T = -1;
  }

  getReg(index: number): number {
    return this.regs[index & 31] | 0;
  }

  setReg(index: number, value: number): void {
    const i = index & 31;
    if (i !== 0) {
      this.regs[i] = value | 0;
    }
  }

  private commitLoads(): void {
    if (this.loadReg2T >= 0) {
      this.regs[this.loadReg2T] = this.loadReg2V;
      this.loadReg2T = -1;
    }
    if (this.loadReg1T >= 0) {
      this.regs[this.loadReg1T] = this.loadReg1V;
      this.loadReg1T = -1;
    }
  }

  private raise(kind: CpuExceptionKind, code: number, addr: number, pc0: number, wasDelayed: boolean): void {
    this.commitLoads();
    const delay = wasDelayed ? 1 : 0;
    this.epcV = ((wasDelayed ? pc0 - 4 : pc0) >>> 0);
    this.causeV = ((this.causeV & CAUSE_KEEP) | (exCodeOf(kind) << 2) | (delay << 31)) >>> 0;
    if (this.realExceptions) {
      this.vectorException(kind, code, addr);

      return;
    }
    const pcBefore = this.pcValue;
    const nextBefore = this.nextPcValue;
    this.hooks.exception(kind, code, addr, this.core);
    this.inDelay = false;
    const redirected = this.pcValue !== pcBefore || this.nextPcValue !== nextBefore;
    if (!redirected && kind !== 'interrupt') {
      this.pcValue = nextBefore >>> 0;
      this.nextPcValue = (this.pcValue + 4) >>> 0;
    } else if (this.nextPcValue === nextBefore) {
      this.nextPcValue = (this.pcValue + 4) >>> 0;
    }
    this.wasStub = this.stubOf(this.pcValue);
  }

  private vectorException(kind: CpuExceptionKind, code: number, addr: number): void {
    if (kind === 'addressLoad' || kind === 'addressStore') {
      this.badVAddr = addr >>> 0;
    }
    this.srV = ((this.srV & ~0x3F) | ((this.srV << 2) & 0x3F)) >>> 0;
    this.syncCacheIsolation();
    const vector = (this.srV & 0x400000) !== 0 ? 0xBFC00180 : 0x80000080;
    this.pcValue = vector;
    this.nextPcValue = (vector + 4) >>> 0;
    this.inDelay = false;
  }

  private syncCacheIsolation(): void {
    this.storesBlocked = this.realExceptions && (this.srV & 0x10000) !== 0;
  }

  private stubOf(pc: number): boolean {
    const p = (pc & 0x1FFFFFFF) >>> 0;

    return p === 0xA0 || p === 0xB0 || p === 0xC0 || p === 0xD0;
  }

  private readCp0(i: number): number {
    switch (i) {
      case 8:
        return this.badVAddr;
      case 12:
        return this.srV;
      case 13:
        return this.realExceptions && this.irqCheck() !== 0 ? (this.causeV | 0x400) >>> 0 : this.causeV;
      case 14:
        return this.epcV;
      case 15:
        return 0x02;
      default:
        return this.cp0[i & 31];
    }
  }

  private writeCp0(i: number, v: number): void {
    switch (i) {
      case 12:
        this.srV = v >>> 0;
        this.syncCacheIsolation();
        break;
      case 13:
        this.causeV = ((this.causeV & 0xFFFF00FF) | (v & 0x300)) >>> 0;
        break;
      case 14:
        this.epcV = v >>> 0;
        break;
      case 15:
        break;
      case 8:
        break;
      default:
        this.cp0[i & 31] = v | 0;
        break;
    }
  }
}