import type { IrqController, IrqLine } from './contracts';

export class IrqRouter implements IrqController {
  sink: (line: IrqLine) => void = () => {};
  dmaDoneSink: (channel: number) => void = () => {};

  raise(line: IrqLine): void {
    this.sink(line);
  }

  dmaDone(channel: number): void {
    this.dmaDoneSink(channel);
  }
}