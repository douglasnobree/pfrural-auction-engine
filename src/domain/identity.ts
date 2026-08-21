import { createHash } from 'node:crypto';

export function normalizeParticipantName(displayName?: string | null): string | null {
  const normalizedName = displayName?.trim().replace(/\s+/g, ' ').slice(0, 120);
  return normalizedName || null;
}

export function readableParticipantName(displayName?: string | null): string | null {
  const normalizedName = normalizeParticipantName(displayName);
  return normalizedName && !/^Participante(?: [A-F0-9]{6})?$/.test(normalizedName)
    ? normalizedName
    : null;
}

export function participantAlias(auctionId: string, userId: string, displayName?: string | null): string {
  const normalizedName = normalizeParticipantName(displayName);
  if (normalizedName) return normalizedName;
  const suffix = createHash('sha256').update(`${auctionId}:${userId}`).digest('hex').slice(0, 6).toUpperCase();
  return `Participante ${suffix}`;
}
