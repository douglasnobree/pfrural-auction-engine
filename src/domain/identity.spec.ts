import { describe, expect, it } from 'vitest';
import { participantAlias } from './identity.js';

describe('participant display identity', () => {
  it('uses the trusted display name when it is available', () => {
    expect(participantAlias('auction-1', 'user-1', '  Maria   da Silva  ')).toBe(
      'Maria da Silva',
    );
  });

  it('uses a stable per-auction anonymous label instead of exposing the user id', () => {
    expect(participantAlias('auction-1', 'user-1')).toMatch(/^Participante [A-F0-9]{6}$/);
    expect(participantAlias('auction-1', 'user-1')).toBe(participantAlias('auction-1', 'user-1'));
    expect(participantAlias('auction-2', 'user-1')).not.toBe(participantAlias('auction-1', 'user-1'));
  });
});
