/**
 * Shared shape for the fake `@actions/core` the tests install. Kept out of the
 * test files so the recorded state can be typed in one place.
 */
export type CoreRecorder = {
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  secrets: string[];
  info: string[];
  debug: string[];
  warnings: string[];
  failed: string[];
};

export type RecordedRequest = { url: string; method: string; body?: unknown };

/** A JSON response shaped the way the FoPost API answers. */
export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
