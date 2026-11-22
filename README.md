# opencode-session-registry-sync

OpenCode plugin that keeps the shared cross-session session registry in sync
with the live session lifecycle: every session registers itself the moment it
exists, renames auto-sync, deletions auto-remove, and peers resolve each other
by name through the `find_session` tool (ambiguous or missing names fail with
candidate lists; the tool never guesses).

Licensed Apache-2.0 (see `LICENSE` and `NOTICE`).

## What it does

1. Every opencode session auto-registers in the shared registry
   (`$XDG_STATE_HOME/opencode/agents-registry.json`, else
   `$HOME/.local/state/opencode/agents-registry.json`) as soon as it exists.
2. Registration is identified by the session name (`session.title`), stored in
   the additive `name` field.
3. Renames auto-sync: `session.renamed` / `session.updated` refresh `name`,
   and the previous name is appended to the capped additive `renamedFrom`
   trail (10 entries, most recent last) so peers holding a stale name can
   re-resolve.
4. Session deletion auto-removes the registry entry.
5. Peers reference each other by name through the `find_session` tool: exact
   match is case-insensitive; a stale name still resolves through the
   `renamedFrom` trail; anything else fails with candidate lists.
6. Untitled sessions are auto-titled at registration time
   (`<project-dir-basename>-<session-id-short>`) through the SDK session
   surface, so the entry is addressable by name from birth. An existing
   non-empty title is never overwritten.
7. Registry file, schema (`{ version: 1, sessions }`), atomic tmp+rename write
   discipline, and stale-entry TTL (24h) are shared with the
   `opencode-cross-session-messaging` plugin; both writers coexist.

## Configuration (environment only; no hard-coded values)

| Variable | Meaning | Default |
|---|---|---|
| `SESSION_REGISTRY_SYNC_STATE_DIR` | Redirects registry, messages, and log to an alternate state dir (used by the tests) | unset: XDG/home layout above |
| `SESSION_REGISTRY_SYNC_HEARTBEAT_MS` | Minimum gap between `updatedAt` heartbeats for live-but-unchanged sessions | `3600000` (1 hour) |

## Install / pin usage

Add the plugin to your `opencode.jsonc` plugins array with an exact git tag
pin (the same consumption shape as the other estate plugin repos):

```jsonc
{
  "plugins": [
    "git+https://github.com/matthew-dresden/opencode-session-registry-sync-mac-dev.git#v1.0.0"
  ]
}
```

Use an exact `vX.Y.Z` tag; mutable refs (branch names, `#main`) are not
supported. The plugin is loaded through `main: src/index.ts`: the tag tree
ships the TypeScript entry point directly and OpenCode's Bun runtime executes
it natively (the same consumption shape as the pinned
`opencode-cross-session-messaging` plugin), so no install-time build step
exists or is needed. Runtime dependencies: zero (node builtins only:
`node:crypto`, `node:fs`, `node:os`, `node:path`).

Note for release engineering: `dist/` is CI-side build output (gitignored;
tsc runs in the check/compile gates as the syntax and type gate) and is not
part of the pin surface. Registry publishes ship `src/` per the `files`
allowlist; `prepublishOnly` gates a registry publish on a clean compile.

## Plugin surface

- V2 plugin shape: `export default { id: "session-registry-sync", setup }`.
- Subscribes to `session.created`, `session.renamed`, `session.updated`,
  `session.deleted` and syncs the registry on each event; per-event registry
  failures are logged and skipped (the 24h TTL is the backstop).
- Registers the `find_session` tool: resolves another session by name to its
  registry entry (sessionId, directory, summary, device, rename trail).
- Runs a file-inbox watcher for registry entries this plugin owns (keyed on
  its per-instance `daemonId`), so `ask_session` delivery works for
  auto-registered sessions without touching the git plugin's routing.

## Pipeline

Standard estate plugin pipeline (CI on PRs, validation plus release PR on
main, tags `v*` create GitHub Releases). Every CI job invokes the npm target a
developer runs (1:1 wiring; `npm run ci` = check + test + hygiene).

