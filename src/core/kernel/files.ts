import { ramWriteWord } from '../ram';
import {
  BU_DCB_FLAGS,
  CARD_DEV,
  CDROM_DEV,
  CDROM_DCB_FLAGS,
  DCB_ADDR,
  FCB_ADDR,
  FCB_COUNT,
  FCB_SIZE,
  NO_DEV,
  FILE_ERROR_BAD_FD,
  FILE_ERROR_BAD_PORT,
  FILE_ERROR_GEN_IO,
  FILE_ERROR_IOCTL,
  FILE_ERROR_NOT_FOUND,
  FILE_ERROR_NO_FD,
  FILE_ERROR_OK,
  FILE_ERROR_UNKNOWN_DEV,
  GETC_SCRATCH,
  RAM_MASK,
  TTY_DEV,
} from './layout';
import type { CdRomHle, Iso9660, Logger } from '../contracts';

const FC_FIELD_STATUS = 0x00;
const FC_FIELD_DISK_ID = 0x04;
const FC_FIELD_XFER_ADDR = 0x08;
const FC_FIELD_XFER_LEN = 0x0C;
const FC_FIELD_FPOS = 0x10;
const FC_FIELD_FLAGS = 0x14;
const FC_FIELD_ERROR = 0x18;
const FC_FIELD_DCB = 0x1C;
const FC_FIELD_FILESIZE = 0x20;
const FC_FIELD_LBA = 0x24;
const FC_FIELD_FCB_NO = 0x28;

const DIRENT_FIELD_SIZE = 0x00;
const DIRENT_FIELD_HEAD = 0x04;
const DIRENT_FIELD_NAME = 0x08;

export class FileTable {
  private readonly ram: Uint32Array;
  private readonly cd: CdRomHle;
  private readonly iso: Iso9660;
  private readonly status: Array<number> = [];
  private readonly device: Array<number> = [];
  private readonly diskId: Array<number> = [];
  private readonly flags: Array<number> = [];
  private readonly fpos: Array<number> = [];
  private readonly fileSize: Array<number> = [];
  private readonly lba: Array<number> = [];
  private readonly xferAddr: Array<number> = [];
  private readonly xferLen: Array<number> = [];
  private readonly err: Array<number> = [];
  private lastError = FILE_ERROR_OK;
  private ffMatches: Array<{ lba: number; size: number; name: string }> = [];
  private ffIndex = 0;

  constructor(ram: Uint32Array, cd: CdRomHle, iso: Iso9660, private readonly log: Logger) {
    this.ram = ram;
    this.cd = cd;
    this.iso = iso;
    for (let i = 0; i < FCB_COUNT; i++) {
      this.status.push(0);
      this.device.push(NO_DEV);
      this.diskId.push(0);
      this.flags.push(0);
      this.fpos.push(0);
      this.fileSize.push(0);
      this.lba.push(0);
      this.xferAddr.push(0);
      this.xferLen.push(0);
      this.err.push(FILE_ERROR_OK);
    }
    for (let fd = 0; fd < FCB_COUNT; fd++) {
      this.mirror(fd);
    }
  }

  probeDevice(name: string): DeviceProbe {
    const colon = name.indexOf(':');
    if (colon < 0) {
      this.log.debug('bios', `fileopen: no device prefix in ${JSON.stringify(name)}`);

      return { device: NO_DEV, known: false };
    }
    const prefix = name.slice(0, colon).toLowerCase();
    if (prefix === 'cdrom' || /^cdrom[0-9]$/.test(prefix)) {
      return { device: CDROM_DEV, known: true };
    }
    if (/^bu[0-9]+$/.test(prefix)) {
      return { device: CARD_DEV, known: true };
    }
    if (prefix === 'tty' || prefix === 'duart' || /^tty[0-9]+$/.test(prefix)) {
      return { device: TTY_DEV, known: true };
    }

    this.log.debug('bios', `fileopen: unknown device ${JSON.stringify(prefix)}`);

    return { device: NO_DEV, known: false };
  }

