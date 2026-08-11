import { createHash } from 'node:crypto';

export function participantAlias(auctionId: string, userId: string, displayName?: string | null): string {
  const normalizedName = displayName?.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (normalizedName) return normalizedName;
  const suffix = createHash('sha256').update(`${auctionId}:${userId}`).digest('hex').slice(0, 6).toUpperCase();
  return `Participante ${suffix}`;
}
