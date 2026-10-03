import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  crcTable[index] = crc >>> 0;
}
function pngChunk(kind: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0); chunk.write(kind, 4, 4, 'ascii'); chunk.set(data, 8);
  let crc = 0xffffffff;
  for (let index = 4; index < chunk.length - 4; index++) crc = crcTable[(crc ^ chunk[index]!) & 255]! ^ (crc >>> 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}
function iconPng(size: number, maskable: boolean): Buffer {
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  const scale = maskable ? .76 : .9;
  const needleCos = Math.cos(-.7); const needleSin = Math.sin(-.7);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let red = 0; let green = 0; let blue = 0; let alpha = 0;
      // Four subpixel samples provide smooth edges without image libraries.
      for (let subX = 0; subX < 2; subX++) for (let subY = 0; subY < 2; subY++) {
        const px = (x + .25 + subX * .5) / size; const py = (y + .25 + subY * .5) / size;
        const cornerX = Math.max(Math.abs(px - .5) - .31, 0); const cornerY = Math.max(Math.abs(py - .5) - .31, 0);
        const visible = maskable || cornerX * cornerX + cornerY * cornerY <= .18 * .18;
        if (!visible) continue;
        const gx = (px - .5) / scale; const gy = (py - .54) / scale;
        const distance = Math.hypot(gx, gy); const angle = Math.atan2(gy, gx);
        const ring = distance >= .235 && distance <= .32 && !(gy > .07 && Math.abs(gx) < .225);
        const filled = ring && (angle < -.4 || angle > 2.6);
        const needleX = gx * needleCos + gy * needleSin;
        const needleY = -gx * needleSin + gy * needleCos;
        const needle = needleX >= -.025 && needleX <= .205 && Math.abs(needleY) < .018;
        const center = distance < .046;
        if (needle || center) { red += 248; green += 251; blue += 255; }
        else if (ring && filled) { red += 135; green += 220; blue += 255; }
        else if (ring) { red += 81; green += 103; blue += 170; }
        else { red += 30 + Math.round(py * 10); green += 49 + Math.round(py * 9); blue += 105 + Math.round(px * 22); }
        alpha += 255;
      }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      scanlines[offset] = Math.round(red / 4); scanlines[offset + 1] = Math.round(green / 4); scanlines[offset + 2] = Math.round(blue / 4); scanlines[offset + 3] = Math.round(alpha / 4);
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(scanlines, { level: 9 })), pngChunk('IEND', new Uint8Array())]);
}
const outputDirectory = new URL('../public/icons/', import.meta.url);
await mkdir(outputDirectory, { recursive: true });
for (const size of [192, 512]) {
  await writeFile(new URL(`icon-${size}.png`, outputDirectory), iconPng(size, false));
  await writeFile(new URL(`maskable-${size}.png`, outputDirectory), iconPng(size, true));
}
