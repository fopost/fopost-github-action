import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import * as core from '@actions/core';
import { registerSecret } from './logging.js';

export type ActionInputs = {
  apiKey: string;
  workspaceId?: string;
  accounts: string[];
  text: string;
  media: string[];
  scheduleAt?: string;
  status: 'draft' | 'scheduled';
  publish: boolean;
  labels: string[];
  failOnError: boolean;
  dryRun: boolean;
};

/** Raised for anything the user can fix by editing the workflow. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/**
 * A list input accepts either style — one entry per line, which YAML block
 * scalars make natural, or comma separated on a single line.
 */
export function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\r\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  if (['true', 'yes', 'y', 'on', '1'].includes(value)) return true;
  if (['false', 'no', 'n', 'off', '0'].includes(value)) return false;
  throw new InputError(`Expected a boolean but got "${raw}". Use true or false.`);
}

/** Normalize a user-supplied timestamp to the ISO 8601 form the API expects. */
export function parseTimestamp(raw: string): string {
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new InputError(
      `\`schedule-at\` is not a valid timestamp: "${raw}". Use ISO 8601, e.g. 2026-09-01T10:00:00Z.`,
    );
  }
  return parsed.toISOString();
}

/** Resolve a workspace-relative path against GITHUB_WORKSPACE, else the cwd. */
export function resolveWorkspacePath(path: string): string {
  if (isAbsolute(path)) return path;
  return resolve(process.env.GITHUB_WORKSPACE || process.cwd(), path);
}

function readTextFile(path: string): string {
  const absolute = resolveWorkspacePath(path);
  try {
    return readFileSync(absolute, 'utf8');
  } catch {
    throw new InputError(`\`text-file\` could not be read: ${path}`);
  }
}

type RawReader = (name: string) => string;

const defaultReader: RawReader = (name) => core.getInput(name);

/**
 * Read, validate, and normalize every action input. The API key is handed to
 * the masker before anything else runs, so nothing downstream can leak it.
 */
export function parseInputs(read: RawReader = defaultReader): ActionInputs {
  const apiKey = read('api-key').trim();
  if (!apiKey) {
    throw new InputError('`api-key` is required. Pass it from `secrets.FOPOST_API_KEY`.');
  }
  registerSecret(apiKey);

  const text = read('text');
  const textFile = read('text-file').trim();
  if (text.trim() && textFile) {
    throw new InputError('Set either `text` or `text-file`, not both.');
  }
  const body = textFile ? readTextFile(textFile) : text;
  if (!body.trim()) {
    throw new InputError('A post needs content. Set `text` or `text-file`.');
  }

  const accounts = parseList(read('accounts'));
  if (accounts.length === 0) {
    throw new InputError(
      '`accounts` is required — list the account ids or usernames to post to, one per line.',
    );
  }

  const scheduleAtRaw = read('schedule-at').trim();
  const scheduleAt = scheduleAtRaw ? parseTimestamp(scheduleAtRaw) : undefined;

  const statusRaw = read('status').trim().toLowerCase();
  if (statusRaw && statusRaw !== 'draft' && statusRaw !== 'scheduled') {
    throw new InputError(`\`status\` must be draft or scheduled, got "${statusRaw}".`);
  }
  const status: 'draft' | 'scheduled' =
    (statusRaw as 'draft' | 'scheduled' | '') || (scheduleAt ? 'scheduled' : 'draft');

  if (status === 'scheduled' && !scheduleAt) {
    throw new InputError('`status: scheduled` needs a `schedule-at` timestamp.');
  }

  return {
    apiKey,
    workspaceId: read('workspace-id').trim() || undefined,
    accounts,
    text: body,
    media: parseList(read('media')),
    scheduleAt,
    status,
    publish: parseBoolean(read('publish'), false),
    labels: parseList(read('labels')),
    failOnError: parseBoolean(read('fail-on-error'), true),
    dryRun: parseBoolean(read('dry-run'), false),
  };
}
