# Posting Format (GitHub posting mode)

Convert each CONFIRMED/LIKELY finding to an inline comment object for the `comments` array:
- **Added/context lines** (`+` or ` ` in diff) — use `line` with the new-file line number:
  ```json
  {"path": "file.go", "line": 123, "body": "**ISSUE**\n\nDETAILS\n\n<!-- docker-agent-review -->"}
  ```
- **Deleted lines** (`-` in diff) — use `side: "LEFT"` with the old-file line number:
  ```json
  {"path": "file.go", "line": 45, "side": "LEFT", "body": "**ISSUE**\n\nDETAILS\n\n<!-- docker-agent-review -->"}
  ```

The `line` field normally refers to the new file (right side of the diff). Deleted lines
don't exist in the new file, so GitHub's API returns 422. Adding `side: "LEFT"` tells
GitHub to anchor the comment on the old file (left side of the diff) instead.

IMPORTANT: Use `jq` to construct the JSON payload. Do NOT manually build JSON strings
with `echo` — this causes double-escaping of newlines (`\n` rendered as literal text).

# WARNING: NEVER use `--arg body "$variable"` to pass comment body text to jq.
# If the body contains `"`, backticks, or `$`, bash silently empties the variable,
# producing a blank comment on the PR. Always write the body to a temp file via a
# quoted heredoc (`<< 'EOF'`) and read it with `jq --rawfile`. A quoted heredoc
# delimiter disables ALL shell expansion — backticks, `$`, and `"` are written verbatim.

Build the review body and comments, then use `jq` to produce correctly-escaped JSON:
```bash
# Review body is the assessment badge, plus the lower-confidence and dismissed-security
# summary sections when they have entries (high-confidence findings go in inline comments).
# Append each section only when non-empty, e.g.:
#   ### Assessment: 🟡 NEEDS ATTENTION
#
#   #### Lower-confidence findings (not posted inline)
#   - [medium] file.go:42 — issue (confidence: weak 48/100)
#
#   #### Dismissed security findings (review manually)
#   - file.go:88 — issue (verifier mitigation: …)
REVIEW_BODY="### Assessment: 🟢 APPROVE"   # or 🟡 NEEDS ATTENTION / 🔴 CRITICAL

# Start with an empty comments array
echo '[]' > /tmp/review_comments.json

# Append each finding using a quoted heredoc + jq --rawfile (safe for any body text)
# NEVER use --arg body "$comment_body" — shell quoting breaks on ", backticks, and $

cat > /tmp/comment_body.md << 'COMMENT_BODY_EOF'
**[SEVERITY] One-line issue summary**

Detailed explanation of the bug, trigger path, and impact.

confidence: moderate (68/100)

<!-- docker-agent-review -->
COMMENT_BODY_EOF

jq --arg path "$file_path" --argjson line "$line_number" \
  --rawfile body /tmp/comment_body.md \
  '. += [{path: $path, line: $line, body: $body}]' \
  /tmp/review_comments.json > /tmp/review_comments.tmp \
  && mv /tmp/review_comments.tmp /tmp/review_comments.json

# For deleted lines (- in diff), add side: LEFT with the OLD file line number:
jq --arg path "$file_path" --argjson line "$old_line_number" --arg side "LEFT" \
  --rawfile body /tmp/comment_body.md \
  '. += [{path: $path, line: $line, side: $side, body: $body}]' \
  /tmp/review_comments.json > /tmp/review_comments.tmp \
  && mv /tmp/review_comments.tmp /tmp/review_comments.json

# Defensive: remove any comments with empty bodies before posting
jq '[.[] | select(.body | length > 0)]' /tmp/review_comments.json > /tmp/review_comments.tmp \
  && mv /tmp/review_comments.tmp /tmp/review_comments.json
echo "Posting review with $(jq length /tmp/review_comments.json) inline comment(s)"

# Use jq to assemble the final payload with proper escaping
jq -n \
  --arg body "$REVIEW_BODY" \
  --arg event "COMMENT" \
  --slurpfile comments /tmp/review_comments.json \
  '{body: $body, event: $event, comments: $comments[0]}' \
| gh api repos/{owner}/{repo}/pulls/{pr}/reviews --input -
```

The `<!-- docker-agent-review -->` marker MUST be on its own line, separated by a blank line
from the content. Do NOT include it in console output mode.

In GitHub posting mode every inline comment body is REQUIRED to carry a confidence label
(`confidence: <band> (<score>/100)`, e.g. `confidence: moderate (68/100)`) on its own line as the
last content line, immediately before the marker, exactly as shown in the template above. Before
posting, verify each comment in `/tmp/review_comments.json` has it and add it to any that is
missing one. A comment without a confidence label is malformed.

# Comment Scope (REQUIRED)

Each comment must address a problem this PR **introduces** — one that would not exist if
the PR were reverted. Do NOT comment on pre-existing issues, even when a changed line
touches the area or the new code depends on them. A concrete suggestion for addressing an
in-scope finding is welcome; just keep both the finding and the suggestion anchored to the
code this PR actually introduced.
