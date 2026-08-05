#!/bin/bash

# Copyright The Docker Agent Action authors
# SPDX-License-Identifier: Apache-2.0

# Test the "Flag caller-facing permission increases as breaking" step of
# .github/workflows/release.yml. The step runs AFTER the immutable tag and the
# GitHub release exist, so a caller-permissions helper failure must be
# non-fatal (annotate + skip), while failures reading/editing the release
# notes once a valid warning exists must still fail the step.
#
# The step's run: block is extracted from the workflow file verbatim and
# executed with `bash -e` (the GitHub Actions default shell mode) against
# stubbed git/node/gh binaries.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=========================================="
echo "Testing release caller-permissions step"
echo "=========================================="

TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR" /tmp/review-pr-previous.yml /tmp/release-notes-with-warning.md' EXIT

# ── Extract the step's run: block from release.yml ──────────────────────────
STEP_SCRIPT="$TEST_DIR/step.sh"
awk '
  !found && index($0, "- name: Flag caller-facing permission increases as breaking") { found=1; next }
  found && !inrun { if ($0 ~ /^        run: \|/) inrun=1; next }
  inrun {
    if ($0 == "" || $0 ~ /^          /) { sub(/^          /, ""); print; next }
    exit
  }
' "$REPO_ROOT/.github/workflows/release.yml" > "$STEP_SCRIPT"

if ! grep -q 'caller-permissions\.js' "$STEP_SCRIPT"; then
  echo "❌ Failed to extract the step script from release.yml (step renamed or re-indented?)"
  exit 1
fi
echo "✅ Extracted step script ($(wc -l < "$STEP_SCRIPT" | tr -d ' ') lines)"

# ── Stub binaries ────────────────────────────────────────────────────────────
STUB_BIN="$TEST_DIR/bin"
STUB_CALLS="$TEST_DIR/calls.log"
mkdir -p "$STUB_BIN"

cat > "$STUB_BIN/git" <<'EOF'
#!/bin/bash
echo "git $*" >> "$STUB_CALLS"
if [ "${STUB_GIT_SHOW_FAIL:-0}" = "1" ]; then
  echo "fatal: invalid object name" >&2
  exit 128
fi
echo 'permissions: {}'
EOF

cat > "$STUB_BIN/node" <<'EOF'
#!/bin/bash
echo "node $*" >> "$STUB_CALLS"
case "${STUB_NODE_MODE:?STUB_NODE_MODE not set}" in
  warn)
    echo '⚠️  Caller permission increased: actions: read → write' >&2
    printf '%s\n' \
      '## ⚠️ Breaking change: callers must grant more permissions' \
      '' \
      '- `actions`: `read` → `write`'
    ;;
  empty)
    echo '✅ No caller-facing permission increases' >&2
    ;;
  fail)
    # Partial stdout before the crash — must never reach the release notes.
    echo 'partial stdout before crash'
    echo 'Error: Unrecognized permission level "banana" at line 2' >&2
    exit 1
    ;;
esac
EOF

cat > "$STUB_BIN/gh" <<'EOF'
#!/bin/bash
echo "gh $*" >> "$STUB_CALLS"
case "$1 $2" in
  'release view')
    if [ "${STUB_GH_VIEW_FAIL:-0}" = "1" ]; then
      echo 'stub: release view failed' >&2
      exit 1
    fi
    printf '%s\n' "## What's Changed" '- generated note line 1'
    ;;
  'release edit')
    if [ "${STUB_GH_EDIT_FAIL:-0}" = "1" ]; then
      echo 'stub: release edit failed' >&2
      exit 1
    fi
    ;;
  *)
    echo "stub gh: unexpected invocation: $*" >&2
    exit 64
    ;;
esac
EOF

chmod +x "$STUB_BIN/git" "$STUB_BIN/node" "$STUB_BIN/gh"

# Runs the extracted step with the given NAME=value env overrides.
# Captures stdout in $OUTPUT, stderr in $TEST_DIR/stderr.txt, status in $STATUS.
run_step() {
  : > "$STUB_CALLS"
  rm -f /tmp/review-pr-previous.yml /tmp/release-notes-with-warning.md
  set +e
  OUTPUT=$(cd "$REPO_ROOT" && env \
    PATH="$STUB_BIN:$PATH" \
    STUB_CALLS="$STUB_CALLS" \
    GITHUB_WORKSPACE="$TEST_DIR" \
    VERSION="v9.9.9" \
    PREVIOUS="v9.9.8" \
    "$@" bash -e "$STEP_SCRIPT" 2>"$TEST_DIR/stderr.txt")
  STATUS=$?
  set -e
}

