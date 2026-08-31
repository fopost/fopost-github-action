import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreRecorder, RecordedRequest } from './test-support.js';
import { jsonResponse } from './test-support.js';

const recorder = vi.hoisted((): CoreRecorder => ({
  inputs: {},
  outputs: {},
  secrets: [],
  info: [],
  debug: [],
  warnings: [],
  failed: [],
}));

vi.mock('@actions/core', () => {
  const summary = {
    addHeading: () => summary,
    addTable: () => summary,
    addQuote: () => summary,
    addRaw: () => summary,
    addSeparator: () => summary,
    write: async () => summary,
  };
  return {
    getInput: (name: string) => recorder.inputs[name] ?? '',
    setOutput: (name: string, value: string) => {
      recorder.outputs[name] = value;
    },
    setSecret: (value: string) => {
      recorder.secrets.push(value);
    },
    info: (message: string) => {
      recorder.info.push(message);
    },
    debug: (message: string) => {
      recorder.debug.push(message);
    },
    warning: (message: string) => {
      recorder.warnings.push(message);
    },
    setFailed: (message: string) => {
      recorder.failed.push(message);
    },
    summary,
  };
});

const { run } = await import('./main.js');
const { resetSecrets } = await import('./logging.js');

const API_KEY = 'fp_live_supersecret_do_not_log';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const POST_ID = '33333333-3333-4333-8333-333333333333';

const ACCOUNT = {
  id: ACCOUNT_ID,
  workspaceId: WORKSPACE_ID,
  platform: 'bluesky',
  username: 'yourbrand',
  name: 'Your Brand',
  active: true,
  isPrimary: true,
};

const POST = {
  id: POST_ID,
  workspaceId: WORKSPACE_ID,
  status: 'draft',
  contentType: 'post',
  scheduleAt: null,
  title: null,
  summary: null,
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
};

let requests: RecordedRequest[] = [];

/** Route the SDK's calls to canned responses, recording every request. */
function stubFetch(handler: (req: RecordedRequest) => Response) {
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    };
    requests.push(request);
    return handler(request);
  });
  globalThis.fetch = impl as unknown as typeof fetch;
  return impl;
}

/**
 * The path a request addressed, without the query string. Requests the SDK
 * makes are matched by the resource suffix below rather than the full path:
 * the SDK owns its base path, and a test that pins it is asserting someone
 * else's implementation detail. Only this action's own requests — the media
 * upload — get an exact-URL assertion.
 */
function pathOf(url: string): string {
  return new URL(url).pathname;
}

function isResource(req: RecordedRequest, suffix: string, method = 'GET'): boolean {
  return req.method === method && pathOf(req.url).endsWith(suffix);
}

