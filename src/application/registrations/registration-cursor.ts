import { DomainError } from '../../domain/errors.js';

type RegistrationCursorPayload = {
  acceptedAt: string;
  id: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeRegistrationCursor(acceptedAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ acceptedAt: acceptedAt.toISOString(), id }),
  ).toString('base64url');
}

export function decodeRegistrationCursor(value: string): RegistrationCursorPayload {
  try {
    const payload = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<RegistrationCursorPayload>;
    const acceptedAt = new Date(payload.acceptedAt ?? '');
    if (
      typeof payload.id !== 'string' ||
      !UUID_PATTERN.test(payload.id) ||
      Number.isNaN(acceptedAt.getTime())
    ) {
      throw new Error('invalid cursor payload');
    }
    return { acceptedAt: acceptedAt.toISOString(), id: payload.id };
  } catch {
    throw new DomainError('INVALID_CURSOR', 'Registration cursor is invalid', 400);
  }
}
