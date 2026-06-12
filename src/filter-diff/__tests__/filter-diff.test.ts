// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for src/filter-diff.
 *
 * The test suite is split into two layers:
 *
 *   1. filterDiff() — pure function tests covering every diff section type.
 *      These run entirely in-memory and have no filesystem dependencies.
 *
 *   2. applyFilter() — I/O integration tests that write real temp files and
 *      verify the in-place rewrite / deletion behaviour.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyFilter, filterDiff, parseExcludePrefixes } from '../filter-diff.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Standard modification diff for a file in the excluded prefix. */
const MOD_EXCLUDED = `${[
  'diff --git a/backend/gen/foo.pb.go b/backend/gen/foo.pb.go',
  'index abc..def 100644',
  '--- a/backend/gen/foo.pb.go',
  '+++ b/backend/gen/foo.pb.go',
  '@@ -1,2 +1,3 @@',
  ' existing',
  '+generated',
].join('\n')}\n`;

/** Deletion diff: `+++ /dev/null` — the path is only available via `--- a/`. */
const DEL_EXCLUDED = `${[
  'diff --git a/backend/gen/old.pb.go b/backend/gen/old.pb.go',
  'deleted file mode 100644',
  'index abc..0000000',
  '--- a/backend/gen/old.pb.go',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-line1',
  '-line2',
].join('\n')}\n`;

/** Pure rename at 100% similarity: no `---` or `+++` lines at all. */
const RENAME_EXCLUDED = `${[
  'diff --git a/backend/gen/old.pb.go b/backend/gen/new.pb.go',
  'similarity index 100%',
  'rename from backend/gen/old.pb.go',
  'rename to backend/gen/new.pb.go',
].join('\n')}\n`;

/** Modification diff for a file NOT in the excluded prefix. */
const MOD_KEPT = `${[
  'diff --git a/src/real.go b/src/real.go',
  'index abc..def 100644',
  '--- a/src/real.go',
  '+++ b/src/real.go',
  '@@ -1,1 +1,2 @@',
  ' existing',
  '+new line',
].join('\n')}\n`;

/** New-file diff (--- /dev/null): path only via `+++ b/`. */
const NEW_FILE_EXCLUDED = `${[
  'diff --git a/backend/gen/brand_new.pb.go b/backend/gen/brand_new.pb.go',
  'new file mode 100644',
  'index 0000000..abc',
  '--- /dev/null',
  '+++ b/backend/gen/brand_new.pb.go',
  '@@ -0,0 +1,3 @@',
  '+// Code generated — do not edit.',
  '+package gen',
  '+',
].join('\n')}\n`;

const PREFIXES = ['backend/gen/**'];

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'filter-diff-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeDiff(name: string, content: string): Promise<string> {
  const p = join(tmpDir, name);
  await writeFile(p, content, 'utf-8');
  return p;
}

// ═════════════════════════════════════════════════════════════════════════════
// parseExcludePrefixes
// ═════════════════════════════════════════════════════════════════════════════

