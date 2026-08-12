export interface ImageDimensions { width: number; height: number }

/** Reads raster dimensions from container headers without decoding pixels. */
export function imageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  return pngDimensions(bytes)
    ?? jpegDimensions(bytes)
    ?? gifDimensions(bytes)
    ?? webpDimensions(bytes)
    ?? bmpDimensions(bytes)
    ?? isobmffDimensions(bytes);
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 24 || !matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return undefined;
  return dimensions(u32be(bytes, 16), u32be(bytes, 20));
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 10 || text(bytes, 0, 3) !== "GIF") return undefined;
  return dimensions(u16le(bytes, 6), u16le(bytes, 8));
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (isStartOfFrame(marker) && length >= 7) return dimensions(u16be(bytes, offset + 5), u16be(bytes, offset + 3));
    offset += length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 30 || text(bytes, 0, 4) !== "RIFF" || text(bytes, 8, 4) !== "WEBP") return undefined;
  const kind = text(bytes, 12, 4);
  if (kind === "VP8X" && bytes.length >= 30) return dimensions(1 + u24le(bytes, 24), 1 + u24le(bytes, 27));
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = u32le(bytes, 21);
    return dimensions(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
  }
  if (kind === "VP8 " && bytes.length >= 30 && matches(bytes, 23, [0x9d, 0x01, 0x2a])) {
    return dimensions(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }
  return undefined;
}

function bmpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 26 || text(bytes, 0, 2) !== "BM") return undefined;
  return dimensions(Math.abs(i32le(bytes, 18)), Math.abs(i32le(bytes, 22)));
}

/** AVIF/HEIC store display dimensions in an Image Spatial Extents box. */
function isobmffDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 24 || text(bytes, 4, 4) !== "ftyp") return undefined;
  for (let offset = 4; offset + 16 <= bytes.length; offset += 1) {
    if (text(bytes, offset, 4) !== "ispe") continue;
    const result = dimensions(u32be(bytes, offset + 8), u32be(bytes, offset + 12));
    if (result) return result;
  }
  return undefined;
}

function isStartOfFrame(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf);
}

function dimensions(width: number, height: number): ImageDimensions | undefined {
  return Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0 ? { width, height } : undefined;
}

function matches(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function text(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function u16be(bytes: Uint8Array, offset: number): number { return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0); }
function u16le(bytes: Uint8Array, offset: number): number { return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8); }
function u24le(bytes: Uint8Array, offset: number): number { return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16); }
function u32be(bytes: Uint8Array, offset: number): number { return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false); }
function u32le(bytes: Uint8Array, offset: number): number { return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true); }
function i32le(bytes: Uint8Array, offset: number): number { return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0, true); }
