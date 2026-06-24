# PR Review Action

AI-powered pull request review using a multi-agent system. Analyzes code changes, posts inline comments, and learns from your feedback.

> **Primary trigger:** Add `docker-agent` as a reviewer in the PR sidebar — the review starts automatically. To re-trigger a review, re-request a review from `docker-agent` in the PR sidebar. The `/review` comment still works but is deprecated.

## Quick Start

### Same-repo PRs (1 workflow)

If your repo only accepts PRs from branches within the same repo (no forks), you need a single workflow file:

**`.github/workflows/pr-review.yml`**:

```yaml
name: PR Review
on:
  pull_request:
    types: [ready_for_review, opened, review_requested]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read

jobs:
  review:
    uses: docker/docker-agent-action/.github/workflows/review-pr.yml@VERSION
    permissions:
      contents: read # Read repository files and PR diffs
      pull-requests: write # Post review comments
      issues: write # Create security incident issues if secrets detected
      checks: write # (Optional) Show review progress as a check run
      id-token: write # Required for OIDC authentication to AWS Secrets Manager
      actions: read # Required by reusable workflow for artifact operations
```

That's it. All three events (`pull_request`, `issue_comment`, `pull_request_review_comment`) have full OIDC/secret access for same-repo PRs, so the reusable workflow handles everything directly.

### Repos that accept fork PRs (2 workflows)

Fork PRs are subject to GitHub's security restrictions: `pull_request` and `pull_request_review_comment` events get **read-only tokens, no secrets, and no OIDC**. To work around this, you need a second "trigger" workflow that saves event context as an artifact, then a `workflow_run` handler picks it up with full permissions.

**`.github/workflows/pr-review-trigger.yml`** — lightweight, no secrets needed:

```yaml
name: PR Review - Trigger
on:
  pull_request:
    types: [ready_for_review, opened, review_requested]
  pull_request_review_comment:
    types: [created]

permissions: {}

jobs:
  save-context:
    runs-on: ubuntu-latest
    steps:
      - name: Save event context
        env:
          PR_NUMBER: ${{ github.event.pull_request.number }}
          PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          COMMENT_JSON: ${{ toJSON(github.event.comment) }}
        run: |
          mkdir -p context
          printf '%s' "${{ github.event_name }}" > context/event_name.txt
          printf '%s' "$PR_NUMBER" > context/pr_number.txt
          printf '%s' "$PR_HEAD_SHA" > context/pr_head_sha.txt
          if [ "${{ github.event_name }}" = "pull_request_review_comment" ]; then
            printf '%s' "$COMMENT_JSON" > context/comment.json
          fi

      - name: Upload context
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: pr-review-context
          path: context/
          retention-days: 1
```

**`.github/workflows/pr-review.yml`** — calls the reusable review workflow:

```yaml
name: PR Review
on:
  issue_comment:
    types: [created]
  workflow_run:
    workflows: ["PR Review - Trigger"]
    types: [completed]

permissions:
  contents: read

jobs:
  review:
    if: |
      (github.event_name == 'issue_comment' &&
       github.event.comment.user.login != 'docker-agent' &&
       github.event.comment.user.login != 'docker-agent[bot]' &&
       github.event.comment.user.type != 'Bot' &&
       !contains(github.event.comment.body, '<!-- docker-agent-review -->') &&
       !contains(github.event.comment.body, '<!-- docker-agent-review-reply -->')) ||
      github.event.workflow_run.conclusion == 'success'
    uses: docker/docker-agent-action/.github/workflows/review-pr.yml@VERSION
    permissions:
      contents: read # Read repository files and PR diffs
      pull-requests: write # Post review comments
      issues: write # Create security incident issues if secrets detected
      checks: write # (Optional) Show review progress as a check run
      id-token: write # Required for OIDC authentication to AWS Secrets Manager
      actions: read # Required by reusable workflow for artifact operations; also needed to download trigger artifacts
    with:
      trigger-run-id: ${{ github.event_name == 'workflow_run' && format('{0}', github.event.workflow_run.id) || '' }}
```

#### How the two workflows interact