describe('parseExcludePrefixes', () => {
  it('splits on newlines and trims whitespace', () => {
    expect(parseExcludePrefixes('  backend/gen/\n  frontend/src/gen/  \n')).toEqual([
      'backend/gen/**',
      'frontend/src/gen/**',
    ]);
  });

  it('strips carriage-return characters (Windows line-endings)', () => {
    expect(parseExcludePrefixes('backend/gen/\r\nfrontend/src/gen/\r\n')).toEqual([
      'backend/gen/**',
      'frontend/src/gen/**',
    ]);
  });

  it('removes blank lines', () => {
    expect(parseExcludePrefixes('\n\nbackend/gen/\n\n')).toEqual(['backend/gen/**']);
  });

  it('returns empty array for empty string', () => {
    expect(parseExcludePrefixes('')).toEqual([]);
  });

  it('expands trailing-slash entries to <entry>** glob', () => {
    expect(parseExcludePrefixes('vendor/')).toEqual(['vendor/**']);
  });

  it('passes through existing glob patterns unchanged', () => {
    expect(parseExcludePrefixes('**/package-lock.json')).toEqual(['**/package-lock.json']);
  });

  it('leaves exact file paths unchanged', () => {
    expect(parseExcludePrefixes('package-lock.json')).toEqual(['package-lock.json']);
    expect(parseExcludePrefixes('alertz/tools/package-lock.json')).toEqual([
      'alertz/tools/package-lock.json',
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// filterDiff — pure function
// ═════════════════════════════════════════════════════════════════════════════

describe('filterDiff — modified file in excluded prefix', () => {
  it('strips the section from the output', () => {
    const result = filterDiff(MOD_EXCLUDED, PREFIXES);
    expect(result.excludedFiles).toEqual(['backend/gen/foo.pb.go']);
    expect(result.remainingCount).toBe(0);
    expect(result.filtered).toBe('');
  });

  it('does not double-log the path (--- and +++ share the same path)', () => {
    const result = filterDiff(MOD_EXCLUDED, PREFIXES);
    expect(result.excludedFiles).toHaveLength(1);
  });
});

describe('filterDiff — deleted file in excluded prefix', () => {
  it('strips the section even though +++ is /dev/null', () => {
    const result = filterDiff(DEL_EXCLUDED, PREFIXES);
    expect(result.excludedFiles).toEqual(['backend/gen/old.pb.go']);
    expect(result.remainingCount).toBe(0);
  });

  it('logs the path from the --- a/ line', () => {
    const result = filterDiff(DEL_EXCLUDED, PREFIXES);
    expect(result.excludedFiles[0]).toBe('backend/gen/old.pb.go');
  });
});

describe('filterDiff — pure rename in excluded prefix', () => {
  it('strips the section (no --- or +++ lines present)', () => {
    const result = filterDiff(RENAME_EXCLUDED, PREFIXES);
    expect(result.excludedFiles).toEqual(['backend/gen/new.pb.go']);
    expect(result.remainingCount).toBe(0);
  });
});

describe('filterDiff — new file in excluded prefix', () => {
  it('strips the section detected via +++ b/ (--- is /dev/null)', () => {
    const result = filterDiff(NEW_FILE_EXCLUDED, PREFIXES);
    expect(result.excludedFiles).toEqual(['backend/gen/brand_new.pb.go']);
    expect(result.remainingCount).toBe(0);
  });
});

describe('filterDiff — file NOT in excluded prefix', () => {
  it('preserves the section unchanged', () => {
    const result = filterDiff(MOD_KEPT, PREFIXES);
    expect(result.excludedFiles).toHaveLength(0);
    expect(result.remainingCount).toBe(1);
    expect(result.filtered).toBe(MOD_KEPT);
  });
});

describe('filterDiff — mixed diff (excluded + kept)', () => {
  const mixed = MOD_EXCLUDED + MOD_KEPT;

  it('strips the excluded section and keeps the other', () => {
    const result = filterDiff(mixed, PREFIXES);
    expect(result.excludedFiles).toEqual(['backend/gen/foo.pb.go']);
    expect(result.remainingCount).toBe(1);
  });

  it('the kept section content is present in the output', () => {
    const result = filterDiff(mixed, PREFIXES);
    expect(result.filtered).toContain('diff --git a/src/real.go');
    expect(result.filtered).not.toContain('diff --git a/backend/gen/foo.pb.go');
  });

  it('all four section types in one diff', () => {
    const all = MOD_EXCLUDED + DEL_EXCLUDED + RENAME_EXCLUDED + NEW_FILE_EXCLUDED + MOD_KEPT;
    const result = filterDiff(all, PREFIXES);
    expect(result.excludedFiles).toHaveLength(4);
    expect(result.remainingCount).toBe(1);
    expect(result.filtered).toContain('diff --git a/src/real.go');
    expect(result.filtered).not.toContain('backend/gen/');
  });
});

describe('filterDiff — all sections excluded', () => {
  it('returns empty filtered string and remainingCount 0', () => {
    const all = MOD_EXCLUDED + DEL_EXCLUDED + RENAME_EXCLUDED;
    const result = filterDiff(all, PREFIXES);
    expect(result.filtered).toBe('');
    expect(result.remainingCount).toBe(0);
    expect(result.excludedFiles).toHaveLength(3);
  });
});

describe('filterDiff — empty exclude-paths', () => {
  it('returns the diff unchanged when no prefixes are given', () => {
    const result = filterDiff(MOD_EXCLUDED, []);
    expect(result.filtered).toBe(MOD_EXCLUDED);
    expect(result.excludedFiles).toHaveLength(0);
    expect(result.remainingCount).toBe(1);
  });
});

describe('filterDiff — empty diff content', () => {
  it('returns empty result without errors', () => {
    const result = filterDiff('', PREFIXES);
    expect(result.filtered).toBe('');
    expect(result.excludedFiles).toHaveLength(0);
    expect(result.remainingCount).toBe(0);
  });
});

describe('filterDiff — glob pattern (**/name)', () => {
  const lockAtRoot = `${[
    'diff --git a/package-lock.json b/package-lock.json',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    '+updated',
  ].join('\n')}\n`;

  const lockNested = `${[
    'diff --git a/harbor-master/tools/package-lock.json b/harbor-master/tools/package-lock.json',
    '--- a/harbor-master/tools/package-lock.json',
    '+++ b/harbor-master/tools/package-lock.json',
    '+updated',
  ].join('\n')}\n`;

  const notALock = `${[
    'diff --git a/src/index.ts b/src/index.ts',
    '--- a/src/index.ts',
    '+++ b/src/index.ts',
    '+code',
  ].join('\n')}\n`;

  it('matches a lock file at the repo root', () => {
    const result = filterDiff(lockAtRoot, ['**/package-lock.json']);
    expect(result.excludedFiles).toEqual(['package-lock.json']);
    expect(result.remainingCount).toBe(0);
  });

  it('matches a lock file in a nested directory', () => {
    const result = filterDiff(lockNested, ['**/package-lock.json']);
    expect(result.excludedFiles).toEqual(['harbor-master/tools/package-lock.json']);
    expect(result.remainingCount).toBe(0);
  });

  it('does not match an unrelated file', () => {
    const result = filterDiff(notALock, ['**/package-lock.json']);
    expect(result.excludedFiles).toHaveLength(0);
    expect(result.remainingCount).toBe(1);
  });

  it('excludes all matching files across depths while keeping non-matching files', () => {
    const result = filterDiff(lockAtRoot + lockNested + notALock, ['**/package-lock.json']);
    expect(result.excludedFiles).toHaveLength(2);
    expect(result.remainingCount).toBe(1);
    expect(result.filtered).toContain('src/index.ts');
  });

  it('directory glob and wildcard glob patterns work together', () => {
    const result = filterDiff(MOD_EXCLUDED + lockNested + MOD_KEPT, [
      'backend/gen/**',
      '**/package-lock.json',
    ]);
    expect(result.excludedFiles).toHaveLength(2);
    expect(result.remainingCount).toBe(1);
  });
});

describe('filterDiff — glob pattern (? and [...] metacharacters)', () => {
  const logFile = `${[
    'diff --git a/src/app.log b/src/app.log',
    '--- a/src/app.log',
    '+++ b/src/app.log',
    '+logged',
  ].join('\n')}\n`;

  const generatedFile = `${[
    'diff --git a/src/generated/api.ts b/src/generated/api.ts',
    '--- a/src/generated/api.ts',
    '+++ b/src/generated/api.ts',
    '+// generated',
  ].join('\n')}\n`;

  const keptFile = `${[
    'diff --git a/src/index.ts b/src/index.ts',
    '--- a/src/index.ts',
    '+++ b/src/index.ts',
    '+code',
  ].join('\n')}\n`;

  it('matches files using ? single-character wildcard', () => {
    const result = filterDiff(logFile + keptFile, ['src/app.lo?']);
    expect(result.excludedFiles).toEqual(['src/app.log']);
    expect(result.remainingCount).toBe(1);
  });

  it('matches files using [...] character class', () => {
    const result = filterDiff(generatedFile + keptFile, ['src/[gG]enerated/**']);
    expect(result.excludedFiles).toEqual(['src/generated/api.ts']);
    expect(result.remainingCount).toBe(1);
  });
});

describe('filterDiff — multiple exclude prefixes', () => {
  it('excludes sections matching any of the configured prefixes', () => {
    const frontendExcluded = `${[
      'diff --git a/frontend/src/gen/api.ts b/frontend/src/gen/api.ts',
      '--- a/frontend/src/gen/api.ts',
      '+++ b/frontend/src/gen/api.ts',
      '+// generated',
    ].join('\n')}\n`;

    const result = filterDiff(MOD_EXCLUDED + frontendExcluded + MOD_KEPT, [
      'backend/gen/**',
      'frontend/src/gen/**',
    ]);
    expect(result.excludedFiles).toHaveLength(2);
    expect(result.remainingCount).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// applyFilter — I/O behaviour
// ═════════════════════════════════════════════════════════════════════════════

describe('applyFilter — rewrites file in-place when some sections remain', () => {
  it('file contains only the kept section after filtering', async () => {
    const p = await writeDiff('pr.diff', MOD_EXCLUDED + MOD_KEPT);
    applyFilter(p, PREFIXES.join('\n'));
    const after = readFileSync(p, 'utf-8');
    expect(after).toContain('diff --git a/src/real.go');
    expect(after).not.toContain('backend/gen/');
  });
});

describe('applyFilter — deletes the file when all sections are excluded', () => {
  it('file no longer exists after all sections are filtered out', async () => {
    const p = await writeDiff('pr.diff', MOD_EXCLUDED + DEL_EXCLUDED);
    applyFilter(p, PREFIXES.join('\n'));
    expect(existsSync(p)).toBe(false);
  });
});

describe('applyFilter — no-op when exclude-paths is empty', () => {
  it('leaves the file unchanged', async () => {
    const original = MOD_EXCLUDED + MOD_KEPT;
    const p = await writeDiff('pr.diff', original);
    applyFilter(p, '');
    expect(readFileSync(p, 'utf-8')).toBe(original);
  });
});

describe('applyFilter — warns on bare directory entries', () => {
  it('emits a warning to stderr when an entry looks like a bare directory name', async () => {
    const p = await writeDiff('pr.diff', MOD_KEPT);
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string) => {
      stderr.push(s);
      return true;
    };
    try {
      applyFilter(p, 'vendor');
    } finally {
      process.stderr.write = original;
    }
    expect(stderr.some((s) => s.includes('"vendor"') && s.includes('trailing slash'))).toBe(true);
  });

  it('does not warn for entries with a file extension', async () => {
    const p = await writeDiff('pr.diff', MOD_KEPT);
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string) => {
      stderr.push(s);
      return true;
    };
    try {
      applyFilter(p, 'package-lock.json');
    } finally {
      process.stderr.write = original;
    }
    expect(stderr.some((s) => s.includes('trailing slash'))).toBe(false);
  });
});

describe('applyFilter — no-op when exclude-paths has only blank lines', () => {
  it('leaves the file unchanged', async () => {
    const original = MOD_EXCLUDED;
    const p = await writeDiff('pr.diff', original);
    applyFilter(p, '\n  \n\r\n');
    expect(readFileSync(p, 'utf-8')).toBe(original);
  });
});
