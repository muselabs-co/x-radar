// generate_icons.js - Generates crisp PNG icons without external npm dependencies
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

function createPng(width, height, drawFn) {
  const bytesPerPixel = 4;
  const rowSize = width * bytesPerPixel;
  const rawData = Buffer.alloc((rowSize + 1) * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (rowSize + 1);
    rawData[rowOffset] = 0; // Filter type: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = drawFn(x, y, width, height);
      const pixelOffset = rowOffset + 1 + x * bytesPerPixel;
      rawData[pixelOffset] = r;
      rawData[pixelOffset + 1] = g;
      rawData[pixelOffset + 2] = b;
      rawData[pixelOffset + 3] = a;
    }
  }

  const compressedData = zlib.deflateSync(rawData);

  // PNG Signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // Bit depth: 8
  ihdrData[9] = 6; // Color type: RGBA
  ihdrData[10] = 0; // Compression
  ihdrData[11] = 0; // Filter
  ihdrData[12] = 0; // Interlace
  const ihdrChunk = createChunk('IHDR', ihdrData);

  // IDAT chunk
  const idatChunk = createChunk('IDAT', compressedData);

  // IEND chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const length = data.length;
  const chunk = Buffer.alloc(8 + length + 4);
  chunk.writeUInt32BE(length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  const crc = crc32(chunk.subarray(4, 8 + length));
  chunk.writeUInt32BE(crc, 8 + length);
  return chunk;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function drawRadar(x, y, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy) - 1;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist > r) return [0, 0, 0, 0]; // Transparent outside

  // Background: dark midnight blue/black (#0f1419)
  let red = 15, green = 20, blue = 25, alpha = 255;

  // Outer border ring (Twitter blue #1d9bf0)
  if (Math.abs(dist - r) < 1.5) {
    return [29, 155, 240, 255];
  }

  // Inner concentric circles
  const ring1 = r * 0.4;
  const ring2 = r * 0.7;
  if (Math.abs(dist - ring1) < 0.8 || Math.abs(dist - ring2) < 0.8) {
    return [30, 80, 130, 200];
  }

  // Radar sweep effect (angle calculation)
  let angle = Math.atan2(dy, dx); // -PI to PI
  if (angle < 0) angle += 2 * Math.PI; // 0 to 2*PI

  const sweepAngle = Math.PI * 0.4; // 72 deg sweep
  const currentBeam = Math.PI * 0.25; // beam direction 45 deg
  let diff = angle - currentBeam;
  while (diff < 0) diff += 2 * Math.PI;
  while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

  if (diff < sweepAngle) {
    const intensity = (1 - diff / sweepAngle) * 0.6;
    red = Math.round(red + (29 - red) * intensity);
    green = Math.round(green + (155 - green) * intensity);
    blue = Math.round(blue + (240 - blue) * intensity);
  }

  // Crosshair lines
  if (Math.abs(dx) < 0.6 || Math.abs(dy) < 0.6) {
    red = 40; green = 90; blue = 140;
  }

  // Center blip / dot (bright cyan #00ffff)
  if (dist < 2.5) {
    return [0, 240, 255, 255];
  }

  // A blip in the radar field
  const blipDx = dx - (r * 0.45);
  const blipDy = dy + (r * 0.45);
  if (Math.sqrt(blipDx * blipDx + blipDy * blipDy) < (w > 32 ? 2.5 : 1.2)) {
    return [0, 255, 180, 255]; // Neon green target blip
  }

  return [red, green, blue, alpha];
}

const iconsDir = path.resolve('icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

[16, 48, 128].forEach(size => {
  const pngBuffer = createPng(size, size, drawRadar);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), pngBuffer);
  console.log(`Generated icon${size}.png`);
});
