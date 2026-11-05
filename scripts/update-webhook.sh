#!/usr/bin/env bash
# Locally install the webhook and its matching game-library UI as one rollback unit.
set -Eeuo pipefail
umask 027

SERVICE='static-deploy-webhook.service'
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SOURCE="$SOURCE_DIR/webhook.py"
DEST_DIR='/usr/local/libexec/static-deploy'
DEST="$DEST_DIR/webhook.py"
ROOT='/var/lib/static-deploy'
GAMES_ROOT="$ROOT/games"
UI_MARKER="$ROOT/.game-library-ui-owned"
BACKUP_DIR='/var/backups/static-deploy-webhook'
HEALTH_URL="${WEBHOOK_HEALTH_URL:-http://127.0.0.1:8765/health}"
LIBRARY_URL='https://bombless.duckdns.org/games/'
REGISTRY_URL='https://bombless.duckdns.org/_games/registry.json'
CADDY_GROUP_OVERRIDE="${CADDY_GROUP:-}"
export no_proxy="127.0.0.1,localhost,bombless.duckdns.org${no_proxy:+,}${no_proxy:-}"
export NO_PROXY="127.0.0.1,localhost,bombless.duckdns.org${NO_PROXY:+,}${NO_PROXY:-}"

log() { printf '[update-webhook] %s\n' "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die 'run with sudo: sudo ./scripts/update-webhook.sh'
[[ -f "$SOURCE" && ! -L "$SOURCE" ]] || die "missing regular source file: $SOURCE"
command -v systemctl >/dev/null 2>&1 || die 'systemctl is required'
command -v python3 >/dev/null 2>&1 || die 'python3 is required'
command -v node >/dev/null 2>&1 || die 'node is required'
command -v npm >/dev/null 2>&1 || die 'npm is required'
command -v curl >/dev/null 2>&1 || die 'curl is required for smoke checks'
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" == '22' ]] || die "Node.js 22 is required by package.json (found $(node --version))"

cd "$SOURCE_DIR"
branch="$(git branch --show-current)"
[[ "$branch" == 'main' ]] || die "checkout must be on main (currently: ${branch:-detached HEAD})"
if ! git diff --quiet || ! git diff --cached --quiet; then
  die 'tracked working-tree changes exist; commit them before updating'
fi
git ls-files --error-unmatch package-lock.json >/dev/null 2>&1 || die 'package-lock.json must be committed/tracked before updater use'
commit="$(git rev-parse --short=12 HEAD)"

unit="$(systemctl cat "$SERVICE" 2>/dev/null)" || die "$SERVICE is not installed"
grep -Fq 'ExecStart=/usr/bin/python3 /usr/local/libexec/static-deploy/webhook.py' <<<"$unit" || die "$SERVICE ExecStart does not match the expected webhook path"
webhook_user="$(systemctl show "$SERVICE" -p User --value)"
webhook_group="$(systemctl show "$SERVICE" -p Group --value)"
webhook_supplementary="$(systemctl show "$SERVICE" -p SupplementaryGroups --value)"
log "webhook identity: user=${webhook_user:-root} group=${webhook_group:-default} supplementary=${webhook_supplementary:-none}"
caddy_unit="$(systemctl cat caddy.service 2>/dev/null)" || die 'caddy.service is not installed; verify the live Caddy identity manually'
caddy_user="$(systemctl show caddy.service -p User --value)"
caddy_group="$(systemctl show caddy.service -p Group --value)"
[[ -n "$caddy_user" ]] || caddy_user='root'
if [[ -n "$CADDY_GROUP_OVERRIDE" ]]; then
  caddy_group="$CADDY_GROUP_OVERRIDE"
elif [[ -z "$caddy_group" ]]; then
  caddy_group="$(id -gn "$caddy_user")"
fi
getent group "$caddy_group" >/dev/null || die "Caddy group does not exist: $caddy_group (set CADDY_GROUP if needed)"
log "Caddy identity: user=$caddy_user group=$caddy_group"
[[ -d "$DEST_DIR" && -d "$GAMES_ROOT" ]] || die 'webhook destination and persistent games root must already exist'
[[ -f "$DEST" && ! -L "$DEST" ]] || die "installed webhook is not a regular file: $DEST"
if [[ -e "$UI_MARKER" ]]; then
  [[ -f "$UI_MARKER" && ! -L "$UI_MARKER" ]] || die 'UI ownership marker is not a regular file'
  grep -Fxq 'static-deploy-game-library-ui-v1' "$UI_MARKER" || die 'unrecognized UI ownership marker'
else
  for name in index.html runner.html assets wasm; do
    [[ ! -e "$GAMES_ROOT/$name" ]] || die "unowned path collides with UI destination: $GAMES_ROOT/$name; inspect it before rollout"
  done
fi
[[ "$(stat -c '%G' "$GAMES_ROOT")" == "$caddy_group" ]] || die "games root group does not match Caddy group $caddy_group; inspect ownership/ACLs before updating"
if [[ "$caddy_user" != 'root' ]]; then
  command -v runuser >/dev/null 2>&1 || die 'runuser is required to verify Caddy read access'
  runuser -u "$caddy_user" -- test -r "$GAMES_ROOT/registry.json" || die 'Caddy cannot read games/registry.json'
  runuser -u "$caddy_user" -- test -x "$GAMES_ROOT" || die 'Caddy cannot traverse the games root'
fi
systemctl is-active --quiet "$SERVICE" || die "$SERVICE is not active; inspect it before updating"

# Build from the committed tree in an isolated temporary checkout. This keeps
# unrelated untracked dist/, node_modules/, caches, and other artifacts intact.
build_workspace="$(mktemp -d "${TMPDIR:-/var/tmp}/static-deploy-build.XXXXXX")"
trap 'rm -rf -- "$build_workspace"' EXIT
git archive HEAD | tar -x -C "$build_workspace"
cd "$build_workspace"
log "running Python tests and frontend checks for committed release $commit"
python3 -m unittest discover -s tests -v
npm ci
npm test
npm run build
cd "$SOURCE_DIR"

BUILD="$build_workspace/dist"
[[ -s "$BUILD/index.html" && -d "$BUILD/assets" ]] || die 'build must contain index.html and assets/'
# Verify every local script/stylesheet URL in the built entry point resolves.
python3 - "$BUILD" <<'PY'
from html.parser import HTMLParser
from pathlib import Path
import sys
root = Path(sys.argv[1]).resolve()
class Assets(HTMLParser):
    refs = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        for key in ('src', 'href'):
            value = attrs.get(key, '')
            if value and not value.startswith(('http:', 'https:', '//', 'data:', '#')):
                self.refs.append(value.split('?', 1)[0].split('#', 1)[0])
p = Assets(); p.feed((root / 'index.html').read_text(encoding='utf-8'))
if (root / 'runner.html').is_file():
    p.feed((root / 'runner.html').read_text(encoding='utf-8'))
missing = [ref for ref in p.refs if not (root / ref).is_file()]
if missing:
    raise SystemExit('missing built UI assets: ' + ', '.join(missing))
PY

# The example package build is an artifact for the package-publishing workflow,
# not UI content; it must never be copied into the shared /games document root.
[[ -d "$BUILD/_build" ]] || die 'expected isolated _build example output is missing'

install -d -o root -g root -m 0700 "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$BACKUP_DIR/$stamp.$commit"
mkdir -m 0700 "$backup"
cp -a -- "$DEST" "$backup/webhook.py"
mkdir -m 0700 "$backup/ui"
for name in index.html runner.html assets wasm; do
  if [[ -e "$GAMES_ROOT/$name" ]]; then
    [[ ! -L "$GAMES_ROOT/$name" ]] || die "refusing symlink UI path: $GAMES_ROOT/$name"
    cp -a -- "$GAMES_ROOT/$name" "$backup/ui/$name"
    : > "$backup/ui/$name.present"
  fi
done

# Stage UI content on the same filesystem as the live document root.
stage="$(mktemp -d "$GAMES_ROOT/.ui-stage.XXXXXX")"
marker_tmp=''
changed=0
cleanup() { [[ -z "$stage" ]] || rm -rf -- "$stage"; [[ -z "$marker_tmp" ]] || rm -f -- "$marker_tmp"; [[ -z "$build_workspace" ]] || rm -rf -- "$build_workspace"; }
rollback() {
  status=$?
  if [[ "$changed" -eq 1 ]]; then
    log 'update failed; restoring webhook and UI together'
    restore_webhook="$(mktemp "$DEST_DIR/.webhook.rollback.XXXXXX")" || true
    if [[ -n "$restore_webhook" ]] && install -o root -g root -m 0755 "$backup/webhook.py" "$restore_webhook" && mv -f -- "$restore_webhook" "$DEST"; then
      :
    else
      log "CRITICAL: webhook restore failed; backup: $backup/webhook.py"
    fi
    for name in index.html runner.html assets wasm; do
      rm -rf -- "$GAMES_ROOT/$name"
      if [[ -e "$backup/ui/$name.present" ]]; then
        cp -a -- "$backup/ui/$name" "$GAMES_ROOT/$name"
      fi
    done
    systemctl restart "$SERVICE" || true
    healthy_rollback=0
    for attempt in $(seq 1 10); do
      if systemctl is-active --quiet "$SERVICE" && curl --fail --silent --show-error --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
        healthy_rollback=1
        break
      fi
      sleep 1
    done
    if [[ "$healthy_rollback" -eq 1 ]]; then
      log 'previous webhook restored and healthy; previous UI files restored'
    else
      log "CRITICAL: rollback restart/health failed; inspect service; backup: $backup"
    fi
  fi
  cleanup
  exit "$status"
}
trap rollback EXIT

install -o root -g "$caddy_group" -m 0640 "$BUILD/index.html" "$stage/index.html"
if [[ -f "$BUILD/runner.html" ]]; then
  install -o root -g "$caddy_group" -m 0640 "$BUILD/runner.html" "$stage/runner.html"
fi
cp -a -- "$BUILD/assets" "$stage/assets"
if [[ -d "$BUILD/wasm" ]]; then cp -a -- "$BUILD/wasm" "$stage/wasm"; fi
chown -R "root:$caddy_group" "$stage"
find "$stage" -type d -exec chmod 2750 {} +
find "$stage" -type f -exec chmod 0640 {} +

# Verify registry and all existing package paths before touching either component.
registry_before="$GAMES_ROOT/registry.json"
[[ -f "$registry_before" ]] || die 'games/registry.json is missing; refusing update'
python3 - "$GAMES_ROOT" "$backup/storage-before.sha256" <<'PY'
import hashlib, json, pathlib, sys
root, output = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
registry = json.loads((root / 'registry.json').read_text(encoding='utf-8'))
if registry.get('registryVersion') != 1 or not isinstance(registry.get('games'), list):
    raise SystemExit('invalid game registry')
reserved = {'assets', 'wasm'}
lines = []
for game in registry['games']:
    gid = game.get('id')
    if not isinstance(gid, str) or gid in reserved or not (root / gid).is_dir():
        raise SystemExit(f'missing, colliding, or invalid registered game directory: {gid!r}')
for path in sorted(p for p in root.rglob('*') if p.is_file() and
                   p.relative_to(root).parts[0] not in {'index.html', 'runner.html', 'assets', 'wasm'} and
                   not p.relative_to(root).parts[0].startswith(('.ui-stage.', '.staging-'))):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    lines.append(f'{digest}  {path.relative_to(root).as_posix()}')
output.write_text('\n'.join(lines) + '\n', encoding='utf-8')
PY

# Backup old webhook and UI is complete; replace each UI-owned path, leaving
# registry.json and all package-ID directories untouched.
changed=1
new_webhook="$(mktemp "$DEST_DIR/.webhook.new.XXXXXX")"
install -o root -g root -m 0755 "$SOURCE" "$new_webhook"
mv -f -- "$new_webhook" "$DEST"
# File replacement is a same-filesystem atomic rename. Non-empty directories
# are moved aside on that filesystem before the staged directory is renamed in.
for name in assets wasm; do
  if [[ -e "$GAMES_ROOT/$name" ]]; then mv -- "$GAMES_ROOT/$name" "$stage/.previous-$name"; fi
  if [[ -e "$stage/$name" ]]; then mv -- "$stage/$name" "$GAMES_ROOT/$name"; fi
done
# Publish the new entry point last, after every referenced asset directory exists.
if [[ -f "$stage/runner.html" ]]; then
  mv -f -- "$stage/runner.html" "$GAMES_ROOT/runner.html"
  chown "root:$caddy_group" "$GAMES_ROOT/runner.html"
  chmod 0640 "$GAMES_ROOT/runner.html"
fi
mv -f -- "$stage/index.html" "$GAMES_ROOT/index.html"
chown "root:$caddy_group" "$GAMES_ROOT/index.html"
chmod 0640 "$GAMES_ROOT/index.html"

log "installed paired webhook/UI commit $commit; restarting $SERVICE"
systemctl restart "$SERVICE"
healthy=0
for attempt in $(seq 1 15); do
  if systemctl is-active --quiet "$SERVICE" && curl --fail --silent --show-error --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
[[ "$healthy" -eq 1 ]] || { systemctl status "$SERVICE" --no-pager -l || true; die "service health failed at $HEALTH_URL"; }
curl --fail --silent --show-error --max-time 10 "$LIBRARY_URL" | grep -qi '<html' || die "UI smoke check failed at $LIBRARY_URL"
curl --fail --silent --show-error --max-time 10 "$REGISTRY_URL" -o "$stage/registry-smoke.json"
# The update must not alter the registry or any package file, even by accident.
python3 - "$GAMES_ROOT" "$backup/storage-before.sha256" <<'PY'
import hashlib, pathlib, sys
root, baseline = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
expected = baseline.read_text(encoding='utf-8').splitlines()
actual = []
for path in sorted(p for p in root.rglob('*') if p.is_file() and
                   p.relative_to(root).parts[0] not in {'index.html', 'runner.html', 'assets', 'wasm'} and
                   not p.relative_to(root).parts[0].startswith(('.ui-stage.', '.staging-'))):
    actual.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(root).as_posix()}")
