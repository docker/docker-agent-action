# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- New `docker-agent-version` action output exposing the version of Docker Agent
  that was used. Emitted alongside the existing value.

### Changed

- Renamed all internal self-references from `cagent` / `cagent-action` to
  `docker-agent` / `docker-agent-action` (action display name, `uses:`
  references, GitHub API URLs, package name, source variables, documentation,
  test fixtures, and cosmetic identifiers). No consumer impact.
- HTML comment markers renamed: `<!-- cagent-review -->` →
  `<!-- docker-agent-review -->` and `<!-- cagent-review-reply -->` →
  `<!-- docker-agent-review-reply -->`. The legacy markers are still recognized
  everywhere we detect (loop guards, stale-thread resolution, reply detection)
  during the rename transition.

### Deprecated

- The `cagent-version` action output is deprecated in favor of
  `docker-agent-version`. It still emits the same value and now logs a warning;
  it will be removed in a future release.
- The `CAGENT_ACTION_ROOT` environment variable is deprecated in favor of
  `DOCKER_AGENT_ACTION_ROOT`. Both are exported during the rename transition.
