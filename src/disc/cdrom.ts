import type {
  CdFileEntry,
  DmaChannel,
  DmaConfig,
  IrqController,
  Logger,
  Scheduler,
  Spu,
} from '../core/contracts';
import type { IsoImage } from './iso9660';
import type { PsxBinImage } from './image';

export class Cdrom {
  constructor(
    _sched: Scheduler,
    _log: Logger,
    _image: PsxBinImage,
    _iso: IsoImage,
    _spu: Spu,
    _irq: IrqController,
  ) {
    throw new Error('Cdrom under construction — CD agent owns src/disc/cdrom.ts');
  }

  load32(_addr: number): number {
    return 0;
  }

  load16(_addr: number): number {
    return 0;
  }

  load8(_addr: number): number {
    return 0;
  }

  store32(_addr: number, _value: number): void {}

  store16(_addr: number, _value: number): void {}

  store8(_addr: number, _value: number): void {}

  dmaStart(_channel: DmaChannel, _config: DmaConfig, _ram: Uint32Array): void {}

  tick(_cycles: number): void {}

  findFile(_path: string): CdFileEntry | null {
    return null;
  }

  readFileBytes(_path: string, _byteOffset: number, _length: number): Uint8Array | null {
    return null;
  }

  readIntoRam(_lba: number, _byteOffset: number, _length: number, _ram: Uint32Array, _dstAddr: number): void {}
}
