import {
  signFileToken,
  verifyFileToken,
  signedFileUrl,
  FILE_TOKEN_TTL_MS,
} from './signed-url';

/** Part of IT-RENDER-002 — token correctness (HMAC + TTL). */
describe('signed-url file tokens', () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('verifies a fresh token for the same id', () => {
    expect(verifyFileToken(id, signFileToken(id))).toBe(true);
  });

  it('rejects a token minted for a different id', () => {
    const token = signFileToken('11111111-1111-1111-1111-111111111111');
    expect(verifyFileToken(id, token)).toBe(false);
  });

  it('rejects a tampered token', () => {
    const token = signFileToken(id);
    expect(verifyFileToken(id, token + 'x')).toBe(false);
    expect(verifyFileToken(id, token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')))).toBe(false);
  });

  it('rejects an expired token', () => {
    const past = Date.now() - FILE_TOKEN_TTL_MS - 1000;
    const token = signFileToken(id, past);
    expect(verifyFileToken(id, token)).toBe(false);
  });

  it('builds a relative file URL with an encoded token', () => {
    const url = signedFileUrl(id);
    expect(url.startsWith(`/api/files/${id}?token=`)).toBe(true);
  });
});