  open(name: string, accessmode: number): number {
    const probe = this.probeDevice(name);
    if (probe.device === NO_DEV) {
      this.lastError = FILE_ERROR_UNKNOWN_DEV;

      return -1;
    }
    if ((accessmode >>> 0 & 3) === 0) {
      this.lastError = FILE_ERROR_GEN_IO;

      return -1;
    }
    const entry = probe.device === CDROM_DEV ? this.cd.findFile(name) : null;
    if (entry === null) {
      this.lastError = probe.device === CARD_DEV ? FILE_ERROR_BAD_PORT : FILE_ERROR_NOT_FOUND;

      return -1;
    }
    let fd = -1;
    for (let i = 2; i < FCB_COUNT; i++) {
      if (this.status[i] === 0) {
        fd = i;
        break;
      }
    }
    if (fd < 0) {
      this.lastError = FILE_ERROR_NO_FD;

      return -1;
    }
    this.status[fd] = accessmode >>> 0;
    this.device[fd] = probe.device;
    this.lba[fd] = entry.lba;
    this.fileSize[fd] = entry.size;
    this.fpos[fd] = 0;
    this.diskId[fd] = entry.lba;
    this.flags[fd] = CDROM_DCB_FLAGS;
    if (probe.device === CARD_DEV) {
      this.flags[fd] = BU_DCB_FLAGS;
    }
    this.err[fd] = FILE_ERROR_OK;
    this.lastError = FILE_ERROR_OK;
    this.mirror(fd);

    return fd;
  }

  read(fd: number, dst: number, length: number): number {
    if (this.isInvalid(fd)) {
      this.lastError = FILE_ERROR_BAD_FD;

      return -1;
    }
    if (this.device[fd] !== CDROM_DEV) {
      this.err[fd] = FILE_ERROR_GEN_IO;
      this.lastError = FILE_ERROR_GEN_IO;

      return -1;
    }
    const remaining = Math.max(0, this.fileSize[fd] - this.fpos[fd]);
    const wanted = length >>> 0;
    const bounded = Math.min(wanted, 0x0500_0000);
    const n = Math.min(bounded, remaining);
    if (n > 0) {
      this.cd.readIntoRam(this.lba[fd], this.fpos[fd], n, this.ram, dst);
      this.fpos[fd] += n;
      this.xferAddr[fd] = dst & RAM_MASK;
      this.xferLen[fd] = n;
      this.mirror(fd);
    }

    return n;
  }

  getByte(fd: number): number {
    if (this.isInvalid(fd) || this.device[fd] !== CDROM_DEV) {
      this.lastError = FILE_ERROR_BAD_FD;

      return -1;
    }
    if (this.fpos[fd] >= this.fileSize[fd]) {
      return -1;
    }
    this.cd.readIntoRam(this.lba[fd], this.fpos[fd], 1, this.ram, GETC_SCRATCH);
    this.fpos[fd] += 1;
    this.mirror(fd);

    return this.readRamByte(GETC_SCRATCH);
  }

  putByte(fd: number, value: number): number {
    if (this.isInvalid(fd)) {
      this.lastError = FILE_ERROR_BAD_FD;

      return -1;
    }
    if (this.device[fd] === TTY_DEV) {
      this.log.debug('bios', 'tty out: ' + String.fromCharCode(value & 0xFF));

      return 1;
    }

    this.err[fd] = FILE_ERROR_GEN_IO;
    this.lastError = FILE_ERROR_GEN_IO;

    return -1;
  }

  write(fd: number, src: number, length: number): number {
    if (this.isInvalid(fd)) {
      this.lastError = FILE_ERROR_BAD_FD;

      return -1;
    }
    if (this.device[fd] === CDROM_DEV) {
      return 0;
    }
    if (this.device[fd] === TTY_DEV) {
      let text = '';
      const n = Math.min(length, 128);
      for (let i = 0; i < n; i++) {
        text += String.fromCharCode(this.readRamByte(src + i) & 0xFF);
      }
      this.log.debug('bios', `tty out: ${JSON.stringify(text)}`);

      return length;
    }

    this.err[fd] = FILE_ERROR_GEN_IO;
    this.lastError = FILE_ERROR_GEN_IO;

    return -1;
  }

