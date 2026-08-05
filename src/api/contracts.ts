import { z } from 'zod';

export const idParam = z.object({ id: z.string().uuid() });
export const lotParam = z.object({ lotId: z.string().uuid() });
export const auctionParam = z.object({ auctionId: z.string().uuid() });
export const registrationBody = z.object({ termsVersion: z.string().trim().min(1).max(100) });
export const internalRegistrationBody = registrationBody.extend({ globallyEnabled: z.boolean().optional() });
export const registrationApprovalBody = z.object({ enabled: z.boolean() });
export const bidBody = z.object({ amountCents: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]), commandId: z.string().min(8).max(128).optional(), expectedVersion: z.string().regex(/^\d+$/).optional(), displayName: z.string().trim().min(1).max(120).optional() });
export const proxyBidBody = bidBody;
export const managerBody = z.object({ expectedVersion: z.string().regex(/^\d+$/).optional() });
export const floorBidBody = z.object({ participantId: z.string().min(1).max(200), amountCents: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]), origin: z.enum(['FLOOR', 'PHONE']), displayName: z.string().trim().min(1).max(120).optional() });
export const currentLotBody = z.object({ lotId: z.string().uuid(), expectedVersion: z.string().regex(/^\d+$/).optional() });
export const streamBody = z.object({ provider: z.string().trim().min(1).max(80), playbackUrl: z.string().url().optional(), providerStreamId: z.string().max(200).optional(), status: z.enum(['CREATED', 'STARTING', 'LIVE', 'ENDED', 'FAILED']).optional(), expectedVersion: z.string().regex(/^\d+$/).optional() });
export const rejectBody = z.object({ reason: z.string().trim().min(3).max(500) });
export const reservationBody = z.object({ quantity: z.number().int().positive().max(100) });
export const publishExecutionBody = z.object({ externalAuctionId: z.string().min(1).max(200), title: z.string().min(1).max(300), mode: z.enum(['SHOPPING', 'LIVE', 'TIMED']), currency: z.string().length(3).optional(), regulationVersion: z.string().min(1).max(100), approvalMode: z.enum(['AUTOMATIC', 'MANUAL_FIFO']).optional(), preBidEnabled: z.boolean().optional(), preBidStartsAt: z.string().datetime({ offset: true }).nullable().optional(), preBidEndsAt: z.string().datetime({ offset: true }).nullable().optional(), startsAt: z.string().datetime({ offset: true }).nullable().optional(), endsAt: z.string().datetime({ offset: true }).nullable().optional(), lots: z.array(z.object({ externalLotId: z.string().min(1).max(200), lotNumber: z.number().int().positive(), title: z.string().min(1).max(300), status: z.enum(['QUEUED', 'OPEN', 'PAUSED']).optional(), startingBidCents: z.string().regex(/^\d+$/).optional(), incrementCents: z.string().regex(/^\d+$/).optional(), reservePriceCents: z.string().regex(/^\d+$/).nullable().optional(), fixedPriceCents: z.string().regex(/^\d+$/).nullable().optional(), quantity: z.number().int().positive().optional(), startsAt: z.string().datetime({ offset: true }).nullable().optional(), endsAt: z.string().datetime({ offset: true }).nullable().optional() })).min(1) });
export const externalLotQuery = z.object({ externalAuctionId: z.string().min(1) });
export const sandboxBody = z.object({ label: z.string().trim().min(1).max(120).optional(), participantId: z.string().trim().min(1).max(120), lotCount: z.number().int().min(1).max(50).optional() });

export function parseBody<T>(schema: z.ZodSchema<T>, body: unknown): T {
  return schema.parse(body);
}
