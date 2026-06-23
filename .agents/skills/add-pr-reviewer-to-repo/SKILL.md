---
name: add-pr-reviewer-to-repo
description: Set up or upgrade GitHub Actions workflows in a consuming repo to use the docker/docker-agent-action PR reviewer (docker/docker-agent-action/.github/workflows/review-pr.yml). Covers both same-repo and fork-PR patterns, trigger mode selection, version pinning, upgrade checklist, and common troubleshooting.
---

# Onboard a Repo to the PR Review Workflow

Use this skill when you are asked to add AI-powered PR review to a repo, or to upgrade an existing setup to the latest version of `docker/docker-agent-action/.github/workflows/review-pr.yml`.

---

## How the reviewer is triggered — tell your team this

> **Primary trigger: add `docker-agent` as a reviewer in the PR sidebar.**
> Open a PR → Reviewers → type `docker-agent` → click. The review starts automatically and appears as a check run.
>
> **To re-trigger:** re-request a review from `docker-agent` in the sidebar (click the refresh icon next to their name). This fires a `review_requested` event and starts a fresh review.
>
> **`/review` comment:** still works but is deprecated. Prefer the sidebar workflow.

Make sure to communicate this to contributors when onboarding a repo — it's the main daily interaction pattern and easy to miss if someone only reads the workflow YAML.

---

## What you DON'T need to add — built-in protections

The reusable workflow handles all of the following internally. **Do not add caller-side guards for these** — they create maintenance burden without improving correctness or safety.

| Concern | How it's handled internally |
| ------- | --------------------------- |
| **Bot comment filtering** | All jobs in the reusable workflow carry comprehensive `if:` conditions that skip `docker-agent`, `docker-agent[bot]`, any `Bot`-type user, and comments containing `<!-- docker-agent-review -->` / `<!-- docker-agent-review-reply -->` HTML markers. |
| **Org membership / authorization** | A dedicated `check-org-membership` step runs before any review work begins. PR authors and comment authors are verified as org members or collaborators. Callers never need their own `author_association` checks. |
| **PR vs issue comment disambiguation** | The reusable workflow checks `github.event.issue.pull_request` internally. Plain issue comments on non-PR issues are ignored automatically. |
| **Draft PR skipping** | Handled internally — draft PRs are not reviewed. |
| **Concurrent review guard** | A cache-based lock (`pr-review-lock-<repo>-<pr>-*`) prevents duplicate reviews from racing on the same PR. |

### The one thing callers ARE responsible for

The **fork vs same-repo distinction** is the caller's responsibility, because it determines the event path:
- Same-repo PRs → use the 1-workflow pattern (events have full OIDC/secret access directly).
- Fork PRs → use the 2-workflow pattern (trigger artifact → `workflow_run` handler).

The reusable workflow uses the presence of `trigger-run-id` to detect which path it's on. The canonical YAML in sections 4a and 4b below (without extra `if:` guards) is the recommended setup.

> **Note on optional optimizations:** some teams add `author_association` checks or bot-login filters on their *calling* workflow's job `if:` to save Actions minutes by skipping the job entirely before it even calls the reusable workflow. This is a valid cost optimization, but it is not required for correctness or security. When in doubt, omit them — the simpler YAML is easier to audit and maintain.

---

## 1. Determine Which Pattern to Use

Check the repo's contribution guidelines and GitHub settings:

- **Does the repo accept PRs from forks?** (open-source repos, cross-org contributions, `CONTRIBUTING.md` mentions fork workflow) → use the **2-workflow (fork) pattern**.
- **PRs only from branches within the same repo?** (private repos, internal teams, branch-protection-only) → use the **1-workflow (same-repo) pattern**.

When in doubt, check recent PRs: if any originate from a fork (`author:fork` or `head.repo.fork == true`), use the 2-workflow pattern.

---

## 2. Determine the Version to Use

Replace `@VERSION` in every workflow YAML below with the latest release tag. As of this writing the latest release is **`v2.0.0`**. Always verify:

```bash
gh release list --repo docker/docker-agent-action --limit 5
```

Use `@main` only for bleeding-edge / pre-release testing.

