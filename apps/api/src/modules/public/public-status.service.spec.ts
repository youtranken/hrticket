import { bucketOf } from './public-status.service';

/**
 * Story 12.8 — the public tracker maps the 6 internal ticket states down to 4
 * requester-facing buckets. `pending` gets its own "awaiting" bucket (previously
 * folded into in_progress) so the requester can tell a ticket is on hold.
 */
describe('bucketOf (public status 6 → 4 mapping)', () => {
  it('open and assigned → received', () => {
    expect(bucketOf('open')).toBe('received');
    expect(bucketOf('assigned')).toBe('received');
  });

  it('in_progress → processing', () => {
    expect(bucketOf('in_progress')).toBe('processing');
  });

  it('pending → awaiting (split out from processing)', () => {
    expect(bucketOf('pending')).toBe('awaiting');
  });

  it('resolved and closed → closed', () => {
    expect(bucketOf('resolved')).toBe('closed');
    expect(bucketOf('closed')).toBe('closed');
  });

  it('unknown/unexpected status falls back to received', () => {
    expect(bucketOf('something-else')).toBe('received');
  });
});
