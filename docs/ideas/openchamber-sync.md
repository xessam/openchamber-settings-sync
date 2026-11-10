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
    plugins/ (not node_modules); recursively strip credential-like keys
    and URL credentials from config
  - `~/.config/openchamber/extensions.json`: only HTTPS git origins;
    do not sync machine paths, storage IDs, capability grants, or scopes.
    Each machine installs extensions and grants them independently.
- Secrets: never sync OpenCode data/auth databases or legacy `auth.json`;
  `auth.json` exists on older installs, while current OpenCode can store
  credentials in its SQLite database. Strip config credentials defensively.
- Git auth in v1: accept GitHub HTTPS via the machine's credential helper and
  GitHub SSH via the machine's non-interactive OpenSSH config/key files. Never
  accept credentials in the remote or store keys/tokens in extension data.
  OpenChamber-managed identities and SSH-agent-only/passphrase-prompted keys
  are not exposed to the service; supporting them needs a host-side Git API.
- Apply: writes files; OpenChamber picks up on reload (verify — Open Q2)

Implementation status: extension manifest, authenticated loopback service,
local preview panel, source filters, and per-machine LWW/tombstone primitives
are implemented and tested. The panel accepts credential-free GitHub HTTPS
or scp-style SSH remotes and tests read access with non-interactive
`git ls-remote`; this is read-only. Push/pull and applying merged values
remain unimplemented.

## Key Assumptions to Validate
- [ ] Extension `service` can push/pull a private repo — local service protocol
      is implemented; credential-helper access to a private repo is unverified
- [ ] Portable preference fields remain stable across OpenChamber updates
- [ ] Per-machine LWW and tombstones converge under real concurrent edits
- [ ] Machines' clocks within ~1s (NTP) — `date` on both
- [ ] OpenChamber rereads preferences and config without restart

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
- Q3: `dcp.jsonc` / `service.json` — in scope or machine-local?
- Q4: How should custom OpenChamber/OpenCode config directories be selected?