---

## 3. Choose a Trigger Mode

The `pull_request` event types control how often reviews run. Pick one mode and apply it to the trigger section of the workflow(s) below.

**Mode B — recommended default** (reviews on open, ready, and explicit re-request only):

```yaml
pull_request:
  types: [opened, ready_for_review, review_requested]
```

**Mode A — continuous re-review on every push** (adds `synchronize`):

```yaml
pull_request:
  types: [opened, ready_for_review, synchronize, review_requested]
```

Mode A costs more workflow minutes. Opt in only if the team wants the reviewer to automatically re-examine every push to the PR branch.

The examples below use **Mode B**.

---

## 4a. Same-Repo PRs — 1-Workflow Pattern

Create one file: **`.github/workflows/pr-review.yml`**

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
```

All three events (`pull_request`, `issue_comment`, `pull_request_review_comment`) have full OIDC/secret access for same-repo PRs, so the reusable workflow handles everything directly.

Replace `@VERSION` with the tag from Step 2 (e.g. `@v2.0.0`).

---

## 4b. Fork PRs — 2-Workflow Pattern

Fork PRs run under GitHub's security restrictions: `pull_request` and `pull_request_review_comment` events get read-only tokens, no secrets, and no OIDC. The solution is a lightweight "trigger" workflow that saves event context as an artifact; a `workflow_run` handler then picks it up with full permissions.

### File 1: `.github/workflows/pr-review-trigger.yml`

Lightweight — no secrets needed, runs in the fork's context:

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

### File 2: `.github/workflows/pr-review.yml`

Full-permissions handler — calls the reusable workflow:

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
      actions: read # Download artifacts from trigger workflow
    with:
      trigger-run-id: ${{ github.event_name == 'workflow_run' && format('{0}', github.event.workflow_run.id) || '' }}
```

Replace `@VERSION` in the `uses:` line with the tag from Step 2 (e.g. `@v2.0.0`).

### How the two workflows interact

```
pull_request (opened / ready_for_review / review_requested)
  → pr-review-trigger.yml  (saves context artifact, no secrets needed)
  → completes
  → workflow_run fires
  → pr-review.yml  (downloads artifact, full OIDC, runs review)

pull_request_review_comment
  → pr-review-trigger.yml  (saves context artifact)
  → workflow_run fires
  → pr-review.yml  (routes to reply-to-feedback or reply-to-mention)

/review comment  –OR–  @docker-agent mention
  → pr-review.yml directly  (issue_comment always has full permissions)
```

`issue_comment` always has full permissions regardless of fork status, so `/review` commands and `@docker-agent` mentions bypass the trigger workflow entirely.

---

## 5. Upgrade Checklist

For repos that already have the workflows, verify each item:

- [ ] **Version/tag is current** — compare the `@VERSION` in `uses:` against the latest release from `gh release list --repo docker/docker-agent-action --limit 1`. Update if behind.
- [ ] **All required permissions are present** — `contents: read`, `pull-requests: write`, `issues: write`, `id-token: write`. Missing any of these causes silent failures or OIDC auth errors.
- [ ] **`checks: write` is present** (optional but recommended) — without it the review won't appear as a check run on the PR.
- [ ] **Bot-filter `if` condition is correct** — the condition must filter out `docker-agent`, `docker-agent[bot]`, any `Bot` user type, and comments containing `<!-- docker-agent-review -->` or `<!-- docker-agent-review-reply -->`. A missing or incomplete filter causes infinite review loops.
- [ ] **Fork repos: trigger workflow has the artifact upload step** — the `actions/upload-artifact` step must be present in `pr-review-trigger.yml`, pinned to a specific commit SHA (not just a tag). Without it the `workflow_run` handler has no artifact to download.
- [ ] **Fork repos: `actions: read` permission in `pr-review.yml`** — required to download the artifact from the trigger workflow run. Missing this causes a 403 when the handler tries to fetch the artifact.
- [ ] **Fork repos: `trigger-run-id` input is wired correctly** — must be `${{ github.event_name == 'workflow_run' && format('{0}', github.event.workflow_run.id) || '' }}`. An empty string is safe for `issue_comment` events; the reusable workflow handles both paths.
- [ ] **Fork repos: `workflow_run.workflows` array matches the trigger workflow name exactly** — the string `"PR Review - Trigger"` (or whatever you named it) must match the `name:` field in `pr-review-trigger.yml` character-for-character.

