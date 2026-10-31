const MASTER_CLOCK = 33_868_800;
const FRAMES_PER_MINUTE = 60 * 75;
const SETTLE_CYCLES = Math.floor((MASTER_CLOCK / 2000 + MASTER_CLOCK / 1000) / 2);
const SLED_FIXED_SECONDS = 0.05;
const SLED_MAX_SECONDS = 0.9;
const SLED_LOG_WEIGHT = 0.4;
const MAX_SLED_LBA = 72 * FRAMES_PER_MINUTE;
const SHORT_SEEK_LIMIT = 7200;

function sectorsPerTrack(lba: number): number {
  const minute = Math.floor(lba / FRAMES_PER_MINUTE);
  if (minute === 0) {
    return 8;
  }
  const upperBounds = [4, 7, 11, 16, 23, 27, 32, 39, 44, 52, 60, 67, 74];
  for (let i = 0; i < upperBounds.length; i++) {
    if (minute <= upperBounds[i]) {
      return 9 + i;
    }
  }

  return 22;
}

export function seekCycles(fromLba: number, toLba: number, sectorCycles: number): number {
  const diff = Math.abs(toLba - fromLba);
  const perTrack = sectorsPerTrack(fromLba);
  const trackJumpBase = fromLba >= perTrack ? fromLba - perTrack : 0;
  let cycles: number;
  if (fromLba < toLba && diff <= perTrack) {
    cycles = sectorCycles * Math.max(diff, 2);
  } else if (fromLba >= toLba && trackJumpBase <= toLba) {
    cycles = sectorCycles * Math.max(toLba - trackJumpBase, 1);
  } else if (diff < SHORT_SEEK_LIMIT) {
    const minutes = Math.min(Math.max(fromLba / FRAMES_PER_MINUTE, 1), 72);
    const switchPoint = Math.floor(330 - 63.1333 * Math.log(minutes));
    cycles = Math.floor((diff < switchPoint ? 0.05 : 0.1) * MASTER_CLOCK);
  } else {
    const variable = SLED_MAX_SECONDS - SLED_FIXED_SECONDS;
    const seconds = SLED_FIXED_SECONDS
      + variable * (Math.log(diff) / Math.log(MAX_SLED_LBA)) * SLED_LOG_WEIGHT
      + variable * (diff / MAX_SLED_LBA) * (1 - SLED_LOG_WEIGHT);
    cycles = Math.floor(seconds * MASTER_CLOCK);
  }

  return cycles + SETTLE_CYCLES;
}
