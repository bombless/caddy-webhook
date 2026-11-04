# Production webhook migration handoff

This document is for the separate agent that will update the already deployed webhook service. Repository changes alone do not alter the production server.

## 1. Intended API contract

The source of truth is `webhook.py`.

| Method | Path | Authentication | Semantics |
| --- | --- | --- | --- |
| GET | `/health` | none | Process health |
| POST | `/_deploy` | Bearer token | Whole-site ZIP; root `index.html` required; publish release and atomically switch `current` |
| POST | `/_deploy/game` | Bearer token | One game-package ZIP; root `manifest.json` required; immutable ID/version install; does not touch `current` |
| GET | `/_games/registry.json` | none | Public registry schema v1 |

Both POST endpoints require `Content-Type: application/zip`. Responses use JSON. A duplicate game ID/version returns HTTP 409 with `{"error":"version_conflict"}`; invalid packages return 400; missing/incorrect token returns 401; upload size/type errors return 413/415.

## 2. Storage and permissions

Expected layout:

```text
/var/lib/static-deploy/
  tmp/
  releases/
    <site-release>/
  current -> releases/<active-release>
  games/
    registry.json
    <game-id>/<semver>/
      manifest.json
      <declared entry>
      assets/...
```

The webhook service account must be able to create and rename files/directories in `tmp/`, `releases/`, and `games/`. Caddy needs read and directory-traverse permissions for `games/` and the active site release. Preserve the existing ownership model, group access, setgid directory policy, and restrictive umask when provisioning the new `games/` tree. The current systemd unit restricts writes to `/var/lib/static-deploy`; verify the deployed unit still has this allowance.

Do not place games inside `releases/` or `current`. Site deployment and rollback must leave `games/` and its URLs unchanged.

## 3. Registry and package URLs

Canonical registry URL: `/_games/registry.json`.

Registry schema:
- `registryVersion: 1`
- `games`: sorted by `id`
- Each game has `id`, `name`, `pluginType`, `latestVersion`, `manifestUrl`, and `versions`
- Each version has `version` and `manifestUrl`; versions are sorted by SemVer precedence
- Package root URL: `/games/{id}/{version}/`
- Manifest URL: `/games/{id}/{version}/manifest.json`

The registry must only be replaced after the immutable package directory has been installed. The implementation serializes read/modify/write registry operations with a process-wide lock and writes the registry through a same-directory temporary file plus atomic replacement. A crash after package installation but before registry replacement can leave an unlisted orphan directory; it must not create a broken registry reference.

## 4. Caddy routing

Merge the handlers from `Caddyfile.example` into the real production site block, not by blindly replacing the deployed Caddyfile:

- `/_deploy*` reverse-proxies to `127.0.0.1:8765`
- `/_games/registry.json` serves `/var/lib/static-deploy/games/registry.json`
- `/games/*` strips the URL prefix and serves from `/var/lib/static-deploy/games/`
- `/app/*` continues serving from `/var/lib/static-deploy/current`
- Game-package CORS headers are scoped to `/games/*`; WASM files use `application/wasm`

Check for existing `handle`, `handle_path`, `route`, `reverse_proxy`, or catch-all handlers that could capture these paths. Preserve the existing reverse-proxy fallback. Run `caddy validate` against the actual config before reload.

## 5. Environment and service

The webhook continues using `DEPLOY_TOKEN` from the existing systemd EnvironmentFile. `DEPLOY_ROOT` is optional and defaults to `/var/lib/static-deploy`. No new production secret is required for the game endpoint; GitHub Actions uses `DEPLOY_TOKEN` and a repository secret `GAME_DEPLOY_WEBHOOK_URL` whose value ends in `/_deploy/game`.

Review the live unit and EnvironmentFile before deployment. Do not expose token values in logs, command output, shell history, or handoff notes. Keep the service bound to loopback unless the production network design explicitly requires otherwise.

## 6. Backup, migration, and rollout

1. Inspect the live webhook source/version, service unit, EnvironmentFile metadata, Caddyfile, directory ownership, and current release symlink.
2. Back up the webhook, unit, Caddy configuration, and the entire `/var/lib/static-deploy` tree (or a consistent filesystem snapshot).
3. Create `games/` with ownership/mode compatible with the webhook service and Caddy.
4. Install the repository's `webhook.py` into the deployed location without modifying existing releases or the `current` symlink.
5. Merge and validate Caddy routes. Ensure registry/package paths are not shadowed by broader site handlers.
6. Restart the webhook service and reload Caddy only after validation.
7. Check health and registry reads; publish a disposable test package; fetch its manifest and entry through Caddy.
8. Verify a full-site deployment still changes only `current`; verify switching `current` back to an earlier release leaves the game package and registry intact.
9. Record exact deployed commit, service status, Caddy validation output, API checks, and rollback procedure.

No automatic migration of old whole-site game content is performed. If a currently deployed site contains game directories under its release, decide explicitly whether any of those files should become registered immutable packages. Do not infer IDs or versions from directory names without validating package manifests.

## 7. Verification commands

Run repository tests before rollout:

```sh
python3 -m unittest discover -s tests -v
npm test
npm run build
```

Production smoke checks (replace the host and token using a secure secret source):

```sh
curl -fsS https://HOST/health
curl -fsS https://HOST/_games/registry.json
```

Then publish a valid test package via `POST /_deploy/game` with the bearer token and ZIP content type, confirm the response contains its `packageUrl`, and fetch the returned manifest and entry. Repeat the same ID/version and expect 409. Publish a new version and confirm both versions remain listed. Do not use a real production game for destructive tests.

## 8. Known differences and items to reconcile

- The repository's `Caddyfile.example` is a route fragment, not a complete production Caddyfile. The deployed Caddy configuration must be inspected directly.
- The webhook defaults to `/var/lib/static-deploy` and loopback port 8765. Confirm the live service uses the same root, port, and environment-file conventions.
- The service unit in the repository writes under `/var/lib/static-deploy`; confirm the production unit's sandbox and directory permissions allow `games/`.
- The repository contains Vue 3 and WASM browser runtimes, but package-import validation does not execute or certify untrusted game code. Keep capability grants deny-by-default and retain the iframe/Worker isolation model.
- Existing game files already deployed inside a site release are not automatically migrated into the persistent library.
- The implementation uses a process-local lock. This is correct for the current single webhook process. If production runs multiple webhook processes/instances against the same storage, replace it with a cross-process lock before enabling concurrent package imports.