function happyPath(req: RecordedRequest): Response {
  if (isResource(req, '/accounts')) return jsonResponse({ data: [ACCOUNT] });
  if (isResource(req, '/posts', 'POST')) {
    return jsonResponse({ data: POST }, 201);
  }
  if (isResource(req, `/posts/${POST_ID}/publish`, 'POST')) {
    return jsonResponse(
      {
        data: {
          post_status: 'publishing',
          deliveries: [{ id: 'd1', accountId: ACCOUNT_ID, status: 'queued' }],
        },
      },
      202,
    );
  }
  return jsonResponse({ error: 'not_found', message: `unstubbed ${req.method} ${req.url}` }, 404);
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  requests = [];
  resetSecrets();
  recorder.inputs = {
    'api-key': API_KEY,
    'workspace-id': WORKSPACE_ID,
    accounts: ACCOUNT_ID,
    text: 'Shipping v1.2.0 today.',
  };
  recorder.outputs = {};
  recorder.secrets = [];
  recorder.info = [];
  recorder.debug = [];
  recorder.warnings = [];
  recorder.failed = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('run', () => {
  it('masks the API key with the runner before doing anything else', async () => {
    stubFetch(happyPath);
    await run();

    expect(recorder.secrets).toContain(API_KEY);
  });

  it('sets every output on a successful create and publish', async () => {
    stubFetch(happyPath);
    recorder.inputs.publish = 'true';

    await run();

    expect(recorder.failed).toEqual([]);
    expect(recorder.outputs['post-id']).toBe(POST_ID);
    expect(recorder.outputs['post-url']).toBe(`https://fopost.com/dashboard/posts/${POST_ID}`);
    expect(recorder.outputs.status).toBe('publishing');
    expect(recorder.outputs['delivery-count']).toBe('1');

    const created = requests.find((r) => isResource(r, '/posts', 'POST'));
    expect(created?.body).toMatchObject({
      workspace_id: WORKSPACE_ID,
      status: 'draft',
      accounts: [ACCOUNT_ID],
    });
  });

  it('resolves a multi-line accounts list by username and platform:username', async () => {
    const second = { ...ACCOUNT, id: '44444444-4444-4444-8444-444444444444', username: 'second' };
    stubFetch((req) => {
      if (isResource(req, '/accounts')) return jsonResponse({ data: [ACCOUNT, second] });
      return happyPath(req);
    });
    recorder.inputs.accounts = '  yourbrand \n bluesky:second \n';

    await run();

    expect(recorder.failed).toEqual([]);
    const created = requests.find((r) => isResource(r, '/posts', 'POST'));
    expect((created?.body as { accounts: string[] }).accounts).toEqual([ACCOUNT_ID, second.id]);
  });

  it('schedules when schedule-at is set, without publishing', async () => {
    stubFetch(happyPath);
    recorder.inputs['schedule-at'] = '2026-09-01T10:00:00Z';

    await run();

    const created = requests.find((r) => isResource(r, '/posts', 'POST'));
    expect(created?.body).toMatchObject({
      status: 'scheduled',
      schedule_at: '2026-09-01T10:00:00.000Z',
    });
    expect(requests.some((r) => pathOf(r.url).endsWith('/publish'))).toBe(false);
  });

  it('makes no mutating call on a dry run', async () => {
    stubFetch(happyPath);
    recorder.inputs['dry-run'] = 'true';
    recorder.inputs.publish = 'true';
    recorder.inputs.media = 'assets/card.png';

    await run();

    expect(recorder.failed).toEqual([]);
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
    expect(requests.some((r) => pathOf(r.url).endsWith('/media/upload'))).toBe(false);
    expect(recorder.outputs.status).toBe('dry-run');
    expect(recorder.outputs['post-id']).toBe('');
    expect(recorder.outputs['delivery-count']).toBe('0');
  });

  it('fails with a clear message that never contains the API key', async () => {
    stubFetch((req) => {
      if (isResource(req, '/accounts')) return jsonResponse({ data: [ACCOUNT] });
      return jsonResponse({ error: 'unauthorized', message: `invalid key ${API_KEY}` }, 401, {
        'x-request-id': 'req_should_not_be_logged',
      });
    });

    await run();

    expect(recorder.failed).toHaveLength(1);
    const message = recorder.failed[0];
    expect(message).toContain('Authentication failed (401)');
    expect(message).toContain('`api-key`');
    expect(message).not.toContain(API_KEY);
    expect(message).toContain('***');
    expect(message).not.toContain('req_should_not_be_logged');
  });

  it('prints the upgrade URL on a 402', async () => {
    stubFetch((req) => {
      if (isResource(req, '/accounts')) return jsonResponse({ data: [ACCOUNT] });
      return jsonResponse(
        {
          error: 'subscription_required',
          message: 'Your plan does not include publishing.',
          upgrade_url: 'https://fopost.com/dashboard/settings/billing',
        },
        402,
      );
    });

    await run();

    expect(recorder.failed[0]).toContain('https://fopost.com/dashboard/settings/billing');
  });

  it('warns instead of failing when fail-on-error is false', async () => {
    stubFetch((req) => {
      if (isResource(req, '/accounts')) return jsonResponse({ data: [ACCOUNT] });
      return jsonResponse({ error: 'server_error', message: 'boom' }, 500);
    });
    recorder.inputs['fail-on-error'] = 'false';

    await run();

    expect(recorder.failed).toEqual([]);
    expect(recorder.warnings).toHaveLength(1);
    expect(recorder.warnings[0]).toContain('server error (500)');
    expect(recorder.outputs.status).toBe('error');
  });

  it('honours fail-on-error false even when the failure is a bad input', async () => {
    // `fail-on-error` used to be read off the parsed inputs, so a parse failure never got
    // as far as setting it and the step failed anyway. The self-test workflow caught this.
    const impl = stubFetch(happyPath);
    recorder.inputs.status = 'scheduled';
    recorder.inputs['schedule-at'] = '';
    recorder.inputs['fail-on-error'] = 'false';

    await run();

    expect(impl).not.toHaveBeenCalled();
    expect(recorder.failed).toEqual([]);
    expect(recorder.warnings[0]).toContain('needs a `schedule-at`');
    expect(recorder.outputs.status).toBe('error');
  });

  it('falls back to failing when fail-on-error is itself malformed', async () => {
    stubFetch(happyPath);
    recorder.inputs.text = '';
    recorder.inputs['fail-on-error'] = 'not-a-boolean';

    await run();

    expect(recorder.failed).toHaveLength(1);
  });

  it('fails on a bad input before any network call', async () => {
    const impl = stubFetch(happyPath);
    recorder.inputs.text = '';

    await run();

    expect(impl).not.toHaveBeenCalled();
    expect(recorder.failed[0]).toContain('Set `text` or `text-file`');
  });
});
