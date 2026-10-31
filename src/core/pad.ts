import type { PadInput } from './contracts';

// Button bit values follow the PlayStation pad protocol (active-low on the wire;
// this state uses 1 = pressed and the SIO layer inverts when answering).
export const PadButton = {
  Select: 0x0001,
  L3: 0x0002,
  R3: 0x0004,
  Start: 0x0008,
  Up: 0x0010,
  Right: 0x0020,
  Down: 0x0040,
  Left: 0x0080,
  L2: 0x0100,
  R2: 0x0200,
  L1: 0x0400,
  R1: 0x0800,
  Triangle: 0x1000,
  Circle: 0x2000,
  Cross: 0x4000,
  Square: 0x8000,
} as const;

export class PadState implements PadInput {
  buttons = 0;
  onPoll: (() => void) | null = null;
}