  seek(fd: number, offset: number, seektype: number): number {
    if (this.isInvalid(fd)) {
      this.lastError = FILE_ERROR_BAD_FD;

      return -1;
    }
    let pos: number;
    if (seektype === 1) {
      pos = this.fpos[fd] + offset;
    } else if (seektype === 2) {
      pos = offset;
    } else if (seektype === 0) {
      pos = offset;
    } else {
      this.err[fd] = FILE_ERROR_IOCTL;
      this.lastError = FILE_ERROR_IOCTL;

      return -1;
    }
    this.fpos[fd] = Math.max(0, pos) >>> 0;
    this.mirror(fd);

    return this.fpos[fd];
  }

  ioctl(fd: number, cmd: number, arg: number): number {
    void arg;
    if (this.isInvalid(fd)) {
      this.lastError = FILE_ERROR_BAD_FD;

      return -1;
    }
    this.err[fd] = FILE_ERROR_IOCTL;
    this.lastError = FILE_ERROR_IOCTL;
    void cmd;

    return -1;
  }

  getDeviceFlag(fd: number): number {
    if (this.isInvalid(fd)) {
      this.lastError = FILE_ERROR_BAD_FD;

      return -1;
    }

    return this.flags[fd];
  }

  errorOf(fd: number): number {
    if (fd < 0 || fd >= FCB_COUNT) {
      return FILE_ERROR_BAD_FD;
    }

    return this.err[fd];
  }

  lastFileError(): number {
    return this.lastError;
  }

  close(fd: number): number {
    if (this.isInvalid(fd)) {
      this.lastError = FILE_ERROR_BAD_FD;

      return -1;
    }
    this.status[fd] = 0;
    this.device[fd] = NO_DEV;
    this.mirror(fd);

    return 1;
  }

  chdir(name: string): number {
    const probe = this.probeDevice(name);
    if (!probe.known) {
      this.lastError = FILE_ERROR_UNKNOWN_DEV;

      return -1;
    }

    return 0;
  }

  openInto(fd: number, name: string, accessmode: number): number {
    const probe = this.probeDevice(name);
    if (probe.device === NO_DEV) {
      this.lastError = FILE_ERROR_UNKNOWN_DEV;

      return -1;
    }
    const entry = this.cd.findFile(name);
    if (entry === null) {
      this.lastError = FILE_ERROR_NOT_FOUND;

      return -1;
    }
    this.status[fd] = accessmode >>> 0;
    this.device[fd] = probe.device;
    this.lba[fd] = entry.lba;
    this.fileSize[fd] = entry.size;
    this.fpos[fd] = 0;
    this.diskId[fd] = entry.lba;
    this.flags[fd] = CDROM_DCB_FLAGS;
    this.err[fd] = FILE_ERROR_OK;
    this.mirror(fd);

    return 1;
  }

  rename(oldName: string, newName: string): number {
    void oldName;
    void newName;
    this.lastError = 0x12;

    return -1;
  }

  deleteFile(name: string): number {
    void name;
    this.lastError = FILE_ERROR_GEN_IO;

    return -1;
  }

  undelete(name: string): number {
    void name;
    this.lastError = FILE_ERROR_GEN_IO;

    return -1;
  }

  formatDevice(): number {
    this.lastError = FILE_ERROR_GEN_IO;

    return -1;
  }

  firstfile(name: string, direntry: number): number {
    const probe = this.probeDevice(name);
    if (probe.device !== CDROM_DEV) {
      this.lastError = probe.device === NO_DEV ? FILE_ERROR_UNKNOWN_DEV : FILE_ERROR_GEN_IO;

      return -1;
    }
    this.ffMatches = this.listMatches(name);
    this.ffIndex = 0;
    if (this.ffMatches.length === 0) {
      this.lastError = FILE_ERROR_NOT_FOUND;

      return 0;
    }
    this.writeDirent(this.ffMatches[0], direntry);

    return 1;
  }

