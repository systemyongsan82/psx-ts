const CRC_TABLE = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }

  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }

  return (c ^ 0xffffffff) >>> 0;
}

function chunk(kind: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = (kind >>> 24) & 0xff;
  out[5] = (kind >>> 16) & 0xff;
  out[6] = (kind >>> 8) & 0xff;
  out[7] = kind & 0xff;
  out.set(data, 8);
  view.setUint32(data.length + 8, crc32(out.subarray(4, 8 + data.length)));

  return out;
}

function zlibStored(raw: Uint8Array): Uint8Array {
  const maxBlock = 65535;
  const blocks = Math.ceil(raw.length / maxBlock) || 1;
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let w = 0;
  out[w++] = 0x78;
  out[w++] = 0x01;
  for (let b = 0; b < blocks; b++) {
    const start = b * maxBlock;
    const len = Math.min(maxBlock, raw.length - start);
    out[w++] = len === maxBlock ? 0 : b === blocks - 1 ? 1 : 0;
    out[w++] = len & 0xff;
    out[w++] = (len >>> 8) & 0xff;
    const nlen = (~len >>> 0) & 0xffff;
    out[w++] = nlen & 0xff;
    out[w++] = (nlen >>> 8) & 0xff;
    out.set(raw.subarray(start, start + len), w);
    w += len;
  }

  let a = 1;
  let bb = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    bb = (bb + a) % 65521;
  }
  const adler = ((bb << 16) | a) >>> 0;
  new DataView(out.buffer).setUint32(w, adler);

  return out;
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 4;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrC = chunk(0x49484452, ihdr);
  const idatC = chunk(0x49444154, zlibStored(raw));
  const iendC = chunk(0x49454e44, new Uint8Array(0));
  const out = new Uint8Array(sig.length + ihdrC.length + idatC.length + iendC.length);
  let w = 0;
  out.set(sig, w); w += sig.length;
  out.set(ihdrC, w); w += ihdrC.length;
  out.set(idatC, w); w += idatC.length;
  out.set(iendC, w);

  return out;
}