if actual != expected: raise SystemExit('registry/package data changed during UI update')
PY
package_manifest_path="$(python3 - "$stage/registry-smoke.json" <<'PY'
import json, pathlib, sys
registry = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
for game in registry.get('games', []):
    versions = game.get('versions') or []
    if versions:
        latest = versions[-1]['version']
        print(f"/games/{game['id']}/{latest}/manifest.json")
        break
PY
)"
if [[ -n "$package_manifest_path" ]]; then
  package_manifest_url="$(python3 - "$REGISTRY_URL" "$package_manifest_path" <<'PY'
from urllib.parse import urljoin
import sys
print(urljoin(sys.argv[1], sys.argv[2]))
PY
)"
  curl --fail --silent --show-error --max-time 10 "$package_manifest_url" -o "$stage/package-manifest-smoke.json"
  package_entry="$(python3 - "$stage/package-manifest-smoke.json" <<'PY'
import json, pathlib, sys
manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
print(manifest['entry'])
PY
)"
  package_entry_url="$(python3 - "$package_manifest_url" "$package_entry" <<'PY'
from urllib.parse import urljoin
import sys
print(urljoin(sys.argv[1], sys.argv[2]))
PY
)"
  curl --fail --silent --show-error --max-time 10 "$package_entry_url" -o /dev/null
fi

if [[ ! -e "$UI_MARKER" ]]; then
  marker_tmp="$(mktemp "$ROOT/.game-library-ui-owned.XXXXXX")"
  printf '%s\n' 'static-deploy-game-library-ui-v1' > "$marker_tmp"
  chown root:root "$marker_tmp"
  chmod 0600 "$marker_tmp"
  mv -f -- "$marker_tmp" "$UI_MARKER"
  marker_tmp=''
fi
changed=0
trap - EXIT
cleanup
log "success: paired update $commit is active and smoke checks passed"
log "backup: $backup"
