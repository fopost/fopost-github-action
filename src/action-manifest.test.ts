import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `action.yml` is not a workflow file. GitHub evaluates `${{ }}` in it against a context
 * that has no `secrets`, so a single one anywhere — even inside a description — fails the
 * action at load time with "Unrecognized named-value: 'secrets'". YAML parses it happily,
 * so nothing but a check like this catches it before a consumer's run breaks.
 */
describe('action.yml', () => {
  const manifest = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');

  it('contains no ${{ }} expressions', () => {
    const found = manifest
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => line.includes('${{'));

    expect(found).toEqual([]);
  });

  it('declares the inputs and outputs the action reads', () => {
    for (const key of ['api-key', 'text', 'text-file', 'publish', 'dry-run', 'fail-on-error']) {
      expect(manifest).toContain(`  ${key}:`);
    }
    for (const key of ['post-id', 'post-url', 'status', 'delivery-count']) {
      expect(manifest).toContain(`  ${key}:`);
    }
  });

  it('runs on a supported node runtime', () => {
    expect(manifest).toMatch(/using:\s*['"]?node\d+/);
  });
});
