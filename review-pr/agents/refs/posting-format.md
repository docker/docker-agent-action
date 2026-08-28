# Posting Format (GitHub posting mode)

Convert each CONFIRMED/LIKELY finding to an inline comment object for the `comments` array.
These two examples show only the `line` vs `side: "LEFT"` wiring; `<confidence-table>` stands for
the REQUIRED confidence table that must close every comment body — see the full body template below.
- **Added/context lines** (`+` or ` ` in diff) — use `line` with the new-file line number:
  ```json
  {"path": "file.go", "line": 123, "body": "**ISSUE**\n\nDETAILS\n\n<confidence-table>\n\n<!-- docker-agent-review -->"}
  ```
- **Deleted lines** (`-` in diff) — use `side: "LEFT"` with the old-file line number:
  ```json
  {"path": "file.go", "line": 45, "side": "LEFT", "body": "**ISSUE**\n\nDETAILS\n\n<confidence-table>\n\n<!-- docker-agent-review -->"}
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
# Review body: write it to /tmp/review_body.md via a QUOTED heredoc — never a
# shell variable (quoting breaks on ", backticks, and $) and never a default
# copied from this file. The body is the header you computed via the Decision
# Rules, plus the lower-confidence, low-severity, and dismissed-security
# summary sections when they have entries (high-confidence findings go in
# inline comments). Exactly ONE status line, chosen by YOUR computed outcome:
#   - incomplete review (merged review_complete false)
#       → body opens "### ⚠️ Review incomplete" (never an "### Assessment:" line)
#   - verification inconclusive (malformed/unpaired verifier batch)
#       → body opens "### ⚠️ Verification inconclusive" (never "### Assessment:")
#   - ANY surviving finding — inline or summary-only, low severity included
#       → "### Assessment: 🔴 CRITICAL" or "### Assessment: 🟡 NEEDS ATTENTION"
#   - complete review, conclusive verification, ZERO surviving findings of every
#     severity → "### Assessment: 🟢 NO FINDINGS" (the ONLY zero-findings outcome —
#     a neutral completion label; the bot never approves, so never write APPROVE,
#     LGTM, or "No issues found" wording into the body)
# Legitimate note text (e.g. the incremental-review coverage note) may precede
# the single status line. The validation step below refuses to post a body
# that is empty, has no/conflicting status lines, carries approve/LGTM
# wording, or pairs 🟢 NO FINDINGS with any findings section.
cat > /tmp/review_body.md << 'REVIEW_BODY_EOF'
<replace this whole placeholder with YOUR computed review body — the posting
command refuses to run until the body carries exactly one valid status line>
REVIEW_BODY_EOF
# Example shape of a completed body with summary sections:
#   ### Assessment: 🟡 NEEDS ATTENTION
#
#   #### Lower-confidence findings (not posted inline)
#   - [medium] file.go:42 — issue (confidence: weak 48/100)
#
#   #### Low-severity findings (not verified, not posted inline)
#   - [low] file.go:12 — issue
#
#   #### Dismissed security findings (review manually)
#   - file.go:88 — issue (verifier mitigation: …)

# Start with an empty comments array
echo '[]' > /tmp/review_comments.json

# Append each finding using a quoted heredoc + jq --rawfile (safe for any body text)
# NEVER use --arg body "$comment_body" — shell quoting breaks on ", backticks, and $

cat > /tmp/comment_body.md << 'COMMENT_BODY_EOF'
**[SEVERITY] One-line issue summary**

Detailed explanation of the bug, trigger path, and impact.

| Confidence | Score |
| :--: | :--: |
| 🟡 moderate | 68/100 |

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

# Deduplicate against previous review cycles BEFORE validating. On a re-review
# the pipeline tends to re-derive findings that are already posted on the PR;
# this drops any new comment matching an existing bot comment (same file,
# nearby line, similar finding heading) so the PR never gets duplicate threads.
# The optional third argument is the workflow-staged review-thread history
# (/tmp/prior_review_threads.json). With it, CURRENT (non-outdated) bot threads
# also suppress a re-derived finding — whether the thread is resolved (a human
# already dealt with it) or unresolved (still open) — while OUTDATED threads
# (the code changed after the comment) never suppress, so those findings are
# reassessed against the new code.
# Fail-open: a missing or malformed new-comments file changes nothing; the
# existing-comments and thread-history files are each optional — whichever one
# is available still dedupes, and with neither available every finding is kept.
node /tmp/dedupe-findings.js /tmp/review_comments.json /tmp/existing_review_comments.json /tmp/prior_review_threads.json

# Validate & sanitize suggestion blocks BEFORE posting. GitHub rejects the
# ENTIRE review (HTTP 422) if any one suggestion anchors outside the diff or to a
# deleted line, so this strips malformed suggestion blocks (keeping the prose
# finding) so one bad suggestion can't lose the whole review. Safe to run even
# when there are no suggestions. Validate against the FULL PR diff: in
# incremental mode the workdir has both pr.diff (incremental) and pr_full.diff
# (full PR diff — what GitHub validates anchors against); otherwise pr.diff IS
# the full diff.
VALIDATION_DIFF=pr.diff
if [ -f pr_full.diff ]; then VALIDATION_DIFF=pr_full.diff; fi
node /tmp/validate-suggestions.js /tmp/review_comments.json "$VALIDATION_DIFF"

# Defensive: remove any comments with empty bodies before posting
jq '[.[] | select(.body | length > 0)]' /tmp/review_comments.json > /tmp/review_comments.tmp \
  && mv /tmp/review_comments.tmp /tmp/review_comments.json
echo "Posting review with $(jq length /tmp/review_comments.json) inline comment(s)"

# The composite action replaces __PR_HEAD_SHA__ with the validated immutable review
# snapshot, __REPOSITORY__/__PR_NUMBER__ with the trusted repository and PR number,
# and __REVIEW_RUN_NONCE__ with this run's attribution nonce before the agent runs.
# Run the chained command exactly as rendered — never rewrite the route, substitute
# owner/repo/PR values, or skip the validation steps. The chain refuses to post when
# the body file is missing/empty, when /tmp/review_comments.json is missing or not a
# JSON array, when a 🟢 NO FINDINGS body is paired with ANY staged inline comment,
# or when the trusted validator rejects the body; the validator also appends this
# run's hidden attribution marker, which the workflow requires to verify that the
# review was actually posted — a bypassed or hand-rolled posting command is reported
# as an unverified run. The payload is staged to a trusted temp file and checked
# before posting, so `gh api` is never invoked when jq fails to construct it.
test -s /tmp/review_body.md \
  && node /tmp/review-assessment.js finalize-body /tmp/review_body.md __REVIEW_RUN_NONCE__ /tmp/review_comments.json \
  && jq -n \
    --rawfile body /tmp/review_body.md \
    --arg event "COMMENT" \
    --arg commit_id "__PR_HEAD_SHA__" \
    --slurpfile comments /tmp/review_comments.json \
    '{body: $body, event: $event, commit_id: $commit_id, comments: $comments[0]}' \
    > /tmp/review_payload.json \
  && jq -e 'type == "object"' /tmp/review_payload.json > /dev/null \
  && gh api "repos/__REPOSITORY__/pulls/__PR_NUMBER__/reviews" --input - < /tmp/review_payload.json
```

The `<!-- docker-agent-review -->` marker MUST be on its own line, separated by a blank line
from the content. Do NOT include it in console output mode.

In GitHub posting mode every inline comment body is REQUIRED to end with a confidence table as its
last content block — a two-column mini markdown table, exactly as shown in the heredoc above:

| Confidence | Score |
| :--: | :--: |
| &lt;emoji&gt; &lt;band&gt; | &lt;score&gt;/100 |

`<emoji>` is the band dot (🟢 strong · 🟡 moderate · 🟠 weak · ⚪ negligible); substitute `<band>`
and the integer `<score>` (0–100) from Confidence Scoring. Leave a blank line between the table and
the `<!-- docker-agent-review -->` marker. Bake the table into the heredoc when you author the body
— never splice it into `/tmp/review_comments.json` afterwards. Before posting, verify each comment
ends with a valid confidence table; if one is missing or malformed, re-author that comment's body
rather than editing the JSON. A comment without a valid confidence table is malformed.

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

| Confidence | Score |
| :--: | :--: |
| 🟡 moderate | 68/100 |

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
