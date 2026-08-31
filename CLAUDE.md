# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What This Is

`fopost/fopost-github-action` — the official FoPost GitHub Action. A **JavaScript**
action (not Docker: JS actions start in about a second, Docker actions in tens of
seconds), written in TypeScript and bundled with `@vercel/ncc` into `dist/index.js`,
which GitHub executes directly on the `node20` runtime. It wraps
[`@fopost/sdk`](https://github.com/fopost/fopost-js) so a workflow can create,
schedule, and publish a post. It is not published to npm — consumers reference it as
`fopost/fopost-github-action@v0`.

## Brand Rules

- The product is **FoPost** (`fopost.com`). Never write "OwlStack" — retired Aug 2026.
- Never write an email address. Support is https://fopost.com/contact and GitHub issues.
  This includes workflow files: the release workflow uses a lightweight tag on purpose,
  because an annotated tag would need a committer identity.
- Never name AI providers/models, infrastructure vendors, or any person. Author is
  Porter Bridge, LLC.

## Architecture

```
action.yml          the action's contract — inputs, outputs, branding, runs.using
src/index.ts        entrypoint; calls run()
src/main.ts         orchestration: parse → resolve → (dry run | upload, create, publish) → outputs + summary
src/inputs.ts       reads and validates every input; masks the API key on read
src/logging.ts      the redaction layer — every log line goes through it
src/errors.ts       FoPost API error → one actionable, redacted line
src/accounts.ts     resolves `accounts` entries and the workspace (read-only calls)
src/media.ts        multipart upload for local files; the SDK does not wrap this endpoint
src/summary.ts      the job summary panel
src/test-support.ts shared test types and a JSON Response helper (not bundled)
dist/index.js       the committed ncc bundle — build output, on purpose
```

A run: `parseInputs` (masks the key first) → `new FoPost({ apiKey, baseUrl })` →
`resolveWorkspaceId` → `resolveAccounts` → on a dry run, print and stop → else upload
media, `posts.create`, optionally `posts.publish` → `setOutput` ×4 → `writeSummary`.

## Security Rules — the ones that matter most here

1. **`registerSecret(apiKey)` runs before anything else** in `parseInputs`. It calls
   `core.setSecret` (so the runner masks the value) _and_ records it locally.
2. **Every log line goes through `src/logging.ts`**, which redacts registered secrets
   itself. The runner's masking only covers what the runner writes; a key echoed back
   inside an API error message would otherwise reach the log verbatim. Never call
   `core.info` / `core.warning` / `core.setFailed` directly from feature code — import
   the wrappers.
3. **`console.*` is banned** by ESLint. Everything goes through `@actions/core`.
4. **Never print a response header.** `src/media.ts` reads exactly one — `Retry-After`,
   to say when to retry — and never logs it.
5. Verbose output is `core.debug`, visible only with `ACTIONS_STEP_DEBUG`.

`src/run.test.ts` and `src/errors.test.ts` pin all of this. Both were verified to fail
when the redaction is removed.

## dist/ Is Committed

This is the one place where committing build output is correct: GitHub runs
`dist/index.js` straight out of the repository, with no install step. The standard
failure mode for a JS action is a **stale bundle** — source merged, bundle not
rebuilt, so the action keeps running the previous version. Two guards:

- `.github/workflows/ci.yml` job `bundle` rebuilds and fails on `git diff --exit-code -- dist/`.
- `.github/workflows/release.yml` repeats the check on the tag, so a release can never
  ship a stale bundle.

The bundle check pins Node 22 deliberately: the committed bytes have to match what one
toolchain produces. Always run `npm run build` and commit `dist/` in the same change as
the source edit.

## API Contract

Inherited from `@fopost/sdk` (read that repo before changing request shapes):

- Base URL `https://api.fopost.com`, paths under **`/v1/`**. Override with the
  `FOPOST_BASE_URL` env var (used by the tests and the local smoke run).
  **`/api/v1/` is a 404** — confirmed by probe (`/v1/platforms` 200,
  `/api/v1/platforms` 404). This action shipped that wrong prefix once; do not
  reintroduce it.
- Auth header `X-API-Key: <key>` — not Bearer.
- Success envelope `{"data": ...}`; the SDK unwraps it.
- Error envelope `{"error": "<code>", "message": "<text>"}`; 402 carries `upgrade_url`.
- `posts.create` then `posts.publish` — publish returns when delivery is **queued**,
  not live. Its body is `{ post_status, deliveries[], healthWarnings }`.
- Media upload is `POST /v1/media/upload`, multipart, files under the `files`
  field plus a `workspaceId` field. The SDK does not wrap it, so `src/media.ts` posts
  directly with the same auth header — which makes the path ours to get right, and the
  one URL `src/media.test.ts` asserts exactly.
- The dashboard URL for a post is `https://fopost.com/dashboard/posts/<id>`, overridable with
  `FOPOST_APP_URL`.

## Parent dependency

`@fopost/sdk` is published on npm, so `npm ci` resolves it normally — no
CI-from-source shim is needed here.

**The range must move to `^0.2.3` as soon as that version is on npm.** The manifest
currently declares `^0.2.2`, and 0.2.2 is broken: it sends _every_ request to
`/api/v1/...`, which the API answers with a 404. So while this action's own media
upload is now correct, the SDK-driven calls (`accounts.list`, `posts.create`,
`posts.publish`) cannot succeed against production until 0.2.3 lands. The fix is on
branch `fix/api-base-path` in `fopost-js`.

`^0.2.3` is not declared yet on purpose: npm has no such version, so declaring it fails
`npm ci` outright with `ETARGET` — which would take CI, the self test, and the release
workflow red, and would not make the action work any sooner. Bump `package.json`, run
`npm install` to refresh the lockfile, and drop this paragraph the day 0.2.3 publishes.

Historical note: the brief for this repo said `^0.1`, but npm only ever carried the
0.2.x line, so `^0.1` would not install either.

**Never assert the SDK's base path in a test.** `src/run.test.ts` matches the SDK's
requests by resource suffix (`/posts`, `/accounts`, `/posts/<id>/publish`) via `pathOf`
and `isResource`, so the suite passes against 0.2.2 and 0.2.3 alike and needs no edit
when the bump lands. Pinning a full SDK URL is asserting someone else's implementation
detail, and is why the `/api/v1` bug survived review the first time.

`overrides.undici` in `package.json` exists only to lift the transitive `undici` that
`@actions/core` → `@actions/http-client` pulls in past its advisories. Drop it once
`@actions/core` ships a newer floor.

## Commands

```bash
npm install
npm run lint          # eslint
npm run format:check  # prettier
npm run typecheck     # tsc --noEmit
npm test              # vitest, fully offline
npm run build         # ncc → dist/index.js  (commit the result)
npm run all           # lint + typecheck + test + build
```

Run the built bundle locally without a live key:

```bash
: > /tmp/out.txt; : > /tmp/sum.md
env "INPUT_API-KEY=placeholder" \
    "INPUT_WORKSPACE-ID=00000000-0000-4000-8000-000000000000" \
    "INPUT_ACCOUNTS=00000000-0000-4000-8000-000000000001" \
    "INPUT_TEXT=hello" "INPUT_DRY-RUN=true" \
    "FOPOST_BASE_URL=http://127.0.0.1:9" \
    "GITHUB_OUTPUT=/tmp/out.txt" "GITHUB_STEP_SUMMARY=/tmp/sum.md" \
    node dist/index.js
```

## Testing

Vitest, fully offline. `@actions/core` is replaced with a recorder via `vi.mock`, and
the network is stubbed by assigning `globalThis.fetch` before `run()` — the SDK binds
the global at construction time, so nothing else needs mocking. **Never let a test
reach the real API.**

The suite exists to catch what fails silently and expensively:

- the key is masked and never appears in a message,
- a dry run makes no mutating call,
- outputs are set on success,
- `fail-on-error: false` warns instead of failing,
- errors map to a clear line.

Layout and copy are not tested. When you add a case, first prove it fails with the
behavior removed.

## Conventions

- Prettier: single quotes, semicolons, trailing commas, 100 char width, 2-space indent.
- TypeScript strict; no unused locals or params; `@typescript-eslint/no-explicit-any`
  is an error. ESM throughout, with a `.js` suffix on relative imports of `.ts` source.
- Comments: short, and only for a non-obvious "why".
- Every user-visible string is a full sentence that names the input to fix.

## Releasing

1. Bump `version` in `package.json`.
2. `npm run all` — the build must leave `dist/` clean after you commit it.
3. Tag `v<version>` and push the tag.

`.github/workflows/release.yml` then verifies the tag matches `package.json`, re-runs
lint/typecheck/tests, re-checks that `dist/` is current, creates the GitHub Release with
generated notes, and force-moves the floating major tag (`v0`) onto the release commit —
that floating tag is what `uses: fopost/fopost-github-action@v0` resolves to.

It needs no repository secret: `${{ github.token }}` with `permissions: contents: write`
is enough for both the release and the tag push.

**Manual, one time only — GitHub Marketplace.** Publishing to the Marketplace cannot be
automated. From the repository's Releases page, edit a release and tick _Publish this
Action to the GitHub Marketplace_, accept the terms, pick the primary and secondary
categories, and update the release. This requires `action.yml` at the repository root
with a unique `name`, a `description`, and `branding` (both present), and the account
to have two-factor authentication on. Once done, later releases are listed
automatically — the checkbox is a one-time step, not a per-release one.

## Git

Conventional Commits, atomic — one logical change each. Branch `feature/<description>`,
merge to `main` via PR. Never `gh pr create` — push the branch and hand over the compare
link.
