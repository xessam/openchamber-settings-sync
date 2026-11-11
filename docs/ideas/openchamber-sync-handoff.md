# OpenChamber Sync — implementation handoff

**Updated:** 2026-11-11 (apply + verification phase)
**Repository:** `~/Workspace/Projects/openchamber-sync`

## Start here

1. Read `docs/ideas/openchamber-sync.md` for product direction and policy.
2. Run `git status --short` before editing. The working tree already contains
   substantial uncommitted work from earlier phases. Preserve it; do not reset,
   revert, stage, or commit it as a batch.
3. Run `npm test` and `npm run build` after changes. There is no lint script.

## Current implementation

### Completed

- Portable snapshot covers allowlisted OpenChamber preferences, sanitized
  `opencode.json`, HTTPS extension origins, and UTF-8 files under OpenCode
  `agents/`, `commands/`, `skills/`, and `plugins/`.
- File scanning excludes non-allowlisted extensions, `.git`, and `node_modules`;
  it refuses symlinks, credential-oriented names/content, binary files, and
  configured size/depth limits. Pattern scanning is defense-in-depth, not a
  guarantee that arbitrary prose or code contains no secrets.
- `readRemoteMachineStates()` in `src/remote-state.js` validates GitHub remotes,
  reads into a temporary bare repo with blob filtering and no checkout, bounds
  processes/output/state sizes, and validates only regular
  `machines/<id>/state.json` blobs. Temporary data is removed on exit.
- `POST /repository/preview` returns bounded, file-level differences and safe
  value previews. Credential-like or oversized values, unsupported keys, and
  incomplete local sources block confirmation.
- The panel requires a conflict choice and explicit acknowledgement.
  `POST /repository/confirm` re-reads local and remote state and rejects a stale
  preview. It is read-only and does not persist an approval for later reuse.
- Stable machine UUIDs use OpenChamber **device-scoped** extension storage and a
  browser lock. If either device storage or Web Locks is unavailable, the panel
  fails closed; it does not fall back to instance-scoped storage.
- On a repository with no machine state, the service prepares an initial
  `machines/<id>/state.json` in memory and returns only branch/path/entry-count
  metadata. It does **not** commit or push it. "No machine state" covers both a
  repository with zero refs and one whose default branch carries unrelated
  content (a README or setup notes) — the bootstrap commit parents on the
  remote head, so unrelated files survive. A repository that already contains
  machine state refuses bootstrap.
- `POST /repository/bootstrap` pushes that prepared state as its own explicit
  step. It re-reads both sides and revalidates the confirmed preview in the
  same operation that writes; a stale or unconfirmable plan is refused before
  any Git call. `src/repository-push.js` builds the commit with Git plumbing in
  a temporary bare repository (`hash-object` → `update-index --cacheinfo` →
  `write-tree` → `commit-tree` → `update-ref`), never checks out remote
  content, uses fixed commit identity/dates for a deterministic commit SHA,
  and pushes `refs/heads/main:refs/heads/main` without force. A concurrent
  remote update or non-fast-forward rejection maps to a safe 409 and leaves
  the remote unchanged; other push failures never leak raw Git output. The
  panel exposes this as a separate "Push initial state" button that appears
  only after a confirmed empty-repository review, and shows the outcome.
- Local bare-repository tests cover empty bootstrap, branch creation,
  unrelated-file preservation under a concurrent update, failed push mapping,
  deterministic-commit retries, and temporary-directory cleanup.
- HTTPS support remains enabled. HTTPS troubleshooting and actual SSH push
  permission have not been tested.
- Applying approved changes is implemented and tested. `POST /repository/apply`
  revalidates the confirmed preview (same stale-preview rules as bootstrap),
  requires a non-empty repository, and writes only the approved
  download/conflict-resolved values. `src/apply-plan.js` derives per-file
  operations from the comparison and resolutions (pure, fail-closed); `src/local-apply.js`
  executes them: content for every target is computed before anything is
  written, a recovery journal (`.openchamber-sync-apply-journal.json` in the
  OpenChamber config directory) records every step before any file changes,
  each step writes a fsynced same-directory temporary file, hard-link backs up
  the original, and renames atomically. Symlinked targets, paths outside the
  portable allowlist, oversized files, and missing settings files refuse the
  apply before any write. An interrupted apply is rolled back on the next apply
  attempt; recovery restores backups only when the target still holds what the
  apply wrote, so a later user edit is never overwritten. The panel exposes
  this as a separate "Apply to this machine" button after confirmation.