---

## 6. Common Mistakes and Troubleshooting

### OIDC auth fails / no credentials available

**Cause:** `id-token: write` permission is missing from the job's `permissions` block.

**Fix:** Add `id-token: write` to the `permissions` block on the `review` job (not just the top-level workflow permissions).

```yaml
jobs:
  review:
    uses: docker/docker-agent-action/.github/workflows/review-pr.yml@VERSION
    permissions:
      id-token: write  # ← must be here
      ...
```

### Fork setup: artifact download fails with 403

**Cause:** `actions: read` is missing from the `pr-review.yml` job permissions.

**Fix:** Add `actions: read` to the `permissions` block on the `review` job in `pr-review.yml`.

### Infinite review loop

**Cause:** The `if` condition on the `save-context` job (trigger workflow) or the `review` job is not filtering bot comments. The agent posts a comment → that fires an `issue_comment` or `pull_request_review_comment` event → the workflow triggers again → repeat.

**Fix:** Ensure the `if` condition filters all of:
- `github.event.comment.user.login != 'docker-agent'`
- `github.event.comment.user.login != 'docker-agent[bot]'`
- `github.event.comment.user.type != 'Bot'`
- `!contains(github.event.comment.body, '<!-- docker-agent-review -->')`
- `!contains(github.event.comment.body, '<!-- docker-agent-review-reply -->')`

### `workflow_run` never fires

**Cause:** The `workflows:` array in `pr-review.yml`'s `workflow_run` trigger doesn't match the `name:` field of the trigger workflow.

**Fix:** Check that the string in `workflows: ["PR Review - Trigger"]` matches exactly the `name:` field at the top of `pr-review-trigger.yml`. Rename one to match the other.

### Reviews don't run on fork PRs at all

**Cause:** The trigger workflow (`pr-review-trigger.yml`) is missing, or its `pull_request` trigger types don't include `opened` / `ready_for_review` / `review_requested`.

**Fix:** Confirm `pr-review-trigger.yml` exists in `.github/workflows/` on the default branch and that its `on.pull_request.types` list matches the desired trigger mode.

### Review doesn't appear as a check run

**Cause:** `checks: write` permission is absent.

**Fix:** Add `checks: write` to the job `permissions` block. This is optional but strongly recommended so the review progress is visible in the PR's Checks tab.

---

## 7. Audit: Validate All Consuming Repos in the Docker Org

Use this procedure when asked to audit, validate, or report on the health of the PR reviewer setup across repos in the Docker org.

### Step 1 — Discover consuming repos

Search GitHub for all files in the `docker` org that reference the reusable workflow:

```bash
gh search code "docker/docker-agent-action/.github/workflows/review-pr.yml" \
  --owner docker \
  --filename "*.yml" \
  --json repository,path \
  --limit 100
```

This returns a list of `(repository, path)` pairs. For each unique repository, fetch the actual workflow file(s):

```bash
# Example: fetch a workflow file from a discovered repo
gh api repos/docker/<repo>/contents/.github/workflows/pr-review.yml \
  --jq '.content' | base64 -d
```

Also check for a trigger workflow in fork setups:

```bash
gh api repos/docker/<repo>/contents/.github/workflows/pr-review-trigger.yml \
  --jq '.content' | base64 -d 2>/dev/null || echo "no trigger workflow"
```

Check whether the repo accepts fork PRs (to validate the correct pattern is in use):

```bash
gh api repos/docker/<repo> --jq '{allow_forking, visibility, fork}'
```

Also check for open PRs from forks as a real-world signal:

```bash
gh pr list --repo docker/<repo> --json headRepository --limit 50 \
  --jq '[.[] | select(.headRepository.isFork == true)] | length'
```

### Step 2 — Validate each repo

For each repo discovered, run through this checklist. Note every issue found.

#### Version / SHA currency

