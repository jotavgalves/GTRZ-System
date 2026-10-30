export interface BgraImage {
  readonly width: number;
  readonly height: number;
  /** Electron NativeImage.toBitmap() layout: 4 bytes per pixel, B G R A. */
  readonly bgra: Buffer;
}

const ROWS_PER_BLOCK = 128;
const BLACK_BELOW_LUMINANCE = 160;

/** ESC/POS "GS v 0" raster blocks. Transparent pixels are treated as paper white. */
export function encodeRaster(image: BgraImage): Buffer {
  const widthBytes = Math.ceil(image.width / 8);
  const blocks: Buffer[] = [];
  for (let top = 0; top < image.height; top += ROWS_PER_BLOCK) {
    const rows = Math.min(ROWS_PER_BLOCK, image.height - top);
    const header = Buffer.from([
      0x1d,
      0x76,
      0x30,
      0x00,
      widthBytes & 0xff,
      widthBytes >> 8,
      rows & 0xff,
      rows >> 8,
    ]);
    const data = Buffer.alloc(widthBytes * rows);
    for (let row = 0; row < rows; row += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const offset = ((top + row) * image.width + x) * 4;
        const alpha = (image.bgra[offset + 3] ?? 255) / 255;
        const blue = (image.bgra[offset] ?? 255) * alpha + 255 * (1 - alpha);
        const green = (image.bgra[offset + 1] ?? 255) * alpha + 255 * (1 - alpha);
        const red = (image.bgra[offset + 2] ?? 255) * alpha + 255 * (1 - alpha);
        if (0.299 * red + 0.587 * green + 0.114 * blue < BLACK_BELOW_LUMINANCE) {
          const index = row * widthBytes + (x >> 3);
          data[index] = (data[index] ?? 0) | (0x80 >> (x & 7));
        }
      }
    }
    blocks.push(header, data);
  }
  return Buffer.concat(blocks);
}

const INITIALIZE = Buffer.from([0x1b, 0x40]);
const FEED_FOUR_LINES = Buffer.from([0x1b, 0x64, 0x04]);
const PARTIAL_CUT = Buffer.from([0x1d, 0x56, 0x42, 0x00]);

/** One print job: every page (e.g. customer note, pickup voucher) is followed by a paper cut. */
export function buildEscPosJob(pages: readonly BgraImage[]): Buffer {
  return Buffer.concat([
    INITIALIZE,
    ...pages.flatMap((page) => [encodeRaster(page), FEED_FOUR_LINES, PARTIAL_CUT]),
  ]);
}
