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

type PresignedUpload = {
  uploadId: string;
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
};

/** Reads the body as JSON; a non-JSON body counts as empty. */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function apiError(res: Response, payload: Record<string, unknown>, fallback: string): FoPostError {
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
    fallback;
  return new FoPostError(message, res.status, payload.error as string | undefined, body);
}

/**
 * Upload one local file to the media library through the direct-upload flow:
 * presign, PUT the bytes to the returned URL, then complete. The SDK does not
 * wrap these endpoints, so this calls them directly with the same auth header.
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
  const mimeType = MIME_TYPES[ext] ?? 'application/octet-stream';

  const doFetch = ctx.fetchImpl ?? globalThis.fetch;
  const base = `${ctx.baseUrl ?? resolveBaseUrl()}/v1/media/presign`;
  const authHeaders = {
    'X-API-Key': ctx.apiKey,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  debug(`Uploading ${name} (${bytes.byteLength} bytes) to the media library`);

  const presignRes = await doFetch(base, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      workspaceId: ctx.workspaceId,
      filename: name,
      mimeType,
      size: bytes.byteLength,
    }),
  });
  const presignPayload = await readJson(presignRes);
  if (!presignRes.ok) {
    throw apiError(
      presignRes,
      presignPayload,
      `Uploading ${name} failed with HTTP ${presignRes.status}`,
    );
  }
  const presigned = presignPayload.data as Partial<PresignedUpload> | undefined;
  if (
    !presigned ||
    typeof presigned.uploadId !== 'string' ||
    typeof presigned.uploadUrl !== 'string'
  ) {
    throw new FoPostError(
      `Uploading ${name} returned no upload URL`,
      presignRes.status,
      undefined,
      presignPayload,
    );
  }

  // The upload URL is pre-authorised: it carries exactly the presigned headers and no API key.
  const putRes = await doFetch(presigned.uploadUrl, {
    method: presigned.method ?? 'PUT',
    headers: presigned.headers ?? { 'Content-Type': mimeType },
    body: new Uint8Array(bytes),
  });
  if (!putRes.ok) {
    throw new FoPostError(
      `Uploading ${name} failed with HTTP ${putRes.status} from storage`,
      putRes.status,
    );
  }

  const completeRes = await doFetch(`${base}/${encodeURIComponent(presigned.uploadId)}/complete`, {
    method: 'POST',
    headers: authHeaders,
  });
  const payload = await readJson(completeRes);
  if (!completeRes.ok) {
    throw apiError(
      completeRes,
      payload,
      `Uploading ${name} failed with HTTP ${completeRes.status}`,
    );
  }

  const uploaded = payload.data as Record<string, unknown> | undefined;
  if (!uploaded || typeof uploaded.url !== 'string') {
    throw new FoPostError(
      `Uploading ${name} returned no media URL`,
      completeRes.status,
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
