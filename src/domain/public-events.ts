export const PUBLIC_REALTIME_EVENT_TYPES = new Set([
  'auction.published', 'auction.started', 'auction.paused', 'auction.resumed', 'auction.closed', 'auction.current_lot.changed',
  'lot.opened', 'lot.paused', 'lot.resumed', 'lot.withdrawn', 'lot.announced', 'lot.sold', 'lot.unsold',
  'bid.accepted', 'stream.changed',
]);

export function isPublicRealtimeEvent(eventType: string): boolean {
  return PUBLIC_REALTIME_EVENT_TYPES.has(eventType);
}
