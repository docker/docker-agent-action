// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * filter-diff CLI entrypoint.
 *
 * Usage:
 *   node dist/filter-diff.js <diffPath> <excludePathsList>
 *
 *   diffPath         Path to the diff file (read and overwritten in-place).
 *   excludePathsList Newline-separated list of path prefixes to exclude.
 *
 * All diff section types are handled correctly:
 *   - Modifications  detected via `+++ b/<path>`
 *   - Deletions      detected via `--- a/<path>` (+++ is /dev/null)
 *   - Pure renames   detected via `rename to <path>` (no --- or +++ present)
 *
 * When all sections are excluded the file is deleted so `hashFiles()` in
 * GitHub Actions returns `''` and downstream `if: hashFiles('pr.diff') != ''`
 * guards fire correctly.
 *
 * See filter-diff.ts for the pure filtering logic and I/O wrapper.
 */
import { applyFilter } from './filter-diff.js';

const [, , diffPath, excludePathsArg] = process.argv;

if (!diffPath) {
  process.stderr.write('Usage: filter-diff <diffPath> <excludePaths>\n');
  process.exit(1);
}

try {
  applyFilter(diffPath, excludePathsArg ?? '');
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
