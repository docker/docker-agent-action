# Contributing

Thanks for your interest in contributing! 🎉

## Quick Start

1. Fork and clone the repo
2. Create a branch: `git checkout -b feature/your-feature`
3. Make your changes and test them
4. Commit: `git commit -m "Add feature: description"`
5. Push and open a PR

## Development Setup

Requires Node.js 24 and [pnpm](https://pnpm.io) (via Corepack; see `packageManager` in `package.json`):

```bash
pnpm install --frozen-lockfile
pnpm build
```

## Testing

Run tests and lint checks before submitting:

```bash
pnpm test          # unit tests (includes the security suite)
pnpm lint          # Biome + tsc + actionlint (CI parity)
```

## Guidelines

**Code**:
- Follow existing patterns
- Use clear variable names
- Add comments for complex logic

**Commits**:
- ✅ "Add timeout parameter"
- ✅ "Fix: Prevent secret leakage"
- ❌ "WIP" or "Update stuff"

**PRs**:
- Describe what and why
- Include test evidence
- Update docs if needed
- Be responsive to feedback

## Security Issues

**Do not** open public issues for vulnerabilities. Contact maintainers privately first.

## What to Contribute

- Security enhancements
- Documentation improvements
- Bug fixes
- New features (discuss first!)

Look for `good first issue` labels to get started.

## License

By contributing, you agree your contributions will be licensed under the Apache License 2.0.
