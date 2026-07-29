// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * fix-reviewer-cache-permission CLI entrypoint.
 *
 * Upgrades `actions: read` to `actions: write` in the permissions block of
 * jobs calling the PR-review reusable workflow
 * (docker/docker-agent-action/.github/workflows/review-pr.yml), in-place.
 * Cache writes (review lock, memory, binary cache) require `actions: write`
 * on the calling job; `write` implicitly includes `read`.
 *
 * Usage:
 *   node dist/fix-reviewer-cache-permission.js <file> [<file> ...]
 *
 * Output (stdout): one `<status> <path>` line per file:
 *   changed <path>       actions: read flipped to write and written to disk
 *   needs-manual <path>  a reviewer-calling job the safe flip cannot make
 *                        compliant (no permissions block, read-all, no
 *                        actions entry, actions: none, unsupported YAML) —
 *                        the file is NOT fully fixed even when a `changed`
 *                        line for the same path is also present
 *   compliant <path>     every reviewer-calling job already has actions: write
 *   skipped <path>       no job calls the reviewer workflow
 * Progress/diagnostics go to stderr.
 *
 * Exit codes:
 *   0  all files processed (whether or not anything changed; needs-manual
 *      files are reported via stdout, not the exit code)
 *   1  at least one file failed to read/write, or bad arguments.
 *      Per-file failures do NOT abort the loop — every file is attempted —
 *      but the non-zero exit tells callers the run is incomplete so they
 *      must not commit a partial fix.
 */
import { applyFix, statusLines } from './fix-permission.js';

function main(): void {
  const files = process.argv.slice(2);

  if (files.length === 0 || files.some((f) => f.startsWith('--'))) {
    process.stderr.write('Usage: fix-reviewer-cache-permission <file> [<file> ...]\n');
    process.exit(1);
  }

  const result = applyFix(files);
  const { changedFiles, compliantFiles, manualFiles, skippedFiles, errors } = result;

  for (const line of statusLines(result)) {
    process.stdout.write(`${line}\n`);
  }

  process.stderr.write(
    `Done: ${changedFiles.length} changed, ${manualFiles.length} needing manual review, ` +
      `${compliantFiles.length} compliant, ${skippedFiles.length} skipped of ${files.length} file(s)\n`,
  );

  if (errors.length > 0) {
    process.stderr.write(
      `Error: ${errors.length} file(s) could not be processed — failing so callers do not commit a partial fix\n`,
    );
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
