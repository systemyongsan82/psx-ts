import { describe, expect, test } from 'bun:test';
import { inflateSync } from 'node:zlib';
import { encodePng } from './png';

function idatPayload(png: Uint8Array): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const kind = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
    if (kind === 'IDAT') {
      return png.subarray(offset + 8, offset + 8 + length);
    }
    offset += length + 12;
  }

  return new Uint8Array(0);
}

describe('encodePng', () => {
  test('scanlines carry filter type None so decoders reproduce pixels exactly', () => {
    const width = 3;
    const height = 2;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < rgba.length; i++) {
      rgba[i] = (i * 37 + 11) & 0xff;
    }
    const raw = inflateSync(idatPayload(encodePng(width, height, rgba)));
    const stride = width * 4;
    for (let y = 0; y < height; y++) {
      const line = y * (stride + 1);
      expect(raw[line]).toBe(0);
      expect(Array.from(raw.subarray(line + 1, line + 1 + stride))).toEqual(Array.from(rgba.subarray(y * stride, (y + 1) * stride)));
    }
  });
});
