import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { PadButton } from '../core/pad';
import { parsePjm } from './pjm';

const MOVIE = "games/Resident Evil - Director's Cut (USA)/arukado,uroboros-redc.pjm";

function syntheticMovie(lines: Array<string>): Uint8Array {
  const header = new Uint8Array(0x9C);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x204D_4A50, true);
  view.setUint32(4, 2, true);
  view.setUint32(0x10, lines.length, true);
  view.setUint32(0x14, 7, true);
  view.setUint32(0x28, 0x92, true);
  view.setUint32(0x2C, 0x9C, true);
  const author = 'tester';
  for (let i = 0; i < author.length; i++) {
    header[0x34 + i] = author.charCodeAt(i);
  }
  header[0x92] = 1;
  const serial = 'SLUS00551';
  for (let i = 0; i < serial.length; i++) {
    header[0x93 + i] = serial.charCodeAt(i);
  }
  const body = new TextEncoder().encode(lines.map((l) => `${l}\r\n`).join(''));
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);

  return out;
}

describe('parsePjm', () => {
  test('maps the 14 text columns to pad bits, Square first and Select last', () => {
    const movie = parsePjm(syntheticMovie([
      '..............||0|',
      '#X.^........S.||0|',
      '........LDRU..||0|',
      '.............s||0|',
    ]));
    expect(movie.frameCount).toBe(4);
    expect(movie.rerecords).toBe(7);
    expect(movie.author).toBe('tester');
    expect(movie.serial).toBe('SLUS00551');
    expect(movie.frames[0]).toBe(0);
    expect(movie.frames[1]).toBe(PadButton.Square | PadButton.Cross | PadButton.Triangle | PadButton.Start);
    expect(movie.frames[2]).toBe(PadButton.Left | PadButton.Down | PadButton.Right | PadButton.Up);
    expect(movie.frames[3]).toBe(PadButton.Select);
  });

  test.skipIf(!existsSync(MOVIE))('reads the Director\'s Cut TAS header and its first Start press', () => {
    const movie = parsePjm(new Uint8Array(readFileSync(MOVIE)));
    expect(movie.frameCount).toBe(207757);
    expect(movie.serial).toBe('SLUS00551');
    expect(movie.author).toContain('arukAdo');
    let first = -1;
    for (let f = 0; f < movie.frameCount; f++) {
      if (movie.frames[f] !== 0) {
        first = f;
        break;
      }
    }
    expect(first).toBe(346);
    expect(movie.frames[first]).toBe(PadButton.Start);
  });
});
