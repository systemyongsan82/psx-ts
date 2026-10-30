import { ramWriteWord } from '../ram';
import {
  EVCB_ADDR,
  EVCB_SIZE,
  EV_MODE_CALLBACK,
  EV_MODE_FLAG,
  EV_STATUS_BUSY,
  EV_STATUS_DISABLED,
  EV_STATUS_FREE,
  EV_STATUS_READY,
  INTERNAL_CD_EVENT_SLOTS,
} from './layout';

export const EVENT_HANDLE_BASE = 0xF100_0000;
export const EVENT_HANDLE_MASK = 0xFFFF;

export const CD_EVENT_SPEC_DMA_DONE = 0x10;
export const CD_EVENT_SPEC_20 = 0x20;
export const CD_EVENT_SPEC_DEAD = 0x40;
export const CD_EVENT_SPEC_END_OF_DISK = 0x80;
export const CD_EVENT_SPEC_ERROR = 0x8000;
export const CD_EVENT_CLASS = 0xF000_0003;

const EVCB_FIELD_CLASS = 0x00;
const EVCB_FIELD_STATUS = 0x04;
const EVCB_FIELD_SPEC = 0x08;
const EVCB_FIELD_MODE = 0x0C;
const EVCB_FIELD_FN = 0x10;

export class EventTable {
  private readonly ram: Uint32Array;
  private readonly cls: Array<number> = [];
  private readonly spec: Array<number> = [];
  private readonly mode: Array<number> = [];
  private readonly fn: Array<number> = [];
  private readonly status: Array<number> = [];

  constructor(ram: Uint32Array, evcbCount: number) {
    this.ram = ram;
    this.rebuild(evcbCount);
  }

  get count(): number {
    return this.status.length;
  }

  rebuild(evcbCount: number): void {
    this.cls.length = 0;
    this.spec.length = 0;
    this.mode.length = 0;
    this.fn.length = 0;
    this.status.length = 0;
    for (let i = 0; i < evcbCount; i++) {
      this.cls.push(0);
      this.spec.push(0);
      this.mode.push(0);
      this.fn.push(0);
      this.status.push(EV_STATUS_FREE);
      writeEvcb(this.ram, i, EV_STATUS_FREE, 0, 0, 0, 0);
    }
    this.openInternalCdEvents();
  }

  private openInternalCdEvents(): void {
    const internalSpecs = [
      CD_EVENT_SPEC_DMA_DONE,
      CD_EVENT_SPEC_20,
      CD_EVENT_SPEC_DEAD,
      CD_EVENT_SPEC_END_OF_DISK,
      CD_EVENT_SPEC_ERROR,
    ];
    for (let i = 0; i < INTERNAL_CD_EVENT_SLOTS; i++) {
      const slot = i;
      this.cls[slot] = CD_EVENT_CLASS;
      this.spec[slot] = internalSpecs[i];
      this.mode[slot] = EV_MODE_FLAG;
      this.fn[slot] = 0;
      this.status[slot] = EV_STATUS_BUSY;
      writeEvcb(this.ram, slot, this.status[slot], this.cls[slot], this.spec[slot], this.mode[slot], this.fn[slot]);
    }
  }

  firstFreeSlot(): number {
    const min = INTERNAL_CD_EVENT_SLOTS;
    for (let i = min; i < this.status.length; i++) {
      if (this.status[i] === EV_STATUS_FREE) {
        return i;
      }
    }

    return -1;
  }

  open(cls: number, spec: number, mode: number, fn: number): number {
    const slot = this.firstFreeSlot();
    if (slot < 0) {

      return 0xFFFFFFFF;
    }
    this.cls[slot] = cls;
    this.spec[slot] = spec;
    this.mode[slot] = mode;
    this.fn[slot] = fn;
    this.status[slot] = EV_STATUS_DISABLED;
    writeEvcb(this.ram, slot, this.status[slot], cls, spec, mode, fn);

    return EVENT_HANDLE_BASE + slot;
  }

