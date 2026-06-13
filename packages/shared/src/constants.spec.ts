import { describe, it, expect } from 'vitest';
import { REOPEN_WARN_THRESHOLD, PROJECTS } from './constants';
import { ErrorCode } from './errors';

describe('shared constants & errors', () => {
  it('reopen warn threshold is 5 (FR41)', () => {
    expect(REOPEN_WARN_THRESHOLD).toBe(5);
  });
  it('has exactly two fixed projects', () => {
    expect(PROJECTS).toEqual(['hris', 'cnb']);
  });
  it('error catalog exposes the data-gateway code', () => {
    expect(ErrorCode.MISSING_ACTOR).toBe('MISSING_ACTOR');
  });
});
