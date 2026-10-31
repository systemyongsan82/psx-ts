// Constants for the PSXjin compatibility profile come from docs/kb/psxjin-timing.md (PSXjin commit 534fd38).
// PSXjin counts one cycle per instruction and divides its counter periods by BIAS=2, so a frame is
// (PSXCLK/60)/BIAS = 282,240 of its cycles and cdReadTime is (PSXCLK/75)/BIAS = 225,792.
// The profile emulates the TAS recording emulator, not any game.

export type TimingProfileName = 'hardware' | 'psxjin';

export interface CdTiming {
  readonly firstResponse: number;
  readonly initFirst: number;
  readonly pauseFirst: number;
  readonly secondResponse: number;
  readonly pauseSecond: number;
  readonly stopSecond: number;
  readonly initSecond: number;
  readonly getIdSecond: number;
  readonly readTocSecond: number;
  readonly motorOnSecond: number;
  readonly setSessionSecond: number;
  readonly sectorCycles: number;
  readonly firstSectorCycles: number | null;
  readonly fixedSeekCycles: number | null;
  readonly sectorRetryCycles: number | null;
}

export interface SioTiming {
  readonly byteCycles: number | null;
  readonly replyImmediate: boolean;
  readonly ackIrqDelay: number;
  readonly cardReadExtraDelay: number;
}

export interface TimingProfile {
  readonly name: TimingProfileName;
  readonly unitInstructionCycles: boolean;
  readonly frameCycles: number;
  readonly linesPerFrame: number;
  readonly vblankLine: number;
  readonly cd: CdTiming;
  readonly sio: SioTiming;
  readonly dmaWordDivisor: number | null;
  readonly secondMemoryCard: boolean;
  readonly returnFromShell: boolean;
}

export const HARDWARE_CD_TIMING: CdTiming = {
  firstResponse: 30_000,
  initFirst: 81_000,
  pauseFirst: 30_000,
  secondResponse: 30_000,
  pauseSecond: 2_200_000,
  stopSecond: 14_000_000,
  initSecond: 50_000,
  getIdSecond: 100_000,
  readTocSecond: 5_000_000,
  motorOnSecond: 33_000,
  setSessionSecond: 10_000_000,
  sectorCycles: 451_584,
  firstSectorCycles: null,
  fixedSeekCycles: null,
  sectorRetryCycles: null,
};

const PSXJIN_RESPONSE_CYCLES = 0x800;
const PSXJIN_READ_START_CYCLES = 0x40000;
const PSXJIN_FRAME_CYCLES = 282_240;
const PSXJIN_SECTOR_CYCLES = 225_792;

export const PSXJIN_CD_TIMING: CdTiming = {
  firstResponse: PSXJIN_RESPONSE_CYCLES,
  initFirst: PSXJIN_RESPONSE_CYCLES,
  pauseFirst: PSXJIN_READ_START_CYCLES,
  secondResponse: PSXJIN_RESPONSE_CYCLES,
  pauseSecond: PSXJIN_RESPONSE_CYCLES,
  stopSecond: PSXJIN_RESPONSE_CYCLES,
  initSecond: PSXJIN_RESPONSE_CYCLES,
  getIdSecond: PSXJIN_RESPONSE_CYCLES,
  readTocSecond: PSXJIN_RESPONSE_CYCLES,
  motorOnSecond: PSXJIN_RESPONSE_CYCLES,
  setSessionSecond: PSXJIN_RESPONSE_CYCLES,
  sectorCycles: PSXJIN_SECTOR_CYCLES,
  firstSectorCycles: PSXJIN_READ_START_CYCLES,
  fixedSeekCycles: PSXJIN_RESPONSE_CYCLES,
  sectorRetryCycles: PSXJIN_RESPONSE_CYCLES,
};

export const HARDWARE_SIO_TIMING: SioTiming = { byteCycles: null, replyImmediate: false, ackIrqDelay: 100, cardReadExtraDelay: 31_000 };
export const PSXJIN_SIO_TIMING: SioTiming = { byteCycles: 200, replyImmediate: true, ackIrqDelay: 1, cardReadExtraDelay: 0 };

export const HARDWARE_PROFILE: TimingProfile = {
  name: 'hardware',
  unitInstructionCycles: false,
  frameCycles: 2_150 * 263,
  linesPerFrame: 263,
  vblankLine: 243,
  cd: HARDWARE_CD_TIMING,
  sio: HARDWARE_SIO_TIMING,
  dmaWordDivisor: null,
  secondMemoryCard: false,
  returnFromShell: false,
};

export const PSXJIN_PROFILE: TimingProfile = {
  name: 'psxjin',
  unitInstructionCycles: true,
  frameCycles: PSXJIN_FRAME_CYCLES,
  linesPerFrame: 262,
  vblankLine: 240,
  cd: PSXJIN_CD_TIMING,
  sio: PSXJIN_SIO_TIMING,
  dmaWordDivisor: 8,
  secondMemoryCard: true,
  returnFromShell: true,
};

export function profileFor(name: TimingProfileName | undefined): TimingProfile {
  return name === 'psxjin' ? PSXJIN_PROFILE : HARDWARE_PROFILE;
}

export function lineDelayCycles(profile: TimingProfile, line: number, hardwareLineCycles: number): number {
  if (profile.name === 'hardware') {
    return hardwareLineCycles;
  }
  const lines = profile.linesPerFrame;
  const at = (n: number): number => Math.floor((n * profile.frameCycles) / lines);

  return at(line + 1) - at(line);
}
