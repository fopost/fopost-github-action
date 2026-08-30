import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreRecorder } from './test-support.js';

const recorder = vi.hoisted((): Pick<CoreRecorder, 'secrets'> => ({
  secrets: [],
}));

vi.mock('@actions/core', () => ({
  getInput: () => '',
  setSecret: (value: string) => {
    recorder.secrets.push(value);
  },
  info: () => {},
  debug: () => {},
  warning: () => {},
  setFailed: () => {},
}));

const { InputError, parseBoolean, parseInputs, parseList, parseTimestamp, resolveWorkspacePath } =
  await import('./inputs.js');
const { resetSecrets } = await import('./logging.js');

/** Build the reader `parseInputs` expects out of a plain input map. */
function reader(inputs: Record<string, string>) {
  return (name: string) => inputs[name] ?? '';
}

const BASE = {
  'api-key': 'fp_live_key',
  'workspace-id': '11111111-1111-4111-8111-111111111111',
  accounts: '22222222-2222-4222-8222-222222222222',
  text: 'hello',
};

beforeEach(() => {
  resetSecrets();
  recorder.secrets = [];
});

describe('parseList', () => {
  it('accepts one entry per line', () => {
    expect(parseList('alpha\nbeta\n\n  gamma  \n')).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('accepts a comma separated line', () => {
    expect(parseList('alpha, beta ,gamma')).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('accepts the two styles mixed', () => {
    expect(parseList('alpha, beta\r\ngamma,\n')).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('is empty for empty input', () => {
    expect(parseList(undefined)).toEqual([]);
    expect(parseList('   ')).toEqual([]);
  });
});

describe('parseBoolean', () => {
  it('reads the usual truthy and falsy spellings', () => {
    expect(parseBoolean('true', false)).toBe(true);
    expect(parseBoolean('YES', false)).toBe(true);
    expect(parseBoolean('0', true)).toBe(false);
    expect(parseBoolean('off', true)).toBe(false);
  });

  it('falls back when unset and rejects nonsense', () => {
    expect(parseBoolean('', true)).toBe(true);
    expect(parseBoolean(undefined, false)).toBe(false);
    expect(() => parseBoolean('maybe', false)).toThrow(InputError);
  });
});

describe('parseTimestamp', () => {
  it('normalizes to ISO 8601', () => {
    expect(parseTimestamp('2026-09-01T10:00:00Z')).toBe('2026-09-01T10:00:00.000Z');
  });

  it('rejects an unparseable value', () => {
    expect(() => parseTimestamp('next tuesday')).toThrow(InputError);
  });
});

describe('resolveWorkspacePath', () => {
  it('resolves a relative path against GITHUB_WORKSPACE', () => {
    vi.stubEnv('GITHUB_WORKSPACE', '/runner/work/repo');
    expect(resolveWorkspacePath('notes/CHANGELOG.md')).toBe('/runner/work/repo/notes/CHANGELOG.md');
    vi.unstubAllEnvs();
  });

  it('leaves an absolute path alone', () => {
    expect(resolveWorkspacePath('/tmp/a.md')).toBe('/tmp/a.md');
  });
});

describe('parseInputs', () => {
  it('masks the API key as soon as it is read', () => {
    parseInputs(reader(BASE));
    expect(recorder.secrets).toEqual(['fp_live_key']);
  });

  it('parses a multi-line accounts list and labels', () => {
    const inputs = parseInputs(
      reader({ ...BASE, accounts: 'a\nb\nc', labels: 'release, changelog' }),
    );
    expect(inputs.accounts).toEqual(['a', 'b', 'c']);
    expect(inputs.labels).toEqual(['release', 'changelog']);
  });

  it('reads the body from text-file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fopost-action-'));
    const file = join(dir, 'CHANGELOG.md');
    writeFileSync(file, '## v1.2.0\n\nFaster scheduling.\n');

    const inputs = parseInputs(reader({ ...BASE, text: '', 'text-file': file }));
    expect(inputs.text).toContain('Faster scheduling.');
  });

  it('rejects text and text-file together', () => {
    expect(() => parseInputs(reader({ ...BASE, 'text-file': '/tmp/x.md' }))).toThrow(
      /either `text` or `text-file`/,
    );
  });

  it('rejects an unreadable text-file', () => {
    expect(() =>
      parseInputs(reader({ ...BASE, text: '', 'text-file': '/nope/missing.md' })),
    ).toThrow(/could not be read/);
  });

  it('requires an api-key, content, and accounts', () => {
    expect(() => parseInputs(reader({ ...BASE, 'api-key': '' }))).toThrow(/`api-key` is required/);
    expect(() => parseInputs(reader({ ...BASE, text: '' }))).toThrow(/A post needs content/);
    expect(() => parseInputs(reader({ ...BASE, accounts: '' }))).toThrow(/`accounts` is required/);
  });

  it('infers scheduled from schedule-at and rejects the reverse gap', () => {
    const scheduled = parseInputs(reader({ ...BASE, 'schedule-at': '2026-09-01T10:00:00Z' }));
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.scheduleAt).toBe('2026-09-01T10:00:00.000Z');

    expect(() => parseInputs(reader({ ...BASE, status: 'scheduled' }))).toThrow(
      /needs a `schedule-at`/,
    );
  });

  it('rejects an unknown status', () => {
    expect(() => parseInputs(reader({ ...BASE, status: 'published' }))).toThrow(
      /must be draft or scheduled/,
    );
  });

  it('defaults publish and dry-run off and fail-on-error on', () => {
    const inputs = parseInputs(reader(BASE));
    expect(inputs.publish).toBe(false);
    expect(inputs.dryRun).toBe(false);
    expect(inputs.failOnError).toBe(true);
    expect(inputs.status).toBe('draft');
  });
});
