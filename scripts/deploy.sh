#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[INFO] deploy.sh now delegates to setup-lambda.sh for idempotent Lambda provisioning."
bash "${SCRIPT_DIR}/setup-lambda.sh"
