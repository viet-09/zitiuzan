// Minimal 8-bit RGBA PNG reader/writer. The pet sprite pipeline only needs
// non-interlaced truecolour-with-alpha sheets, so a dependency is overkill.
import fs from 'node:fs';
import zlib from 'node:zlib';

const SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
const BYTES_PER_PIXEL = 4;

let crcTable = null;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[n] = value;
    }
  }
  let value = -1;
  for (let i = 0; i < buffer.length; i += 1) value = crcTable[(value ^ buffer[i]) & 0xff] ^ (value >>> 8);
  return (value ^ -1) >>> 0;
}

function unfilter(raw, width, height) {
  const stride = width * BYTES_PER_PIXEL;
  const out = Buffer.alloc(height * stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const current = out.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= BYTES_PER_PIXEL ? current[x - BYTES_PER_PIXEL] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= BYTES_PER_PIXEL ? previous[x - BYTES_PER_PIXEL] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const dLeft = Math.abs(estimate - left);
        const dUp = Math.abs(estimate - up);
        const dUpLeft = Math.abs(estimate - upLeft);
        value += dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
      }
      current[x] = value & 0xff;
    }
  }
  return out;
}

/** Decode an 8-bit RGBA PNG into `{ width, height, data }`. */
export function decodePNG(file) {
  const buffer = fs.readFileSync(file);
  const parts = [];
  let width = 0;
  let height = 0;
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error(`${file}: expected a non-interlaced 8-bit RGBA PNG`);
      }
    } else if (type === 'IDAT') parts.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  return { width, height, data: unfilter(zlib.inflateSync(Buffer.concat(parts)), width, height) };
}

/** Encode raw RGBA bytes as an 8-bit RGBA PNG buffer. */
export function encodePNG({ width, height, data }) {
  const stride = width * BYTES_PER_PIXEL;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunks = [Buffer.from(SIGNATURE)];
  const push = (type, payload) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    chunks.push(length, body, checksum);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  push('IHDR', header);
  push('IDAT', zlib.deflateSync(raw, { level: 9 }));
  push('IEND', Buffer.alloc(0));
  return Buffer.concat(chunks);
}

/** Allocate a fully transparent RGBA canvas. */
export function createCanvas(width, height) {
  return { width, height, data: Buffer.alloc(width * height * BYTES_PER_PIXEL) };
}

/** Copy a source rectangle onto a canvas, optionally mirrored horizontally. */
export function blit(target, source, rect, position, { mirror = false } = {}) {
  for (let y = 0; y < rect.height; y += 1) {
    const targetY = position.y + y;
    if (targetY < 0 || targetY >= target.height) continue;
    for (let x = 0; x < rect.width; x += 1) {
      const targetX = position.x + (mirror ? rect.width - 1 - x : x);
      if (targetX < 0 || targetX >= target.width) continue;
      const from = ((rect.y + y) * source.width + (rect.x + x)) * BYTES_PER_PIXEL;
      const to = (targetY * target.width + targetX) * BYTES_PER_PIXEL;
      source.data.copy(target.data, to, from, from + BYTES_PER_PIXEL);
    }
  }
}
