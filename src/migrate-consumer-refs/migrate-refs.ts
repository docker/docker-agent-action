/**
 * migrate-consumer-refs — core logic for rewriting `docker/cagent-action`
 * references to `docker/docker-agent-action` in consumer workflow files.
 *
 * The action moved to a brand new repo (`docker/docker-agent-action`) rather
 * than renaming in place — GitHub Actions `uses:` references do not follow
 * repository renames. The old repo stays live during the transition, so this
 * migration is incremental and consumers run it at their own pace.
 *
 * Handles every consumer reference shape observed in the wild:
 *
 *   uses: docker/cagent-action@SHA                                  # root action
 *   uses: docker/cagent-action@SHA # v1.5.4                         # with version comment
 *   uses: docker/cagent-action/review-pr@SHA                        # sub-action
 *   uses: docker/cagent-action/setup-credentials@SHA                # sub-action
 *   uses: docker/cagent-action/.github/workflows/review-pr.yml@SHA  # reusable workflow
 *   uses: docker/cagent-action@v1.5.4                               # tag ref (older repos)
 *   uses: docker/cagent-action@main                                 # branch ref
 *
 * Two rewrite modes:
 *
 *   - slug-only: replace the repo slug, keep the existing ref untouched.
 *   - repin: replace the repo slug AND update the ref to a new SHA with a
 *     `# vX.Y.Z` trailing comment (the default for migration PRs, so
 *     consumers land on a release published under the new name).
 *
 * Non-`uses:` references (e.g. `gh api repos/docker/cagent-action/...`,
 * documentation links) are also rewritten via the plain slug replacement,
 * but only on lines that actually contain the old slug — the rest of the
 * file is preserved byte-for-byte.
 *
 * Pure functions plus a thin I/O wrapper (applyMigration) used by the CLI in
 * index.ts — mirroring the filter-diff module layout.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const OLD_SLUG = 'docker/cagent-action';
export const NEW_SLUG = 'docker/docker-agent-action';

/**
 * Sub-action paths that moved between old releases and the current tree.
 * Applied ONLY when re-pinning (newSha set): at old SHAs the old path still
 * exists in the new repo's history, so slug-only mode must keep it untouched —
 * but a re-pinned ref pointing at the new tree with the old path would 404.
 */
const SUBPATH_MIGRATIONS: ReadonlyArray<[string, string]> = [
  ['/.github/actions/setup-credentials', '/setup-credentials'],
];

export interface MigrateOptions {
  /**
   * When set, every `uses:` reference to the new repo is re-pinned to
   * this commit SHA (with `# version` appended as a comment).
   * When undefined, existing refs are preserved (slug-only mode).
   */
  newSha?: string;
  /** Human-readable version (e.g. `v2.0.0`) appended as a trailing comment when re-pinning. */
  newVersion?: string;
}

export interface MigrateResult {
  /** Rewritten file content. Identical to input when no references were found. */
  content: string;
  /** True when at least one replacement was made. */
  changed: boolean;
  /** Count of `uses:` references rewritten. */
  usesCount: number;
  /** Count of non-`uses:` references rewritten (API URLs, doc links, etc.). */
  otherCount: number;
}

/**
 * Escape a string for use inside a RegExp.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches a `uses:` line referencing the old repo. Captures:
 *   1. prefix     — everything before the slug (indentation, `- uses:`, quotes)
 *   2. subpath    — optional sub-action / workflow path (e.g. `/review-pr`)
 *   3. ref        — the ref after `@` (SHA, tag, or branch)
 *   4. comment    — optional trailing ` # vX.Y.Z` comment
 *
 * The slug must be followed by `/` or `@` so that a hypothetical
 * `docker/cagent-action-fork` is not matched.
 */
const USES_RE = new RegExp(
  `^(\\s*(?:-\\s*)?uses:\\s*["']?)${escapeRegExp(OLD_SLUG)}((?:/[^@\\s"']*)?)@([^\\s"'#]+)(["']?)([ \\t]*#[^\\n]*)?\\s*$`,
);

/**
 * Plain slug occurrences on non-`uses:` lines (API URLs, --repo flags, links).
 * Guarded so `docker/cagent-action-foo` or `docker/cagent-action_foo` is not
 * rewritten (GitHub repo names allow letters, digits, hyphens, underscores
 * and dots — dots are excluded from the lookahead on purpose, since a slug
 * followed by `.` is overwhelmingly a sentence/URL boundary, e.g.
 * `docker/cagent-action.git`).
 */
