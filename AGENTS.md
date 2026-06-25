# AGENTS.md

Guide for AI agents and LLMs working in this repository. Read this before exploring the codebase or proposing changes.

## What this repo is

**`docker/docker-agent-action`** — a GitHub Action (and a family of sub-actions) that runs [Docker Agent](https://github.com/docker/docker-agent) AI agents inside GitHub Actions workflows. It is published to the GitHub Marketplace and consumed by other repos as `uses: docker/docker-agent-action@vX.Y.Z`.

The repo ships **three things**:

1. **Root composite action** (`action.yml`) — downloads the `docker-agent` binary, optionally installs `mcp-gateway`, validates inputs, runs the agent securely (auth checks, prompt injection detection, secret-leak scanning), and exposes outputs.
2. **`review-pr/`** — a higher-level composite action and reusable workflow (`.github/workflows/review-pr.yml`) that orchestrates a multi-agent PR review pipeline (drafter → verifier → poster) with a learning loop driven by reviewer feedback.
3. **TypeScript helpers in `src/`** — bundled to `dist/*.js` and invoked by internal sub-actions (e.g., `setup-credentials`, security primitives, signed commits via the GitHub API).

Anything else here (workflows under `.github/workflows/`, scripts, tests) exists to develop, test, release, or self-test these three artifacts.

## Repo layout

```
.
├── action.yml                       # ← Root action ("Docker Agent Runner"). Composite. Source of truth for inputs/outputs.
├── DOCKER_AGENT_VERSION             # Pinned docker-agent version (currently v1.54.0). Read at runtime by action.yml.
├── package.json                     # pnpm workspace root. Scripts: build, test, lint, format, actionlint.
├── tsup.config.ts                   # Bundles src/<name>/index.ts → dist/<name>.js (ESM, Node 24, fully bundled).
├── tsconfig.json                    # TS config. rootDir=src, target ES2024, strict.
├── vitest.config.ts                 # Two projects: "unit" and "integration".
├── biome.json                       # Formatter + linter (Biome). 100 char width, 2 spaces, single quotes, semicolons.
│
├── src/
│   ├── add-reaction/                # Adds emoji reactions to issue/PR comments.
│   │   ├── index.ts                 # Entry → bundled to dist/add-reaction.js
│   │   └── __tests__/
│   ├── check-org-membership/        # Authorizes a review: auto-run on PR-author membership, review_requested on the (trusted, timeline-derived) requester. Resolves PR author via pulls.get.
│   │   ├── index.ts                 # Entry → bundled to dist/check-org-membership.js (standalone CLI + library).
│   │   └── __tests__/
│   ├── credentials/                 # Fetches AWS secrets via OIDC, exports PAT and AI keys.
│   │   ├── index.ts                 # Entry → bundled to dist/credentials.js
│   │   ├── ai-keys.ts
│   │   ├── aws-credentials.ts
│   │   ├── github-app.ts            # Reads docker-agent-action/github-app from Secrets Manager; exports GITHUB_APP_TOKEN (a PAT) + ORG_MEMBERSHIP_TOKEN.
│   │   └── __tests__/
│   ├── filter-diff/                 # Strips excluded-path sections from a unified diff.
│   │   ├── index.ts                 # CLI entry → bundled to dist/filter-diff.js
│   │   ├── filter-diff.ts           # Core filterDiff() pure function + applyFilter() I/O wrapper.
│   │   └── __tests__/
│   ├── score-risk/                  # Per-file risk scoring for the PR review pipeline.
│   │   ├── index.ts                 # CLI entry → bundled to dist/score-risk.js
│   │   ├── score-risk.ts            # Core scoreFiles() pure function.
│   │   └── __tests__/
│   ├── get-pr-meta/                 # Fetches PR metadata (title, body, author, base branch) used by review-pr.
│   │   ├── index.ts                 # Entry → bundled to dist/get-pr-meta.js
│   │   └── __tests__/
│   ├── mention-reply/               # Handles @docker-agent mention events: parses context, verifies org membership, builds prompt.
│   │   ├── index.ts                 # Entry → bundled to dist/mention-reply.js
│   │   └── __tests__/
│   ├── post-comment/                # Posts comments to PRs/issues.
│   │   ├── index.ts                 # Entry → bundled to dist/post-comment.js
│   │   └── __tests__/
│   ├── security/                    # Security primitives consumed by action.yml.
│   │   ├── index.ts                 # CLI dispatcher → bundled to dist/security.js.
│   │   │                            #   Subcommands: check-auth <association> <allowed-roles-json>
│   │   │                            #                sanitize-input <inputPath> <outputPath>
│   │   │                            #                sanitize-output <filePath>
│   │   ├── check-auth.ts            # author_association-based authorization.
│   │   ├── sanitize-input.ts        # Detects prompt injection patterns. Sets risk-level output.
│   │   ├── sanitize-output.ts       # Scans agent output for leaked API keys / tokens.
│   │   ├── patterns.ts              # Single source of truth for SECRET_PATTERNS, SECRET_PREFIXES, CRITICAL_PATTERNS.
│   │   └── __tests__/security.test.ts  # Vitest unit tests (replaces former test-security.sh / test-exploits.sh).
│   └── signed-commit/               # CLI tool that creates verified commits via GitHub's GraphQL API.
│       ├── index.ts                 # Entry → bundled to dist/signed-commit.js
│       ├── signed-commit.ts
│       └── __tests__/
│
├── review-pr/                       # PR-review action + agents.
│   ├── action.yml                   # Composite: orchestrates diff fetching, chunking, risk scoring, review, learning.
│   ├── README.md                    # User-facing docs for the PR review feature.
│   ├── reply/action.yml             # Sub-action: replies to feedback on review comments.
│   └── agents/
│       ├── pr-review.yaml           # Root reviewer agent (docker-agent YAML).
│       ├── pr-review-feedback.yaml  # Processes captured feedback into memory.
│       ├── pr-review-mention-reply.yaml  # Handles @docker-agent mention-reply responses.
│       ├── pr-review-reply.yaml     # Replies in-thread to reviewer comments.
│       ├── refs/                    # Reference docs passed to agents (posting format, code-review style).
│       └── evals/                   # docker-agent eval JSON files (success-*, security-*, marlin-*, etc.).
│
├── setup-credentials/               # Composite action: fetches AWS creds via OIDC, exports GITHUB_APP_TOKEN +
│   └── action.yml                   #   ORG_MEMBERSHIP_TOKEN. At root so consumers can use
│                                    #   docker/docker-agent-action/setup-credentials@VERSION directly.
│                                    #   Also exports DOCKER_AGENT_ACTION_ROOT (repo root of the downloaded action copy)
│                                    #   for subsequent run: steps that need to invoke dist/ bundles.
│
├── .github/
│   ├── actions/
│   │   └── mention-reply/           # Internal-only JS action (node24). main = dist/mention-reply.js.
│   │       └── action.yml           #   Only used by review-pr.yml; not intended for external consumers.
│   ├── workflows/                   # CI + self-test + release workflows (see "Workflows" below).
│   └── CODEOWNERS
│
├── scripts/
│   ├── act-local.sh                 # Helper for running workflows locally with `act`.
│   └── debug-permissions.ts
│
├── .agents/
│   └── skills/
│       └── add-pr-reviewer-to-repo/
│           └── SKILL.md             # Skill: set up or upgrade a repo to use the PR reviewer reusable workflow.
│
└── tests/                           # Shell-based integration tests for action.yml bash logic.
    ├── test-job-summary.sh
    ├── test-output-extraction.sh
    ├── out.diff                      # Fixture used by test-output-extraction.sh
    └── test.diff                    # Fixture used by test-output-extraction.sh
```

## Critical conventions

### Versioning & releases

- This action is consumed via `uses: docker/docker-agent-action@vX.Y.Z`. **The committed `dist/` directory is the runtime artifact** that consumers download — it must be checked in for tagged releases.
- `DOCKER_AGENT_VERSION` is the **single source of truth** for the docker-agent binary version. `action.yml` reads it with `cat`. Update via `.github/workflows/update-docker-agent-version.yml`.
- Internal `uses:` references to this action (e.g. `review-pr/action.yml` → `docker/docker-agent-action@<sha>`) are pinned to **commit SHAs with version comments**, not tags. Bumping requires updating both the SHA and the comment.

### TypeScript / `src` rules

- Only `src/<name>/index.ts` files listed in the explicit `entry` map in `tsup.config.ts` are bundled to `dist/<name>.js`. To add a new action entrypoint, create `src/<name>/index.ts` **and** add it to the `entry` map in `tsup.config.ts`. Pure library modules that are only imported by other actions (e.g. `add-reaction`, `check-org-membership`, `get-pr-meta`, `post-comment`) should **not** be added to the entry map — they get bundled into their consumer automatically.
- **New logic in composite actions must be implemented as TypeScript in `src/` with Vitest unit tests — not as inline bash, awk, or other scripting languages embedded in YAML files.** Shell steps in action YAML files should only orchestrate calls to `dist/*.js` tools (e.g. `node "$ACTION_PATH/dist/filter-diff.js" pr.diff "$EXCLUDE_PATHS"`). This keeps business logic testable, type-safe, and auditable outside the YAML layer.
- `tsup` runs with `noExternal: [/.*/]` — **all npm dependencies are bundled in**. Do not assume `node_modules` exists at runtime.
- Target is `node24`, ESM only, Node platform (so AWS SDK uses the Node export, not browser).
- Sourcemaps are intentionally disabled (consumers clone `dist/`; sourcemaps would bloat every checkout).
- Use `.js` extension in relative imports (`import { x } from './foo.js'`) — required by `Node16` module resolution even though the source is `.ts`.
- A `createRequire` banner is injected by `tsup.config.ts` so CJS dependencies bundled into ESM (e.g. `tunnel` via `@actions/http-client`) can `require('net')` etc. at runtime. The banner uses `import.meta.url` and is ESM-only — if `format` is ever extended to include `'cjs'`, move the banner to a format-specific entry to avoid a parse error.

### Linting / formatting

- **Biome** (`biome.json`) handles both formatting and linting. Run `pnpm format` to fix, `pnpm lint` to check.
- `pnpm lint` runs three things in CI parity: `biome ci .`, `tsc --noEmit`, `actionlint`.
- **`actionlint`** validates all `*.yml` workflow files. It runs after `pnpm build` because the build emits `dist/` files referenced by some actions. If you change a workflow, run `pnpm actionlint` locally.
- Biome config: 100-col line width, 2-space indent, single quotes, semicolons always, trailing commas everywhere.

### Tests

- `pnpm test` — Vitest "unit" project (`src/**/__tests__/**/*.test.ts`).
- `pnpm test:integration` — Vitest "integration" project (`*.integration.test.ts`).
- `tests/*.sh` are integration tests for the **shell logic** inside `action.yml` (output extraction, job summary, etc.). Run them when changing the bash blocks of `action.yml`.
- Security unit tests live in `src/security/__tests__/security.test.ts` (Vitest) and run as part of `pnpm test`. Run them when changing anything under `src/security/`.
- The PR review agent has a separate eval suite under `review-pr/agents/evals/`. Run with `docker agent eval review-pr/agents/pr-review.yaml review-pr/agents/evals/`.

### Security-first design (do not regress)

The action runs untrusted input (PR titles, bodies, comments, diffs) through an LLM with credentials. Several mitigations are non-negotiable:

- **No `eval`** in any bash block. Argument arrays + quoted expansion only. If you find yourself wanting `eval "$EXTRA_ARGS"`, stop and use `read -ra`.
- **All API keys are explicit inputs.** `action.yml`'s "Validate inputs" step rejects runs with no provider key. Do not add a fallback to env vars.
- **All secret values are masked** with `::add-mask::` before any other step can log them.
- **Authorization** for comment-triggered events is enforced in four tiers: `skip-auth` (caller already verified) → **trusted-bot PAT bypass** (resolves the `github-token` input to its GitHub login via `gh api /user`; if it matches the comment author's login, auto-authorize — handles machine-user PAT bots whose account type may be `"User"`, not `"Bot"`) → `org-membership-token` (preferred, queries `/orgs/:org/members/:user`) → `author_association` (legacy fallback, unreliable for `pull_request_review_comment`). Don't remove tiers; add new ones above the fallback.
- **Output sanitization** (`node "$ACTION_PATH/dist/security.js" sanitize-output`) runs on every agent invocation — if it detects a leaked secret it opens a security incident issue and fails the run. Keep this on the `if: always()` path.
- **Prompt sanitization** writes to `/tmp/prompt-clean.txt`; the runner prefers this file over the raw `$PROMPT_INPUT`. Don't bypass it.
- The full threat model commentary lives in this file (the `security/` shell scripts it was previously co-located with no longer exist; the logic has moved to `src/security/`).

### `review-pr` action specifics

- Uses a **best-effort cache lock** (`pr-review-lock-<repo>-<pr>-*` cache key) to avoid concurrent reviews on the same PR. Lock TTL is 600s; the agent execution timeout is 1800s (30 min) — these are intentionally decoupled. Reviews are idempotent so the small race window is acceptable.
- **Memory persistence** uses `actions/cache` keyed by `pr-review-memory-<repo>-<job>-<run_id>` with prefix-based restore. The DB lives at `${{ github.workspace }}/.cache/pr-review-memory.db`.
- **Feedback loop**: the `reply-to-feedback` job in `.github/workflows/review-pr.yml` (which runs the `pr-review-reply.yaml` agent) uploads a `pr-review-feedback` artifact on every reply via its "Upload feedback artifact" step. The next review run downloads all such artifacts, runs `pr-review-feedback.yaml` to call `add_memory(...)` for each, then deletes the artifacts.
- **Bot reply detection** uses HTML markers: `<!-- docker-agent-review -->` on review comments, `<!-- docker-agent-review-reply -->` on agent replies (including mention-reply responses). **Don't change these strings** — workflows in consumer repos grep for them.
- **Copilot-style triggers**: in addition to the original `pull_request_review` / `issue_comment /review` paths, `review-pr.yml` now also fires on:
  - `pull_request` action `review_requested` when `github.event.requested_reviewer.login == 'docker-agent'`
  - `@docker-agent` mentions on PR/issue comments — these run the `.github/actions/mention-reply` handler (sets `should-reply` and builds the context prompt) and then the `review-pr/mention-reply` sub-action (referenced from a pinned SHA, not present as a local path on every commit). The `pr-review-mention-reply.yaml` agent handles the actual reply.
- Diffs over 1500 lines are **chunked at file boundaries** in `review-pr/action.yml` (see "Split diff into chunks"). Per-file **risk scoring** (security paths, line counts, error-handling patterns) prioritizes verifier attention.
- Stale review threads on lines no longer in the diff are auto-resolved via GraphQL `resolveReviewThread`. Threads with no `<!-- docker-agent-review -->` marker are never touched.

### Workflows (`.github/workflows/`)

| Workflow                          | Purpose                                                              |
| --------------------------------- | -------------------------------------------------------------------- |
| `test.yml`                        | Unit + integration tests on push/PR.                                 |
| `test-e2e.yml`                    | End-to-end action invocation against a real agent.                   |
| `release.yml`                     | Publishes tagged releases (must include a built `dist/`).            |
| `review-pr.yml`                   | **Reusable workflow** consumers call as `docker/docker-agent-action/.github/workflows/review-pr.yml@v…`. |
| `self-review-pr.yml` + `-trigger.yml` | Dogfooding: the repo reviews its own PRs.                        |
| `reply-to-feedback.yml`           | Handles replies to bot review comments.                              |
| `pr-describe.yml`                 | Generates PR descriptions from diffs.                                |
| `security-scan.yml`               | Periodic security scanning.                                          |
| `update-docker-agent-version.yml` | Bumps `DOCKER_AGENT_VERSION` automatically.                          |
| `update-consumers.yml`            | Pushes version updates to downstream consumer repos.                 |
| `migrate-consumers.yml`           | Consumer migration to the new repo: opens PRs across consumer repos rewriting `docker/cagent-action` refs to `docker/docker-agent-action` (incremental, no deadline — old repo stays live; dry-run by default, `repos` allowlist for pilots). |
| `manual-test-pirate-agent.yml`    | Manual smoke test with a toy agent.                                  |

## Common tasks (cheat sheet)

```bash
# Install (uses pnpm via Corepack, see packageManager in package.json)
pnpm install --frozen-lockfile

# Build TypeScript bundles → dist/
pnpm build

# Type-check only
pnpm typecheck

# Unit tests (includes src/security/__tests__)
pnpm test

# Integration tests (Vitest)
pnpm test:integration

# Shell-based integration tests for action.yml bash logic
bash tests/test-job-summary.sh
bash tests/test-output-extraction.sh

# Format + lint (write fixes)
pnpm format

# Strict CI check (Biome + tsc + actionlint). Run before every commit.
pnpm lint

# Run an eval suite for the PR-review agent
docker agent eval review-pr/agents/pr-review.yaml review-pr/agents/evals/ \
  -e GITHUB_TOKEN -e GH_TOKEN
```

## Editing checklist

When you change something, verify:

- [ ] Did you change `action.yml` inputs/outputs? Update `README.md`'s input table and (if relevant) `review-pr/action.yml` consumers.
- [ ] Did you add/remove a `src/<name>/index.ts`? `dist/` will change after `pnpm build`. Commit it for tagged releases (CI does this on `release.yml`; for PRs, build is verified but `dist/` may be ignored — check `.gitignore`).
- [ ] Did you change a bash block in any `action.yml`? Run `pnpm actionlint` and the relevant `tests/*.sh`.
- [ ] Did you change anything under `src/security/`? Re-run `pnpm test` (covers `src/security/__tests__/security.test.ts`) and confirm the threat model above is still covered.
- [ ] Did you bump a pinned `uses:` SHA? Update the trailing version comment too.
- [ ] Did you change a `<!-- docker-agent-* -->` marker, an output name, or an env var name? Search the repo (and consumer documentation) for references first — these are public contracts.

## Things to avoid

- **Don't** add `eval` to any shell snippet. Use bash arrays.
- **Don't** depend on `node_modules` being present at action runtime. Add new packages to `package.json` and let `tsup` bundle them.
- **Don't** introduce env-var fallbacks for API keys — explicit inputs only.
- **Don't** remove `if: always()` from sanitize-output / upload-artifact / summary steps.
- **Don't** commit changes to `review-pr/agents/.cache/*.db*` files (they're local memory artifacts).
- **Don't** rename markers (`<!-- docker-agent-review -->`, `<!-- docker-agent-review-reply -->`) without a versioned migration plan.
- **Don't** loosen authorization checks — comment-triggered events are the primary abuse vector for this action.

## Agent skills

Reusable, task-specific how-to guides for AI agents are kept in `.agents/skills/`. Each skill is a single `SKILL.md` file with a YAML frontmatter block (`name` + `description`) followed by step-by-step instructions.

| Skill | Description |
| ----- | ----------- |
| [`add-pr-reviewer-to-repo`](.agents/skills/add-pr-reviewer-to-repo/SKILL.md) | Set up or upgrade a consuming repo to use `docker/docker-agent-action/.github/workflows/review-pr.yml`. Covers 1-workflow vs 2-workflow (fork) patterns, trigger mode selection, VERSION pinning, upgrade checklist, and common troubleshooting. |

When asked to onboard a new repo (or upgrade an existing one) to the PR reviewer, load the `add-pr-reviewer-to-repo` skill before starting.

## Where to look for more context

- **User-facing docs**: `README.md` (root action), `review-pr/README.md` (PR review feature).
- **Contributing rules**: `CONTRIBUTING.md`.
- **Code of conduct**: `CODE_OF_CONDUCT.md`.
- **License**: Apache 2.0 (`LICENSE`).