fail() {
  echo "❌ $1"
  echo "--- stdout ---"; echo "$OUTPUT"
  echo "--- stderr ---"; cat "$TEST_DIR/stderr.txt"
  echo "--- calls ---"; cat "$STUB_CALLS"
  exit 1
}

echo ""
echo "Test 1: first release (no previous tag) → clean skip"
echo "---"
run_step PREVIOUS= STUB_NODE_MODE=empty
[ "$STATUS" -eq 0 ] || fail "expected exit 0, got $STATUS"
echo "$OUTPUT" | grep -q "First release" || fail "expected first-release message"
grep -q '^gh ' "$STUB_CALLS" && fail "gh must not be called" || true
echo "✅ Skips cleanly on first release"

echo ""
echo "Test 2: previous tag has no review-pr.yml → clean skip"
echo "---"
run_step STUB_GIT_SHOW_FAIL=1 STUB_NODE_MODE=empty
[ "$STATUS" -eq 0 ] || fail "expected exit 0, got $STATUS"
echo "$OUTPUT" | grep -q "nothing to compare" || fail "expected nothing-to-compare message"
grep -q '^node ' "$STUB_CALLS" && fail "helper must not be called" || true
echo "✅ Skips cleanly when the previous tag lacks the workflow"

echo ""
echo "Test 3: no permission increase → notes left as generated"
echo "---"
run_step STUB_NODE_MODE=empty
[ "$STATUS" -eq 0 ] || fail "expected exit 0, got $STATUS"
echo "$OUTPUT" | grep -q "unchanged" || fail "expected unchanged message"
grep -q '^gh release edit' "$STUB_CALLS" && fail "release must not be edited" || true
echo "✅ Leaves release notes untouched"

echo ""
echo "Test 4: permission increase → warning prepended to release notes"
echo "---"
run_step STUB_NODE_MODE=warn
[ "$STATUS" -eq 0 ] || fail "expected exit 0, got $STATUS"
grep -q '^gh release view v9.9.9' "$STUB_CALLS" || fail "expected gh release view call"
grep -q '^gh release edit v9.9.9' "$STUB_CALLS" || fail "expected gh release edit call"
[ -f /tmp/release-notes-with-warning.md ] || fail "expected updated notes file"
head -n1 /tmp/release-notes-with-warning.md | grep -q '^## ⚠️ Breaking change' \
  || fail "warning must be the first line of the notes"
grep -q 'generated note line 1' /tmp/release-notes-with-warning.md \
  || fail "generated notes must be preserved after the warning"
echo "✅ Warning prepended, generated notes preserved"

echo ""
echo "Test 5: helper failure → non-fatal, ::warning emitted, notes untouched"
echo "---"
run_step STUB_NODE_MODE=fail
[ "$STATUS" -eq 0 ] || fail "helper failure must not fail the step (got $STATUS)"
echo "$OUTPUT" | grep -q '^::warning' || fail "expected a ::warning workflow command on stdout"
grep -q 'Error: Unrecognized permission level' "$TEST_DIR/stderr.txt" \
  || fail "helper stderr must stream through to the step log"
grep -q '^gh ' "$STUB_CALLS" && fail "gh must not be called after a helper failure" || true
[ ! -f /tmp/release-notes-with-warning.md ] || fail "notes file must not be written on helper failure"
echo "$OUTPUT" | grep -q 'partial stdout before crash' \
  && fail "partial helper stdout must be discarded" || true
echo "✅ Helper failure is non-fatal and never leaks into release notes"

echo ""
echo "Test 6: valid warning but gh release view fails → step fails"
echo "---"
run_step STUB_NODE_MODE=warn STUB_GH_VIEW_FAIL=1
[ "$STATUS" -ne 0 ] || fail "reading release notes must stay fatal"
echo "✅ gh release view failure still fails the step"

echo ""
echo "Test 7: valid warning but gh release edit fails → step fails"
echo "---"
run_step STUB_NODE_MODE=warn STUB_GH_EDIT_FAIL=1
[ "$STATUS" -ne 0 ] || fail "editing release notes must stay fatal"
echo "✅ gh release edit failure still fails the step"

echo ""
echo "=========================================="
echo "✅ All release caller-permissions tests passed"
echo "=========================================="
