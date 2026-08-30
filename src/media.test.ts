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
  it('uploads a local file with the API key header and attaches what came back', async () => {
    const path = tempFile('card.png');
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { data: [{ id: 'media_1', type: 'image', name: 'card.png', url: 'r2://card.png' }] },
        201,
      ),
    );

    const items = await resolveMedia([path], { ...CTX, fetchImpl: fetchImpl as never });

    expect(items).toEqual([
      { id: 'media_1', type: 'image', name: 'card.png', url: 'r2://card.png' },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // This request is ours, not the SDK's, so the exact path is pinned here.
    // The API serves /v1; /api/v1 is a 404 and was shipped once already.
    expect(url).toBe('https://api.fopost.test/v1/media/upload');
    expect(url).not.toContain('/api/v1');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe(CTX.apiKey);
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('workspaceId')).toBe(CTX.workspaceId);
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

  it('surfaces a rate limit with the retry delay from the header', async () => {
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
