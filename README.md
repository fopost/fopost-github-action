# FoPost GitHub Action

[![CI](https://img.shields.io/github/actions/workflow/status/fopost/fopost-github-action/ci.yml?branch=main&label=ci)](https://github.com/fopost/fopost-github-action/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/fopost/fopost-github-action?include_prereleases&label=release)](https://github.com/fopost/fopost-github-action/releases)
[![license](https://img.shields.io/github/license/fopost/fopost-github-action)](LICENSE)

Create, schedule, and publish social posts from a GitHub workflow — to every
network connected to your [FoPost](https://fopost.com) workspace.

Announce a release the moment it ships, schedule a weekly digest from a file in
the repository, or open a draft for a human to send. Built on
[`@fopost/sdk`](https://www.npmjs.com/package/@fopost/sdk) and bundled as a
Node 20 JavaScript action, so it starts in about a second.

```yaml
- uses: fopost/fopost-github-action@v0
  with:
    api-key: ${{ secrets.FOPOST_API_KEY }}
    accounts: bluesky:yourbrand, linkedin:yourbrand
    text: ${{ github.event.repository.name }} ${{ github.ref_name }} is out.
    publish: true
```

## Getting an API key

Create one in the dashboard under Settings → API Keys. It needs the `posts`
scope, plus `media` if you attach local files. Store it as a repository secret
named `FOPOST_API_KEY` and reference it as `${{ secrets.FOPOST_API_KEY }}` —
never paste the key into the workflow file, and never into a `run:` step.

The action calls `core.setSecret` on the key before it does anything else, so
the runner masks it in every log line, including the ones this action writes.

## Usage

### Post on release

```yaml
name: Announce release

on:
  release:
    types: [published]

jobs:
  announce:
    runs-on: ubuntu-latest
    steps:
      - uses: fopost/fopost-github-action@v0
        with:
          api-key: ${{ secrets.FOPOST_API_KEY }}
          workspace-id: ${{ vars.FOPOST_WORKSPACE_ID }}
          accounts: |
            bluesky:yourbrand
            linkedin:yourbrand
            mastodon:yourbrand
          text: |
            ${{ github.event.repository.name }} ${{ github.event.release.tag_name }} is out.

            ${{ github.event.release.html_url }}
          labels: release
          publish: true
```

### Post release notes from `CHANGELOG.md`

`text-file` reads a file out of the checkout, so the copy lives in the
repository and changes go through review like any other change.

```yaml
steps:
  - uses: actions/checkout@v4

  - name: Extract the newest CHANGELOG section
    run: awk '/^## /{ if (seen++) exit } seen' CHANGELOG.md > release-notes.md

  - uses: fopost/fopost-github-action@v0
    with:
      api-key: ${{ secrets.FOPOST_API_KEY }}
      accounts: bluesky:yourbrand
      text-file: release-notes.md
      status: draft # a person sends it from the dashboard
```

### Post on a schedule

```yaml
on:
  schedule:
    - cron: '0 8 * * 1' # Mondays, 08:00 UTC

jobs:
  digest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: fopost/fopost-github-action@v0
        with:
          api-key: ${{ secrets.FOPOST_API_KEY }}
          accounts: bluesky:yourbrand, linkedin:yourbrand
          text-file: content/weekly-digest.md
          media: assets/digest-card.png
          schedule-at: '2026-09-07T15:00:00Z'
          fail-on-error: false # a missed digest should not fail the repo's checks
```

### Attach media

Local paths are uploaded to the media library first; `http(s)` URLs are
attached as they are.

```yaml
with:
  media: |
    assets/card.png
    https://cdn.example.com/clip.mp4
```

### Check a workflow without posting

`dry-run` validates every input, resolves the accounts, and prints what would
go out — without creating, uploading, or publishing anything.

```yaml
with:
  api-key: ${{ secrets.FOPOST_API_KEY }}
  accounts: bluesky:yourbrand
  text: Dress rehearsal.
  dry-run: true
```

More complete workflows live in [`examples/`](examples).

## Inputs

| Input           | Required | Default | Description                                                                                              |
| --------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `api-key`       | yes      | —       | FoPost API key. Always from a secret. Masked on read.                                                    |
| `workspace-id`  | no       | —       | Workspace to post into. Optional when the key reaches exactly one workspace.                             |
| `accounts`      | yes      | —       | Accounts to post to, one per line or comma separated. An account id, a username, or `platform:username`. |
| `text`          | one of   | —       | Post body. Mutually exclusive with `text-file`.                                                          |
| `text-file`     | one of   | —       | Path in the checkout whose contents become the body.                                                     |
| `media`         | no       | —       | Images or videos. A local path is uploaded; an `http(s)` URL is attached as is.                          |
| `schedule-at`   | no       | —       | ISO 8601 timestamp. Implies `status: scheduled`.                                                         |
| `status`        | no       | `draft` | `draft` or `scheduled`. Defaults to `scheduled` when `schedule-at` is set.                               |
| `publish`       | no       | `false` | Publish right after creating. Delivery is queued, so success means accepted, not yet live.               |
| `labels`        | no       | —       | Labels to attach, one per line or comma separated.                                                       |
| `fail-on-error` | no       | `true`  | Set to `false` to log a warning and keep the step green.                                                 |
| `dry-run`       | no       | `false` | Validate and print without creating, uploading, or publishing.                                           |

## Outputs

| Output           | Description                                                                    |
| ---------------- | ------------------------------------------------------------------------------ |
| `post-id`        | Id of the created post. Empty on a dry run.                                    |
| `post-url`       | Dashboard URL of the created post. Empty on a dry run.                         |
| `status`         | `draft`, `scheduled`, `publishing`, `pending_approval`, `dry-run`, or `error`. |
| `delivery-count` | Number of per-account deliveries queued by `publish`. `0` when not publishing. |

Every run also writes a job summary with the post's status, the accounts it
went to, and a preview of the body.

## Errors

Failures come back as one actionable line, never a stack trace and never a
response header:

- **401** — the key is missing or revoked; check `api-key`.
- **402** — the plan does not cover the request; the message carries the upgrade URL.
- **403** — the key's scopes or workspace access do not reach this workspace.
- **429** — rate limited, with when to retry.
- **5xx** — transient; re-run the job.

Set `fail-on-error: false` to downgrade all of these to a warning, which is the
right call for a scheduled digest that should not turn a repository's checks
red.

## Security

- Pass `api-key` from `${{ secrets.FOPOST_API_KEY }}`. A key committed to a
  workflow file is a key you have to rotate.
- The key is masked with the runner (`core.setSecret`) before any other work,
  and this action redacts it again in every message it writes — so a key echoed
  back by an API error never lands in the log.
- No response header is ever printed.
- Pin the action to a tag (`@v0`) or, for the strictest supply-chain posture, to
  a commit SHA.
- Workflows triggered by `pull_request` from a fork have no access to secrets,
  which is the behavior you want: a fork cannot post as you.
- Verbose output goes to `core.debug`, visible only when the repository sets the
  `ACTIONS_STEP_DEBUG` secret to `true`.

## Versioning

Releases are tagged `v<version>`, and the floating major tag (`v0`) is moved to
each release, so `@v0` always points at the newest release on that major.

## Contributing

```bash
npm install
npm run lint && npm run typecheck && npm test
npm run build   # regenerates dist/ — commit it
```

`dist/` is build output that is committed on purpose: GitHub runs it directly.
CI fails if it drifts from the source, so run `npm run build` before you push.

## Links

- Documentation — https://fopost.com/docs
- TypeScript SDK — https://github.com/fopost/fopost-js
- Issues — https://github.com/fopost/fopost-github-action/issues
- Support — https://fopost.com/contact

MIT licensed. See [LICENSE](LICENSE).
