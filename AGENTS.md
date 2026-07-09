# AGENTS.md

Guide for AI agents and LLMs working in this repository. Read this before exploring the codebase or proposing changes.

## What this repo is

**`docker/docker-agent-action`** — a public GitHub Action that runs [Docker Agent](https://github.com/docker/docker-agent) AI agents inside GitHub Actions workflows. It is a **generic prompt runner**: callers supply an agent (a Docker Hub identifier or a `.yaml` file), a prompt, and their own provider API key. It is published to the GitHub Marketplace and consumed as `uses: docker/docker-agent-action@vX.Y.Z`.

The action is a Node action (`runs: using: node24`, `main: dist/main.js`). The entrypoint (`src/main/index.ts`) downloads and caches the docker-agent binary, optionally installs mcp-gateway, sanitizes the prompt, runs the agent with a retry loop, filters the verbose log into clean output, scans that output for leaked secrets, uploads the verbose log as an artifact, and writes a job summary.

The docker-agent binary version is pinned in the `DOCKER_AGENT_VERSION` file and injected at build time as the `__DOCKER_AGENT_VERSION__` compile-time constant via tsup's `define` option — the bundle never reads the file at runtime.

The action performs **no authorization checks**. Who may trigger a workflow (and thereby spend API budget) is entirely the calling workflow's responsibility.

## Repo layout

```
.
├── action.yml                       # ← Root action ("Docker Agent Runner"). node24, main: dist/main.js.
│                                    #   Source of truth for inputs/outputs.
├── DOCKER_AGENT_VERSION             # Pinned docker-agent version. Read at build time by tsup/vitest (define).
├── package.json                     # pnpm root. Scripts: build, test, test:integration, typecheck, lint, format.
├── tsup.config.ts                   # Explicit entry map {main, signed-commit} → dist/*.js (ESM, node24, fully bundled).
├── tsconfig.json                    # TS config. rootDir=src, target ES2024, strict.
├── vitest.config.ts                 # Two projects: "unit" and "integration".
├── biome.json                       # Formatter + linter (Biome). 100 char width, 2 spaces, single quotes.
│
├── src/
│   ├── main/                        # Action entrypoint → bundled to dist/main.js.
│   │   ├── index.ts                 # Orchestration: validate → sanitize → setup → run → scan → report.
│   │   ├── binary.ts                # docker-agent / mcp-gateway download + two-level caching.
│   │   ├── exec.ts                  # Spawns docker-agent: retry loop, timeout (exit 124), keys via env only.
│   │   ├── outputs.ts               # Verbose-log noise filter + ```docker-agent-output``` block extraction.
│   │   ├── artifact.ts              # Verbose-log artifact upload.
│   │   ├── summary.ts               # Job summary writer.
│   │   └── __tests__/               # Unit + integration tests.
│   ├── security/                    # Security library (no CLI — imported by src/main).
│   │   ├── patterns.ts              # Single source of truth for SECRET_PATTERNS, CRITICAL/SUSPICIOUS/MEDIUM patterns.
│   │   ├── sanitize-input.ts        # Prompt-injection detection: block critical, strip suspicious, warn medium.
│   │   ├── sanitize-output.ts       # Secret-leak scan of agent output.
│   │   ├── validators.ts            # Structural validators (GitHub token CRC32 checksum).
│   │   └── __tests__/
│   └── signed-commit/               # CLI tool → dist/signed-commit.js. Creates verified commits via
│       │                            #   GitHub's GraphQL API. Used by release CI only.
│       ├── index.ts
│       ├── signed-commit.ts
│       └── __tests__/
│
├── examples/
│   └── reviewer/                    # PR-reviewer example built on the action (docs, not linted by actionlint).
│       ├── agent.yaml               # Single-agent reviewer definition (reads diff from /tmp/pr.diff).
│       ├── review-pr.yml            # Copy-pasteable workflow: fetch diff → run action → post PR comment.
│       └── README.md
│
└── .github/
    ├── workflows/                   # CI + release workflows (see "Workflows" below).
    ├── SECURITY.md                  # Docker's vulnerability disclosure policy.
    └── CODEOWNERS
```

## Critical conventions

### Versioning & releases

- Consumers use `uses: docker/docker-agent-action@vX.Y.Z`. **The built `dist/` directory is the runtime artifact.** `dist/` is gitignored on `main`; `release.yml` builds it, creates a signed release commit containing `dist/` on a throwaway staging branch (via `dist/signed-commit.js`), tags that commit, and deletes the branch. `dist/` is therefore committed **only on release tags**.
- `DOCKER_AGENT_VERSION` is the **single source of truth** for the docker-agent binary version. It is read at build time by `tsup.config.ts` and `vitest.config.ts` (`define: __DOCKER_AGENT_VERSION__`). Update via `.github/workflows/update-docker-agent-version.yml`.
- Commit messages follow **Conventional Commits** (`feat:`, `fix:`, `chore:`, `release:`).

### TypeScript / `src` rules

- `tsup.config.ts` has an **explicit entry map**: `{ main, signed-commit }`. Only those `src/<name>/index.ts` files become `dist/<name>.js`. Library code (e.g. `src/security/`) is not an entry — it is bundled into its importer.
- `tsup` runs with `noExternal: [/.*/]` — **all npm dependencies are bundled in**. Do not assume `node_modules` exists at runtime.
- Target is `node24`, ESM only, `platform: 'node'` (so dependencies resolve their Node export, not a browser variant).
- Use `.js` extension in relative imports (`import { x } from './foo.js'`) — required by `Node16` module resolution even though the source is `.ts`.
- Sourcemaps are intentionally disabled (consumers clone `dist/` on tags; sourcemaps would bloat every checkout).
- A `createRequire` banner is injected by `tsup.config.ts` so CJS dependencies bundled into ESM (e.g. `tunnel` via `@actions/http-client`) can `require('net')` etc. at runtime. The banner uses `import.meta.url` and is ESM-only — if `format` is ever extended to include `'cjs'`, move it to a format-specific banner.

### Linting / formatting

- **Biome** (`biome.json`) handles both formatting and linting: 100-col line width, 2-space indent, single quotes, semicolons always, trailing commas. Run `pnpm format` to fix.
- `pnpm lint` runs three things in CI parity: `biome ci .`, `tsc --noEmit`, and `actionlint` (via `pnpm actionlint`, which builds first).
- **actionlint** validates `.github/workflows/*.yml` only — files under `examples/` are not linted, but keep them valid anyway (users copy them verbatim).

### Tests

- `pnpm test` — Vitest "unit" project (`src/**/__tests__/**/*.test.ts`, excluding `*.integration.test.ts`).
- `pnpm test:integration` — Vitest "integration" project (`*.integration.test.ts`).
- Security tests live in `src/security/__tests__/` and run as part of `pnpm test`. Run them when changing anything under `src/security/`.

### Security-first design (do not regress)

The action runs untrusted input (prompts often embed PR titles, bodies, diffs) through an LLM with credentials. Several mitigations are non-negotiable:

- **All API keys are explicit inputs.** `src/main/index.ts` fails fast when no provider key is given. Do not add an env-var fallback.
- **All secrets are masked** with `core.setSecret()` before any exec/spawn or logging (`maskSecrets()` in `src/main/exec.ts`; the resolved GitHub token is masked immediately in `src/main/index.ts`).
- **API keys are passed to docker-agent via env, never argv** (argv is visible in process listings and logs).
- **Prompt sanitization** (`src/security/sanitize-input.ts`) runs on every user-provided prompt: critical exfiltration patterns block the run, suspicious injection lines are stripped (the agent reads `/tmp/prompt-clean.txt`, not the raw prompt), medium-risk patterns warn.
- **Output sanitization** (`src/security/sanitize-output.ts`) runs in the `finally` block of `src/main/index.ts` — it executes on every path, including failures. If it detects a leaked secret it opens a security incident issue and fails the run. Keep it in the `finally` path.
- **No authorization inside the action.** The action does not check who triggered the workflow (no org or role checks) — calling workflows gate access. Do not reintroduce auth logic here; document trigger hygiene instead (see `examples/reviewer/README.md`).
- **No `eval`-style shelling out.** `extra-args` is word-split into an argv array (`buildArgs()` in `src/main/exec.ts`), never passed through a shell.

## Workflows (`.github/workflows/`)

| Workflow                          | Purpose                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `test.yml`                        | Lint (Biome + actionlint), typecheck, unit + integration tests on push/PR.                    |
| `test-e2e-trigger.yml`            | Runs on PRs with no permissions; saves PR context as an artifact.                             |
| `test-e2e.yml`                    | `workflow_run` handler: real end-to-end action invocations (pirate agent, invalid agent) using repo secrets (`secrets.OPENAI_API_KEY`). |
| `release.yml`                     | Manual dispatch: bumps the version, builds `dist/`, creates a signed release commit + tag (uses `secrets.RELEASE_TOKEN \|\| github.token`). |
| `update-docker-agent-version.yml` | Bumps `DOCKER_AGENT_VERSION` and opens a PR (repository_dispatch from docker-agent releases, or manual). |

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

# Format + lint (write fixes)
pnpm format

# Strict CI check (Biome + tsc + actionlint). Run before every commit.
pnpm lint
```

## Editing checklist

When you change something, verify:

- [ ] Did you change `action.yml` inputs/outputs? Update the `README.md` inputs/outputs tables — they must match `action.yml` exactly.
- [ ] Did you add/remove an action entrypoint? Update the explicit `entry` map in `tsup.config.ts` and the `main:` reference in `action.yml` if relevant.
- [ ] Did you change the docker-agent version? Edit `DOCKER_AGENT_VERSION` only — it is the single source of truth (tsup/vitest inject it as `__DOCKER_AGENT_VERSION__`).
- [ ] Did you change anything under `src/security/`? Re-run `pnpm test` and confirm the mitigations above still hold.
- [ ] Did you change a workflow or example YAML? Run `pnpm actionlint` (examples aren't scanned, but keep them valid).
- [ ] Did you rename an output or env var? Search the repo and docs first — these are public contracts for consumers.

## Things to avoid

- **Don't** depend on `node_modules` being present at action runtime. Add new packages to `package.json` and let `tsup` bundle them.
- **Don't** introduce env-var fallbacks for API keys — explicit inputs only.
- **Don't** move output sanitization, artifact upload, or the job summary out of the `finally` path in `src/main/index.ts`.
- **Don't** pass secrets via argv — env only.
- **Don't** add authorization logic to the action — access control belongs to the calling workflow.

## Where to look for more context

- **User-facing docs**: `README.md` (the action), `examples/reviewer/README.md` (PR reviewer example).
- **Security details**: `SECURITY.md` (protections), `.github/SECURITY.md` (vulnerability disclosure policy).
- **Contributing rules**: `CONTRIBUTING.md`.
- **Code of conduct**: `CODE_OF_CONDUCT.md`.
- **License**: Apache 2.0 (`LICENSE`).
