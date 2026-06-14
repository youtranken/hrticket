import { sanitizeEmailHtml } from './sanitize';

/** IT-RENDER-001 (run as a fast unit test) — the sanitizer is the primary XSS gate. */
describe('sanitizeEmailHtml', () => {
  const vectors: Array<[string, string]> = [
    ['script tag', '<p>hi</p><script>alert(1)</script>'],
    ['img onerror', '<img src=x onerror="alert(1)">'],
    ['javascript: href', '<a href="javascript:alert(1)">click</a>'],
    ['svg onload', '<svg/onload=alert(1)>'],
    ['iframe', '<iframe src="javascript:alert(1)"></iframe>'],
    ['body onload', '<body onload="alert(1)">x</body>'],
    ['style expression', '<div style="background:url(javascript:alert(1))">x</div>'],
    ['onmouseover', '<a onmouseover="alert(1)" href="https://x.com">x</a>'],
    ['object', '<object data="javascript:alert(1)"></object>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
  ];

  it.each(vectors)('strips XSS vector: %s', (_name, dirty) => {
    const out = sanitizeEmailHtml(dirty).toLowerCase();
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('onload');
    expect(out).not.toContain('onmouseover');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('<iframe');
  });

  it('rewrites a known cid image to the file placeholder', () => {
    const out = sanitizeEmailHtml('<img src="cid:logo123">', { logo123: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    expect(out).toContain('/api/files/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(out).not.toContain('cid:');
  });

  it('drops an unknown cid image src', () => {
    const out = sanitizeEmailHtml('<img src="cid:missing">');
    expect(out).not.toContain('cid:');
    expect(out).not.toContain('src=');
  });

  it('defangs remote images into data-remote-src (no auto-load)', () => {
    const out = sanitizeEmailHtml('<img src="https://tracker.example/x.png">');
    expect(out).toContain('data-remote-src="https://tracker.example/x.png"');
    expect(out).not.toMatch(/\ssrc="https:/);
  });

  it('keeps benign formatting', () => {
    const out = sanitizeEmailHtml('<p><b>Hi</b> <a href="https://ok.com">link</a></p>');
    expect(out).toContain('<b>Hi</b>');
    expect(out).toContain('href="https://ok.com"');
  });
});
