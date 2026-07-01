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

# For a MULTI-LINE suggestion (replacing lines start..end within one hunk), add
# start_line and start_side. start_line < line, both on the RIGHT side:
jq --arg path "$file_path" --argjson start "$start_line_number" --argjson line "$end_line_number" \
  --rawfile body /tmp/comment_body.md \
  '. += [{path: $path, start_line: $start, start_side: "RIGHT", line: $line, side: "RIGHT", body: $body}]' \
  /tmp/review_comments.json > /tmp/review_comments.tmp \
  && mv /tmp/review_comments.tmp /tmp/review_comments.json

# Validate & sanitize suggestion blocks BEFORE posting. GitHub rejects the
# ENTIRE review (HTTP 422) if any one suggestion anchors outside the diff or to a
# deleted line, so this strips malformed suggestion blocks (keeping the prose
# finding) so one bad suggestion can't lose the whole review. Safe to run even
# when there are no suggestions. `pr.diff` is the pre-fetched diff in the workdir.
node /tmp/validate-suggestions.js /tmp/review_comments.json pr.diff

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

# Suggestion Blocks (actionable fixes)

When an in-scope finding has a small, exact fix that REPLACES one or more contiguous
changed lines, include a GitHub suggestion block in the comment body so the author can
apply it in one click. Put the EXACT replacement code in the block — the verbatim lines
that should replace the anchored range, never a description of the change:

````markdown
**[medium] One-line issue summary**

Why this is wrong and what the fix does.

```suggestion
	cfg := DefaultConfig()
	cfg.Timeout = 30 * time.Second
```

confidence: moderate (68/100)

<!-- docker-agent-review -->
````

Because the comment body is written via a quoted heredoc (`<< 'EOF'`), the backticks and
indentation inside the block are preserved verbatim — no extra escaping is needed.

Rules GitHub enforces (a violation makes the ENTIRE review fail with HTTP 422):
- **Right side only.** A suggestion replaces right-side content, so anchor it on an added
  (`+`) or context (` `) line. NEVER attach a suggestion to a deleted line (`side: "LEFT"`).
- **The anchor is the replaced range.** A single-line suggestion uses `line`; a multi-line
  suggestion uses `start_line`..`line` with `start_line < line` and `start_side: "RIGHT"`,
  and the whole range MUST stay inside ONE diff hunk.
- **Match the real code.** Read the current line(s) with `read_file`/`grep -n` first and
  reproduce the existing indentation exactly — the block replaces the entire line range.
- **One block per comment, fence closed.** Open with ` ```suggestion ` and close with ` ``` `.
- **Only when it is a clean drop-in.** If the fix needs prose, edits elsewhere, or spans
  non-contiguous lines, describe it in prose instead — do not force a suggestion block.

The validator (`node /tmp/validate-suggestions.js …`, run before posting above) strips any
suggestion block whose anchor breaks these rules and keeps the prose finding, but emit valid
suggestions in the first place so the actionable fix survives.

# Comment Scope (REQUIRED)

Each comment must address a problem this PR **introduces** — one that would not exist if
the PR were reverted. Do NOT comment on pre-existing issues, even when a changed line
touches the area or the new code depends on them. A concrete suggestion for addressing an
in-scope finding is welcome; just keep both the finding and the suggestion anchored to the
code this PR actually introduced.
