# Caddy Static Deployment Webhook

A small authenticated webhook that accepts a ZIP archive of a static frontend build and atomically switches the active release served by Caddy.

## Layout on the server

- Webhook: `/usr/local/libexec/static-deploy/webhook.py`
- Environment: `/etc/static-deploy/webhook.env` (keep private; never commit the token)
- Releases: `/var/lib/static-deploy/releases/`
- Active release: `/var/lib/static-deploy/current`
- systemd unit: `static-deploy-webhook.service`

## API

- `GET /health` — health check
- `POST /_deploy` — upload an `application/zip` archive with `Authorization: Bearer $DEPLOY_TOKEN`

The archive must contain `index.html` at its root. Limits: 100 MiB upload, 500 MiB expanded content, 10,000 entries. ZIP paths are checked against traversal and symlinks are rejected. The active symlink is switched atomically after extraction.

## Caddy routing

See `Caddyfile.example`. It proxies `/_deploy` to `127.0.0.1:8765` and serves `/app/*` from `/var/lib/static-deploy/current` while preserving the existing application proxy for other paths.

## Install

1. Create a dedicated `deployhook` system user and the directories under `/var/lib/static-deploy`.
2. Install `webhook.py` at `/usr/local/libexec/static-deploy/webhook.py`.
3. Install `static-deploy-webhook.service` under `/etc/systemd/system/`.
4. Create `/etc/static-deploy/webhook.env` with a freshly generated random `DEPLOY_TOKEN`, owned by `root:deployhook`, mode `0640`. Never put the token in this repository.
5. Run `systemctl daemon-reload` and `systemctl enable --now static-deploy-webhook`.
6. Validate and reload Caddy after merging the example routes into the existing site block.
7. Add a GitHub Actions repository secret named `DEPLOY_TOKEN` before enabling the workflow.

## GitHub Actions

`.github/workflows/deploy.yml` builds the frontend, packages the `dist/` directory, and posts it to the webhook. Adjust the build commands and output directory to match your frontend framework.
