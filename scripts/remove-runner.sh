#!/usr/bin/env bash
# remove-runner.sh
# Gracefully de-registers the GitHub Actions self-hosted runner from vm-ci-runner-as.
#
# Usage:
#   TOKEN=$(gh api -X POST /repos/YOONPYOGitHub/agent-sentinel/actions/runners/remove-token --jq .token)
#   az vm run-command invoke \
#     -g rg-agent-sentinel \
#     --name vm-ci-runner-as \
#     --command-id RunShellScript \
#     --scripts @scripts/remove-runner.sh \
#     --parameters "GH_RUNNER_TOKEN=${TOKEN}"

set -euo pipefail

RUNNER_HOME="/opt/actions-runner"
log() { echo "[remove-runner] $*"; }

log "Stopping runner service..."
"${RUNNER_HOME}/svc.sh" stop  || true
"${RUNNER_HOME}/svc.sh" uninstall || true

log "De-registering from GitHub..."
cd "${RUNNER_HOME}"
./config.sh remove --token "${GH_RUNNER_TOKEN}" || true

log "Runner removed."
