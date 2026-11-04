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
7. Add GitHub Actions secrets `DEPLOY_WEBHOOK_URL` and `DEPLOY_TOKEN` to each caller repository.

## Reusable GitHub Actions workflow

This repository is the source of truth for static-site deployment automation. Consumers should call `.github/workflows/deploy-static.yml` at a stable version tag, not copy the implementation into their own repositories.

Example caller job:

```yaml
name: Build and deploy
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  deploy:
    uses: bombless/caddy-webhook/.github/workflows/deploy-static.yml@v1
    with:
      output_dir: "."
    secrets:
      DEPLOY_WEBHOOK_URL: ${{ secrets.DEPLOY_WEBHOOK_URL }}
      DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
```

For a Node project, pass `build_command: npm ci && npm run build` and `output_dir: dist`. For a plain HTML/CSS/JS project, use `output_dir: "."`. The output directory must contain `index.html` at its root. The reusable workflow packages the output and performs one real authenticated upload; it does not send an empty POST probe.

### Workflow contract

- Inputs: `output_dir` (required), `build_command` (optional), `node_version` (optional, defaults to 22).
- Secrets: `DEPLOY_WEBHOOK_URL` and `DEPLOY_TOKEN` (both required).
- Endpoint: full HTTPS URL including the webhook path, normally `https://<host>/_deploy`.
- The token is sent only in the Authorization bearer header and is masked in logs.
- HTTP responses and curl connection/TLS failures are diagnosed separately.
- Do not add a preflight POST with an empty request body. Use `GET /health` only for a dedicated health check.

## Troubleshooting

- curl exit 5/6: proxy or DNS resolution problem.
- curl exit 7: TCP connection refused/unavailable.
- curl exit 28: connection or upload timeout.
- curl exit 35: TLS handshake failure.
- curl exit 51/60: TLS certificate verification failure. Do not disable certificate verification.
- HTTP 400: invalid ZIP archive.
- HTTP 401: bearer token mismatch.
- HTTP 413: upload size outside the configured limit.
- HTTP 415: wrong content type.
- HTTP 500: unexpected server-side deployment failure; inspect the server journal.

Never commit deployment tokens, private keys, or server environment files.
