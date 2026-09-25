import { config } from '../../config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelWeight: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = config.LOG_LEVEL.toLowerCase();
const minimumWeight = configuredLevel === 'silent'
  ? Number.POSITIVE_INFINITY
  : configuredLevel === 'trace'
    ? levelWeight.debug
    : configuredLevel === 'fatal'
      ? levelWeight.error
      : levelWeight[configuredLevel as LogLevel] ?? levelWeight.info;
const repeatedFailures = new Map<string, { firstSeenAt: number; lastLoggedAt: number; suppressed: number }>();

function clean(value: string): string {
  return value
    .replace(/\b((?:amqps?|postgres(?:ql)?|rediss?|redis):\/\/)[^@\s/]+@/gi, '$1[credentials-redacted]@')
    .replace(/[\u0000-\u001f\u007f]/g, (character) => JSON.stringify(character).slice(1, -1));
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    const safe = clean(value);
    return /^[A-Za-z0-9._:/-]+$/.test(safe) ? safe : JSON.stringify(safe);
  }
  if (value instanceof Error) {
    const firstFrame = value.stack?.split('\n')[1]?.trim();
    return JSON.stringify(clean(`${value.name}: ${value.message}${firstFrame ? ` (${firstFrame})` : ''}`));
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return clean(JSON.stringify(value) ?? String(value));
  } catch {
    return JSON.stringify('[unserializable]');
  }
}

export function logEvent(
  level: LogLevel,
  service: string,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (levelWeight[level] < minimumWeight) return;

  const details = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ');
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${service}] ${event}${details ? ` ${details}` : ''}`;

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function logRepeatedFailure(
  service: string,
  event: string,
  key: string,
  error: unknown,
  fields: Record<string, unknown> = {},
  intervalMs = 60_000,
): void {
  const now = Date.now();
  const state = repeatedFailures.get(key);
  if (!state) {
    repeatedFailures.set(key, { firstSeenAt: now, lastLoggedAt: now, suppressed: 0 });
    logEvent('error', service, event, { ...fields, error });
    return;
  }

  state.suppressed += 1;
  if (now - state.lastLoggedAt < intervalMs) return;

  state.lastLoggedAt = now;
  const suppressed = state.suppressed;
  state.suppressed = 0;
  logEvent('error', service, event, {
    ...fields,
    error,
    repeatedForMs: now - state.firstSeenAt,
    suppressedOccurrences: suppressed,
  });
}

export function logRecovered(
  service: string,
  event: string,
  key: string,
  fields: Record<string, unknown> = {},
): void {
  const state = repeatedFailures.get(key);
  if (!state) return;

  repeatedFailures.delete(key);
  logEvent('info', service, event, {
    ...fields,
    recoveredAfterMs: Date.now() - state.firstSeenAt,
    suppressedOccurrences: state.suppressed,
  });
}

export function clearRepeatedFailure(key: string): void {
  repeatedFailures.delete(key);
}
