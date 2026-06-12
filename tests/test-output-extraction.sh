#!/bin/bash

# Copyright The Docker Agent Action authors
# SPDX-License-Identifier: Apache-2.0

# Test output extraction logic from action.yml
# Simulates the sanitize-output step's extraction methods

set -e

echo "=========================================="
echo "Testing Output Extraction Logic"
echo "=========================================="

# Create test output files
TEST_DIR=$(mktemp -d)
trap "rm -rf $TEST_DIR" EXIT

# Test Case 1: With docker-agent-output code block (preferred method)
echo ""
echo "Test 1: Extracting from docker-agent-output code block"
echo "---"
cat > "$TEST_DIR/output1.log" <<'EOF'
For any feedback, please visit: https://docker.qualtrics.com/jfe/form/SV_cNsCIg92nQemlfw

time=2025-11-05T21:22:35.664Z level=WARN msg="rootSessionID not set"

--- Agent: root ---

```docker-agent-output
## ✅ No security issues detected

Scanned 15 commits from the past 2 days. No security vulnerabilities were identified.
```
EOF

# Extract using the primary method
if grep -q '```docker-agent-output' "$TEST_DIR/output1.log"; then
  awk '
    /```docker-agent-output/ { capturing=1; next }
    capturing && /^```/ { capturing=0; next }
    capturing { print }
  ' "$TEST_DIR/output1.log" > "$TEST_DIR/output1.clean"
  echo "✅ Extraction successful"
else
  echo "❌ docker-agent-output block not found"
fi

echo "Cleaned output:"
cat "$TEST_DIR/output1.clean"
echo ""

# Test Case 1b: Code fence NOT at start of line (agent emits thoughts before it)
echo ""
echo "Test 1b: Extracting docker-agent-output when code fence is mid-line"
echo "---"
cat > "$TEST_DIR/output1b.log" <<'EOF'
For any feedback, please visit: https://docker.qualtrics.com/jfe/form/SV_cNsCIg92nQemlfw

time=2025-11-05T21:22:35.664Z level=WARN msg="rootSessionID not set"

--- Agent: root ---

I'll analyze the PR by reading the actual diff and related files to generate a comprehensive description.```docker-agent-output
## Summary

Implements automated PR review functionality.

## Changes

### Added
- New workflow file
```
EOF

if grep -q '```docker-agent-output' "$TEST_DIR/output1b.log"; then
  awk '
    /```docker-agent-output/ { capturing=1; next }
    capturing && /^```/ { capturing=0; next }
    capturing { print }
  ' "$TEST_DIR/output1b.log" > "$TEST_DIR/output1b.clean"
  echo "✅ Extraction successful"
else
  echo "❌ docker-agent-output block not found"
fi

echo "Cleaned output:"
cat "$TEST_DIR/output1b.clean"
echo ""

# Verify no agent thoughts leaked through
if grep -q "I'll analyze" "$TEST_DIR/output1b.clean"; then
  echo "❌ FAIL: Agent thoughts leaked into clean output"
  exit 1
else
  echo "✅ Agent thoughts correctly excluded"
fi

# Test Case 2: Fallback - Extract after agent marker
echo ""
echo "Test 2: Fallback extraction after agent marker"
echo "---"
cat > "$TEST_DIR/output2.log" <<'EOF'
For any feedback, please visit: https://docker.qualtrics.com/jfe/form/SV_cNsCIg92nQemlfw

time=2025-11-05T21:22:35.664Z level=WARN msg="rootSessionID not set"

--- Agent: root ---

✅ **No security issues detected**

Scanned 15 commits from the past 2 days. No security vulnerabilities were identified.
EOF

# Extract using fallback method
if grep -q "^--- Agent: root ---$" "$TEST_DIR/output2.log"; then
  AGENT_LINE=$(grep -n "^--- Agent: root ---$" "$TEST_DIR/output2.log" | tail -1 | cut -d: -f1)
  tail -n +$((AGENT_LINE + 1)) "$TEST_DIR/output2.log" | \
    grep -v "^time=" | \
    grep -v "^level=" | \
    grep -v "For any feedback" | \
    sed '/^$/N;/^\n$/d' > "$TEST_DIR/output2.clean"
  echo "✅ Extraction successful (fallback method)"
else
  echo "❌ Agent marker not found"
fi

echo "Cleaned output:"
cat "$TEST_DIR/output2.clean"
echo ""

echo ""
echo "Test 3: Edge case - malformed output without expected markers"
echo "---"
cat > "$TEST_DIR/output3.log" <<'EOF'
Some random output
No agent markers here
Just plain text
EOF

