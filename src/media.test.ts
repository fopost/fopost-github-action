import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { jsonResponse } from './test-support.js';

vi.mock('@actions/core', () => ({
  getInput: () => '',
  setSecret: () => {},
  info: () => {},
  debug: () => {},
  warning: () => {},
  setFailed: () => {},
}));

const { classifyMedia, remoteMediaItem, resolveMedia } = await import('./media.js');
const { isFoPostError } = await import('./errors.js');

const CTX = {
  apiKey: 'fp_live_key',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  baseUrl: 'https://api.fopost.test',
};

function tempFile(name: string, contents = 'binary-ish'): string {
  const dir = mkdtempSync(join(tmpdir(), 'fopost-media-'));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe('classifyMedia', () => {
  it('separates gif, video, and image', () => {
    expect(classifyMedia('a.gif')).toBe('gif');
    expect(classifyMedia('a.mp4')).toBe('video');
    expect(classifyMedia('a.PNG')).toBe('image');
  });
});

describe('remoteMediaItem', () => {
  it('names the item from the URL path', () => {
    expect(remoteMediaItem('https://cdn.example.com/a/card.png?v=2')).toEqual({
      type: 'image',
      name: 'card.png',
      url: 'https://cdn.example.com/a/card.png?v=2',
    });
  });
});

describe('resolveMedia', () => {
  it('presigns, PUTs the bytes without the API key, then completes', async () => {
    const path = tempFile('card.png');
    const uploadUrl = 'https://bucket.example.test/staging/card.png?sig=abc';
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/media/presign')) {
        return jsonResponse(
          {
            data: {
              uploadId: 'up_1',
              uploadUrl,
              method: 'PUT',
              headers: { 'Content-Type': 'image/png' },
              expiresAt: '2026-09-19T00:15:00.000Z',
            },
          },
          201,
        );
      }
      if (url === uploadUrl && init.method === 'PUT') return new Response(null, { status: 200 });
      if (url.endsWith('/v1/media/presign/up_1/complete')) {
        return jsonResponse(
          { data: { id: 'media_1', type: 'image', name: 'card.png', url: 'r2://card.png' } },
          201,
        );
      }
      return jsonResponse({ error: 'not_found', message: `unstubbed ${url}` }, 404);
    });

    const items = await resolveMedia([path], { ...CTX, fetchImpl: fetchImpl as never });

    expect(items).toEqual([
      { id: 'media_1', type: 'image', name: 'card.png', url: 'r2://card.png' },
    ]);
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'POST https://api.fopost.test/v1/media/presign',
      `PUT ${uploadUrl}`,
      'POST https://api.fopost.test/v1/media/presign/up_1/complete',
    ]);
    // These requests are ours, not the SDK's, so the exact paths are pinned here.
    // The API serves /v1; /api/v1 is a 404 and was shipped once already.
    expect(calls.some(([url]) => url.includes('/api/v1'))).toBe(false);

    const [, presign] = calls[0];
    expect((presign.headers as Record<string, string>)['X-API-Key']).toBe(CTX.apiKey);
    expect(JSON.parse(presign.body as string)).toEqual({
      workspaceId: CTX.workspaceId,
      filename: 'card.png',
      mimeType: 'image/png',
      size: 'binary-ish'.length,
    });

    const [, put] = calls[1];
    expect(put.headers).toEqual({ 'Content-Type': 'image/png' });
    expect(put.headers).not.toHaveProperty('X-API-Key');
    expect(put.body).toBeInstanceOf(Uint8Array);

    const [, complete] = calls[2];
    expect((complete.headers as Record<string, string>)['X-API-Key']).toBe(CTX.apiKey);
  });

  it('passes a remote URL through without uploading', async () => {
    const fetchImpl = vi.fn();
    const items = await resolveMedia(['https://cdn.example.com/clip.mp4'], {
      ...CTX,
      fetchImpl: fetchImpl as never,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(items[0].type).toBe('video');
  });

  it('surfaces a rate limit on presign with the retry delay from the header', async () => {
    const path = tempFile('card.png');
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'rate_limited', message: 'Too many uploads' }, 429, {
        'retry-after': '120',
      }),
    );

    const error = await resolveMedia([path], { ...CTX, fetchImpl: fetchImpl as never }).catch(
      (e) => e,
    );

    expect(isFoPostError(error)).toBe(true);
    expect((error as { body: { retry_after: number } }).body.retry_after).toBe(120);
  });

  it('reports a missing file as an input problem', async () => {
    const error = await resolveMedia(['assets/nope.png'], CTX).catch((e) => e);
    expect(String(error)).toContain('could not be read');
  });
});
