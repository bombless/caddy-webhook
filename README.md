# Caddy Static Deployment Webhook and Game Library

This repository contains the authenticated Python deployment webhook, Caddy routing examples, a Vue 3 game host/runtime, and a constrained WebAssembly game runtime.

## Deployment model

There are two independent publication flows:

- **Whole-site release:** `POST /_deploy` accepts a ZIP containing a root `index.html`, publishes it under `/var/lib/static-deploy/releases/`, and atomically switches `/var/lib/static-deploy/current`. This remains the platform-shell deployment and retains rollback semantics.
- **Game package:** `POST /_deploy/game` accepts exactly one package ZIP with a root `manifest.json`. It installs an immutable `id/version` directory under `/var/lib/static-deploy/games/` and atomically updates the public registry. It never changes `current` and never deletes earlier games or versions.

Do not point a whole-site ZIP at the game endpoint or change `/_deploy` into a merge operation.

## Webhook API

All POST requests require `Authorization: Bearer $DEPLOY_TOKEN` and `Content-Type: application/zip`.

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Process health check |
| `POST /_deploy` | Publish a complete site release |
| `POST /_deploy/game` | Publish one immutable game package |
| `GET /_games/registry.json` | Public game registry |

Uploads are limited to 100 MiB, 10,000 ZIP entries, and 500 MiB expanded content. ZIP paths are checked for traversal, duplicate/conflicting paths, special files and symlinks. Game manifests are parsed as strict UTF-8 JSON; duplicate JSON keys, unsupported manifest versions, invalid IDs, non-semver versions, unsafe entry paths, unsupported plugin types, and missing entries are rejected.

The game ID format is `[a-z0-9][a-z0-9-]{0,63}`. Versions use semantic version syntax. A published `id/version` is immutable: repeating it returns HTTP 409. A newer semantic version is added alongside previous versions and becomes latest according to SemVer precedence (build metadata does not affect ordering).

## Persistent storage layout

```text
/var/lib/static-deploy/
  current -> releases/<active-release>
  releases/
    <site-release>/
  tmp/
  games/
    registry.json
    <game-id>/
      <version>/
        manifest.json
        index.html or game.wasm
        assets/...
```

Game packages must remain outside `releases/` and outside `current`. The webhook process needs write access to `tmp/`, `releases/`, and `games/`; Caddy needs read/traverse access to the published files. A package directory may be left orphaned if the process crashes after its atomic installation but before the registry replacement. Such a directory is intentionally not advertised; reconcile it manually after verifying its manifest and contents.

## Package contract

Vue 3 and WASM use the same outer manifest fields: `manifestVersion`, `id`, `name`, `version`, `pluginType`, `entry`, and `runtime`.

- Vue 3 packages declare `pluginType: "vue3"`, `entry: "index.html"`, `runtime.apiVersion: "1"`, a display object, and a capabilities array.
- WASM packages declare `pluginType: "wasm"`, a package-relative `.wasm` entry, display width/height, capabilities, and the ABI v1 declaration documented in `wasm/schema/manifest.schema.json`.

Capabilities are requests, not grants. The WASM host currently defaults to deny-all and only implements keyboard/pointer grants. See [Vue 3 runtime documentation](docs/vue3-plugin-runtime.md), [Vue 3 design](docs/design/vue3-plugin.md), and [WASM runtime documentation](wasm/README.md).

A successful package deployment returns its immutable package URL and canonical registry URL. Registry schema version 1 contains games sorted by ID and each game's versions sorted by SemVer precedence. Each version points to its own manifest URL.

## Caddy routing

Merge [Caddyfile.example](Caddyfile.example) into the actual site block, preserving the existing application reverse-proxy fallback. It routes the webhook control plane, registry, persistent `/games/*` package files, and replaceable `/app/*` site release separately. Static WASM assets are served with `application/wasm`. Game package CORS headers are scoped to `/games/*`; do not apply wildcard CORS to the webhook or platform shell.

The Caddy example is repository guidance only. It does not update a running Caddy instance. Validate the real Caddyfile before reloading the server.

## GitHub Actions

- `.github/workflows/deploy.yml` builds/tests and publishes the platform shell to GitHub Pages only from `main`.
- `.github/workflows/deploy-site.yml` is the whole-site webhook publisher targeting `POST /_deploy` with `DEPLOY_WEBHOOK_URL` and `DEPLOY_TOKEN` secrets.
- `.github/workflows/publish-game.yml` is a manual package-publication workflow. It builds the Vue example package (or accepts a package directory), creates a ZIP with `manifest.json` at its root, and posts it to `/_deploy/game`.
- The reusable whole-site deployment workflow remains available at `.github/workflows/deploy-static.yml`; its caller must continue to target `/_deploy`.

Configure `GAME_DEPLOY_WEBHOOK_URL` and `DEPLOY_TOKEN` as GitHub Actions secrets before running the package publication workflow. The URL secret must end in `/_deploy/game`. Never print or commit the token.

## Local validation

```sh
python3 -m unittest discover -s tests -v
npm test
npm run build
```

## Server-agent handoff boundary

This repository change does **not** install or activate code on the production server. A separate agent must reconcile the deployed service with this source of truth.

That agent must review the live webhook/Caddy/systemd configuration before changing it; create and permission `games/`; deploy the updated webhook; add the registry and package static routes; preserve the existing `current` and `releases/` data; back up configuration and data; validate Caddy; then restart/reload services in a controlled window. It must verify `GET /_games/registry.json`, upload a test game, confirm the package is served, and confirm a whole-site deployment/rollback leaves the library untouched. Do not assume the production server matches this repository's example configuration.
