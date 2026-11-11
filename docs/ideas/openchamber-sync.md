# openchamber-sync — two machines, one config

## Problem Statement
How might we make two machines running OpenChamber converge on the same
config — OpenChamber prefs, OpenCode config, extension list — without manual
copying, versioned and self-healing, with named bundles (v2) to switch
workflows?

## Recommended Direction
Direction A, the **sync engine**: an OpenChamber extension whose `service`
capability talks to one private GitHub repo. Start with explicit user actions;
only add background syncing after bootstrap, merge, and recovery are proven.
Direction B (VS Code-style named profiles) is the explicit **v2**, not a
rejection — it lands once a converged baseline exists. The repo layout
below reserves `profiles/` from day one so v2 is additive, not a migration.

Mechanics (v1):
- First release: explicit preview, bootstrap, and sync actions; consider
  startup/debounced/interval triggers only after recovery is proven
- One git branch, no server component: the repo IS the backend
- Layout: `machines/<machine-id>/state.json` (per-key values + timestamps);
  derive merged truth locally rather than committing a shared output file,
  so two devices never race to update the same generated file
- Merge: per key-path last-write-wins on wall clock; arrays/objects
  replaced whole — no inner merge
- Deletes: per-machine tombstones block resurrection. Do not garbage-collect
  until every active machine has acknowledged them or has been explicitly retired;
  a 30-day TTL alone can resurrect settings from a long-offline device.
- Sources (allowlists):
  - `~/.config/openchamber/preferences.json` `fields` allowlist (themes,
    fonts, keymaps, favorites, notifications, editor prefs); do not sync
    `settings.json` wholesale (it includes relay keys, host state, paths,
    tunnels, bookmarks, ports, and project state)
  - `~/.config/opencode/` → opencode.json, agents/, commands/, skills/,
    plugins/ (not node_modules or .git); files are limited to UTF-8 text with
    `.cjs`, `.js`, `.json`, `.jsonc`, `.md`, `.mdc`, `.mjs`, `.toml`, `.ts`,
    `.txt`, `.yaml`, or `.yml` extensions. Other extensions are excluded;
    credential-named allowlisted files, symlinks, binary/oversized files, and
    files matching credential markers block this source rather than silently
    becoming deletions. Limit: 256 files,
    512 KiB per file, 4 MiB total, 4,096 directory entries, and 12 levels deep.
    Structured config recursively drops credential-like keys and URL credentials;
    credential-like content in other config strings blocks that source.
  - `~/.config/openchamber/extensions.json`: only HTTPS git origins;
    do not sync machine paths, storage IDs, capability grants, or scopes.
    Each machine installs extensions and grants them independently.
- Secrets: never sync OpenCode data/auth databases or legacy `auth.json`;
  `auth.json` exists on older installs, while current OpenCode can store
  credentials in its SQLite database. Strip config credentials defensively.
- Git auth in v1: accept GitHub HTTPS via the machine's credential helper and
  GitHub SSH via the machine's non-interactive OpenSSH config/key files. Never
  accept credentials in the remote or store keys/tokens in extension data.
  OpenChamber-managed identities are not exposed to the service. An SSH agent
  can only be used if its socket is available in the service environment;
  passphrase prompts cannot be answered. Supporting host-managed identities
  needs a host-side Git API.
- Apply: writes files; OpenChamber picks up on reload (verify — Open Q2)

Implementation status: extension manifest, authenticated loopback service,
local preview panel, source filters, per-machine LWW/tombstone primitives,
read-only first-sync review, stable device identity, initial state
preparation, and repository bootstrap push are implemented and tested. The panel accepts
credential-free GitHub HTTPS or scp-style SSH remotes and tests read access with non-interactive
`git ls-remote`; this is read-only and does not test push access. Expand the
panel's **Git test diagnostics** to see the command type, exit code, SSH agent
environment availability, and recognized failure category. The agent indicator
only reports whether its socket is configured, not whether it is usable. Raw
Git/SSH output, repository addresses, and credential-helper output are not shown.
Repository bootstrap push is implemented as a separate explicit step: the
service re-reads both sides, revalidates the confirmed preview in the same
operation, then builds a deterministic commit for `machines/<id>/state.json`
with Git plumbing in a temporary bare repository (no checkout of remote
content) and pushes it without force. It works on an empty repository and on a
repository whose default branch has unrelated content but no machine state:
the commit parents on the remote head, so unrelated files are preserved, and
the push is a fast-forward. Repeating an already-pushed bootstrap reports the
existing head instead of stacking a commit. A concurrent remote update or
non-fast-forward rejection fails closed with no remote change and requires a
fresh preview. A repository that already contains machine state refuses
bootstrap.