  slotOf(handle: number): number {
    return handle & EVENT_HANDLE_MASK;
  }

  close(handle: number): number {
    const slot = this.slotOf(handle);
    if (slot >= INTERNAL_CD_EVENT_SLOTS && slot < this.status.length) {
      this.status[slot] = EV_STATUS_FREE;
      writeEvcb(this.ram, slot, EV_STATUS_FREE, this.cls[slot], this.spec[slot], this.mode[slot], this.fn[slot]);
    }

    return 1;
  }

  enable(handle: number): number {
    const slot = this.slotOf(handle);
    if (this.isValid(slot) && this.status[slot] === EV_STATUS_DISABLED) {
      this.setStatus(slot, EV_STATUS_BUSY);
    }

    return 1;
  }

  disable(handle: number): number {
    const slot = this.slotOf(handle);
    if (this.isValid(slot)) {
      const st = this.status[slot];
      if (st === EV_STATUS_BUSY || st === EV_STATUS_READY) {
        this.setStatus(slot, EV_STATUS_DISABLED);
      }
    }

    return 1;
  }

  test(handle: number): number {
    const slot = this.slotOf(handle);
    if (this.isValid(slot) && this.status[slot] === EV_STATUS_READY) {
      this.setStatus(slot, EV_STATUS_BUSY);

      return 1;
    }

    return 0;
  }

  isBlockedWaitCandidate(handle: number): boolean {
    const slot = this.slotOf(handle);

    return this.isValid(slot) && this.status[slot] === EV_STATUS_BUSY;
  }

  isReady(handle: number): boolean {
    const slot = this.slotOf(handle);

    return this.isValid(slot) && this.status[slot] === EV_STATUS_READY;
  }

  isReadySlot(slot: number): boolean {
    return slot >= 0 && slot < this.status.length && this.status[slot] === EV_STATUS_READY;
  }

  deliver(cls: number, spec: number, outCallbacks: Array<number>): number {
    let fired = 0;
    for (let i = 0; i < this.status.length; i++) {
      if (this.status[i] !== EV_STATUS_BUSY) {
        continue;
      }
      if (this.cls[i] !== cls || this.spec[i] !== spec) {
        continue;
      }
      if (this.mode[i] === EV_MODE_CALLBACK && this.fn[i] !== 0) {
        outCallbacks.push(this.fn[i]);
        continue;
      }
      if (this.mode[i] === EV_MODE_FLAG) {
        this.setStatus(i, EV_STATUS_READY);
        fired++;
      }
    }

    return fired;
  }

  unDeliver(cls: number, spec: number): void {
    for (let i = 0; i < this.status.length; i++) {
      if (this.status[i] === EV_STATUS_READY && this.mode[i] === EV_MODE_FLAG
        && this.cls[i] === cls && this.spec[i] === spec) {
        this.setStatus(i, EV_STATUS_BUSY);
      }
    }
  }

  private isValid(slot: number): boolean {
    return slot >= 0 && slot < this.status.length;
  }

  private setStatus(slot: number, value: number): void {
    this.status[slot] = value;
    ramWriteWord(this.ram, EVCB_ADDR + slot * EVCB_SIZE + EVCB_FIELD_STATUS, value);
  }
}

function writeEvcb(
  ram: Uint32Array,
  slot: number,
  status: number,
  cls: number,
  spec: number,
  mode: number,
  fn: number,
): void {
  const base = EVCB_ADDR + slot * EVCB_SIZE;
  ramWriteWord(ram, base + EVCB_FIELD_CLASS, cls);
  ramWriteWord(ram, base + EVCB_FIELD_STATUS, status);
  ramWriteWord(ram, base + EVCB_FIELD_SPEC, spec);
  ramWriteWord(ram, base + EVCB_FIELD_MODE, mode);
  ramWriteWord(ram, base + EVCB_FIELD_FN, fn);
}