import { parseRange } from './range';

/** Range matrix for the file-stream endpoint (Story 8.1, supports IT-STREAM-001).
 *  Pure parser → deterministic, CI-gated; no Docker. */
describe('parseRange (RFC 7233 single range)', () => {
  const SIZE = 100; // bytes 0..99

  it('no / blank / non-bytes header → null (serve whole file, 200)', () => {
    expect(parseRange(undefined, SIZE)).toBeNull();
    expect(parseRange('', SIZE)).toBeNull();
    expect(parseRange('   ', SIZE)).toBeNull();
    expect(parseRange('items=0-10', SIZE)).toBeNull();
  });

  it('closed range bytes=A-B → inclusive slice', () => {
    expect(parseRange('bytes=10-19', SIZE)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=0-0', SIZE)).toEqual({ start: 0, end: 0 });
  });

  it('open-ended bytes=N- → N..EOF', () => {
    expect(parseRange('bytes=10000-', 20_000_000)).toEqual({ start: 10_000, end: 19_999_999 });
    expect(parseRange('bytes=0-', SIZE)).toEqual({ start: 0, end: 99 });
  });

  it('suffix bytes=-N → final N bytes', () => {
    expect(parseRange('bytes=-5', SIZE)).toEqual({ start: 95, end: 99 });
    // Suffix larger than the file → whole file.
    expect(parseRange('bytes=-500', SIZE)).toEqual({ start: 0, end: 99 });
  });

  it('end past EOF is clamped to the last byte', () => {
    expect(parseRange('bytes=90-1000', SIZE)).toEqual({ start: 90, end: 99 });
  });

  it('tolerates surrounding whitespace and case', () => {
    expect(parseRange('  Bytes = 10-19 ', SIZE)).toEqual({ start: 10, end: 19 });
  });

  it('multi-range → null (fallback to full 200, multipart unsupported)', () => {
    expect(parseRange('bytes=0-9,20-29', SIZE)).toBeNull();
  });

  it('syntactically bad headers → null', () => {
    expect(parseRange('bytes=', SIZE)).toBeNull();
    expect(parseRange('bytes=abc', SIZE)).toBeNull();
    expect(parseRange('bytes=10', SIZE)).toBeNull(); // no dash
    expect(parseRange('bytes=1.5-3', SIZE)).toBeNull();
    expect(parseRange('bytes=-', SIZE)).toBeNull();
    expect(parseRange('bytes=-0x10', SIZE)).toBeNull();
  });

  it('out-of-bounds / inverted → unsatisfiable (416)', () => {
    expect(parseRange('bytes=100-200', SIZE)).toBe('unsatisfiable'); // start past EOF
    expect(parseRange('bytes=150-', SIZE)).toBe('unsatisfiable');
    expect(parseRange('bytes=50-10', SIZE)).toBe('unsatisfiable'); // start > end
    expect(parseRange('bytes=-0', SIZE)).toBe('unsatisfiable'); // last 0 bytes
  });

  it('empty file → always whole (null)', () => {
    expect(parseRange('bytes=0-10', 0)).toBeNull();
  });
});
