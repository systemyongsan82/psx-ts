import { PadButton } from '../core/pad';

export interface PjmMovie {
  readonly version: number;
  readonly frameCount: number;
  readonly rerecords: number;
  readonly author: string;
  readonly serial: string;
  readonly frames: Uint16Array;
}

const MAGIC = 0x204D_4A50;
const PAD_COLUMNS = 14;

const COLUMN_BUTTONS: Array<number> = [
  PadButton.Square,
  PadButton.Cross,
  PadButton.Circle,
  PadButton.Triangle,
  PadButton.R1,
  PadButton.L1,
  PadButton.R2,
  PadButton.L2,
  PadButton.Left,
  PadButton.Down,
  PadButton.Right,
  PadButton.Up,
  PadButton.Start,
  PadButton.Select,
];

function readCString(bytes: Uint8Array, start: number, max: number): string {
  let out = '';
  for (let i = start; i < Math.min(bytes.length, start + max); i++) {
    if (bytes[i] === 0) {
      break;
    }
    out += String.fromCharCode(bytes[i]);
  }

  return out;
}

export function parsePjm(bytes: Uint8Array): PjmMovie {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 0x34 || view.getUint32(0, true) !== MAGIC) {
    throw new Error('not a PJM movie');
  }
  const frameCount = view.getUint32(0x10, true);
  const inputStart = view.getUint32(0x2C, true);
  const frames = new Uint16Array(frameCount);
  let pos = inputStart;
  for (let f = 0; f < frameCount; f++) {
    if (pos + PAD_COLUMNS > bytes.length) {
      throw new Error(`PJM input truncated at frame ${f}`);
    }
    let buttons = 0;
    for (let c = 0; c < PAD_COLUMNS; c++) {
      if (bytes[pos + c] !== 0x2E) {
        buttons |= COLUMN_BUTTONS[c];
      }
    }
    frames[f] = buttons;
    while (pos < bytes.length && bytes[pos] !== 0x0A) {
      pos++;
    }
    pos++;
  }

  return {
    version: view.getUint32(4, true),
    frameCount,
    rerecords: view.getUint32(0x14, true),
    author: readCString(bytes, 0x34, 0x5E),
    serial: readCString(bytes, view.getUint32(0x28, true) + 1, 9),
    frames,
  };
}