# Fallback 3 should just clean metadata
grep -v "^time=" "$TEST_DIR/output3.log" | \
  grep -v "^level=" | \
  grep -v "For any feedback" > "$TEST_DIR/output3.clean"

if [ -f "$TEST_DIR/output3.clean" ]; then
  echo "✅ Fallback extraction successful (metadata cleaning only)"
else
  echo "❌ Fallback extraction failed"
fi

echo "Cleaned output:"
cat "$TEST_DIR/output3.clean"
echo ""

echo ""
echo "Test 4: Defensive check - agent marker exists but grep fails"
echo "---"

# This simulates the edge case where grep -q finds the marker but grep -n doesn't
# (e.g., race condition or encoding issue)
cat > "$TEST_DIR/output4.log" <<'EOF'
--- Agent: root ---

Some output
EOF

# Simulate the defensive logic
AGENT_LINE=$(grep -n "^--- Agent: root ---$" "$TEST_DIR/output4.log" | tail -1 | cut -d: -f1)

if [ -n "$AGENT_LINE" ]; then
  echo "✅ AGENT_LINE extracted successfully: $AGENT_LINE"
  tail -n +$((AGENT_LINE + 1)) "$TEST_DIR/output4.log" > "$TEST_DIR/output4.clean"
else
  echo "⚠️  AGENT_LINE is empty (defensive check would prevent arithmetic error)"
  cp "$TEST_DIR/output4.log" "$TEST_DIR/output4.clean"
fi

# Test Case 5: Strip "Calling function()" and "function response →" blocks
echo ""
echo "Test 5: Strip Calling/response tool trace blocks"
echo "---"
cat > "$TEST_DIR/output5.log" <<'EOF'
Calling read_multiple_files(
  paths: [
  "pr.diff",
  "commits.txt"
]
)

read_multiple_files response → (
=== pr.diff ===
diff --git a/file.txt b/file.txt
+hello
)

## Summary

This PR adds a greeting.

## Changes

- Added hello to file.txt
EOF

# Run the same AWK filter used in action.yml
awk '
  /<thinking>/,/<\/thinking>/ { next }
  /^\[thinking\]/,/^\[\/thinking\]/ { next }
  /^Thinking:/ { next }
  /^--- Tool:/ { in_tool=1; next }
  in_tool && /^--- (Tool:|Agent:|$)/ { in_tool=0; next }
  in_tool { next }
  /^Calling [a-zA-Z_]+\(/ { in_call=1; next }
  in_call && /^\)$/ { in_call=0; next }
  in_call { next }
  /^[a-zA-Z_]+ response →/ { in_resp=1; next }
  in_resp && /^\)$/ { in_resp=0; next }
  in_resp { next }
  /^--- Agent:/ { next }
  /^time=/ { next }
  /^level=/ { next }
  /^msg=/ { next }
  /^> \[!NOTE\]/ { next }
  /For any feedback/ { next }
  /transfer_task/ { next }
  /Delegating to/ { next }
  /Task delegated/ { next }
  NF==0 && !seen_content { next }
  NF>0 { seen_content=1 }
  { print }
' "$TEST_DIR/output5.log" > "$TEST_DIR/output5.clean"

echo "Cleaned output:"
cat "$TEST_DIR/output5.clean"
echo ""

# Verify tool traces were stripped
if grep -q "Calling read_multiple_files" "$TEST_DIR/output5.clean"; then
  echo "❌ FAIL: 'Calling read_multiple_files' was not stripped"
  exit 1
fi
if grep -q "read_multiple_files response" "$TEST_DIR/output5.clean"; then
  echo "❌ FAIL: 'read_multiple_files response' was not stripped"
  exit 1
fi
if grep -q "diff --git" "$TEST_DIR/output5.clean"; then
  echo "❌ FAIL: Diff content inside response block was not stripped"
  exit 1
fi
# Verify actual content survived
if ! grep -q "## Summary" "$TEST_DIR/output5.clean"; then
  echo "❌ FAIL: '## Summary' heading was stripped (should be kept)"
  exit 1
fi
if ! grep -q "This PR adds a greeting." "$TEST_DIR/output5.clean"; then
  echo "❌ FAIL: Description body was stripped (should be kept)"
  exit 1
fi
echo "✅ Tool trace blocks correctly stripped, markdown content preserved"

echo ""
echo "=========================================="
echo "✅ All extraction tests completed"
echo "=========================================="
