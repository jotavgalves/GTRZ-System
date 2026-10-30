import { describe, expect, it } from 'vitest';
import {
  buildEscPosJob,
  encodeRaster,
  type BgraImage,
} from '../../apps/desktop/src/main/escpos-raster';

function image(width: number, height: number, black: (x: number, y: number) => boolean): BgraImage {
  const bgra = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (black(x, y)) bgra.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
  }
  return { width, height, bgra };
}

describe('ESC/POS raster encoding', () => {
  it('packs pixels most-significant-bit first with a GS v 0 header', () => {
    const encoded = encodeRaster(
      image(16, 2, (x, y) => (y === 0 && x === 0) || (y === 1 && x === 15)),
    );
    expect([...encoded.subarray(0, 8)]).toEqual([0x1d, 0x76, 0x30, 0x00, 2, 0, 2, 0]);
    expect([...encoded.subarray(8)]).toEqual([0x80, 0x00, 0x00, 0x01]);
  });

  it('pads a width that is not a multiple of eight and splits tall images into blocks', () => {
    const encoded = encodeRaster(image(10, 130, () => true));
    expect([...encoded.subarray(0, 8)]).toEqual([0x1d, 0x76, 0x30, 0x00, 2, 0, 128, 0]);
    const second = 8 + 2 * 128;
    expect([...encoded.subarray(second, second + 8)]).toEqual([0x1d, 0x76, 0x30, 0x00, 2, 0, 2, 0]);
    expect(encoded[8]).toBe(0xff);
    expect(encoded[9]).toBe(0xc0);
  });

  it('treats transparent pixels as white paper', () => {
    const transparent: BgraImage = { width: 8, height: 1, bgra: Buffer.alloc(8 * 4, 0) };
    expect([...encodeRaster(transparent).subarray(8)]).toEqual([0x00]);
  });

  it('cuts the paper after every page', () => {
    const page = image(8, 1, () => false);
    const job = buildEscPosJob([page, page]);
    expect([...job.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    const cut = Buffer.from([0x1d, 0x56, 0x42, 0x00]);
    const first = job.indexOf(cut);
    expect(first).toBeGreaterThan(0);
    expect(job.indexOf(cut, first + 1)).toBeGreaterThan(first);
    expect(job.subarray(-cut.length).equals(cut)).toBe(true);
  });
});
