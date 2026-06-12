#!/usr/bin/env bash

# Copyright The Docker Agent Action authors
# SPDX-License-Identifier: Apache-2.0

# act-local.sh — Run GitHub Actions workflows locally with `act`.
#
# Fetches a PAT from 1Password and writes a temporary env file so act can skip
# the OIDC-based setup-credentials action (which does not work outside GitHub
# Actions).
#
# NOTE: The 1Password op path below must match the item where the PAT is stored.
# Update OP_PAT_PATH if the item was created under a different path.
#
# Usage examples:
#   # Run unit tests
#   ./scripts/act-local.sh push -j test
#
#   # Dry-run the release job
#   ./scripts/act-local.sh workflow_dispatch -j release --input version_bump=patch -n

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACT_ENV_FILE="$(mktemp /tmp/act-env-XXXXX)"

# Clean up temp env file on exit
trap 'rm -f "${ACT_ENV_FILE}"' EXIT

# ---------------------------------------------------------------------------
# 1. Ensure `op` CLI is available and signed in
# ---------------------------------------------------------------------------
if ! command -v op &>/dev/null; then
  echo "❌ 1Password CLI (op) is not installed." >&2
  echo "   Install it: https://developer.1password.com/docs/cli/" >&2
  exit 1
fi

if ! op account list &>/dev/null; then
  echo "❌ Not signed in to 1Password CLI. Run: op signin" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Fetch PAT from 1Password
#
# Update OP_PAT_PATH to match the 1Password item that holds the PAT.
# The PAT needs repo read/write + actions:read scope.
# ---------------------------------------------------------------------------
# shellcheck disable=SC2034
OP_PAT_PATH='op://Team AI Agent/Docker Agent GitHub Action/pat'

echo "🔑 Fetching PAT from 1Password..."
GITHUB_APP_TOKEN="$(op read "${OP_PAT_PATH}")"

# ---------------------------------------------------------------------------
# 3. Write the temporary env file
# ---------------------------------------------------------------------------
cat > "${ACT_ENV_FILE}" <<EOF
GITHUB_APP_TOKEN=${GITHUB_APP_TOKEN}
ORG_MEMBERSHIP_TOKEN=${GITHUB_APP_TOKEN}
ANTHROPIC_API_KEY_FROM_SSM=dummy
OPENAI_API_KEY_FROM_SSM=dummy
EOF

# ---------------------------------------------------------------------------
# 4. Run act with the env file and any extra arguments
# ---------------------------------------------------------------------------
echo "🚀 Running: act --env-file ${ACT_ENV_FILE} $*"
echo ""

cd "${REPO_ROOT}"
act --env-file "${ACT_ENV_FILE}" "$@"
