# PR Reviewer Example

A minimal AI pull request reviewer built on [`docker/docker-agent-action`](../../README.md). On every pull request it fetches the diff, has a single [Docker Agent](https://github.com/docker/docker-agent) review the added lines for bugs, security issues, and logic errors, and posts the result as a PR comment.

This is a teaching example: two small files, no extra infrastructure. Use it as a starting point for your own reviewer.

## What's here

| File | Purpose |
| --------------- | ------------------------------------------------------------------------- |
| `agent.yaml` | A single-agent Docker Agent definition that reviews a diff at `/tmp/pr.diff` |
| `review-pr.yml` | A copy-pasteable workflow that stages the diff, runs the agent, and posts the review |

## Prerequisites

- An **Anthropic API key** stored as a repository secret named `ANTHROPIC_API_KEY` (`Settings` → `Secrets and variables` → `Actions`). You can swap in any other supported provider — see [Customizing](#customizing).

## Setup

1. Copy `agent.yaml` into your repository as `.github/agents/reviewer.yaml` (the path the workflow references).
2. Copy `review-pr.yml` into your repository as `.github/workflows/review-pr.yml`.
3. In the workflow, replace `VERSION` in `docker/docker-agent-action@VERSION` with a real release tag (see [releases](https://github.com/docker/docker-agent-action/releases)).
4. Add the `ANTHROPIC_API_KEY` secret to your repository.

Open a pull request and the review appears as a comment a few minutes later.

## How it works

1. **Stage the diff** — the workflow checks out the repo and runs `gh pr diff "$PR_NUMBER" > /tmp/pr.diff`, so the agent gets a stable file to read instead of calling the GitHub API itself.
2. **Review** — `docker/docker-agent-action` runs `agent.yaml`; the instruction tells the agent to read `/tmp/pr.diff`, only judge added (`+`) lines, and emit nothing but the review markdown.
3. **Post** — the workflow takes the action's `output-file` output (the cleaned agent response) and posts it with `gh pr comment --body-file`.

## Customizing

- **Model / provider**: edit the `models:` block in `agent.yaml`. For example, to use OpenAI:

  ```yaml
  models:
    gpt:
      provider: openai
      model: gpt-5.2
      max_tokens: 64000
  ```

  Point `agents.root.model` at the new alias, then pass `openai-api-key: ${{ secrets.OPENAI_API_KEY }}` to the action instead of `anthropic-api-key`.
- **Review focus**: tweak the `instruction:` block — add project-specific rules ("we target Go 1.22", "flag missing tests"), tighten or relax severities, or restrict the scope to certain paths.
- **Confidence / verbosity**: the instruction asks for confident findings only and a concise verdict-plus-findings format. Loosen the "only report findings you are confident about" line for more (but noisier) findings, or drop the "Output ONLY the review markdown" constraint if you want the agent to explain its reasoning.
- **Runner behavior**: the action supports `timeout`, `max-retries`, `add-prompt-files`, and more — see the [inputs table](../../README.md#inputs).

## Security note

Review workflows run with **your** API key, so control who can trigger them:

- Restrict triggers. This example uses `on: pull_request`, which runs the workflow from the PR's merge ref with a read-mostly token and — for fork PRs — no access to your secrets. Prefer it over `pull_request_target`, which runs with secrets and write permissions even for fork-authored code.
- Do not expose secrets to forks. GitHub does not pass secrets to `pull_request` runs from forks (the review step will fail fast for lack of an API key), and first-time contributors need manual workflow approval. Keep it that way — don't copy secrets into fork-accessible contexts.
- The action itself performs no authorization checks: anyone who can trigger your workflow can spend your API budget. Gate access in the workflow (e.g. `if:` conditions on the PR author) if you need tighter control.
- The action scans agent output for leaked secrets before your workflow posts it and fails the run (opening an incident issue) on a leak — see the [security docs](../../SECURITY.md).
- Treat the PR diff as untrusted input: a malicious PR can embed instructions aimed at the agent (prompt injection). That is why the example agent is restricted to read-only filesystem tools. If you extend it with shell or write-capable tools, a malicious diff can steer those tools — and the action's `yolo` input defaults to `true` (auto-approve), so consider `yolo: false` for interactive use or stricter setups.
