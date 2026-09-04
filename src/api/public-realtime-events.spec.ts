import { describe, expect, it } from 'vitest';
import { isPublicRealtimeEvent } from '../domain/public-events.js';

describe('public realtime event allowlist', () => {
  it('allows public auction state while rejecting participant notification payloads', () => {
    expect(isPublicRealtimeEvent('bid.accepted')).toBe(true);
    expect(isPublicRealtimeEvent('lot.sold')).toBe(true);
    expect(isPublicRealtimeEvent('participant.notification.requested')).toBe(false);
    expect(isPublicRealtimeEvent('registration.whatsapp_consent.changed')).toBe(false);
    expect(isPublicRealtimeEvent('bid.updated')).toBe(false);
  });
});
