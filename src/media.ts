import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { MediaItem } from '@fopost/sdk';
import { FoPostError } from '@fopost/sdk';
import { InputError, resolveWorkspacePath } from './inputs.js';
import { debug, info } from './logging.js';

export const DEFAULT_BASE_URL = 'https://api.fopost.com';

/** Base URL for direct calls. Mirrors what the SDK resolves for its own requests. */
export function resolveBaseUrl(): string {
  return (process.env.FOPOST_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.heic', '.bmp']);

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

export function classifyMedia(name: string): MediaItem['type'] {
  const ext = extname(name).toLowerCase();
  if (ext === '.gif') return 'gif';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'image';
}

export function isRemoteUrl(entry: string): boolean {
  return /^https?:\/\//i.test(entry);
}

/** A remote URL is attached as-is; the API fetches it at delivery time. */
export function remoteMediaItem(url: string): MediaItem {
  const name = basename(new URL(url).pathname) || 'media';
  return { type: classifyMedia(name), name, url };
}

export type UploadContext = {
  apiKey: string;
  workspaceId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

type UploadedMedia = MediaItem & { id?: string };

/**
 * Upload one local file to the media library. The SDK does not wrap the
 * multipart endpoint, so this posts directly with the same auth header.
 */
export async function uploadMediaFile(path: string, ctx: UploadContext): Promise<UploadedMedia> {
  const absolute = resolveWorkspacePath(path);
  let bytes: Buffer;
  try {
    await stat(absolute);
    bytes = await readFile(absolute);
  } catch {
    throw new InputError(`\`media\` entry could not be read: ${path}`);
  }

  const name = basename(absolute);
  const ext = extname(name).toLowerCase();
  const form = new FormData();
  form.append('workspaceId', ctx.workspaceId);
  form.append('files', new Blob([new Uint8Array(bytes)], { type: MIME_TYPES[ext] }), name);

  const doFetch = ctx.fetchImpl ?? globalThis.fetch;
  const url = `${ctx.baseUrl ?? resolveBaseUrl()}/api/v1/media/upload`;
  debug(`Uploading ${name} (${bytes.byteLength} bytes) to the media library`);

  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'X-API-Key': ctx.apiKey, Accept: 'application/json' },
    body: form,
  });

  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    // Only the retry delay is lifted off the response; no other header is read
    // or logged, so nothing incidental reaches the build log.
    const retryAfter = Number(res.headers.get('retry-after'));
    const body =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? { ...payload, retry_after: retryAfter }
        : payload;
    const message =
      (typeof payload.message === 'string' && payload.message) ||
      (typeof payload.error === 'string' && payload.error) ||
      `Uploading ${name} failed with HTTP ${res.status}`;
    throw new FoPostError(message, res.status, payload.error as string | undefined, body);
  }

  const items = Array.isArray(payload.data) ? (payload.data as Record<string, unknown>[]) : [];
  const uploaded = items[0];
  if (!uploaded || typeof uploaded.url !== 'string') {
    throw new FoPostError(
      `Uploading ${name} returned no media URL`,
      res.status,
      undefined,
      payload,
    );
  }

  info(`Uploaded ${name}`);
  return {
    id: typeof uploaded.id === 'string' ? uploaded.id : undefined,
    type: (uploaded.type as MediaItem['type']) ?? classifyMedia(name),
    name: typeof uploaded.name === 'string' ? uploaded.name : name,
    url: uploaded.url,
  };
}

/** Turn every `media` entry into an attachable item, uploading local files. */
export async function resolveMedia(entries: string[], ctx: UploadContext): Promise<MediaItem[]> {
  const items: MediaItem[] = [];
  for (const entry of entries) {
    items.push(isRemoteUrl(entry) ? remoteMediaItem(entry) : await uploadMediaFile(entry, ctx));
  }
  return items;
}