Applying approved changes is implemented as a separate explicit step
(`POST /repository/apply`) that runs after a confirmed review of a non-empty
repository. The apply re-reads both sides and revalidates the confirmed
preview, then writes only the approved download and conflict-resolved-to-repository
values: per-key merges into `preferences.json` (inside `fields`) and
`opencode.json` (top-level keys), reconstruction of the HTTPS `gitOrigins`
entries in `extensions.json` (non-HTTPS entries and unrelated keys are
preserved), and whole-file writes or deletions for OpenCode
agent/command/skill/plugin files. Unsynced local fields are preserved. Writes
are atomic: content is computed for every target first, a recovery journal in
the OpenChamber config directory records every step before any file changes,
each step uses a same-directory temporary file (fsynced), a hard-link backup,
and an atomic rename, and the journal is removed only after every step.
Symlinked targets, paths outside the portable allowlist, and oversized files
refuse the apply before any write. An interrupted apply is rolled back on the
next apply attempt (backups restore the pre-apply values; a file the user
edited after the interruption is never overwritten).

Portable file policy is an allowlist, not a guarantee that arbitrary text is
secret-free. Credential marker detection is deliberately fail-closed but is
not exhaustive; users must review portable files before confirming upload.
The first-sync review lists changed paths and bounded local/repository values;
marker matches and oversized values are withheld and block confirmation.
The preview is capped at 200 changes, 32 KiB per value, and 512 KiB of value
text; unsupported paths and truncated previews also block confirmation.
Never sync `.env`, key material, OpenCode auth/data databases, or legacy
`auth.json`. Source status becomes unavailable if an allowlisted text file
looks credential-bearing, so it cannot be mistaken for a deletion.

First-sync direction: compare local and remote values read-only. The panel
shows upload/download/conflict items and requires a choice for every conflict,
plus a separate explicit acknowledgement. The service re-reads both sides
before accepting confirmation and rejects a stale plan. Confirmation is only
a review receipt: it does not upload or modify local files. On a confirmed empty
repository, the service prepares an initial `machines/<id>/state.json` in memory
and returns its path/count; uploading it happens only through the separate
explicitly revalidated bootstrap push step. The stable ID is a UUID
stored in OpenChamber's device-scoped extension storage under a cross-tab lock.
Hosts without device storage or Web Locks fail closed; there is no instance-scope
fallback. Missing/unreadable
sources, unsupported remote keys, incomplete previews, or credential-like
content block confirmation. Snapshot covers the three JSON sources above and
allowlisted OpenCode agent, command, skill, and plugin files. Treat sanitization
as defense in depth, not a guarantee that arbitrary configuration text contains
no secrets. Git read access does not establish push permission.

Remote-state reader: performs bounded, non-interactive Git commands in a fresh
temporary bare repository; fetches the default branch shallowly with blob
filtering; never checks out remote paths or runs repository hooks. Empty branch
lists return an empty-state result. Only regular `machines/<id>/state.json`
blobs are accepted (64 machines maximum); JSON is size-bounded and validated
against the machine ID and state schema before use (4,096 entries per machine,
16,384 total). Temporary repositories are removed after success or failure.
Limits are 15 seconds total, 10 seconds per Git process, 8 MiB per state, and
32 MiB across states. If the server reports
that blob filtering is unsupported, the read fails closed. The authenticated
`POST /repository/preview` service route uses this reader and returns only the
bounded comparison needed by the panel; raw machine IDs and Git output are not
returned.

Remaining work, in order:
- [x] Define an allowlisted portable file policy; cover OpenCode
      agent/command/skill/plugin files, with credential-marker matches blocking
      the source. Review arbitrary text before confirming an upload.
- [x] Read and validate remote per-machine states with bounded Git operations,
      including empty repositories and untrusted/malformed repository contents.
