import {
  signFileToken,
  verifyFileToken,
  signedFileUrl,
  FILE_TOKEN_TTL_MS,
} from './signed-url';

/** Part of IT-RENDER-002 — token correctness (HMAC + TTL + user binding). */
describe('signed-url file tokens', () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const uid = '99999999-8888-7777-6666-555555555555';

  it('verifies a fresh token for the same id + user', () => {
    expect(verifyFileToken(id, uid, signFileToken(id, uid))).toBe(true);
  });

  it('rejects a token minted for a different id', () => {
    const token = signFileToken('11111111-1111-1111-1111-111111111111', uid);
    expect(verifyFileToken(id, uid, token)).toBe(false);
  });

  it('rejects a token minted for a different user', () => {
    const token = signFileToken(id, '00000000-0000-0000-0000-000000000000');
    expect(verifyFileToken(id, uid, token)).toBe(false);
  });

  it('rejects a tampered token', () => {
    const token = signFileToken(id, uid);
    expect(verifyFileToken(id, uid, token + 'x')).toBe(false);
    expect(verifyFileToken(id, uid, token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')))).toBe(false);
  });

  it('rejects an expired token', () => {
    const past = Date.now() - FILE_TOKEN_TTL_MS - 1000;
    const token = signFileToken(id, uid, past);
    expect(verifyFileToken(id, uid, token)).toBe(false);
  });

  it('builds a relative file URL with an encoded token', () => {
    const url = signedFileUrl(id, uid);
    expect(url.startsWith(`/api/files/${id}?token=`)).toBe(true);
  });
});
