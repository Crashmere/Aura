#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ $EUID -ne 0 || $# -ne 2 ]]; then
  echo 'Usage: install.sh <linux-binary> <deploy-public-key>' >&2
  exit 64
fi
app=/opt/aura
binary=$(realpath "$1")
public_key=$(realpath "$2")
scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ ! -e $app && ! -e /etc/systemd/system/aura.service && ! -e /etc/nginx/app-locations/aura.conf ]] || { echo 'Installation already exists' >&2; exit 1; }
if id aura >/dev/null 2>&1 || id aura-deploy >/dev/null 2>&1; then echo 'Account already exists' >&2; exit 1; fi
[[ -f /run/lock/ali-release-retention.lock && -x /opt/serverportal/bin/portal ]]
for tool in vips vipsheader exiftool ffmpeg; do command -v "$tool" >/dev/null; done
ssh-keygen -l -f "$public_key" >/dev/null
if ss -H -ltn 'sport = :18087' | grep -q .; then echo 'Port 18087 is in use' >&2; exit 1; fi
useradd --system --home-dir "$app" --shell /usr/sbin/nologin aura
install -d -m 0755 "$app" "$app/bin" "$app/config" "$app/releases"
install -d -m 0700 -o aura -g aura "$app/data" "$app/backups"
install -m 0755 "$binary" "$app/bin/aura"
install -m 0644 "$scripts/nginx-location.conf" "$scripts/aura.service" "$scripts/aura-backup.service" "$scripts/aura-backup.timer" "$app/config/"
runuser -u aura -- "$app/bin/aura" init --data "$app/data"
bash "$scripts/setup-deploy.sh" "$public_key"
systemctl link "$app/config/aura.service" "$app/config/aura-backup.service" "$app/config/aura-backup.timer"
systemctl daemon-reload
systemctl enable --now aura.service aura-backup.timer
curl --fail --silent --retry 10 --retry-delay 1 --retry-connrefused http://127.0.0.1:18087/healthz
systemctl start aura-backup.service
ln -s "$app/config/nginx-location.conf" /etc/nginx/app-locations/aura.conf
if ! nginx -t; then rm /etc/nginx/app-locations/aura.conf; echo 'Nginx validation failed; new link removed' >&2; exit 1; fi
systemctl reload nginx
echo 'Aura installed. Publish its portal declaration and synchronize documents next.'
