import { describe, expect, it } from 'vitest';
import { assertBiddingWindow, assertShoppingPurchaseWindow, auctionAcceptsBids, isLiveBiddingWindow, isPreBidExpired, isPreBidWindow, isShoppingPurchaseWindow, preBidCutoffAt } from './bidding-window.js';

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

  it('does not open a scheduled timed auction without a configured pre-bid window', () => {
    expect(auctionAcceptsBids('TIMED', 'SCHEDULED', false)).toBe(false);
    expect(auctionAcceptsBids('SHOPPING', 'SCHEDULED', false)).toBe(false);
    expect(() => assertBiddingWindow({ mode: 'TIMED', status: 'SCHEDULED', preBidEnabled: true })).toThrowError('Pre-bidding is not configured');
  });

  it('keeps shopping outside the bid window and uses its purchase interval', () => {
    expect(isPreBidWindow('SHOPPING', 'SCHEDULED')).toBe(false);
    expect(auctionAcceptsBids('SHOPPING', 'SCHEDULED')).toBe(false);
    const startsAt = new Date('2026-08-05T14:00:00.000Z');
    const endsAt = new Date('2026-08-05T16:00:00.000Z');
    expect(isShoppingPurchaseWindow({ mode: 'SHOPPING', status: 'SCHEDULED', startsAt, endsAt, now: startsAt })).toBe(true);
    expect(isShoppingPurchaseWindow({ mode: 'SHOPPING', status: 'SCHEDULED', startsAt, endsAt, now: endsAt })).toBe(false);
    expect(() => assertShoppingPurchaseWindow({ mode: 'SHOPPING', status: 'SCHEDULED', startsAt, endsAt, now: endsAt })).toThrowError('not available');
  });

  it('enforces the configured pre-bid dates', () => {
    expect(() => assertBiddingWindow({ mode: 'LIVE', status: 'SCHEDULED', preBidEnabled: true, preBidStartsAt: new Date('2026-08-05T12:00:00.000Z'), auctionStartsAt: new Date('2026-08-05T14:00:00.000Z'), now: new Date('2026-08-05T11:59:00.000Z') })).toThrowError('Pre-bidding has not started');
    expect(() => assertBiddingWindow({ mode: 'LIVE', status: 'SCHEDULED', preBidEnabled: true, auctionStartsAt: new Date('2026-08-05T14:00:00.000Z'), now: new Date('2026-08-05T14:00:00.000Z') })).toThrowError('Pre-bidding has ended');
  });

  it('uses the live start as the fallback cutoff when no live pre-bid end is configured', () => {
    const startsAt = new Date('2026-08-05T14:00:00.000Z');
    expect(preBidCutoffAt({ mode: 'LIVE', preBidEnabled: true, auctionStartsAt: startsAt })).toEqual(startsAt);
    expect(isPreBidExpired({ mode: 'LIVE', preBidEnabled: true, auctionStartsAt: startsAt }, startsAt)).toBe(true);
  });

  it('allows timed bidding after the pause and blocks only the scheduled pause boundary', () => {
    expect(() => assertBiddingWindow({
      mode: 'TIMED',
      status: 'SCHEDULED',
      preBidEndsAt: new Date('2026-08-05T14:00:00.000Z'),
      now: new Date('2026-08-05T14:00:00.000Z'),
    })).toThrowError('Pre-bidding has ended');
    expect(() => assertBiddingWindow({
      mode: 'TIMED',
      status: 'RUNNING',
      preBidEndsAt: new Date('2026-08-05T14:00:00.000Z'),
      now: new Date('2026-08-05T14:00:00.000Z'),
    })).not.toThrow();
  });
});
