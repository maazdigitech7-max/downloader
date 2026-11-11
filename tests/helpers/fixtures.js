'use strict';

const sharp = require('sharp');

async function makePng() {
  return sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 124, g: 58, b: 237, alpha: 0.5 } } }).png().toBuffer();
}
async function makeJpeg() {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: '#2563eb' } }).jpeg().toBuffer();
}
/** Minimal buffer that is recognised as MP4 (ftyp box). Enough for type-sniffing and proxy tests; no ffmpeg needed. */
function makeMp4() {
  const head = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31]);
  return Buffer.concat([head, Buffer.alloc(4000, 7)]);
}

module.exports = { makePng, makeJpeg, makeMp4 };
