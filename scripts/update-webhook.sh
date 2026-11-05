#!/usr/bin/env bash
# Install this checkout's webhook.py into the local systemd service with rollback.
set -Eeuo pipefail

SERVICE='static-deploy-webhook.service'
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SOURCE="$SOURCE_DIR/webhook.py"
DEST_DIR='/usr/local/libexec/static-deploy'
DEST="$DEST_DIR/webhook.py"
BACKUP_DIR='/var/backups/static-deploy-webhook'
HEALTH_URL="${WEBHOOK_HEALTH_URL:-http://127.0.0.1:8765/health}"

log() { printf '[update-webhook] %s\n' "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die 'run with sudo: sudo ./scripts/update-webhook.sh'
[[ -f "$SOURCE" && ! -L "$SOURCE" ]] || die "missing regular source file: $SOURCE"
command -v systemctl >/dev/null 2>&1 || die 'systemctl is required'
command -v python3 >/dev/null 2>&1 || die 'python3 is required'
command -v curl >/dev/null 2>&1 || die 'curl is required for the health check'

cd "$SOURCE_DIR"
branch="$(git branch --show-current)"
[[ "$branch" == 'main' ]] || die "checkout must be on main (currently: ${branch:-detached HEAD})"
if ! git diff --quiet || ! git diff --cached --quiet; then
  die 'tracked working-tree changes exist; commit or stash them before updating'
fi
commit="$(git rev-parse --short=12 HEAD)"

# Refuse to silently replace a differently configured service.
unit="$(systemctl cat "$SERVICE" 2>/dev/null)" || die "$SERVICE is not installed"
grep -Fq 'ExecStart=/usr/bin/python3 /usr/local/libexec/static-deploy/webhook.py' <<<"$unit" || \
  die "$SERVICE ExecStart does not match the expected webhook path"
[[ -d "$DEST_DIR" ]] || die "destination directory does not exist: $DEST_DIR"
[[ -f "$DEST" && ! -L "$DEST" ]] || die "existing installed webhook is not a regular file: $DEST"
systemctl is-active --quiet "$SERVICE" || die "$SERVICE is not active; inspect it before updating"

log "running webhook unit tests for commit $commit"
python3 -m unittest discover -s tests -v

install -d -o root -g root -m 0700 "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$(mktemp "$BACKUP_DIR/webhook.py.$stamp.$commit.XXXXXX")"
cp -a -- "$DEST" "$backup"
chmod 0600 "$backup"

changed=0
rollback() {
  status=$?
  if [[ "$changed" -eq 1 ]]; then
    log 'update failed; restoring the previous webhook'
    restore_tmp="$(mktemp "$DEST_DIR/.webhook.py.rollback.XXXXXX")" || return
    if install -o root -g root -m 0755 "$backup" "$restore_tmp" && mv -f -- "$restore_tmp" "$DEST"; then
      systemctl restart "$SERVICE" || log 'WARNING: rollback service restart failed'
      if curl --fail --silent --show-error --max-time 3 "$HEALTH_URL" >/dev/null; then
        log 'previous webhook restored and healthy'
      else
        log 'WARNING: previous webhook was restored but health check did not pass'
      fi
    else
      rm -f -- "$restore_tmp"
      log "CRITICAL: could not restore backup; backup remains at $backup"
    fi
  fi
  exit "$status"
}
trap rollback EXIT

new_tmp="$(mktemp "$DEST_DIR/.webhook.py.new.XXXXXX")"
install -o root -g root -m 0755 "$SOURCE" "$new_tmp"
mv -f -- "$new_tmp" "$DEST"
changed=1
log "installed commit $commit; restarting $SERVICE"
systemctl restart "$SERVICE"

healthy=0
for attempt in $(seq 1 15); do
  if curl --fail --silent --show-error --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" -ne 1 ]]; then
  systemctl status "$SERVICE" --no-pager -l || true
  die "health check failed at $HEALTH_URL"
fi
systemctl is-active --quiet "$SERVICE" || die "$SERVICE is not active after restart"
changed=0
trap - EXIT
log "success: $SERVICE is active and $HEALTH_URL is healthy"
log "backup: $backup"
