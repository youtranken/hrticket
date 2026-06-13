import { sign, verifySigned } from './signing';

describe('HMAC signing (pre-auth tokens / signed URLs)', () => {
  it('round-trips a payload', () => {
    const token = sign('otp:user-123:1700000000');
    expect(verifySigned(token)).toBe('otp:user-123:1700000000');
  });

  it('rejects a tampered payload', () => {
    const token = sign('otp:user-123:1700000000');
    const tampered = token.replace('user-123', 'user-999');
    expect(verifySigned(tampered)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = sign('x') + 'zzz';
    expect(verifySigned(token)).toBeNull();
  });
});
