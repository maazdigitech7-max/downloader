'use strict';

const { AppError } = require('./errors');

const IMAGE_TARGETS = ['jpg', 'png', 'webp'];
const OUTPUT = {
  jpg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  webp: { mime: 'image/webp', ext: 'webp' },
};

/**
 * Identify a file from its first bytes (name and browser-reported type are never trusted).
 * Returns { mime, ext, kind } or null when the content is not a recognised image/video.
 */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', kind: 'image' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png', kind: 'image' };
  const head6 = buf.toString('latin1', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return { mime: 'image/gif', ext: 'gif', kind: 'image' };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp', kind: 'image' };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { mime: 'video/webm', ext: 'webm', kind: 'video' };
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis|M4A |M4B |M4P )$/.test(brand)) return null;
    return brand === 'qt  ' ? { mime: 'video/quicktime', ext: 'mov', kind: 'video' } : { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
  }
  return null;
}

let sharpModule;
let sharpError = null;
/** Load sharp on first use. If it is unavailable only the converter fails, not the whole site. */
function getSharp() {
  if (sharpModule) return sharpModule;
  try {
    sharpModule = require('sharp');
    return sharpModule;
  } catch (err) {
    sharpError = err;
    console.error('[sharp] failed to load:', err.message);
    throw new AppError(503, 'CONVERTER_UNAVAILABLE', 'The image converter is temporarily unavailable on this server.');
  }
}

/** Image conversion with sharp, entirely in memory (serverless hosts have no persistent disk). */
class MediaService {
  capabilities() {
    return { image: IMAGE_TARGETS };
  }

  /** For /api/health: can the converter library be loaded? */
  sharpStatus() {
    try {
      getSharp();
      return 'ok';
    } catch {
      return `unavailable: ${sharpError?.message || 'unknown error'}`.slice(0, 200);
    }
  }

  static outputInfo(format) {
    return OUTPUT[format] || null;
  }

  async convert(buffer, format) {
    const sharp = getSharp();
    try {
      let img = sharp(buffer, { limitInputPixels: 50_000_000 }).rotate();
      if (format === 'jpg') img = img.flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true });
      else if (format === 'png') img = img.png();
      else img = img.webp({ quality: 90 });
      return await img.toBuffer();
    } catch {
      throw new AppError(422, 'CONVERSION_FAILED', 'Could not convert this image. It may be corrupted or too large.');
    }
  }
}

module.exports = { MediaService, sniff };
