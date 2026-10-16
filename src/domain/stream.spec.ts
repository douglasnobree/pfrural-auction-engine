import { describe, expect, it } from 'vitest';
import { assertStreamPlayback } from './stream.js';

const playbackUrl = 'https://customer-test.cloudflarestream.com/public-input-id/webRTC/play';

describe('public stream credentials boundary', () => {
  it('accepts Cloudflare playback and retains existing providers', () => {
    expect(() => assertStreamPlayback({ provider: 'cloudflare-webrtc', playbackUrl })).not.toThrow();
    expect(() => assertStreamPlayback({ provider: 'youtube', playbackUrl: 'https://youtube.com/watch?v=example' })).not.toThrow();
    expect(() => assertStreamPlayback({ provider: 'hls', playbackUrl: 'https://example.test/video.m3u8' })).not.toThrow();
  });

  it('blocks a publishing credential even if the operator selects a generic provider', () => {
    for (const provider of ['cloudflare-webrtc', 'custom', 'direct']) {
      expect(() => assertStreamPlayback({ provider, playbackUrl: playbackUrl.replace('/play', '/publish') })).toThrowError(expect.objectContaining({ code: 'STREAM_PUBLISH_URL_PRIVATE' }));
    }
  });

  it('rejects non-Cloudflare, HTTP and credential-bearing endpoints', () => {
    for (const invalid of [undefined, 'https://example.test/webRTC/play', playbackUrl.replace('https:', 'http:'), playbackUrl.replace('https://', 'https://user:secret@'), `${playbackUrl}#secret`]) {
      expect(() => assertStreamPlayback({ provider: 'cloudflare-webrtc', playbackUrl: invalid })).toThrowError(expect.objectContaining({ code: 'INVALID_CLOUDFLARE_PLAYBACK_URL' }));
    }
  });
});
