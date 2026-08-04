import { DomainError } from './errors.js';

export function parseCents(value: unknown, field = 'amountCents'): bigint {
  if (typeof value === 'bigint') {
    if (value <= 0n) throw new DomainError('INVALID_AMOUNT', `${field} must be greater than zero`, 400);
    return value;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new DomainError('INVALID_AMOUNT', `${field} must be a positive decimal string of cents`, 400);
  }
  const cents = BigInt(value);
  if (cents <= 0n) throw new DomainError('INVALID_AMOUNT', `${field} must be greater than zero`, 400);
  return cents;
}

export function centsToJson(value: bigint | null): string | null {
  return value === null ? null : value.toString(10);
}
