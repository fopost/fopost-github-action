import type { Account, FoPost } from '@fopost/sdk';
import { InputError } from './inputs.js';
import { debug, warning } from './logging.js';
import { describeError } from './errors.js';

export type ResolvedAccount = {
  id: string;
  /** What to print in the log and the job summary. */
  label: string;
  platform?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeId(entry: string): boolean {
  return UUID.test(entry.trim());
}

function label(account: Account): string {
  const handle = account.username || account.name || account.id;
  return account.platform ? `${account.platform}:${handle}` : handle;
}

/** Every string an account can be named by in the `accounts` input. */
function keysFor(account: Account): string[] {
  const keys = [account.id];
  if (account.username) {
    keys.push(account.username, `${account.platform}:${account.username}`);
  }
  if (account.name) keys.push(account.name, `${account.platform}:${account.name}`);
  return keys.map((key) => key.toLowerCase());
}

/**
 * Resolve `accounts` entries to account ids. The listing is read-only and used
 * for display names too; when it is unavailable, entries that are already ids
 * pass through untouched rather than failing the run.
 */
export async function resolveAccounts(
  client: FoPost,
  workspaceId: string,
  entries: string[],
): Promise<ResolvedAccount[]> {
  let available: Account[] = [];
  try {
    available = await client.accounts.list({ workspaceId });
  } catch (error) {
    const unresolvable = entries.filter((entry) => !looksLikeId(entry));
    if (unresolvable.length > 0) throw error;
    debug(`Could not list accounts (${describeError(error)}); using the ids as given.`);
    return entries.map((id) => ({ id, label: id }));
  }

  const index = new Map<string, Account>();
  for (const account of available) {
    for (const key of keysFor(account)) {
      if (!index.has(key)) index.set(key, account);
    }
  }

  return entries.map((entry) => {
    const match = index.get(entry.trim().toLowerCase());
    if (match) return { id: match.id, label: label(match), platform: match.platform };
    if (looksLikeId(entry)) {
      warning(`Account ${entry} is not in this workspace's account list; sending it anyway.`);
      return { id: entry, label: entry };
    }
    const known = available.map(label).sort().join(', ') || 'none';
    throw new InputError(`No connected account matches "${entry}". Connected accounts: ${known}.`);
  });
}

/**
 * The workspace to post into: the one that was named, else the only one this
 * key can reach. Anything else is ambiguous and has to be spelled out.
 */
export async function resolveWorkspaceId(client: FoPost, given?: string): Promise<string> {
  if (given) return given;

  const workspaces = await client.workspaces.list();
  if (workspaces.length === 1) {
    debug(`Defaulting to the only reachable workspace: ${workspaces[0].name}`);
    return workspaces[0].id;
  }
  if (workspaces.length === 0) {
    throw new InputError('This API key can not reach any workspace. Set `workspace-id`.');
  }
  const names = workspaces.map((w) => `${w.name} (${w.id})`).join(', ');
  throw new InputError(`\`workspace-id\` is required — this key can reach: ${names}.`);
}
