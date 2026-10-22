/**
 * Checks that the bytes of an asset really are what its declared mime type says (arc42 §8.2: the
 * content is verified, not the extension). Returns a reason, or `null` when the bytes fit.
 * Magic numbers for binary formats; text formats must be valid UTF-8 (and parse, for JSON).
 */
export function contentProblem(bytes: Uint8Array, mime: string): string | null {
  const check = CHECKS[mime.toLowerCase()];
  if (!check || !Object.hasOwn(CHECKS, mime.toLowerCase())) return `mime type "${mime}" has no content check`;
  return check(bytes) ? null : `content is not ${mime}`;
}

const ascii = (bytes: Uint8Array, at: number, text: string): boolean =>
  bytes.length >= at + text.length && Array.from(text).every((c, i) => bytes[at + i] === c.charCodeAt(0));

const startsWith = (bytes: Uint8Array, ...values: number[]): boolean =>
  bytes.length >= values.length && values.every((v, i) => bytes[i] === v);

function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const isText = (bytes: Uint8Array): boolean => {
  const text = utf8(bytes);
  return text !== null && !text.includes('\u0000');
};

const SVG_PROLOGUE = /^(?:\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*$/i;
const MAX_SVG_PROLOGUE = 4096;

function isSvg(bytes: Uint8Array): boolean {
  const text = utf8(bytes)?.replace(/^﻿/, '');
  if (text === undefined || text === null) return false;
  const start = text.search(/<svg[\s>/]/i);
  if (start < 0 || start > MAX_SVG_PROLOGUE || !SVG_PROLOGUE.test(text.slice(0, start))) return false;
  // Scripts do not run in an image, but the file is also reachable as a plain asset; refuse the obvious.
  return !/<script[\s>/]|javascript:/i.test(text);
}

function isJson(bytes: Uint8Array): boolean {
  const text = utf8(bytes);
  if (text === null) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

const CHECKS: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  'image/png': (b) => startsWith(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  'image/jpeg': (b) => startsWith(b, 0xff, 0xd8, 0xff),
  'image/gif': (b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'),
  'image/webp': (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'),
  'image/avif': (b) => ascii(b, 4, 'ftyp') && (ascii(b, 8, 'avif') || ascii(b, 8, 'avis')),
  'image/svg+xml': isSvg,
  'video/mp4': (b) => ascii(b, 4, 'ftyp'),
  'video/webm': (b) => startsWith(b, 0x1a, 0x45, 0xdf, 0xa3),
  'audio/mpeg': (b) => ascii(b, 0, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  'audio/ogg': (b) => ascii(b, 0, 'OggS'),
  'audio/wav': (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE'),
  'font/woff': (b) => ascii(b, 0, 'wOFF'),
  'font/woff2': (b) => ascii(b, 0, 'wOF2'),
  'font/ttf': (b) => startsWith(b, 0x00, 0x01, 0x00, 0x00) || ascii(b, 0, 'true'),
  'font/otf': (b) => ascii(b, 0, 'OTTO'),
  'text/javascript': isText,
  'text/css': isText,
  'application/json': isJson,
};

export const isPng = (bytes: Uint8Array): boolean => CHECKS['image/png'](bytes);
