import { hashPassword, verifyPassword, generateOtp, generateTempPassword, sha256 } from './password';

describe('password & token crypto', () => {
  it('hashes and verifies a password (argon2id)', async () => {
    const hash = await hashPassword('s3cret-password');
    expect(await verifyPassword(hash, 's3cret-password')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('generateOtp is 6 numeric digits', () => {
    expect(generateOtp()).toMatch(/^\d{6}$/);
  });

  it('temp password is reasonably long', () => {
    expect(generateTempPassword().length).toBeGreaterThanOrEqual(12);
  });

  it('sha256 is stable', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).not.toBe(sha256('abd'));
  });
});
