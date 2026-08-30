import * as core from '@actions/core';

/**
 * Values registered with the runner's masker. Kept here as well so this action
 * can redact them itself: `core.setSecret` only covers what the runner writes,
 * and a secret can reach us through an error message the runner never sees.
 */
const secrets = new Set<string>();

/** Register a secret with the runner AND with our own redactor. */
export function registerSecret(value: string): void {
  if (!value) return;
  core.setSecret(value);
  secrets.add(value);
}

/** Replace every registered secret in `text` with `***`. */
export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('***');
  }
  return out;
}

/** Reset the local redactor. Test-only; the runner's own masking is not undone. */
export function resetSecrets(): void {
  secrets.clear();
}

export function info(message: string): void {
  core.info(redact(message));
}

/** Only reaches the log when the ACTIONS_STEP_DEBUG secret is set to true. */
export function debug(message: string): void {
  core.debug(redact(message));
}

export function warning(message: string): void {
  core.warning(redact(message));
}

export function setFailed(message: string): void {
  core.setFailed(redact(message));
}
