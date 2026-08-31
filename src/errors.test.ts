import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FoPostError } from '@fopost/sdk';

vi.mock('@actions/core', () => ({
  getInput: () => '',
  setSecret: () => {},
  info: () => {},
  debug: () => {},
  warning: () => {},
  setFailed: () => {},
}));

const { describeError, isFoPostError } = await import('./errors.js');
const { InputError } = await import('./inputs.js');
const { redact, registerSecret, resetSecrets } = await import('./logging.js');

const KEY = 'fp_live_topsecret';

beforeEach(() => {
  resetSecrets();
});

describe('redact', () => {
  it('replaces every occurrence of a registered secret', () => {
    registerSecret(KEY);
    expect(redact(`sent ${KEY} twice: ${KEY}`)).toBe('sent *** twice: ***');
  });

  it('is a no-op with nothing registered', () => {
    expect(redact('nothing to hide')).toBe('nothing to hide');
  });
});

describe('isFoPostError', () => {
  it('recognizes the SDK error and a structurally identical copy', () => {
    expect(isFoPostError(new FoPostError('nope', 401))).toBe(true);
    expect(isFoPostError({ name: 'FoPostError', status: 404 })).toBe(true);
    expect(isFoPostError(new Error('plain'))).toBe(false);
  });
});

describe('describeError', () => {
  it('passes an input problem through verbatim', () => {
    expect(describeError(new InputError('`accounts` is required.'))).toBe(
      '`accounts` is required.',
    );
  });

  it('names the input to fix on a 401', () => {
    const message = describeError(new FoPostError('invalid key', 401));
    expect(message).toContain('Authentication failed (401)');
    expect(message).toContain('`api-key`');
  });

  it('prints the upgrade URL on a 402', () => {
    const error = new FoPostError('Plan does not cover this', 402, 'subscription_required', {
      upgrade_url: 'https://fopost.com/dashboard/settings/billing',
    });
    expect(describeError(error)).toContain('Upgrade: https://fopost.com/dashboard/settings/billing');
  });

  it('says when to retry on a 429', () => {
    const soon = new FoPostError('Too many requests', 429, 'rate_limited', { retry_after: 45 });
    expect(describeError(soon)).toContain('Retry in about 45s');

    const later = new FoPostError('Too many requests', 429, 'rate_limited', { retry_after: 600 });
    expect(describeError(later)).toContain('Retry in about 10m');

    const unknown = new FoPostError('Too many requests', 429);
    expect(describeError(unknown)).toContain('Retry in a few minutes');
  });

  it('calls a 5xx transient', () => {
    expect(describeError(new FoPostError('boom', 503))).toContain('server error (503)');
  });

  it('covers the remaining mapped statuses', () => {
    expect(describeError(new FoPostError('nope', 403))).toContain('Permission denied (403)');
    expect(describeError(new FoPostError('nope', 404))).toContain('Not found (404)');
    expect(describeError(new FoPostError('bad field', 422))).toContain('rejected (422)');
    expect(describeError(new FoPostError('odd', 418))).toContain('FoPost API error (418)');
  });

  it('redacts a secret the API echoed back into an error message', () => {
    registerSecret(KEY);
    const message = describeError(new FoPostError(`key ${KEY} is revoked`, 401));
    expect(message).not.toContain(KEY);
    expect(message).toContain('***');
  });

  it('handles a thrown non-Error', () => {
    expect(describeError('socket hang up')).toBe('socket hang up');
  });
});