CI jobs (`.github/workflows/ci.yml`, on pull_request):

| Job | npm target |
|---|---|
| pr-title | `npm run check:pr-title -- --title "$PR_TITLE"` (conventional commits) |
| typecheck | `npm run check:type` (tsc --noEmit) |
| build | `npm run compile` + `npm run check:syntax` |
| test | `npm test` (node:test via tsx) |
| license-check | `npm run check:license` |
| tarball-check | `npm run check:tarball` (after `npm run compile`) |
| hygiene | `npm run hygiene` (secret + lint-class scan over the tree) |
| version-immutability | `npm run check:version` (release-bot PRs exempt) |

Release flow:

1. Push to `main` triggers `.github/workflows/main-validation.yml`: the
   `validate` job reruns the full gate set; `release-pr` calculates the next
   version from conventional commits since the last `v*` tag, bumps
   `package.json`, appends `CHANGELOG.md`, and opens a `chore(release): vX.Y.Z`
   PR.
2. Merging the release PR triggers `.github/workflows/tag-release.yml`, which
   tags `vX.Y.Z` on the release commit and creates the GitHub Release from the
   changelog section.
3. A canary-gated `publish` job can later publish to GitHub Packages, but only
   on explicit `workflow_dispatch` with `REGISTRY_READY == 'true'`.

Security gates:

- Local: `.githooks/` (installed via `npm run prepare` ->
  `scripts/security/install-hooks.sh`, which sets `core.hooksPath`).
  `pre-commit` runs gitleaks on staged changes; `pre-push` runs a full-history
  gitleaks scan plus `scan_diff.py` (rejects secret-shaped content and lint
  classes: em-dash, CJK/fullwidth/mojibake codepoints).
- CI: `.github/workflows/security.yml` runs gitleaks (pinned 8.30.1,
  checksum-verified) over full history on pushes to `main` and PRs, with
  `.gitleaks.toml` as the gate config. House rule: no secret-shaped material
  (real, test, or synthetic) in the tree or history, ever; real credentials
  come from AWS SSM at runtime.

## Repository layout

| Path | Purpose |
|---|---|
| `src/index.ts` | The plugin (single source file, ported verbatim from the monorepo) |
| `tests/registry-sync.test.ts` | Registration and rename-trail behavior tests |
| `tests/name-lookup.test.ts` | `lookupByName` behavior tests (exact, case-insensitive, ambiguous, missing) |
| `dist/` | tsc build output (gitignored; rebuilt by `npm run compile`) |
| `scripts/check-license.mjs` | License + NOTICE compliance gate |
| `scripts/check-tarball.mjs` | Tarball allowlist and secret-leak gate |
| `scripts/security/install-hooks.sh` | Installs `.githooks/` via `core.hooksPath` (prepare wiring) |
| `ci/` | Release pipeline helpers (version calc, changelog, PR-title and release-commit checks) |
| `.github/workflows/ci.yml` | PR checks (see table above) |
| `.github/workflows/main-validation.yml` | Push-to-main validation + release PR |
| `.github/workflows/tag-release.yml` | Tag `v*` on release commits + GitHub Release |
| `.github/workflows/security.yml` | gitleaks 8.30.1 full-history scan (checksum-verified) |
| `.githooks/` | pre-commit, pre-push, scan_diff.py (local security kit) |
| `.gitleaks.toml` | gitleaks gate config (extends defaults, flags PEM blocks) |

## Development

```bash
npm install            # installs devDependencies, installs git hooks
npm run compile        # tsc -> dist/
npm test               # behavioral tests (node:test via tsx)
npm run check          # typecheck + compile + syntax + license + tarball gates
npm run hygiene        # secret + lint-class scan over the committed tree
npm run ci             # the full CI gate set: check + test + hygiene
```

Tests are isolated through the `SESSION_REGISTRY_SYNC_STATE_DIR` override:
each test points the plugin core at a fresh temp state dir, so the suite makes
no network calls and never touches real state.
