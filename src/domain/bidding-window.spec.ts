import { describe, expect, it } from 'vitest';
import { assertBiddingWindow, auctionAcceptsBids, isLiveBiddingWindow, isPreBidWindow } from './bidding-window.js';

describe('auction bidding windows', () => {
  it('keeps timed auctions available for pre-bids while scheduled', () => {
    expect(isPreBidWindow('TIMED', 'SCHEDULED', true)).toBe(true);
    expect(auctionAcceptsBids('TIMED', 'SCHEDULED', true)).toBe(true);
  });

  it('does not accept pre-bids while the lot auction is paused or finished', () => {
    expect(isPreBidWindow('TIMED', 'PAUSED')).toBe(false);
    expect(auctionAcceptsBids('TIMED', 'FINISHED')).toBe(false);
  });

  it('only accepts live bids after a live auction starts', () => {
    expect(isLiveBiddingWindow('LIVE', 'SCHEDULED')).toBe(false);
    expect(isLiveBiddingWindow('LIVE', 'RUNNING')).toBe(true);
    expect(auctionAcceptsBids('LIVE', 'RUNNING')).toBe(true);
  });

  it('allows optional live pre-bids only when explicitly enabled', () => {
    expect(auctionAcceptsBids('LIVE', 'SCHEDULED', true)).toBe(true);
    expect(auctionAcceptsBids('LIVE', 'SCHEDULED', false)).toBe(false);
  });

  it('treats shopping as the pre-bid nomenclature', () => {
    expect(isPreBidWindow('SHOPPING', 'SCHEDULED')).toBe(true);
    expect(auctionAcceptsBids('SHOPPING', 'SCHEDULED')).toBe(true);
    expect(auctionAcceptsBids('SHOPPING', 'RUNNING')).toBe(true);
  });

  it('enforces the configured pre-bid dates', () => {
    expect(() => assertBiddingWindow({ mode: 'LIVE', status: 'SCHEDULED', preBidEnabled: true, preBidStartsAt: new Date('2026-08-05T12:00:00.000Z'), auctionStartsAt: new Date('2026-08-05T14:00:00.000Z'), now: new Date('2026-08-05T11:59:00.000Z') })).toThrowError('Pre-bidding has not started');
    expect(() => assertBiddingWindow({ mode: 'LIVE', status: 'SCHEDULED', preBidEnabled: true, auctionStartsAt: new Date('2026-08-05T14:00:00.000Z'), now: new Date('2026-08-05T14:00:00.000Z') })).toThrowError('Pre-bidding has ended');
  });
});
