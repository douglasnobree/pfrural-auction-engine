import { describe, expect, it } from 'vitest';
import { participantAlias } from './identity.js';

describe('participant display identity', () => {
  it('uses the trusted display name when it is available', () => {
    expect(participantAlias('auction-1', 'user-1', '  Maria   da Silva  ')).toBe(
      'Maria da Silva',
    );
  });

  it('uses a readable generic label instead of exposing a hash', () => {
    expect(participantAlias('auction-1', 'user-1')).toBe('Participante');
  });
});
