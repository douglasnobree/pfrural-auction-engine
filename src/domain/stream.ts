import { DomainError } from './errors.js';

export function assertStreamPlayback(input: { provider: string; playbackUrl?: string }) {
  let url: URL | undefined;
  try { if (input.playbackUrl) url = new URL(input.playbackUrl); } catch { /* validated below */ }
  const cloudflareHost = url && /^customer-[a-z\d-]+\.cloudflarestream\.com$/i.test(url.hostname);
  if (cloudflareHost && /\/webRTC\/publish\/?$/i.test(url!.pathname)) {
    throw new DomainError('STREAM_PUBLISH_URL_PRIVATE', 'Use the public playback URL, never the private publishing URL', 400);
  }
  if (input.provider === 'cloudflare-webrtc' && (!url || !cloudflareHost || url.protocol !== 'https:' ||
      url.username || url.password || url.port || url.hash || !/^\/[a-z\d_-]+\/webRTC\/play\/?$/i.test(url.pathname))) {
    throw new DomainError('INVALID_CLOUDFLARE_PLAYBACK_URL', 'Use the Cloudflare HTTPS WebRTC playback URL ending in /webRTC/play', 400);
  }
}
