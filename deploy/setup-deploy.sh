#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 || $# -ne 1 ]]; then
  printf 'Usage: sudo bash deploy/setup-deploy.sh <deploy-public-key.pub>\n' >&2; exit 64
fi
public_key=$(realpath "$1")
scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ssh-keygen -l -f "$public_key" >/dev/null
if [[ $(wc -l < "$public_key") -ne 1 ]] || ! grep -q '^ssh-ed25519 ' "$public_key"; then
  printf 'Expected one Ed25519 public key.\n' >&2; exit 64
fi
test -x /opt/aura/bin/aura
if id aura-deploy >/dev/null 2>&1 || [[ -e /etc/sudoers.d/aura-deploy ]]; then
  printf 'Deployment user already exists; rotate its key explicitly instead of rerunning setup.\n' >&2; exit 1
fi
useradd --system --home-dir /opt/aura/deploy-user --shell /bin/bash aura-deploy
# Deployment users cannot edit their home, authorized keys, or root-owned scripts.
install -d -m 0755 /opt/aura/deploy-user /opt/aura/deploy-user/.ssh
install -m 0755 "$scripts/deploy-ssh.sh" /opt/aura/bin/deploy-ssh.sh
install -m 0755 "$scripts/deploy-release.sh" /opt/aura/bin/deploy-release.sh
printf 'restrict,command="/opt/aura/bin/deploy-ssh.sh" %s\n' "$(< "$public_key")" > /opt/aura/deploy-user/.ssh/authorized_keys
chmod 0644 /opt/aura/deploy-user/.ssh/authorized_keys
printf 'aura-deploy ALL=(root) NOPASSWD: /opt/aura/bin/deploy-release.sh\n' > /etc/sudoers.d/aura-deploy
chmod 0440 /etc/sudoers.d/aura-deploy
visudo -cf /etc/sudoers.d/aura-deploy
printf 'Restricted deployment user configured.\n'
