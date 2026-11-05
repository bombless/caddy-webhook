# Production webhook and game-library updater handoff

This repository now installs the webhook and its `/games/` UI together through the local root-only `scripts/update-webhook.sh`. Repository edits and CI do not update production. This document is a rollout checklist, not authorization to restart or deploy a live service.

## HTTP contract

| Method | Path | Authentication | Behavior |
| --- | --- | --- | --- |
| GET | `/health` | none | Webhook process health |
| POST | `/_deploy` | none | Disabled; always 404 |
| POST | `/_deploy/game` | Bearer token | Immutable game package ZIP; manifest required |
| GET | `/_games/registry.json` | none | Public registry schema v1 |
| GET | `/games/` | none | Game-library UI installed with webhook |
| GET | `/games/assets/...` | none | UI assets |
| GET | `/games/{id}/{version}/...` | none | Immutable package files |

The UI is not ZIP-published and has no release-symlink storage. UI deployment is not a GitHub Actions operation. Package publishing remains independent through `POST /_deploy/game`.

## Persistent storage

```text
/var/lib/static-deploy/
  tmp/                         # webhook upload staging
  games/
    index.html                 # UI root
    assets/                    # Vite UI assets
    wasm/                      # optional copied WASM runtime
    registry.json              # package publisher-owned
    <game-id>/<version>/       # immutable package-owned directories
      manifest.json
      entry and assets...
```

The updater replaces only `index.html`, `assets/`, and `wasm/`. Those two directory names are reserved and rejected as game IDs to prevent namespace collisions. A private ownership marker at `/var/lib/static-deploy/.game-library-ui-owned` distinguishes managed UI paths from pre-existing or orphan package directories; the first install refuses ambiguous collisions. The updater must never mirror the entire build directory or delete `games/*`; `registry.json` and every package-ID directory must remain byte-for-byte intact. The Vue example build is isolated under `dist/_build/` for the package-publishing workflow and is not installed as UI content.

The webhook service needs write/traverse access to `tmp/` and package directories. Caddy needs read/traverse access to the full `games/` tree. Verify the live unit's user, primary/supplementary groups, sandbox paths, ACLs, setgid behavior, and actual ownership before rollout; do not infer production identity solely from the checked-in example unit. The updater reads the live Caddy service identity, verifies that the persistent games root uses its group and that Caddy can read/traverse it, and installs UI files as `root:<caddy-group>` (files 0640, directories 2750). Set `CADDY_GROUP` only when the live deployment intentionally uses a non-default group.

## Caddy routing

`Caddyfile.example` is a route fragment, not a complete production Caddyfile. Its `/games/*` handler roots at `/var/lib/static-deploy` and retains the `/games` URI prefix, so both the UI and package paths resolve under `/var/lib/static-deploy/games/`. The `/games` path redirects to `/games/`. Registry reads map to `games/registry.json`. CORS, immutable caching, and WASM MIME handling are scoped to package paths/assets.

Inspect the complete live Caddyfile for overlapping `handle`, `handle_path`, `route`, `reverse_proxy`, and catch-all matchers. Validate the actual production Caddyfile with the installed Caddy version before any reload. Preserve `/app/*` only if the unrelated existing site still needs it.

## CI and package publication

`.github/workflows/deploy.yml` runs `npm ci`, tests, builds, and uploads a build artifact only; it does not call a webhook endpoint. `.github/workflows/deploy-static.yml` has been removed because its generic whole-site deployment behavior is not part of this design. `publish-game.yml` and `publish-snake.yml` continue to publish immutable packages to `/_deploy/game` using `GAME_DEPLOY_WEBHOOK_URL` and `DEPLOY_TOKEN`.

The repository lockfile must be committed/tracked before using the updater. It deliberately refuses untracked release inputs. The updater requires a clean tracked worktree on `main`, then builds from a temporary `git archive` of `HEAD`; unrelated untracked `dist/`, `node_modules/`, caches, and other files are left untouched and are never copied into the installed UI.

## Paired local updater

Run only on the webhook host, as root, from the intended local checkout:

```sh
sudo ./scripts/update-webhook.sh
```

The updater runs Python tests, `npm ci`, `npm test`, and `npm run build`; validates the main UI entry and referenced assets; checks the isolated example output; backs up the installed webhook and current UI-owned paths under `/var/backups/static-deploy-webhook/`; stages UI files on the persistent games filesystem; and replaces only UI-owned top-level paths. It then restarts `static-deploy-webhook.service` and checks service health, `/games/`, registry readability, and at least one registered package manifest when one exists.

If replacement, restart, health, or smoke checks fail, the updater restores both the old webhook and old UI-owned files and restarts the old service. Backups are timestamped and are not automatically pruned. Retention/cleanup is a separate maintenance task. Review the script and confirm the live Caddy group and local smoke-test URLs before execution.

## Production rollout checklist (separate authorization)

1. Inspect live Caddyfile, systemd unit, EnvironmentFile metadata, service user/groups, webhook path, storage ownership/ACLs, registry, and package inventory.
2. Back up webhook, Caddy/service configuration, EnvironmentFile metadata, registry, UI files, and package storage (or take a consistent filesystem snapshot).
3. Confirm updater assumptions (Caddy group, modes, URLs, service ExecStart) match production; set `CADDY_GROUP` only when appropriate, and resolve any permission mismatch before proceeding.
4. Run the paired updater locally on the webhook host.
5. Run `caddy validate` against the complete production Caddyfile; reload only after validation succeeds.
6. Verify `/health`, `/games/`, referenced UI assets, `/_games/registry.json`, and at least one existing package manifest/entry.
7. Verify `POST /_deploy` returns 404. Exercise `POST /_deploy/game` only with a disposable valid package and verify duplicate ID/version returns 409; do not overwrite or delete real package data.
8. Record deployed commit, backup path, service/Caddy status, smoke-test results, and rollback procedure.

No production restart, Caddy reload, Git push, or remote deployment is authorized merely by this repository plan.
