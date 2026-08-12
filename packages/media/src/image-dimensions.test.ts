import { describe, expect, it } from "vitest";
import { imageDimensions } from "./image-dimensions.js";

describe("imageDimensions", () => {
  it("reads PNG dimensions from the IHDR header", () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(bytes.buffer).setUint32(16, 1024, false);
    new DataView(bytes.buffer).setUint32(20, 768, false);
    expect(imageDimensions(bytes)).toEqual({ width: 1024, height: 768 });
  });

  it("reads JPEG dimensions from a start-of-frame segment", () => {
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x00, 0x04, 0x00,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
      0xff, 0xd9,
    ]);
    expect(imageDimensions(bytes)).toEqual({ width: 1024, height: 768 });
  });

  it("returns undefined for unknown or truncated content", () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(imageDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  });
});