- [x] Connect a read-only first-sync comparison to the panel; require explicit
      confirmation and a choice for each conflict. Confirmation rechecks the
      preview and has no side effects; no upload/apply action exists.
- [x] Complete repository bootstrap by pushing the prepared state to `main`
      with non-force push and concurrent-update handling (plumbing-only commit,
      revalidated in the write operation; rejection requires a fresh preview).
      Stable device-scoped ID and initial state preparation are implemented.
- [x] Apply approved changes atomically with backups, preserve unsynced fields,
      and recover correctly from interrupted runs and concurrent changes
      (`POST /repository/apply`, recovery journal, interruption tests).
- [x] Test multi-machine convergence, deletions, recovery, and end-to-end
      transport against temporary repositories; establish which settings
      require restarting OpenChamber/OpenCode (see Q2 findings below).

## Key Assumptions to Validate
- [x] Extension `service` can push/pull a private repo — local service protocol
      is implemented; SSH push against the intended private test repository was
      verified 2026-11-11 with a scratch-branch probe that pushed, read back,
      and left no real configuration behind. HTTPS read fails on this machine
      because no Git credential helper is configured (non-interactive reads
      fail closed as designed); HTTPS needs a configured helper before first use.
- [ ] Portable preference fields remain stable across OpenChamber updates
- [x] Per-machine LWW and tombstones converge under real concurrent edits —
      covered by unit tests plus end-to-end tests over temporary repositories
      (convergence, tombstone resurrection blocking, equal-timestamp ties,
      stale previews, long-offline machines, malformed state)
- [ ] Machines' clocks within ~1s (NTP) — `date` on both
- [x] OpenChamber rereads preferences and config without restart — see Q2

## MVP Scope
Safe local preview, repository bootstrap, explicit sync, LWW + tombstones,
and recovery from interrupted operations. Add automatic triggers only after
the explicit flow is reliable. Install the extension from its own git origin
once the configuration repository is independent and established.

## Not Doing (and Why)
- Always-on background sync in the first release — prove the explicit flow first
- OpenChamber-managed Account/SSH identities in v1 — the public SDK exposes no
  identity selection/credential API; avoid copying those credentials into the extension
- Vector clocks / CRDTs — wall clock + tombstones cover the real failures
- Encrypted secrets — keys verified out of scope already
- Per-project UI state — machine-local by nature
- Change log UI ("Direction C") — git history is the receipt, for free
- Inner merge of arrays/objects — whole-value replacement is predictable
- OS-specific grant filtering — both machines are Linux
- Profiles in v1 — needs a converged baseline to exist first
- Machine-specific extension grants and `storageIds` — re-approve locally

## Open Questions
- Q1: Private repo hosting — **resolved: private GitHub repo** (bare repo
  on machine A is zero-setup but a single point of failure)
- Q2: Which synced settings/config files hot-reload, and which need restart?
  Findings from the installed OpenChamber build (2026-11-11):
  - **OpenChamber `preferences.json` fields hot-reload.** The settings runtime
    re-reads `preferences.json` from disk on every settings read
    (`readSettingsFromDisk` in `@openchamber/web/server/lib/opencode/settings-runtime.js`);
    there is no startup cache to invalidate.
  - **`opencode.json` is watched by OpenCode.** OpenChamber's own source states
    its managed OpenCode config "lives in a config file OpenCode watches, so
    flipping one of these switches takes effect in the running process instead
    of waiting for a restart" (same module, managed-plugin handling).
  - **`extensions.json` is read per operation, not cached at startup.** Install
    and list flows call `readExtensionStore` on demand; OpenChamber's in-memory
    extension catalog is invalidated only by OpenChamber's own writes
    (`onExtensionStoreWrite`), so an externally applied origin list is visible
    to the next install action but the extension panel may need a reload, and
    nothing installs automatically (each machine installs independently by
    design).
  - **Agent/command/skill/plugin files: unverified.** Whether OpenCode rescans
    those directories while running is not established from source; verify on
    the second machine after a real apply (new agent visible without restart?)
    before relying on it.
- Q3: `dcp.jsonc` / `service.json` — in scope or machine-local?
- Q4: How should custom OpenChamber/OpenCode config directories be selected?
