import { FoPostError } from '@fopost/sdk';
import { InputError } from './inputs.js';
import { redact } from './logging.js';

type ErrorBody = Record<string, unknown>;

function bodyOf(error: FoPostError): ErrorBody {
  return error.body && typeof error.body === 'object' ? (error.body as ErrorBody) : {};
}

function stringField(body: ErrorBody, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function numberField(body: ErrorBody, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

/** Restate `seconds` as something a person reading a workflow log can act on. */
function describeRetryDelay(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.ceil(minutes / 60)}h`;
}

/** True for anything the SDK threw, including a copy bundled separately. */
export function isFoPostError(error: unknown): error is FoPostError {
  if (error instanceof FoPostError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'FoPostError' &&
    typeof (error as { status?: unknown }).status === 'number'
  );
}

/**
 * Turn any failure into one line a workflow author can act on. Response headers
 * are never echoed and the API key is redacted, so nothing here can leak a
 * credential into a public build log.
 */
export function describeError(error: unknown): string {
  if (error instanceof InputError) return redact(error.message);

  if (isFoPostError(error)) {
    const body = bodyOf(error);
    const detail = error.message || 'The FoPost API rejected the request.';

    switch (true) {
      case error.status === 401:
        return redact(
          `Authentication failed (401). Check that \`api-key\` holds a current FoPost API key: ${detail}`,
        );

      case error.status === 402: {
        const upgradeUrl = stringField(body, 'upgrade_url', 'upgradeUrl');
        const suffix = upgradeUrl ? ` Upgrade: ${upgradeUrl}` : '';
        return redact(`Payment required (402). ${detail}${suffix}`);
      }

      case error.status === 403:
        return redact(
          `Permission denied (403). The API key's scopes or workspace access do not cover this request: ${detail}`,
        );

      case error.status === 404:
        return redact(
          `Not found (404). Check \`workspace-id\` and \`accounts\` point at things this key can see: ${detail}`,
        );

      case error.status === 429: {
        const retryAfter = numberField(body, 'retry_after', 'retryAfter');
        const suffix = retryAfter
          ? ` Retry in about ${describeRetryDelay(retryAfter)}.`
          : ' Retry in a few minutes.';
        return redact(`Rate limited (429). ${detail}${suffix}`);
      }

      case error.status === 400 || error.status === 422:
        return redact(`The request was rejected (${error.status}). ${detail}`);

      case error.status >= 500:
        return redact(
          `FoPost returned a server error (${error.status}). This is usually transient — re-run the job: ${detail}`,
        );

      default:
        return redact(`FoPost API error (${error.status}). ${detail}`);
    }
  }

  if (error instanceof Error) return redact(error.message);
  return redact(String(error));
}
