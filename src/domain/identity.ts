export function participantAlias(auctionId: string, userId: string, displayName?: string | null): string {
  const normalizedName = displayName?.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (normalizedName) return normalizedName;
  return 'Participante';
}
