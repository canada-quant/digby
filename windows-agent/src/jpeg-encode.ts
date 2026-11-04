/**
 * JPEG encoding (W3, moved out of the retired W1 FFI adapter — pure Buffer math,
 * jpeg-js, no native code). The Rust helper returns raw BGRA frames; the
 * AGENT owns JPEG encoding + downscaling (roadmap W3: "the agent keeps
 * encoding JPEG via existing jpeg-js code — do not move encode into Rust").
 *
 * W1's encodeJpegFromBgr (24bpp BGR from GetDIBits) is superseded by
 * encodeJpegFromBgra: the frozen helper contract returns BGRA (32bpp —
 * WGC's native B8G8R8A8 frame format; the GDI fallback captures 32bpp too,
 * so ONE format crosses the seam). The pinned math is unchanged: channel
 * swap → long-edge cap → box downsample → jpeg-js encode.
 */

/** BGRA (32bpp, 4 bytes/px, row-major, no padding) → JPEG base64 with a
 *  long-edge cap. Box-sampled — the same kernel as W1. */
export function encodeJpegFromBgra(
  pixels: Buffer, width: number, height: number,
  maxDim: number, quality: number,
): { base64: string; width: number; height: number } {
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  // jpeg-js wants RGBA input: swap B↔R out of BGRA.
  const rgba = Buffer.alloc(outW * outH * 4);
  for (let dy = 0; dy < outH; dy++) {
    const sy = Math.min(height - 1, Math.floor(dy / scale));
    for (let dx = 0; dx < outW; dx++) {
      const sx = Math.min(width - 1, Math.floor(dx / scale));
      const src = (sy * width + sx) * 4;
      const dst = (dy * outW + dx) * 4;
      rgba[dst] = pixels[src + 2];     // R ← BGRA[2]
      rgba[dst + 1] = pixels[src + 1]; // G
      rgba[dst + 2] = pixels[src];     // B ← BGRA[0]
      rgba[dst + 3] = 0xff;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jpegJs = require('jpeg-js');
  const encoded: { data: Buffer } = jpegJs.encode({ data: rgba, width: outW, height: outH }, quality);
  return { base64: encoded.data.toString('base64'), width: outW, height: outH };
}