```bash
# Get the latest release tag
LATEST=$(gh release view --repo docker/docker-agent-action --json tagName --jq '.tagName')
echo "Latest: $LATEST"

# Extract the version in use from the workflow file
grep "review-pr.yml@" .github/workflows/pr-review.yml
```

- [ ] The `uses:` line ends with `@<LATEST>` (e.g. `@v2.0.0`). Flag if behind.

#### Fork pattern correctness

- [ ] If the repo has fork PRs (or `allow_forking: true` and is public), it must use the **2-workflow pattern** (`pr-review.yml` + `pr-review-trigger.yml`).
- [ ] If the repo is private or fork PRs are disabled, the **1-workflow pattern** is correct and sufficient.
- [ ] Flag if a public/open-source repo is using the 1-workflow pattern without confirming forks are disabled.

#### Required permissions

Check the `permissions:` block on the `review` job in `pr-review.yml`:

- [ ] `contents: read`
- [ ] `pull-requests: write`
- [ ] `issues: write`
- [ ] `id-token: write` ← OIDC; missing this breaks all credential fetching
- [ ] `checks: write` ← optional but strongly recommended
- [ ] `actions: read` ← **required for fork setups only** (artifact download)

#### Trigger types

Check `on.pull_request.types` in `pr-review.yml` (or `pr-review-trigger.yml` for fork setups):

- [ ] Includes `review_requested` — the **primary trigger** (sidebar reviewer UX)
- [ ] Includes `ready_for_review`
- [ ] Includes `opened`

#### Unnecessary caller-side `if:` guards

The reusable workflow handles all safety checks internally. Flag any of the following as unnecessary (safe to remove, not a correctness issue):

- [ ] `author_association` checks on the calling job
- [ ] Bot-login filters (`github.event.comment.user.login != 'docker-agent'`, etc.) on any job in the calling workflow
- [ ] `github.event.issue.pull_request` checks on the calling job
- [ ] Draft PR `if:` guards on the calling job

#### Fork setup specifics

For repos using the 2-workflow pattern, additionally check:

- [ ] `trigger-run-id` input is wired as:
  ```yaml
  trigger-run-id: ${{ github.event_name == 'workflow_run' && format('{0}', github.event.workflow_run.id) || '' }}
  ```
- [ ] `workflow_run.workflows` in `pr-review.yml` matches the `name:` field in `pr-review-trigger.yml` exactly (character-for-character, including capitalisation and spaces)
- [ ] `actions/upload-artifact` in the trigger workflow is pinned to a full commit SHA (not just a tag like `@v4`). Check against the current pinned SHA in this repo's own trigger workflow:
  ```bash
  grep "upload-artifact" /workspace/.github/workflows/self-review-pr-trigger.yml
  ```

### Step 3 — Produce a summary report

Group findings by status. Use this format:

```
## PR Reviewer Workflow Audit — docker org
Checked: <date>  |  Latest release: <tag>

### ✅ Compliant (<N> repos)
- docker/<repo> — <pattern>, <version>
- ...

### ⚠️ Needs update (<N> repos)
- docker/<repo>
  - Version outdated: using @v1.x.x, latest is @v2.0.0
  - Missing permission: `checks: write`
  - <other issues>
- ...

### ❌ Critical problems (<N> repos)
- docker/<repo>
  - <description of broken config or missing workflows>
- ...
```

For each issue in the ⚠️ and ❌ buckets, note the relevant section of this skill where the fix is documented.

### Step 4 — Remediation

When asked to fix issues found in the audit:

1. For each affected repo, open a PR against that repo with the corrections.
2. One PR per repo (batch all fixes for a repo into a single PR).
3. In the PR description, list every issue found and how it was fixed.
4. Reference the relevant section of this skill (`## 5. Upgrade Checklist`, `## 4a`, `## 4b`, etc.) for context.
5. Assign the PR to the repo owner or use `--assignee @me` if no clear owner.

> **Don't fix what isn't broken.** Unnecessary `if:` guards (author_association checks, bot filters in the main review job) are safe to remove but are not critical. Only include their removal in a PR if you are already making other changes to that file — don't open a PR solely to remove optional guards.