- End-to-end multi-machine tests run the full pipeline (real Git, real service
  routes, real temporary config directories and repositories): convergence
  after apply, tombstone deletions blocking resurrection, equal-timestamp
  ties, stale previews after local or remote changes, long-offline machines,
  and malformed remote state failing closed.
- Real transport was verified against the intended private test repository
  (SSH, 2026-11-11): non-interactive read and push both work. The probe pushed
  a scratch branch containing only a probe note, read it back, and uploaded no
  configuration. See the caveat below about the repository's current state.
  HTTPS read fails on this machine because no Git credential helper is
  configured; non-interactive access fails closed as designed.

### Important limits and safety rules

- Never put credentials in remote URLs; never store Git credentials in the
  extension or sync state.
- Do not upload real configuration or overwrite local settings without the
  user explicitly approving a complete preview. Confirmation remains a
  read-only review receipt; only `POST /repository/bootstrap` writes, and it
  revalidates everything itself and writes exactly one state file.
- Credential-marker detection can miss novel or unlabeled secrets. Keep the
  full-value preview bounded and block confirmation whenever a value is
  withheld/truncated.
- Remote reads currently cap at 15 seconds total, 10 seconds per Git process,
  64 machines, 4,096 entries per machine / 16,384 total, 8 MiB per state, and
  32 MiB total state data. Preview caps are 200 items, 32 KiB per value, and
  512 KiB total value text. Bootstrap pushes cap at 15 seconds total,
  10 seconds per Git process, and 8 MiB of prepared state.
- Do not force-push. If the remote changes after preview or during a push,
  refresh and require a new confirmation rather than silently overwriting or
  retrying against stale state.

## Remaining work — in order

### 1. Restore the test repository state — **resolved 2026-11-11**

The push probe revealed GitHub behavior: pushing to an empty repository adopts
the first pushed branch as the repository's HEAD. The scratch branch was
removed after the default branch was switched back to `main` in the GitHub UI.
`main` still holds the probe commit (a single probe note, no configuration).
Rather than requiring a recreated empty repository, bootstrap now accepts any
repository that contains no machine state and parents its commit on the remote
head, preserving unrelated files (implemented and tested; verified against the
real repository's content in a local mirror). The repository is ready for the
first real sync.

### 2. First real end-to-end sync via the panel

- Run the extension panel against `git@github.com:xessam/openchamber-sync.git`:
  preview, confirm, bootstrap push, then a second machine's preview/confirm/apply.
- Verify on the second machine which settings actually take effect without a
  restart, especially agent/command/skill/plugin files (see Q2 findings in
  `docs/ideas/openchamber-sync.md`), and record the result.
- Configure a Git credential helper if HTTPS remotes are wanted; SSH is the
  working path on this machine.

### 3. Later (explicitly out of scope so far)

- Pushing a machine's merged state updates to a non-empty repository (machine
  B currently cannot register its own state file; only bootstrap on an empty
  repository writes).
- Automatic triggers — only after the explicit flow is proven in practice.

## Key files

- `src/machine-identity.js` — device-scoped identity creation/fail-closed rules.
- `src/repository-bootstrap.js` — initial state-document preparation; no I/O.
- `src/repository-push.js` — bounded plumbing-only bootstrap push (no force).
- `src/apply-plan.js` — pure planner: comparison + resolutions → per-file operations.
- `src/local-apply.js` — atomic apply executor with recovery journal and rollback.
- `src/remote-state.js` — bounded remote read and validation.
- `src/service.js` — authenticated preview/confirm/bootstrap/apply service routes.
- `src/bootstrap-preview.js`, `src/local-snapshot.js`, `src/portable-files.js` —
  snapshot, preview, and path policy.
- `src/panel.js`, `panel/index.html`, `panel/style.css` — first-sync review UI
  with the separate push-initial-state and apply steps.
- `test/` — unit, local-repository, and end-to-end tests; all network access is
  stubbed or uses temporary local repositories.

## Last verification

- `npm test` — 116 tests passed (apply planner, atomic apply with interruption
  and recovery, service apply route, end-to-end multi-machine suites, and
  bootstrap onto a repository with unrelated content).
- `npm run build` — panel and service bundles built successfully.
- `git diff --check` — passed.
- SSH read and push verified against the intended private test repository with
  a scratch-branch probe (no real configuration uploaded). The parented
  bootstrap path was verified against a local mirror of the real repository:
  the commit parents on the probe commit, the probe file survives, and a
  repeated push reports the existing head. No real configuration has been
  pushed yet; the first real sync runs through the panel.
