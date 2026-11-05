# Bombless Game Platform

The game-library UI is served at `/games/` and is installed together with the Python webhook by the local root-only `scripts/update-webhook.sh` updater. It is not independently published and there is no a separate UI upload endpoint endpoint or UI deployment workflow.

Immutable game packages are published independently through authenticated `POST /_deploy/game`. Each package is installed under `/var/lib/static-deploy/games/<game-id>/<version>/`; publishing a package updates `/var/lib/static-deploy/games/registry.json` without replacing the UI or any earlier package. The public registry is `/_games/registry.json`.

The legacy whole-site `POST /_deploy` endpoint is disabled and returns 404. Do not re-enable it: a general site deployment must not be able to replace the game UI or package store.

## HTTP API

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/health` | Webhook process health |
| POST | `/_deploy` | Disabled; returns 404 |
| POST | `/_deploy/game` | Authenticated immutable game-package ZIP publishing |
| GET | `/_games/registry.json` | Public game registry |
| GET | `/games/` | Game-library UI installed by the local updater |
| GET | `/games/{id}/{version}/...` | Immutable package files |

Game publishing requires `Authorization: Bearer <DEPLOY_TOKEN>` and `Content-Type: application/zip`. Duplicate ID/version returns 409; invalid archives return 400; missing/incorrect token returns 401.

## Storage

```text
/var/lib/static-deploy/
  tmp/                         # webhook upload staging
  games/
    index.html                 # UI, installed with webhook update
    assets/                    # Vite UI assets
    wasm/                      # copied WASM runtime assets
    registry.json              # managed only by game-package publishing
    <game-id>/<version>/       # immutable package namespace
```

The updater owns only the UI top-level paths explicitly listed in `scripts/update-webhook.sh`; `assets` and `wasm` are reserved package IDs to avoid collisions. It must preserve `games/registry.json` and every package directory. A private ownership marker at `/var/lib/static-deploy/.game-library-ui-owned` distinguishes UI-owned paths from pre-existing or orphan package directories; the first install refuses ambiguous collisions. Never use a broad mirror or `rm -rf games/*`. UI output is checked for collisions with package-owned paths before installation.

## Development and CI

Requirements: Python 3.10+ and Node.js 22.

```sh
npm ci
npm test
npm run build
```

`npm test` runs Node tests and Python webhook tests. `npm run build` validates the Vue example, builds the main Vite UI, emits the Vue example under `dist/_build/hello-vue3`, and copies the WASM runtime to `dist/wasm/`.

`.github/workflows/deploy.yml` is CI only: it tests/builds and uploads a build artifact. It does not call a deployment endpoint. Game package publication remains in the dedicated `publish-game.yml` / `publish-snake.yml` workflows and uses `GAME_DEPLOY_WEBHOOK_URL` ending in `/_deploy/game`.

## Local paired updater

On the webhook host, from a clean tracked checkout of `main`, run:

```sh
sudo ./scripts/update-webhook.sh
```

The updater validates the checkout and build, backs up the installed webhook and UI-owned files under `/var/backups/static-deploy-webhook/`, stages both on their destination filesystems, installs them while preserving registry/package data, restarts `static-deploy-webhook.service`, and verifies service health plus `/games/` and registry/package readability. A failed install or smoke check restores both previous components and restarts the previous service. The build runs from a temporary archive of the committed tree, so unrelated untracked `dist/`, `node_modules/`, caches, and other artifacts remain untouched. Untracked files are not treated as release input; the lockfile must be committed/tracked for `npm ci`.

The updater is a local root operation, not a remotely callable API. Backups are timestamped and retained; cleanup/retention is an explicit separate maintenance task.

## Production rollout

Repository edits, CI, and local tests do not update production. Before a production rollout, inspect the live Caddyfile, service unit, EnvironmentFile metadata, service identity/groups, persistent storage inventory, registry, package contents, and permissions. Back up the webhook, Caddy/service configuration, registry, UI files, and package storage (or take a consistent filesystem snapshot). Run the updater locally on the webhook host. Validate the full production Caddyfile before reload. Verify `/health`, `/games/`, built assets, `/_games/registry.json`, at least one existing package manifest/entry, and `POST /_deploy` returning 404. Test `POST /_deploy/game` only with a disposable valid package and confirm duplicate publication returns 409. Do not overwrite/delete real game data.

No production restart, Caddy reload, Git push, or remote deployment is performed by repository changes alone.
