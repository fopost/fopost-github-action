import * as core from '@actions/core';
import { FoPost, type MediaItem } from '@fopost/sdk';
import { resolveAccounts, resolveWorkspaceId, type ResolvedAccount } from './accounts.js';
import { describeError } from './errors.js';
import { parseInputs, readFailOnError, type ActionInputs } from './inputs.js';
import { debug, info, setFailed, warning } from './logging.js';
import { resolveBaseUrl, resolveMedia } from './media.js';
import { writeSummary } from './summary.js';

const DEFAULT_DASHBOARD_URL = 'https://fopost.com/dashboard';

function postUrl(postId: string): string {
  const base = (process.env.FOPOST_APP_URL || DEFAULT_DASHBOARD_URL).replace(/\/$/, '');
  return `${base}/posts/${postId}`;
}

type Delivery = { account: string; status: string };

/** The publish endpoint answers with per-account delivery rows; read them loosely. */
function readDeliveries(payload: unknown): { status?: string; deliveries: Delivery[] } {
  if (!payload || typeof payload !== 'object') return { deliveries: [] };
  const data = payload as Record<string, unknown>;
  const rows = Array.isArray(data.deliveries) ? (data.deliveries as Record<string, unknown>[]) : [];
  return {
    status: typeof data.post_status === 'string' ? data.post_status : undefined,
    deliveries: rows.map((row) => ({
      account: typeof row.accountId === 'string' ? row.accountId : '',
      status: typeof row.status === 'string' ? row.status : 'queued',
    })),
  };
}

function setOutputs(values: {
  postId: string;
  postUrl: string;
  status: string;
  deliveryCount: number;
}): void {
  core.setOutput('post-id', values.postId);
  core.setOutput('post-url', values.postUrl);
  core.setOutput('status', values.status);
  core.setOutput('delivery-count', String(values.deliveryCount));
}

async function dryRun(
  inputs: ActionInputs,
  accounts: ResolvedAccount[],
  workspaceId: string,
): Promise<void> {
  const media: MediaItem[] = inputs.media.map((entry) => ({
    type: 'image',
    name: entry,
    url: entry,
  }));

  info('Dry run — nothing was created, uploaded, or published.');
  info(`Workspace: ${workspaceId}`);
  info(`Status: ${inputs.status}${inputs.scheduleAt ? ` at ${inputs.scheduleAt}` : ''}`);
  info(`Accounts: ${accounts.map((a) => a.label).join(', ')}`);
  if (inputs.media.length > 0) info(`Media that would be uploaded: ${inputs.media.join(', ')}`);
  if (inputs.publish) info('Would publish immediately after creating the post.');
  debug(`Body:\n${inputs.text}`);

  setOutputs({ postId: '', postUrl: '', status: 'dry-run', deliveryCount: 0 });
  await writeSummary({
    dryRun: true,
    status: `${inputs.status} (dry run)`,
    scheduleAt: inputs.scheduleAt,
    text: inputs.text,
    accounts,
    media,
    labels: inputs.labels,
    deliveries: [],
  });
}

export async function run(): Promise<void> {
  // Read this before anything that can throw: a malformed input must still honour it.
  const failOnError = readFailOnError();

  try {
    const inputs = parseInputs();

    const client = new FoPost({ apiKey: inputs.apiKey, baseUrl: resolveBaseUrl() });
    const workspaceId = await resolveWorkspaceId(client, inputs.workspaceId);
    const accounts = await resolveAccounts(client, workspaceId, inputs.accounts);

    if (inputs.dryRun) {
      await dryRun(inputs, accounts, workspaceId);
      return;
    }

    const media = await resolveMedia(inputs.media, {
      apiKey: inputs.apiKey,
      workspaceId,
      baseUrl: resolveBaseUrl(),
    });

    const post = await client.posts.create({
      workspaceId,
      status: inputs.status,
      scheduleAt: inputs.scheduleAt,
      content: [{ text: inputs.text, media: media.length > 0 ? media : undefined }],
      accounts: accounts.map((account) => account.id),
      labels: inputs.labels.length > 0 ? inputs.labels : undefined,
    });

    info(`Created post ${post.id} (${post.status})`);

    let status = post.status as string;
    let deliveries: Delivery[] = [];

    if (inputs.publish) {
      const result = readDeliveries(await client.posts.publish(post.id));
      status = result.status ?? 'publishing';
      deliveries = result.deliveries;
      if (status === 'pending_approval') {
        info('This workspace requires approval — the post is waiting for a reviewer.');
      } else {
        info(`Queued ${deliveries.length} ${deliveries.length === 1 ? 'delivery' : 'deliveries'}.`);
      }
    }

    setOutputs({
      postId: post.id,
      postUrl: postUrl(post.id),
      status,
      deliveryCount: deliveries.length,
    });

    await writeSummary({
      dryRun: false,
      status,
      postId: post.id,
      postUrl: postUrl(post.id),
      scheduleAt: inputs.scheduleAt,
      text: inputs.text,
      accounts,
      media,
      labels: inputs.labels,
      deliveries,
    });
  } catch (error) {
    const message = describeError(error);
    if (failOnError) {
      setFailed(message);
    } else {
      warning(`${message} (\`fail-on-error\` is false, so the step is passing anyway.)`);
      setOutputs({ postId: '', postUrl: '', status: 'error', deliveryCount: 0 });
    }
  }
}
