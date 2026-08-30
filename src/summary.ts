import * as core from '@actions/core';
import type { MediaItem } from '@fopost/sdk';
import type { ResolvedAccount } from './accounts.js';
import { redact } from './logging.js';

export type SummaryInput = {
  dryRun: boolean;
  status: string;
  postId?: string;
  postUrl?: string;
  scheduleAt?: string;
  text: string;
  accounts: ResolvedAccount[];
  media: MediaItem[];
  labels: string[];
  deliveries: Array<{ account: string; status: string }>;
};

const PREVIEW_LENGTH = 280;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…` : flat;
}

/** Escape the handful of characters that would otherwise break a table cell. */
function cell(value: string): string {
  return redact(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Render the run into the step summary panel. Failing to write a summary must
 * never fail the step, so every error here is swallowed.
 */
export async function writeSummary(input: SummaryInput): Promise<void> {
  const heading = input.dryRun ? 'FoPost — dry run' : 'FoPost';

  const facts: string[][] = [['Status', input.status]];
  if (input.postId)
    facts.push(['Post', input.postUrl ? `[${input.postId}](${input.postUrl})` : input.postId]);
  if (input.scheduleAt) facts.push(['Scheduled for', input.scheduleAt]);
  if (input.labels.length > 0) facts.push(['Labels', input.labels.join(', ')]);
  if (input.media.length > 0) {
    facts.push(['Media', input.media.map((item) => `${item.name} (${item.type})`).join(', ')]);
  }

  const deliveryFor = new Map(input.deliveries.map((d) => [d.account, d.status]));
  const accountRows = input.accounts.map((account) => [
    cell(account.label),
    cell(account.platform ?? '—'),
    cell(deliveryFor.get(account.id) ?? (input.dryRun ? 'would post' : 'assigned')),
  ]);

  try {
    let summary = core.summary
      .addHeading(heading, 2)
      .addTable([
        [
          { data: 'Field', header: true },
          { data: 'Value', header: true },
        ],
        ...facts.map((row) => row.map(cell)),
      ])
      .addHeading('Accounts', 3)
      .addTable([
        [
          { data: 'Account', header: true },
          { data: 'Platform', header: true },
          { data: 'Delivery', header: true },
        ],
        ...accountRows,
      ])
      .addHeading('Content', 3)
      .addQuote(cell(preview(input.text)));

    if (input.dryRun) {
      summary = summary.addRaw('Nothing was created, uploaded, or published.', true);
    }

    await summary.write();
  } catch {
    // No summary file (running outside a runner, or a read-only path).
  }
}
