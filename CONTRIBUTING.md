# Contributing

Thanks for your interest in contributing! 🎉

## Quick Start

1. Fork and clone the repo
2. Create a branch: `git checkout -b feature/your-feature`
3. Make your changes and test them
4. Commit: `git commit -m "Add feature: description"`
5. Push and open a PR

## Testing

Run tests before submitting:

```bash
cd tests
./test-security.sh
./test-exploits.sh
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

## Automated PR Review

This repo uses the `docker-agent` AI reviewer on pull requests. How a review is triggered depends on who opened the PR:

- **Org members:** a review runs automatically when the PR is opened or marked ready for review. Re-request a review from `docker-agent` in the sidebar to re-run it.
- **External / fork contributors:** the PR is not reviewed automatically. An org member gets it reviewed in two steps:
  1. **Approve the workflow run.** GitHub holds workflows on PRs from first-time and external contributors until a maintainer clicks **Approve and run workflows**.
  2. **Request the review.** In the PR sidebar, under **Reviewers**, add `docker-agent`. The review starts and appears as a check run.

No special commands or workflow inputs are needed, and an external contributor cannot trigger a review of their own PR. The deprecated `/review` comment still works, but requesting `docker-agent` as a reviewer is the supported path. See the [PR Review documentation](review-pr/README.md#external-and-fork-contributor-prs) for the full flow.

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
