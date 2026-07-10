# Security Documentation

This document describes the security hardening built into the docker-agent-action GitHub Action.

## 🔒 Security Features

This action includes **built-in security features for all agent executions**:

1. **Prompt Injection Detection** — The user-provided prompt is checked in three tiers before it reaches the agent:
   - **Critical patterns** (block execution): Direct secret exfiltration commands (`echo $API_KEY`, `console.log(process.env)`, `printenv`, `cat .env`)
   - **Suspicious patterns** (strip + warn): Behavioral/natural-language injection attempts ("ignore previous instructions", "system mode", "reveal the token", base64/hex obfuscation, etc.) — matching lines are removed from the prompt before it reaches the agent
   - **Medium-risk patterns** (warn only): API key variable names in configuration (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, etc.)

   The result is reported via the `prompt-suspicious` and `input-risk-level` (`low`/`medium`/`high`) outputs.

2. **Output Scanning** — All agent responses are scanned for leaked secrets before your workflow can post or log them:
   - Anthropic API keys (`sk-ant-api*`, `sk-ant-sid*`, `sk-ant-admin*`)
   - OpenAI API keys (shape: `sk-…T3BlbkFJ…`)
   - GitHub tokens: `ghp_*`, `gho_*`, `ghu_*`, `ghs_*`, `github_pat_*`
   - GitHub token matches are further validated against a CRC32 checksum baked into every modern GitHub token, eliminating fixtures and placeholders
   - If secrets are detected: the workflow fails and a security incident issue is created

3. **Token Masking** — Every provided API key and the resolved GitHub token are registered with the runner's `::add-mask::` mechanism (`core.setSecret`) before any process is spawned or output is logged. Keys are passed to the agent via environment variables, never argv.

4. **Automatic Incident Response** — On a detected leak the action opens a GitHub issue labeled `security` with rotation instructions and fails the run (see `security-blocked` / `secrets-detected` outputs).

> **Authorization is out of scope.** The action performs no caller authorization of its own — anyone who can trigger your workflow can run the agent with your API key. Access control is the calling workflow's responsibility: restrict triggers, prefer `pull_request` over `pull_request_target`, and gate on the actor with `if:` conditions where needed.

## Security Architecture

The action implements a defense-in-depth approach:

```
┌────────────────────────────────────────────────────────────────┐
│ 1. Input Validation & Masking (src/main/index.ts, exec.ts)     │
│    ✓ Explicit API-key inputs only — fail fast when none given  │
│    ✓ All keys/tokens masked via core.setSecret before use      │
│    ✓ Keys passed to the agent via env, never argv              │
└────────────────────────────────────────────────────────────────┘
                          ↓
┌────────────────────────────────────────────────────────────────┐
│ 2. Prompt Sanitization (src/security/sanitize-input.ts)        │
│    ✓ Detect and block critical exfiltration commands           │
│    ✓ Strip suspicious injection patterns                       │
│    ✓ Warn on medium-risk API key references                    │
│    ✓ Remove diff comment lines (hidden instruction vector)     │
└────────────────────────────────────────────────────────────────┘
                          ↓
┌────────────────────────────────────────────────────────────────┐
│ 3. Agent Execution (src/main/exec.ts)                          │
│    ✓ Agent reads the sanitized prompt file, not the raw input  │
│    ✓ Isolated Docker Agent runtime with controlled env         │
└────────────────────────────────────────────────────────────────┘
                          ↓
┌────────────────────────────────────────────────────────────────┐
│ 4. Output Scanning (src/security/sanitize-output.ts)           │
│    ✓ Runs in the finally path — on every execution outcome     │
│    ✓ Scan for leaked API keys (Anthropic, OpenAI, etc.)        │
│    ✓ Scan for leaked tokens (GitHub PAT, OAuth, fine-grained)  │
│    ✓ CRC32 structural validator rejects fixtures/placeholders  │
└────────────────────────────────────────────────────────────────┘
                          ↓
┌────────────────────────────────────────────────────────────────┐
│ 5. Incident Response (src/main/index.ts)                       │
│    ✓ Create GitHub security issue with details                 │
│    ✓ Fail workflow with clear error                            │
│    ✓ Prevent secret exposure in downstream steps               │
└────────────────────────────────────────────────────────────────┘
```

## Security Modules

