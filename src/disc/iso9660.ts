import type { Iso9660, IsoEntry, RawSectorIo, Logger } from '../core/contracts';

const SECTOR_SIZE = 2352;
const USER_DATA_OFF = 24;
const USER_DATA_SIZE = 2048;
const ROOT_PVD_LBA = 16;

function readUserDataInto(io: RawSectorIo, lba: number, dst: Uint8Array): void {
  let done = 0;
  let sector = lba;
  while (done < USER_DATA_SIZE) {
    const raw = new Uint8Array(SECTOR_SIZE);
    io.readRawSectors(sector, 1, raw);
    dst.set(raw.subarray(USER_DATA_OFF, USER_DATA_OFF + USER_DATA_SIZE), done);
    done += USER_DATA_SIZE;
    sector += 1;
  }
}

function asciiBytes(dst: Uint8Array, start: number, len: number): string {
  let acc = '';
  const stop = start + len;
  for (let i = start; i < stop; i++) {
    const c = dst[i];
    if (c === 0) {
      break;
    }
    acc += String.fromCharCode(c);
  }

  return acc;
}

export class IsoImage implements Iso9660 {
  private readonly entries: Array<IsoEntry> = [];
  readonly volumeId: string;

  constructor(private readonly io: RawSectorIo, log: Logger) {
    const pvd = new Uint8Array(USER_DATA_SIZE);
    readUserDataInto(io, ROOT_PVD_LBA, pvd);
    const id = String.fromCharCode(pvd[1], pvd[2], pvd[3], pvd[4], pvd[5]);
    if (id !== 'CD001') {
      log.warn('iso', `PVD id mismatch: ${id}`);
    }
    this.volumeId = asciiBytes(pvd, 40, 32).trim();
    const rootExtent = pvd[158] | (pvd[159] << 8) | (pvd[160] << 16) | (pvd[161] << 24);
    this.scan([rootExtent], '', this.entries, new Set<number>());
    log.debug('iso', `scanned ${this.entries.length} entries, root at lba ${rootExtent}, volume ${this.volumeId}`);
  }

  private scan(roots: Array<number>, base: string, out: Array<IsoEntry>, visited: Set<number>): void {
    const queue = roots.slice();
    while (queue.length > 0) {
      const extent = queue.shift() ?? 0;
      if (extent < 0 || visited.has(extent)) {
        continue;
      }
      visited.add(extent);
      const dirData = new Uint8Array(USER_DATA_SIZE);
      readUserDataInto(this.io, extent, dirData);
      const before = out.length;
      parseDirRecords(dirData, base, out);
      for (let k = before; k < out.length; k++) {
        if (out[k].isDirectory) {
          queue.push(out[k].lba);
        }
      }
    }
  }

  find(path: string): IsoEntry | null {
    const want = normalize(path);
    for (const e of this.entries) {
      if (normalize(e.path) === want) {
        return e;
      }
    }

    return null;
  }

  list(path: string): Array<IsoEntry> {
    const prefix = normalize(path);
    return this.entries.filter((e) => normalize(e.path).startsWith(prefix));
  }

  readBytes(entry: IsoEntry, offset: number, length: number): Uint8Array {
    return readEntryBytes(this.io, entry.lba, offset, length);
  }
}

export function readEntryBytes(io: RawSectorIo, entryLba: number, offset: number, length: number): Uint8Array {
  const dst = new Uint8Array(length);
  let lba = entryLba + Math.floor(offset / USER_DATA_SIZE);
  let sectorOffset = offset % USER_DATA_SIZE;
  let done = 0;
  while (done < length) {
    const chunk = Math.min(USER_DATA_SIZE - sectorOffset, length - done);
    const raw = new Uint8Array(SECTOR_SIZE);
    io.readRawSectors(lba, 1, raw);
    for (let i = 0; i < chunk; i++) {
      dst[done + i] = raw[USER_DATA_OFF + sectorOffset + i];
    }
    done += chunk;
    sectorOffset = 0;
    lba += 1;
  }

  return dst;
}

function normalize(path: string): string {
  return path
    .replace(/^\S+?:/, '')
    .replace(/[\\/]+/g, '/')
    .replace(/;.*$/, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

function parseDirRecords(dirData: Uint8Array, parentPath: string, out: Array<IsoEntry>): void {
  let i = 0;
  while (i < dirData.length) {
    const rl = dirData[i];
    if (rl === 0) {
      break;
    }
    const lba = readU32(dirData, i + 2);
    const size = readU32(dirData, i + 10);
    const flags = dirData[i + 25];
    const nameLen = dirData[i + 32];
    const name = asciiBytes(dirData, i + 33, nameLen).split(';')[0];
    if (name !== '.' && name !== '..') {
      out.push({
        name,
        path: `${parentPath}\\${name}`,
        lba,
        size: (flags & 0x02) !== 0 ? 0 : size,
        isDirectory: (flags & 0x02) !== 0,
      });
    }
    i += rl;
  }
}

function readU32(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}