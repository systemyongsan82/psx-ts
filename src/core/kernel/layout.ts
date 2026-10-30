export const RAM_TOP = 0x0020_0000;
export const RAM_MASK = RAM_TOP - 1;

export const VEC_A = 0x0000_00A0;
export const VEC_B = 0x0000_00B0;
export const VEC_C = 0x0000_00C0;
export const VEC_RET = 0x0000_00D0;

export const EXC_HANDLER = 0x0000_0080;
export const TOT_ADDR = 0x0000_0100;
export const CMDLINE_ADDR = 0x0000_0180;

export const JUMP_A_BASE = 0x0000_0200;
export const JUMP_A_SLOT = 8;
export const JUMP_A_COUNT = 96;

export const B_SENTINEL_BASE = 0x0000_0580;
export const B_SENTINEL_COUNT = 0x5E;
export const B_SENTINEL_STRIDE = 4;
export const C_SENTINEL_BASE = 0x0000_0700;
export const C_SENTINEL_COUNT = 0x1E;
export const C_SENTINEL_STRIDE = 4;

export const B0_TABLE_ADDR = 0x0000_0780;
export const B0_TABLE_ENTRIES = 0x5E;
export const C0_TABLE_ADDR = 0x0000_0900;
export const C0_TABLE_ENTRIES = 0x1E;

export const EXIT_STRUCT_ADDR = 0x0000_09C0;
export const GETC_SCRATCH = 0x0000_0A80;

export const HEAP_BASE = 0x0000_8920;
export const HEAP_TOP = 0x0000_C000;

export const DCB_ADDR = 0x0000_D000;
export const FCB_ADDR = 0x0000_D340;
export const KERNEL_STACK_BASE = 0x0000_C000;
export const KERNEL_STACK_TOP = 0x0000_D000;
export const KERNEL_SP_BASE = KERNEL_STACK_TOP - 8;
export const KERNEL_SP_WINDOW = 0x400;
export const KERNEL_SP_MAX_DEPTH = 4;
export const DEV_STRINGS_ADDR = 0x0000_D720;

export const EXCB_ADDR = 0x0000_E000;
export const PCB_ADDR = 0x0000_E020;
export const TCB_ADDR = 0x0000_E030;
export const EVCB_ADDR = 0x0000_E340;

export const EXCB_COUNT = 4;
export const EXCB_SIZE = 8;
export const PCB_SIZE = 4;
export const TCB_SIZE = 0xC0;
export const TCB_COUNT_MAX = 4;
export const TCB_STATUS_FREE = 0x1000;
export const TCB_STATUS_USED = 0x4000;
export const EVCB_SIZE = 0x1C;
export const FCB_SIZE = 0x2C;
export const FCB_COUNT = 16;
export const DCB_SIZE = 0x50;
export const DCB_COUNT = 10;

export const INTERNAL_MIN = 5;
export const INTERNAL_CD_EVENT_SLOTS = 5;

export const EV_STATUS_FREE = 0;
export const EV_STATUS_DISABLED = 0x1000;
export const EV_STATUS_BUSY = 0x2000;
export const EV_STATUS_READY = 0x4000;

export const EV_MODE_CALLBACK = 0x1000;
export const EV_MODE_FLAG = 0x2000;

export const EV_CLASS_VBLANK = 0xF000_0001;
export const EV_CLASS_GPU = 0xF000_0002;
export const EV_CLASS_CDROM = 0xF000_0003;
export const EV_CLASS_DMA = 0xF000_0004;
export const EV_CLASS_TMR0 = 0xF000_0005;
export const EV_CLASS_TMR1_TMR2 = 0xF000_0006;
export const EV_CLASS_CONTROLLER = 0xF000_0008;
export const EV_CLASS_SPU = 0xF000_0009;
export const EV_CLASS_PIO = 0xF000_000A;
export const EV_CLASS_SIO = 0xF000_000B;
export const EV_CLASS_EXCEPTION = 0xF000_0010;
export const EV_CLASS_CARD_HL = 0xF400_0001;

export const EV_SPEC_INTERRUPTED = 0x0002;
export const EV_SPEC_CMD_COMPLETE = 0x0020;
export const EV_SPEC_CMD_ACK = 0x0010;
export const EV_SPEC_DMA_DONE = 0x0010;
export const EV_SPEC_DATA_READY = 0x0040;
export const EV_SPEC_DATA_END = 0x0080;
export const EV_SPEC_GEN_IRQ = 0x1000;
export const EV_SPEC_SYSCALL = 0x4000;
export const EV_SPEC_ERROR = 0x8000;

export const RC_CLASS_TIMER0 = 0xF200_0000;
export const RC_CLASS_TIMER1 = 0xF200_0001;
export const RC_CLASS_TIMER2 = 0xF200_0002;
export const RC_CLASS_VBLANK = 0xF200_0003;

export const IRQ_VBLANK = 0;
export const IRQ_PAD = 7;

export const CDROM_DCB_FLAGS = 0x14;
export const BU_DCB_FLAGS = 0x14;
export const TTY_DCB_FLAGS = 0x01;
export const CDROM_SECTOR_SIZE = 0x800;
export const BU_SECTOR_SIZE = 0x80;
export const TTY_SECTOR_SIZE = 1;

export const CDROM_DEV = 0;
export const CARD_DEV = 1;
export const TTY_DEV = 2;
export const NO_DEV = 0xFF;

export const FILE_ERROR_OK = 0x00;
export const FILE_ERROR_NOT_FOUND = 0x02;
export const FILE_ERROR_BAD_PORT = 0x06;
export const FILE_ERROR_BAD_FD = 0x09;
export const FILE_ERROR_GEN_IO = 0x10;
export const FILE_ERROR_IOCTL = 0x16;
export const FILE_ERROR_NO_FD = 0x18;
export const FILE_ERROR_UNKNOWN_DEV = 0x13;

export const DEFINT_LINE_CLASS = (() => {
  const map = new Array<number>(10).fill(EV_CLASS_SIO);
  map[0] = EV_CLASS_VBLANK;
  map[1] = EV_CLASS_GPU;
  map[2] = EV_CLASS_CDROM;
  map[3] = EV_CLASS_DMA;
  map[4] = EV_CLASS_TMR0;
  map[5] = EV_CLASS_TMR1_TMR2;
  map[6] = EV_CLASS_TMR1_TMR2;
  map[7] = EV_CLASS_CONTROLLER;
  map[8] = EV_CLASS_SIO;
  map[9] = EV_CLASS_SPU;

  return map;
})();

export const DEFINT_SPEC = EV_SPEC_GEN_IRQ;

export const IRQ_MASK_REG = 0x1F80_1074;
export const RC_REG_BASE = 0x1F80_1100;
export const RC_REG_MODE_OFF = 4;
export const RC_REG_TARGET_OFF = 8;

export function isKernelCallPc(virtualPc: number): boolean {
  const pc = (virtualPc & 0x1FFF_FFFF) >>> 0;
  if (pc === VEC_A || pc === VEC_B || pc === VEC_C || pc === VEC_RET) {
    return true;
  }
  if (pc >= JUMP_A_BASE && pc < JUMP_A_BASE + JUMP_A_COUNT * JUMP_A_SLOT) {
    return true;
  }
  if (pc >= B_SENTINEL_BASE && pc < B_SENTINEL_BASE + B_SENTINEL_COUNT * B_SENTINEL_STRIDE) {
    return true;
  }

  return pc >= C_SENTINEL_BASE && pc < C_SENTINEL_BASE + C_SENTINEL_COUNT * C_SENTINEL_STRIDE;
}