#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077

# The deployment identity may publish only this application's bounded declaration.
# All validation and atomic publication logic belongs to ServerPortal/server-operations.
if [[ $EUID -eq 0 && $# -eq 3 && ( $1 == portal || $1 == portal-check ) && $2 =~ ^[0-9a-f]{40}$ && $3 =~ ^[0-9a-f]{64}$ ]]; then
  portal_action=register
  if [[ $1 == portal-check ]]; then portal_action=check-registration; fi
  exec timeout 45 /opt/serverportal/bin/portal "$portal_action" --app aura --commit "$2" --sha256 "$3"
fi

if [[ $EUID -ne 0 || $# -ne 2 || ! $1 =~ ^[0-9a-f]{40}$ || ! $2 =~ ^[0-9a-f]{64}$ ]]; then echo 'Usage: deploy-release.sh <commit> <sha256> < binary' >&2; exit 64; fi
commit=$1
expected=$2
app=/opt/aura
nas=false
upgrade=/opt/server-context/scripts/upgrade-state.py
if [[ -r /etc/server-maintenance-host && $(< /etc/server-maintenance-host) == nas ]]; then
  nas=true
  test -f "$upgrade"
  exec 8>/run/lock/server-maintenance.lock
  flock -s -n 8 || { printf 'A full backup or maintenance operation is running.\n' >&2; exit 75; }
fi
exec 9>/run/lock/aura-deploy.lock
flock -n 9 || { echo 'Another release is running.' >&2; exit 75; }
test -f "$app/data/aura.sqlite"
test -x "$app/bin/aura"
release=$(mktemp -d "$app/releases/$commit.XXXXXX")
chmod 0755 "$release"
stopped=false
replaced=false
healthy() {
  systemctl is-active --quiet aura &&
    curl --fail --silent --max-time 3 http://127.0.0.1:18087/healthz | grep -q '"status":"ok"' &&
    curl --fail --silent --max-time 3 http://127.0.0.1/aura/ | grep -q '/aura/assets/'
}
wait_healthy() { for ((attempt=0;attempt<20;attempt++)); do if healthy; then return 0; fi; sleep 1; done; return 1; }
finish() {
  result=$?
  trap - EXIT HUP INT TERM
  recovery_status=not-needed
  if [[ $result -ne 0 && $stopped == true ]]; then
    recovery_status=failed
    systemctl stop aura || true
    if [[ $replaced == true ]]; then install -m 0755 "$release/previous" "$app/bin/aura.rollback"; mv -f "$app/bin/aura.rollback" "$app/bin/aura"; fi
    if systemctl start aura && wait_healthy; then recovery_status=healthy; echo 'Previous program is healthy; database was not rolled back.' >&2;
    else echo 'ROLLBACK FAILED: inspect journalctl -u aura.' >&2; fi
  fi
  printf '%s\n' "$recovery_status" > "$release/recovery"
  if [[ $result -eq 0 ]]; then echo success > "$release/result"; else echo failed > "$release/result"; fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
timeout 90 head -c 67108865 > "$release/aura"
size=$(stat -c %s "$release/aura")
if ((size==0||size>67108864)); then echo 'Binary size must be 1 byte to 64 MiB.' >&2; exit 65; fi
actual=$(sha256sum "$release/aura")
if [[ ${actual%% *} != "$expected" ]]; then echo 'Checksum mismatch.' >&2; exit 65; fi
chmod 0755 "$release/aura"
cp "$app/bin/aura" "$release/previous"
chmod 0755 "$release/previous"
printf 'commit=%s\nsha256=%s\n' "$commit" "$expected" > "$release/metadata"
backup="$app/backups/before-deploy-$(basename "$release")"
stopped=true
systemctl stop aura
if [[ $nas == true ]]; then
  candidate_data=$(python3 "$upgrade" begin --app aura --release "$(basename "$release")")
  backup="/var/lib/server-upgrades/aura/$(basename "$release")"
  runuser -u aura -- timeout 60 "$release/aura" check --data "$candidate_data"
else
  runuser -u aura -- timeout 600 "$app/bin/aura" backup --data "$app/data" --out "$backup"
  runuser -u aura -- timeout 60 "$release/aura" check --data "$backup"
fi
install -m 0755 "$release/aura" "$app/bin/aura.next"
replaced=true
mv -f "$app/bin/aura.next" "$app/bin/aura"
systemctl start aura
wait_healthy
if [[ $nas == true ]]; then
  systemctl stop aura
  python3 "$upgrade" verify --app aura --release "$(basename "$release")"
  systemctl start aura
  wait_healthy
fi
printf '%s\n' "$commit" > "$app/current-commit"
chmod 0644 "$app/current-commit"
if [[ $nas == true ]]; then python3 "$upgrade" accept --app aura --release "$(basename "$release")"; fi
printf 'Deployed %s.\n' "$commit"