const PLAIN_RE = new RegExp(`${escapeRegExp(OLD_SLUG)}(?![A-Za-z0-9_-])`, 'g');

/**
 * Rewrite all old-slug references in a single file's content.
 */
export function migrateRefs(content: string, options: MigrateOptions = {}): MigrateResult {
  if (options.newSha !== undefined && !/^[0-9a-f]{40}$/.test(options.newSha)) {
    throw new Error(`newSha must be a 40-char lowercase hex SHA, got: "${options.newSha}"`);
  }

  // Preserve the original line ending style and trailing newline exactly:
  // split on \n and re-join, keeping any \r at line ends untouched (the
  // regexes tolerate \r via the trailing \s* / [^\n] classes only on full
  // matches, so handle \r explicitly).
  const lines = content.split('\n');
  let usesCount = 0;
  let otherCount = 0;

  const out = lines.map((rawLine) => {
    // Tolerate CRLF: strip a trailing \r for matching, re-append afterwards.
    const hasCR = rawLine.endsWith('\r');
    const line = hasCR ? rawLine.slice(0, -1) : rawLine;

    const usesMatch = line.match(USES_RE);
    if (usesMatch) {
      const [, prefix, subpath, ref, closeQuote, comment] = usesMatch;
      usesCount++;
      let newRef = ref;
      let newComment = comment ?? '';
      let newSubpath = subpath;
      if (options.newSha !== undefined) {
        newRef = options.newSha;
        newComment = options.newVersion ? ` # ${options.newVersion}` : '';
        for (const [oldPath, newPath] of SUBPATH_MIGRATIONS) {
          if (newSubpath === oldPath) newSubpath = newPath;
        }
      }
      const rebuilt = `${prefix}${NEW_SLUG}${newSubpath}@${newRef}${closeQuote}${newComment}`;
      return hasCR ? `${rebuilt}\r` : rebuilt;
    }

    // Cheap substring guard before the regex replace — .replace() with a /g
    // regex resets lastIndex itself, so no manual lastIndex bookkeeping is
    // needed. Compare before/after so guarded near-misses (e.g.
    // `docker/cagent-action-fork`, excluded by the lookahead) don't inflate
    // otherCount.
    if (line.includes(OLD_SLUG)) {
      const rebuilt = line.replace(PLAIN_RE, NEW_SLUG);
      if (rebuilt !== line) {
        otherCount++;
        return hasCR ? `${rebuilt}\r` : rebuilt;
      }
    }

    return rawLine;
  });

  const result = out.join('\n');
  return {
    content: result,
    changed: result !== content,
    usesCount,
    otherCount,
  };
}

// ---------------------------------------------------------------------------
// I/O wrapper (used by the CLI entry point)
// ---------------------------------------------------------------------------

export interface ApplyMigrationResult {
  /** Files that were rewritten on disk (in input order). */
  changedFiles: string[];
  /** Per-file failures (read/write errors). Files in this list were NOT partially written. */
  errors: Array<{ file: string; message: string }>;
}

/**
 * Apply migrateRefs to each file in-place.
 *
 * Per-file errors (unreadable file, write failure) are collected instead of
 * aborting the loop, so a single bad file cannot leave the caller with a
 * silently truncated "changed files" list. Callers MUST treat a non-empty
 * `errors` array as a failure (the CLI exits 1) — this prevents the
 * migrate-consumers workflow from committing a partial migration.
 *
 * Progress messages are written to stderr.
 */
export function applyMigration(
  files: string[],
  options: MigrateOptions = {},
): ApplyMigrationResult {
  // Validate options once upfront so an invalid SHA fails fast instead of
  // being reported once per file.
  if (options.newSha !== undefined && !/^[0-9a-f]{40}$/.test(options.newSha)) {
    throw new Error(`newSha must be a 40-char lowercase hex SHA, got: "${options.newSha}"`);
  }

  const changedFiles: string[] = [];
  const errors: ApplyMigrationResult['errors'] = [];

  for (const file of files) {
    try {
      const before = readFileSync(file, 'utf-8');
      const result = migrateRefs(before, options);
      if (result.changed) {
        writeFileSync(file, result.content, 'utf-8');
        changedFiles.push(file);
        process.stderr.write(
          `✅ ${file}: ${result.usesCount} uses ref(s), ${result.otherCount} other ref(s) rewritten\n`,
        );
      } else {
        process.stderr.write(`ℹ️  ${file}: no old references found\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ file, message });
      process.stderr.write(`⚠️  ${file}: ${message}\n`);
    }
  }

  return { changedFiles, errors };
}