```
pull_request (opened / ready_for_review / review_requested)
  → pr-review-trigger.yml (saves context as artifact, no secrets needed)
  → completes
  → workflow_run fires
  → pr-review.yml (downloads artifact, runs review)

pull_request_review_comment
  → pr-review-trigger.yml (saves context as artifact)
  → workflow_run fires
  → pr-review.yml (downloads artifact, routes to reply-to-feedback for replies to agent
     comments, or reply-to-mention for top-level @-mentions)

/review comment  –OR–  @docker-agent mention
  → pr-review.yml directly (issue_comment has full permissions)
```

Adding `docker-agent` as a reviewer fires a `pull_request` event with `action: review_requested`, which follows the trigger-workflow path above. The `issue_comment` event (`/review` command and `@docker-agent` mentions) always has full permissions regardless of fork status, so those paths work directly without the trigger workflow.

### Choosing a trigger mode

The `pull_request` trigger types in your calling workflow control how often reviews run. Two modes are supported — the examples above use **Mode B**:

**Mode B — recommended default:**
```yaml
pull_request:
  types: [opened, ready_for_review, review_requested]
```
Reviews run when a PR is opened or marked ready for review. After the initial review, further `pull_request`-triggered reviews only run when `docker-agent` is explicitly re-requested as a reviewer. Re-request a review from `docker-agent` in the PR sidebar to re-trigger at any time. The `/review` comment still works but is deprecated.

**Mode A — continuous re-review on every push:**
```yaml
pull_request:
  types: [opened, ready_for_review, synchronize, review_requested]
```
Adds `synchronize` to also trigger on every push to the PR branch. Opt in if your team wants the reviewer to automatically re-examine every update, at the cost of more workflow runs.

### Customizing

```yaml
with:
  model: anthropic/claude-haiku-4-5 # Use a faster/cheaper model
```

### What you get

| Trigger                              | Behavior                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Request review from `docker-agent`   | **Primary trigger.** Add `docker-agent` as a reviewer in the PR sidebar — review starts automatically, shown as a check run. Authorized by the requesting org member, so it also works for external/fork contributors' PRs. |
| PR opened/ready                      | Auto-reviews when a PR is opened or marked ready for review (org-member-authored PRs).                                                   |
| ~~`/review`~~ _(deprecated)_         | Re-trigger a review, or trigger manually when auto-review hasn't run (e.g. after a force-push). Shows as a check run if `checks: write` is granted. |
| Reply to review comment              | Responds in-thread and captures feedback to improve future reviews.                                                                      |
| `@docker-agent` mention              | Answers questions and clarifies review findings. Works in both PR-level issue comments and inline file-line review comments, including on fork PRs (via the trigger workflow). |

