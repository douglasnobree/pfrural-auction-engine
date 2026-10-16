import { describe, expect, it, vi } from 'vitest';
import { ManagerService } from './manager.service.js';

function setup(version: bigint | null) {
  const stream = { id: 'stream-1', version: version ?? 1n, updatedAt: new Date('2026-10-16T12:00:00Z'), provider: 'cloudflare-webrtc', playbackUrl: 'https://customer-test.cloudflarestream.com/input-id/webRTC/play', providerStreamId: 'input-id', status: 'LIVE' };
  const client = {
    $queryRaw: vi.fn(),
    auctionExecution: { findUnique: vi.fn().mockResolvedValue({ id: 'auction-1' }) },
    streamSession: {
      findFirst: vi.fn().mockResolvedValue(version === null ? null : stream),
      create: vi.fn().mockResolvedValue(stream),
      update: vi.fn().mockResolvedValue({ ...stream, version: stream.version + 1n }),
    },
    managerAction: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const service = new ManagerService({ transaction: async (work: (transaction: typeof client) => Promise<unknown>) => work(client) } as never, {} as never);
  return { service, client, stream };
}

describe('stream updates', () => {
  it('rejects stale changes under the auction lock', async () => {
    const { service, client, stream } = setup(3n);
    await expect(service.updateStream('auction-1', 'operator', 'key', stream, 2n, 'correlation')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(client.streamSession.update).not.toHaveBeenCalled();
    expect(client.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('publishes version and input identity so viewers can follow source changes', async () => {
    const { service, client, stream } = setup(3n);
    await expect(service.updateStream('auction-1', 'operator', 'key', stream, 3n, 'correlation')).resolves.toMatchObject({ version: '4', providerStreamId: 'input-id', status: 'LIVE' });
    expect(client.outboxEvent.create).toHaveBeenCalled();
  });

  it('starts a new stream at version one so simultaneous creation cannot overwrite it', async () => {
    const { service, client, stream } = setup(null);
    await service.updateStream('auction-1', 'operator', 'key', stream, 0n, 'correlation');
    expect(client.streamSession.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ version: 1n }) }));
  });
});