All security logic lives under `src/security/` as a library imported by the action entrypoint
(`src/main/index.ts`) and bundled into `dist/main.js` by [tsup](https://tsup.egoist.dev).
All npm dependencies are bundled in — no `node_modules` is required at action runtime.

| Module | Purpose |
|---|---|
| `src/security/patterns.ts` | Single source of truth for all detection patterns |
| `src/security/sanitize-input.ts` | 3-tier prompt sanitization logic |
| `src/security/sanitize-output.ts` | Output scanning for real secret leaks |
| `src/security/validators.ts` | Structural validators (GitHub CRC32 checksum) |

### Secret Patterns (`src/security/patterns.ts`)

`src/security/patterns.ts` is the **single source of truth** for all detection patterns. It
exports four groups:

#### `SECRET_PATTERNS` — Full regex patterns for output scanning

| Name | Pattern | Notes |
|------|---------|-------|
| `anthropic-api-key` | `sk-ant-(?:api\|sid\|admin)\d{2}-[A-Za-z0-9_-]{93}AA` | Covers api03, sid01, admin01 key families |
| `github-pat` | `ghp_[A-Za-z0-9]{36}` | + CRC32 validator |
| `github-oauth` | `gho_[A-Za-z0-9]{36}` | + CRC32 validator |
| `github-user-token` | `ghu_[A-Za-z0-9]{36}` | + CRC32 validator |
| `github-server-token` | `ghs_[A-Za-z0-9]{36}` | + CRC32 validator |
| `github-fine-grained-pat` | `github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}` | + CRC32 validator |
| `openai-api-key` | `sk-[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}` | `T3BlbkFJ` = base64("OpenAI") |

Each `SecretPattern` entry has a `name`, a `regex`, and an optional `validator`. The
`validGitHubChecksum` validator (from `src/security/validators.ts`) decodes the trailing 6-char
base62 CRC32 embedded in every modern GitHub token, rejecting fixtures and example values that
happen to match the regex shape.

#### `SECRET_PREFIXES` — Alternation string for quick prefix checks

```
(sk-ant-|sk-proj-|sk-|ghp_|gho_|ghu_|ghs_|github_pat_|ANTHROPIC_API_KEY|GITHUB_TOKEN|OPENAI_API_KEY)
```

Available for lightweight, prefix-based pre-screening of prompts.

#### `CRITICAL_PATTERNS` — Direct exfiltration commands (block execution)

These are programmatic commands that directly extract secrets from the agent's environment.
They are **never legitimate** in a user prompt. Any match causes `sanitize-input` to block
the run:

```
# Shell
echo.*\$.*ANTHROPIC_API_KEY
echo.*\$.*GITHUB_TOKEN
echo.*\$.*OPENAI_API_KEY
echo.*\$.*GOOGLE_API_KEY

# Python
print\(.*ANTHROPIC_API_KEY
print\(.*OPENAI_API_KEY
print\(.*GITHUB_TOKEN
print\(.*GOOGLE_API_KEY
print.*os\.environ

# JavaScript
console\.log.*process\.env
console\.log\(.*ANTHROPIC_API_KEY
console\.log\(.*OPENAI_API_KEY
console\.log\(.*GITHUB_TOKEN
console\.log\(.*GOOGLE_API_KEY

# Environment extraction
print.*environment.*variable
printenv\s+(ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GOOGLE_API_KEY)

# File access
cat\s+\.env
```

> **Security note:** The false-positive filter (`isFalsePositive`) is intentionally **not**
> applied to CRITICAL patterns. Applying it would create exploitable bypass vectors: an attacker
> could decorate a payload with regex metacharacters (e.g. `+"echo $ANTHROPIC_API_KEY[]"`) to
> trigger the quoted-line suppression and evade detection.

#### `SUSPICIOUS_PATTERNS` — Behavioural injection (strip + warn)

Instruction overrides, system/mode overrides, direct secret-revelation requests (natural
language), system-prompt extraction, jailbreak attempts, and encoding/obfuscation attempts
(base64, hex). Matching lines are **stripped** from the sanitized prompt; execution
continues with a warning.

#### `MEDIUM_RISK_PATTERNS` — API key variable names (warn only)

`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` — common in
legitimate configuration code; warns but does not strip or block.

### Prompt Sanitization (`src/security/sanitize-input.ts`)

`sanitizeInput(inputPath, outputPath)` applies a three-tier strategy:

1. **Strip diff comment lines** — removes `+//`, `+/*`, and `+#` lines (common
   injection vector for hiding instructions in code comments when a diff is
   embedded in the prompt).
2. **CRITICAL patterns** — block execution entirely (the sanitized file is never written).
3. **SUSPICIOUS patterns** — strip matching lines, warn, continue.
4. **MEDIUM-RISK patterns** — warn only, no strip.

The agent always reads the sanitized file (`/tmp/prompt-clean.txt`), never the raw prompt.
Results surface as action outputs:

| Action output | Values | Meaning |
|--------|--------|---------|
| `security-blocked` | `true` / `false` | `true` when a CRITICAL pattern blocked the run (or a leak was detected in output) |
| `prompt-suspicious` | `true` / `false` | `true` when suspicious content was stripped |
| `input-risk-level` | `low` / `medium` / `high` | Highest tier triggered |

### Output Scanning (`src/security/sanitize-output.ts`)

`sanitizeOutput(filePath)` scans the agent's response against `SECRET_PATTERNS` with three
false-positive heuristics:

1. **Regex metacharacter check** — if the matched text contains `[`, `]`, `{`, `}`, `(`,
   etc., it is treated as a pattern definition in code, not a real credential.
2. **Single-quote wrapping check** — if _this specific occurrence_ of the match is
   individually wrapped in single quotes in the file, it is suppressed (quoted regex
   pattern in a comment or doc). A file containing both a bare token and a quoted copy
   is still flagged — the bare occurrence is not suppressed.
3. **Structural validator** — for GitHub tokens, the trailing 6-char base62 CRC32 is
   validated. Fixtures and placeholders whose checksum doesn't match are rejected.

The function also warns (without blocking) when `MEDIUM_RISK_PATTERNS` variable names
appear in the output.

The scan runs in the `finally` path of `src/main/index.ts`, so it executes on every
outcome — success, agent failure, or unexpected error. A detected leak sets the
`secrets-detected` output to `true`, triggers the incident response, and fails the run.

## Security Testing

Security logic is covered by [Vitest](https://vitest.dev/) unit test suites at
`src/security/__tests__/security.test.ts` and `src/security/__tests__/validators.test.ts`.
Run them with:

```bash
pnpm test
```

**Coverage includes:**

- Clean input / clean output (should pass)
- Prompt injection in diff comment (should strip, not block)
- Leaked Anthropic API key (should block)
- Leaked GitHub token with valid CRC32 (should block)
- Leaked GitHub token quoted in code (should NOT flag — false-positive heuristic)
- Leaked GitHub token: bare token flagged even when quoted copy is also present
- Regex pattern in output (should NOT flag — metacharacter heuristic)
- Low/medium/high risk classification
- Critical exfiltration commands block the run, sanitized file never written
- Suspicious content physically stripped, clean lines preserved
- False-positive bypass attempts (decorated payloads with `[]`, `()`, `{}`)
- CRC32 checksum validation of GitHub token shapes

## Security in Practice

### Basic Usage with Security Checks

```yaml
- name: Run Agent
  id: agent
  uses: docker/docker-agent-action@VERSION
  with:
    agent: my-agent
    prompt: "Analyze the logs"
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}

- name: Check for security issues
  if: always()
  run: |
    if [ "${{ steps.agent.outputs.secrets-detected }}" == "true" ]; then
      echo "⚠️ Secret leak detected - incident issue created"
    fi
    if [ "${{ steps.agent.outputs.prompt-suspicious }}" == "true" ]; then
      echo "⚠️ Prompt had suspicious patterns"
    fi
```

All executions automatically include:

- Prompt sanitization (blocking and stripping)
- Output scanning for secrets
- Incident issue creation if secrets are detected
- Workflow failure on security violations

### Controlling Who Can Trigger Your Workflow

The action does not authorize callers. Lock down the workflow instead:

- Use narrow triggers (`pull_request` with explicit `types`, `workflow_dispatch`) and avoid
  `pull_request_target` unless you fully understand its risks.
- Rely on GitHub's built-in gates: secrets are not exposed to `pull_request` runs from forks,
  and first-time contributors require manual workflow approval.
- Add `if:` conditions on the actor (e.g. `github.actor`, team membership checked in a prior
  step) when the trigger surface is broader than trusted contributors.

## Security Outputs

| Output | Description |
|--------|-------------|
| `secrets-detected` | `true` if secrets were detected in the agent's output |
| `prompt-suspicious` | `true` if suspicious patterns were stripped from the prompt |
| `input-risk-level` | Risk level of the input (`low` / `medium` / `high`) |
| `security-blocked` | `true` if execution was blocked (prompt blocked OR output leaked) |

## Maintenance

### Adding New Secret Patterns

1. **Edit `src/security/patterns.ts`** — add a new entry to `SECRET_PATTERNS`:

   ```typescript
   {
     name: 'new-provider-api-key',
     regex: /np-[A-Za-z0-9]{40}/,
     // Optional: add a validator function if the token has a structural invariant
   }
   ```

2. **Add the prefix to `SECRET_PREFIXES`** if needed for quick pre-screening:

   ```typescript
   export const SECRET_PREFIXES =
     '(sk-ant-|...|np-)';
   ```

3. **Run the test suite** to confirm no regressions:

   ```bash
   pnpm test
   ```

4. **Add a specific test case** in `src/security/__tests__/security.test.ts` for the new pattern.

### Security Review Checklist

Before merging changes to the security module:

- [ ] All unit tests pass (`pnpm test`)
- [ ] Type-check and lint pass (`pnpm lint`)
- [ ] New patterns added only to `src/security/patterns.ts`
- [ ] No hardcoded secrets in code
- [ ] Output scanning still runs on all execution paths (the `finally` block of `src/main/index.ts`)
- [ ] Critical-pattern detection does not apply `isFalsePositive()` (would create bypass vector)

## Reporting Security Issues

If you discover a security vulnerability, please:

1. **Do NOT** open a public issue
2. Report it privately per Docker's [security policy](.github/SECURITY.md) ([security@docker.com](mailto:security@docker.com))
3. Provide detailed information about the vulnerability
4. Allow time for a fix before public disclosure

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [GitHub Security Best Practices](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
- [Docker Agent Repository](https://github.com/docker/docker-agent)
- [Portcullis secret-pattern catalogue](https://github.com/dgageot/portcullis) (Apache-2.0) — basis for the regex shapes and CRC32 validator
