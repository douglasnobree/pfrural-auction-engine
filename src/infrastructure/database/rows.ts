export function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Expected bigint-compatible value, received ${typeof value}`);
  return BigInt(value);
}

export function asDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(String(value));
}

export function asJson<T>(value: unknown): T | null {
  return value === null || value === undefined ? null : value as T;
}
