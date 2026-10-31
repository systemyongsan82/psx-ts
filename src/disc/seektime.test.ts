import { describe, expect, test } from 'bun:test';
import { seekCycles } from './seektime';

const SECTOR = 451_584;
const MASTER_CLOCK = 33_868_800;

describe('seek time model (DuckStation GetTicksForSeek)', () => {
  test('a one-sector forward hop costs about two sector times, not a full seek', () => {
    const cycles = seekCycles(5000, 5001, SECTOR);
    expect(cycles).toBeGreaterThan(2 * SECTOR);
    expect(cycles).toBeLessThan(2 * SECTOR + MASTER_CLOCK / 100);
  });

  test('short forward distance within one track scales with the distance', () => {
    expect(seekCycles(5000, 5008, SECTOR)).toBeGreaterThan(seekCycles(5000, 5002, SECTOR));
  });

  test('medium seeks take 50 ms below the switch point and 100 ms above it', () => {
    const near = seekCycles(5000, 5100, SECTOR) / MASTER_CLOCK;
    const far = seekCycles(5000, 6000, SECTOR) / MASTER_CLOCK;
    expect(near).toBeGreaterThan(0.05);
    expect(near).toBeLessThan(0.06);
    expect(far).toBeGreaterThan(0.1);
    expect(far).toBeLessThan(0.11);
  });

  test('sled seeks grow with distance and stay below about one second', () => {
    const mid = seekCycles(5000, 20_000, SECTOR) / MASTER_CLOCK;
    const full = seekCycles(0, 300_000, SECTOR) / MASTER_CLOCK;
    expect(mid).toBeGreaterThan(0.2);
    expect(full).toBeGreaterThan(mid);
    expect(full).toBeLessThan(1);
  });

  test('a seek to the current sector still takes the minimum drive time', () => {
    const cycles = seekCycles(0, 0, SECTOR);
    expect(cycles).toBeGreaterThan(0);
    expect(cycles).toBeLessThan(MASTER_CLOCK / 20);
  });
});