> **Built-in defense-in-depth:**
>
> 1. **Verifies org membership** before every review. Auto-review checks the **PR author** (so only org members' PRs are reviewed automatically); a **requested review** checks the **requester**, so a maintainer can pull an external contributor's PR into review on demand; `/review` checks the commenter
> 2. **Prevents bot cascades** — replies from bots (except `docker-agent`) are ignored
> 3. **Fork PRs work automatically** with the two-workflow setup — the trigger → `workflow_run` pattern provides OIDC/secret access regardless of fork status

### What you don't need to add

The workflow YAML examples above are the complete, recommended setup. The reusable workflow handles all safety checks internally — **do not add your own `if:` guards for these**:

| Protection | How it's handled |
| ---------- | ---------------- |
| **Bot comment filtering** | All jobs in the reusable workflow filter out `docker-agent`, `docker-agent[bot]`, any `Bot`-type user, and comments with `<!-- docker-agent-review -->`/`<!-- docker-agent-review-reply -->` markers. No caller-side filtering needed. |
| **Org membership / authorization** | A `check-org-membership` step runs before any review work. Auto-review verifies the **PR author**; a requested review verifies the **requester** (so an external contributor's PR can be reviewed when an org member requests it); comment / `/review` paths verify the commenter. All via OIDC. Callers never need `author_association` checks. |
| **PR vs issue comment** | The reusable workflow checks `github.event.issue.pull_request` internally. Plain issue comments on non-PR issues are silently ignored. |
| **Draft PR skipping** | Draft PRs are skipped internally — no caller condition needed. |
| **Concurrent review guard** | A cache-based lock (`pr-review-lock-<repo>-<pr>-*`) prevents duplicate reviews from racing on the same PR. |

**The only decision callers make** is which setup pattern to use: 1-workflow for same-repo PRs, 2-workflow for repos that accept fork PRs. That distinction is the caller's responsibility because it controls which event path delivers OIDC credentials to the reusable workflow.

> **Optional optimization:** some teams add `author_association` checks or bot-login filters on their calling workflow's job `if:` to skip the job early and save Actions minutes. This is a valid cost optimization but is not required for correctness or security. When in doubt, use the canonical YAML above without extra conditions — it's simpler to audit and maintain.

---

## Running Locally

Requires [Docker Agent](https://github.com/docker/docker-agent) installed locally. The reviewer agent automatically detects its environment. When running locally, it diffs your current branch against the base branch and outputs findings to the console.

```bash
cd ~/code/my-project
docker agent run agentcatalog/review-pr "Review my changes"
```

The agent automatically:

- Pulls the latest version from Docker Hub
- Reads `AGENTS.md` or `CLAUDE.md` from your repo root for project-specific context (language versions, conventions, etc.)
- Diffs your current branch against the base branch
- Outputs the review as formatted markdown

> **Tip:** Docker Agent has a TUI, so you can interact with the agent during the review — ask follow-up questions, request clarification on findings, or drill into specific files.

### Project Context via `AGENTS.md`

The reviewer automatically looks for an `AGENTS.md` (or `CLAUDE.md`) file in your repository root before analyzing code. This file is read and passed to all sub-agents (drafter and verifier), so project-specific context like language versions, build tools, and coding conventions are respected during the review.

For example, if your `AGENTS.md` says "Look at go.mod for the Go version," the reviewer will check `go.mod` before flagging APIs as nonexistent — avoiding false positives from newer language features.

No workflow configuration is needed — just commit an `AGENTS.md` to your repo root.

You can also pass additional files explicitly with `--prompt-file`:

```bash
docker agent run agentcatalog/review-pr --prompt-file CONTRIBUTING.md "Review my changes"
```

---

## Inputs

### Reusable Workflow

When using `docker/docker-agent-action/.github/workflows/review-pr.yml`:

| Input               | Description                                                            | Default |
| ------------------- | ---------------------------------------------------------------------- | ------- |
| `trigger-run-id`    | Workflow run ID from `pr-review-trigger.yml` (for `workflow_run` path) | -       |
| `pr-number`         | PR number override (auto-detected from event or trigger artifact)      | -       |
| `comment-id`        | Comment ID for reactions (auto-detected)                               | -       |
| `additional-prompt` | Additional review guidelines                                           | -       |
| `model`             | Model override (e.g., `anthropic/claude-haiku-4-5`)                    | -       |
| `add-prompt-files`  | Comma-separated files to append to the prompt                          | -       |

### `review-pr` (Composite Action)

PR number and comment ID are auto-detected from `github.event` when not provided.

> **API Keys:** Provide at least one API key for your preferred provider. You don't need all of them.

| Input                      | Description                                                      | Required |
| -------------------------- | ---------------------------------------------------------------- | -------- |
| `pr-number`                | PR number (auto-detected)                                        | No       |
| `comment-id`               | Comment ID for reactions (auto-detected)                         | No       |
| `additional-prompt`        | Additional review guidelines (appended to built-in instructions) | No       |
| `model`                    | Model override (default: `anthropic/claude-sonnet-4-5`)          | No       |
| `anthropic-api-key`        | Anthropic API key                                                | No\*     |
| `openai-api-key`           | OpenAI API key                                                   | No\*     |
| `google-api-key`           | Google API key (Gemini)                                          | No\*     |
| `aws-bearer-token-bedrock` | AWS Bedrock token                                                | No\*     |
| `xai-api-key`              | xAI API key (Grok)                                               | No\*     |
| `nebius-api-key`           | Nebius API key                                                   | No\*     |
| `mistral-api-key`          | Mistral API key                                                  | No\*     |
| `github-token`             | GitHub token                                                     | No       |
| `add-prompt-files`         | Comma-separated files to append to the prompt                    | No       |

\*API keys are optional when using the reusable workflow (credentials are fetched via OIDC). Only required when using the composite action directly without OIDC.

---

## Example Output

When issues are found, the action posts inline review comments:

```markdown
**Potential null pointer dereference**

The `user` variable could be `nil` here if `GetUser()` returns an error,
but the error check happens after this line accesses `user.ID`.

Consider moving the nil check before accessing user properties.

<!-- docker-agent-review -->
```

When no issues are found:

```markdown
✅ Looks good! No issues found in the changed code.
```

---

### Review Pipeline

```
AGENTS.md + PR Diff → Drafter (hypotheses) → Verifier (confirm) → Post Comments
```

### Learning System

When you reply to a review comment:

1. The `reply-to-feedback` job checks if the reply is to an agent comment (via `<!-- docker-agent-review -->` marker)
2. Verifies the author is an org member/collaborator (authorization gate)
3. Builds the full thread context (original comment + all replies in chronological order)
4. Runs a Sonnet-powered reply agent that posts a contextual response in the same thread
5. **Captures feedback as an artifact** — saves the comment JSON as a `pr-review-feedback` artifact

On the **next review run** (on any PR in the same repo):

6. The review action downloads all pending `pr-review-feedback` artifacts
7. A separate feedback agent processes each one and calls `add_memory` to record lessons learned
8. The processed artifacts are deleted so they're not reprocessed
9. The review agent has access to all accumulated memories, calibrating future reviews

This means developer feedback on one PR improves reviews across all future PRs in the repo.

### Conversational Replies

The reviewer supports true multi-turn conversation in PR review threads. When you reply to a review comment:

- **Ask a question** — the agent explains its reasoning, references specific code, and offers suggestions
- **Correct a false positive** — the agent acknowledges the mistake and remembers it for future reviews
- **Disagree** — the agent engages thoughtfully, discusses trade-offs, and considers your perspective
- **Add context** — the agent thanks you, reassesses its finding, and stores the insight

Agent replies are marked with `<!-- docker-agent-review-reply -->` (distinct from `<!-- docker-agent-review -->` on original review comments) to prevent infinite loops. Multi-turn threading works automatically because GitHub's `in_reply_to_id` always points to the root comment.

**Memory persistence:** The memory database is stored in GitHub Actions cache. Each review run restores the previous cache, processes any pending feedback, runs the review, and saves with a unique key. Old caches are automatically cleaned up (keeping the 5 most recent).

---

## Running Evals

Evals verify that the reviewer produces consistent, correct results across multiple runs.

### Run all evals

```bash
cd docker-agent-action
docker agent eval review-pr/agents/pr-review.yaml review-pr/agents/evals/ \
  -e GITHUB_TOKEN -e GH_TOKEN
```

### Eval structure

Each eval file in `review-pr/agents/evals/` contains:

- **`messages`**: The initial user prompt (e.g., a PR URL)
- **`evals.relevance`**: Natural-language assertions checked against the agent's output
- **`evals.setup`**: Setup commands run before the eval (e.g., installing `gh`)

### Eval naming conventions

| Prefix       | Expected outcome                                                   |
| ------------ | ------------------------------------------------------------------ |
| `success-*`  | Clean PR, agent should APPROVE                                     |
| `security-*` | PR with security concerns, agent should COMMENT or REQUEST_CHANGES |

### Writing new evals

1. Find a PR with a known correct outcome (e.g., a clean PR that should be approved, or one with a real bug)
2. Create a JSON file with the PR URL as the user message and relevance criteria describing the expected behavior
3. Run the eval 3+ times to verify consistency

```json
{
  "id": "unique-uuid",
  "title": "Description of what this eval tests",
  "evals": {
    "setup": "apk add --no-cache github-cli",
    "relevance": [
      "The agent ran 'echo $GITHUB_ACTIONS' before performing the review to detect the output mode",
      "The agent output the review to the console as formatted markdown instead of posting via gh api",
      "The drafter response is valid JSON containing a 'findings' array and a 'summary' field",
      "... assertions about the expected findings and verdict ..."
    ]
  },
  "messages": [
    {
      "message": {
        "agentName": "",
        "message": {
          "role": "user",
          "content": "https://github.com/org/repo/pull/123",
          "created_at": "2026-01-01T00:00:00-05:00"
        }
      }
    }
  ]
}
```

> **Tip:** Create multiple eval files for the same PR to test consistency. If the agent produces different verdicts across runs, the failing evals highlight the inconsistency.