  nextfile(direntry: number): number {
    this.ffIndex++;
    if (this.ffIndex >= this.ffMatches.length) {
      return 0;
    }
    this.writeDirent(this.ffMatches[this.ffIndex], direntry);

    return 1;
  }

  private listMatches(name: string): Array<{ lba: number; size: number; name: string }> {
    const colon = name.indexOf(':');
    const lastSlash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
    let dirPart: string;
    let leaf: string;
    if (lastSlash > colon) {
      dirPart = name.slice(0, lastSlash);
      leaf = name.slice(lastSlash + 1);
    } else {
      dirPart = name.slice(0, colon + 1);
      leaf = name.slice(colon + 1);
    }
    const out: Array<{ lba: number; size: number; name: string }> = [];
    const entries = this.iso.list(dirPart);
    for (const e of entries) {
      if (e.isDirectory) {
        continue;
      }
      if (wildcardMatch(leaf, e.name)) {
        out.push({ lba: e.lba, size: e.size, name: e.name });
      }
    }

    return out;
  }

  private writeDirent(match: { lba: number; size: number; name: string }, direntry: number): void {
    ramWriteWord(this.ram, direntry + DIRENT_FIELD_SIZE, match.size >>> 0);
    ramWriteWord(this.ram, direntry + DIRENT_FIELD_HEAD, match.lba >>> 0);
    for (let i = 0; i < 16; i++) {
      const ch = i < match.name.length ? match.name.charCodeAt(i) & 0xFF : 0;
      this.writeByte(direntry + DIRENT_FIELD_NAME + i, ch);
    }
  }

  private readRamByte(addr: number): number {
    const a = addr & RAM_MASK;
    const shift = (a & 3) * 8;
    const w = this.ram[a >>> 2];

    return Math.trunc((w >>> shift) & 0xFF);
  }

  private writeByte(addr: number, value: number): void {
    const a = addr & RAM_MASK;
    const shift = (a & 3) * 8;
    const keep = 0xFFFFFFFF ^ (0xFF << shift);
    const cur = this.ram[a >>> 2];

    this.ram[a >>> 2] = (cur & keep) | ((value & 0xFF) << shift);
  }

  private isInvalid(fd: number): boolean {
    return fd < 0 || fd >= FCB_COUNT || this.status[fd] === 0;
  }

  remirrorAll(): void {
    for (let fd = 0; fd < FCB_COUNT; fd++) {
      this.mirror(fd);
    }
  }

  private mirror(fd: number): void {
    const base = FCB_ADDR + fd * FCB_SIZE;
    ramWriteWord(this.ram, base + FC_FIELD_STATUS, this.status[fd]);
    ramWriteWord(this.ram, base + FC_FIELD_DISK_ID, this.diskId[fd]);
    ramWriteWord(this.ram, base + FC_FIELD_XFER_ADDR, this.xferAddr[fd]);
    ramWriteWord(this.ram, base + FC_FIELD_XFER_LEN, this.xferLen[fd]);
    ramWriteWord(this.ram, base + FC_FIELD_FPOS, this.fpos[fd]);
    ramWriteWord(this.ram, base + FC_FIELD_FLAGS, this.flags[fd]);
    ramWriteWord(this.ram, base + FC_FIELD_ERROR, this.err[fd]);
    ramWriteWord(this.ram, base + FC_FIELD_DCB, DCB_ADDR);
    ramWriteWord(this.ram, base + FC_FIELD_FILESIZE, this.fileSize[fd]);
    ramWriteWord(this.ram, base + FC_FIELD_LBA, this.lba[fd]);
    ramWriteWord(this.ram, base + FC_FIELD_FCB_NO, fd);
  }
}

export interface DeviceProbe {
  readonly device: number;
  readonly known: boolean;
}

function wildcardMatch(pattern: string, candidate: string): boolean {
  if (pattern.indexOf('?') < 0) {
    return candidate.toLowerCase() === pattern.toLowerCase();
  }
  if (pattern.length !== candidate.length) {
    return false;
  }
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p === '?') {
      continue;
    }
    if (candidate[i] && candidate[i].toLowerCase() !== p.toLowerCase()) {
      return false;
    }
  }

  return true;
}