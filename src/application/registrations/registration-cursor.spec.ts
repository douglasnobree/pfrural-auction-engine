import { describe, expect, it } from 'vitest';
import { DomainError } from '../../domain/errors.js';
import { decodeRegistrationCursor, encodeRegistrationCursor } from './registration-cursor.js';

describe('registration cursor', () => {
  it('round-trips the stable acceptedAt/id ordering key', () => {
    const acceptedAt = new Date('2026-08-11T15:00:00.123Z');
    const id = '11111111-1111-4111-8111-111111111111';

    expect(decodeRegistrationCursor(encodeRegistrationCursor(acceptedAt, id))).toEqual({
      acceptedAt: acceptedAt.toISOString(),
      id,
    });
  });

  it('rejects forged or malformed cursors', () => {
    expect(() => decodeRegistrationCursor('not-a-cursor')).toThrowError(DomainError);
  });
});
