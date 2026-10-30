import type { IrqController, IrqLine } from './contracts';

export class IrqRouter implements IrqController {
  sink: (line: IrqLine) => void = () => {};

  raise(line: IrqLine): void {
    this.sink(line);
  }
}