/**
 * Tiny magic-byte sniffer for the fixed attachment whitelist. We can't trust the
 * declared Content-Type or extension (FR74), so the file's real signature decides.
 * Anything not recognised here is treated as unsafe and never stored.
 */
export type SafeType = 'pdf' | 'jpg' | 'png' | 'gif' | 'webp' | 'mp3' | 'mp4';

function ascii(buf: Buffer, start: number, text: string): boolean {
  return buf.toString('latin1', start, start + text.length) === text;
}

export function sniffType(buf: Buffer): SafeType | null {
  if (buf.length < 12) return null;

  if (ascii(buf, 0, '%PDF')) return 'pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (ascii(buf, 1, 'PNG') && buf[0] === 0x89) return 'png';
  if (ascii(buf, 0, 'GIF8')) return 'gif';
  if (ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WEBP')) return 'webp';
  if (ascii(buf, 0, 'ID3')) return 'mp3';
  if (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return 'mp3'; // MPEG audio frame sync
  if (ascii(buf, 4, 'ftyp')) return 'mp4';

  return null;
}

const MIME: Record<SafeType, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};

export function mimeFor(t: SafeType): string {
  return MIME[t];
}
