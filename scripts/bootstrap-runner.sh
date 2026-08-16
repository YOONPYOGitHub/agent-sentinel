#!/usr/bin/env bash
# bootstrap-runner.sh
# Bootstraps the GitHub Actions self-hosted runner on vm-ci-runner-as.
# Called via `az vm run-command invoke` ? NOT committed to the repo with a token.
#
# Environment variables expected (injected at run-command call time):
#   GH_RUNNER_TOKEN  - short-lived registration token from `gh api` (1-hour TTL)
#   GH_RUNNER_NAME   - runner name (defaults to hostname)
#   RUNNER_VERSION   - GitHub Actions runner version (e.g. 2.319.1)
#
# Usage (operator runs from WSL / CI host ? NOT from within the VM):
#   TOKEN=$(gh api -X POST /repos/YOONPYOGitHub/agent-sentinel/actions/runners/registration-token --jq .token)
#   az vm run-command invoke \
#     -g rg-agent-sentinel \
#     --name vm-ci-runner-as \
#     --command-id RunShellScript \
#     --scripts @scripts/bootstrap-runner.sh \
#     --parameters "GH_RUNNER_TOKEN=${TOKEN}" "RUNNER_VERSION=2.319.1"
#
# The token is passed as a parameter to the Azure Run Command API (TLS in-transit).
# It is never written to disk or stored in Key Vault / source control.
#
# Rotation / removal:
#   - Runner tokens expire in 1 hour; no rotation needed.
#   - To remove runner: az vm run-command invoke ... --scripts @scripts/remove-runner.sh
#   - Or from GitHub: Settings > Actions > Runners > Remove (forces offline deregistration).
#
# Exact outbound domains required (all port 443 TCP):
#   api.github.com
#   *.actions.githubusercontent.com
#   github.com
#   objects.githubusercontent.com
#   *.blob.core.windows.net
#   mcr.microsoft.com
#   registry.npmjs.org
#   registry-1.docker.io, auth.docker.io, production.cloudflare.docker.com
#   management.azure.com
#   login.microsoftonline.com
#   acr260814.azurecr.io  (via VNet private endpoint)
# Port 80 TCP: OS package mirrors, CRL endpoints.

set -euo pipefail

RUNNER_HOME="/opt/actions-runner"
RUNNER_USER="actions-runner"
RUNNER_VERSION="${RUNNER_VERSION:-2.319.1}"
RUNNER_NAME="${GH_RUNNER_NAME:-$(hostname)}"
REPO_URL="https://github.com/YOONPYOGitHub/agent-sentinel"
LABELS="self-hosted,linux,x64,agent-sentinel-private"
RUNNER_ARCH="linux-x64"

log() { echo "[bootstrap] $*"; }

log "=== Agent Sentinel CI Runner Bootstrap ==="
log "Runner version : ${RUNNER_VERSION}"
log "Runner name    : ${RUNNER_NAME}"
log "Labels         : ${LABELS}"

# ?? 1. OS hardening & dependencies ?????????????????????????????????????????
log "Installing system dependencies..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq \
  curl git jq unzip ca-certificates \
  apt-transport-https lsb-release gnupg

# Docker (for image builds)
if ! command -v docker &>/dev/null; then
  log "Installing Docker..."
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io
  systemctl enable --now docker
fi

# Azure CLI (if not present)
if ! command -v az &>/dev/null; then
  log "Installing Azure CLI..."
  curl -sL https://aka.ms/InstallAzureCLIDeb | bash
fi

# Node.js 22 via NodeSource
if ! node --version 2>/dev/null | grep -q 'v22'; then
  log "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi

# pnpm via corepack
corepack enable
corepack prepare pnpm@latest --activate 2>/dev/null || true

# ?? 2. Dedicated runner user ????????????????????????????????????????????????
if ! id "${RUNNER_USER}" &>/dev/null; then
  log "Creating runner user ${RUNNER_USER}..."
  useradd -m -s /bin/bash "${RUNNER_USER}"
  usermod -aG docker "${RUNNER_USER}"
fi

# ?? 3. Download runner archive ??????????????????????????????????????????????
mkdir -p "${RUNNER_HOME}"
cd "${RUNNER_HOME}"

ARCHIVE="actions-runner-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"
if [ ! -f "${ARCHIVE}" ]; then
  log "Downloading runner ${RUNNER_VERSION}..."
  curl -fsSL \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${ARCHIVE}" \
    -o "${ARCHIVE}"
fi

log "Extracting runner..."
tar xzf "${ARCHIVE}" --overwrite

chown -R "${RUNNER_USER}:${RUNNER_USER}" "${RUNNER_HOME}"

# ?? 4. Configure runner ??????????????????????????????????????????????????????
# GH_RUNNER_TOKEN is the short-lived token from gh api (1-hour TTL).
# It is passed in the Azure Run Command parameters and never written to disk.
log "Configuring runner..."
sudo -u "${RUNNER_USER}" "${RUNNER_HOME}/config.sh" \
  --url "${REPO_URL}" \
  --token "${GH_RUNNER_TOKEN}" \
  --name "${RUNNER_NAME}" \
  --labels "${LABELS}" \
  --runnergroup "Default" \
  --work "_work" \
  --unattended \
  --replace

# ?? 5. Install and start as systemd service ?????????????????????????????????
log "Installing runner as systemd service..."
"${RUNNER_HOME}/svc.sh" install "${RUNNER_USER}"
"${RUNNER_HOME}/svc.sh" start

log "=== Bootstrap complete. Runner status: ==="
"${RUNNER_HOME}/svc.sh" status || true
