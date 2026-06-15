/**
 * RFC 7233 single-range parser for the file-stream endpoint (Story 8.1).
 *
 * Pure function — no I/O — so the Range matrix is unit-testable and deterministic.
 * Returns:
 *  - `{ start, end }` (inclusive byte offsets) for a single satisfiable range → 206
 *  - `'unsatisfiable'` when the range falls outside the file → 416
 *  - `null` to mean "serve the whole file" (200): no/blank header, a non-`bytes`
 *    unit, a syntactically bad header, OR a multi-range request (we do not support
 *    multipart/byteranges — fall back to a full 200 response, allowed by the RFC).
 *
 * `size` is the total file size in bytes; an empty file (size 0) is always served
 * whole (a Range against it is meaningless).
 */
export type ParsedRange = { start: number; end: number } | 'unsatisfiable' | null;

export function parseRange(header: string | undefined, size: number): ParsedRange {
  if (!header || size <= 0) return null;

  const trimmed = header.trim();
  const eq = trimmed.indexOf('=');
  if (eq < 0) return null;
  if (trimmed.slice(0, eq).trim().toLowerCase() !== 'bytes') return null;

  const spec = trimmed.slice(eq + 1).trim();
  // Multi-range (comma-separated) → not supported; fall back to full 200.
  if (spec.includes(',')) return null;

  const dash = spec.indexOf('-');
  if (dash < 0) return null;
  const rawStart = spec.slice(0, dash).trim();
  const rawEnd = spec.slice(dash + 1).trim();

  // Digits only (reject signs, whitespace-in-the-middle, hex, etc.).
  const isDigits = (s: string) => s.length > 0 && /^\d+$/.test(s);

  let start: number;
  let end: number;

  if (rawStart === '') {
    // Suffix range `bytes=-N`: the final N bytes.
    if (!isDigits(rawEnd)) return null;
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable'; // last 0 bytes is meaningless
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (rawEnd === '') {
    // Open-ended `bytes=N-`: from N to the end.
    if (!isDigits(rawStart)) return null;
    start = Number(rawStart);
    end = size - 1;
  } else {
    // Closed `bytes=A-B`.
    if (!isDigits(rawStart) || !isDigits(rawEnd)) return null;
    start = Number(rawStart);
    end = Number(rawEnd);
    if (start > end) return 'unsatisfiable';
    // Clamp the end to the last byte (RFC: an end past EOF is allowed).
    if (end > size - 1) end = size - 1;
  }

  if (start > size - 1) return 'unsatisfiable';
  return { start, end };
}
