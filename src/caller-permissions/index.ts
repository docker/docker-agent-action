// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * caller-permissions CLI entrypoint.
 *
 * Usage:
 *   node dist/caller-permissions.js <previousWorkflowPath> <currentWorkflowPath>
 *
 * Compares the caller-facing GITHUB_TOKEN permission requirement of a
 * reusable workflow between two releases. When the current workflow requires
 * more than the previous one (none < read < write), a markdown breaking-change
 * warning is printed to stdout for the release workflow to prepend to the
 * generated release notes. Prints nothing when the requirement is unchanged
 * or reduced.
 *
 * The previous path may not exist (workflow introduced in this release):
 * treated as no baseline. The current path must exist — a missing file exits
 * non-zero so a mistyped path in release.yml cannot silently disable the
 * safeguard.
 *
 * See caller-permissions.ts for the extraction and comparison logic.
 */
import { generateCallerPermissionsWarning } from './caller-permissions.js';

const [, , previousPath, currentPath] = process.argv;

if (!previousPath || !currentPath) {
  process.stderr.write('Usage: caller-permissions <previousWorkflowPath> <currentWorkflowPath>\n');
  process.exit(1);
}

try {
  const warning = generateCallerPermissionsWarning(previousPath, currentPath);
  if (warning !== '') process.stdout.write(`${warning}\n`);
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
