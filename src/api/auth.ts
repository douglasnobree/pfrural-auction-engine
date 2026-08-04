import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { DomainError } from '../domain/errors.js';

export interface Actor {
  userId: string;
  roles: string[];
}

export function actorFromRequest(request: FastifyRequest): Actor {
  const userId = header(request, 'x-user-id');
  const roles = header(request, 'x-actor-role')?.split(',').map((role) => role.trim()).filter(Boolean) ?? ['participant'];
  if (config.AUTH_MODE === 'internal') {
    if (header(request, 'x-internal-token') !== config.INTERNAL_SERVICE_TOKEN) throw new DomainError('UNAUTHORIZED', 'Internal authentication failed', 401);
  }
  if (!userId) throw new DomainError('UNAUTHORIZED', 'Authenticated user is required', 401);
  return { userId, roles };
}

export function managerFromRequest(request: FastifyRequest): Actor {
  const actor = actorFromRequest(request);
  if (!actor.roles.some((role) => ['manager', 'auction_manager', 'admin'].includes(role))) throw new DomainError('FORBIDDEN', 'Manager permission is required', 403);
  return actor;
}

export function internalRequest(request: FastifyRequest): void {
  if (header(request, 'x-internal-token') !== config.INTERNAL_SERVICE_TOKEN) throw new DomainError('UNAUTHORIZED', 'Internal authentication failed', 401);
}

export function trustedDisplayName(request: FastifyRequest, displayName: string | undefined): string | undefined {
  if (!displayName || header(request, 'x-internal-token') !== config.INTERNAL_SERVICE_TOKEN) return undefined;
  return displayName;
}

export function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function idempotencyKey(request: FastifyRequest): string {
  const value = header(request, 'idempotency-key');
  if (!value || value.length < 8 || value.length > 128) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key must have between 8 and 128 characters', 400);
  return value;
}

export function correlationId(request: FastifyRequest): string {
  return header(request, 'x-correlation-id') ?? randomUUID();
}
