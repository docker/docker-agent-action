/**
 * Unit tests for src/migrate-consumer-refs.
 *
 * Covers every consumer reference shape from the migration roadmap (Phase 1B):
 *   - root action `uses:` (SHA-pinned, tag-pinned, branch, with/without comments)
 *   - sub-action paths (review-pr, setup-credentials, review-pr/reply, …)
 *   - reusable workflow path (.github/workflows/review-pr.yml)
 *   - non-uses references (gh api URLs, --repo flags, markdown links)
 *   - repin mode (--sha/--version) vs slug-only mode
 *   - safety: similarly-named slugs are NOT rewritten
 *   - applyMigration I/O wrapper: in-place rewrite, per-file error collection
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMigration, migrateRefs, NEW_SLUG, OLD_SLUG } from '../migrate-refs.js';

const SHA_OLD = '3f5dc9969f307d3c76acb7e9ccaefdd96bd62f4b';
const SHA_NEW = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// ═════════════════════════════════════════════════════════════════════════════
// uses: references — slug-only mode
// ═════════════════════════════════════════════════════════════════════════════

describe('migrateRefs — uses: root action (slug-only)', () => {
  it('rewrites the slug and preserves the SHA ref', () => {
    const input = `      - uses: ${OLD_SLUG}@${SHA_OLD}\n`;
    const result = migrateRefs(input);
    expect(result.content).toBe(`      - uses: ${NEW_SLUG}@${SHA_OLD}\n`);
    expect(result.usesCount).toBe(1);
    expect(result.changed).toBe(true);
  });

  it('preserves an existing version comment', () => {
    const input = `      - uses: ${OLD_SLUG}@${SHA_OLD} # v1.5.4\n`;
    const result = migrateRefs(input);
    expect(result.content).toBe(`      - uses: ${NEW_SLUG}@${SHA_OLD} # v1.5.4\n`);
  });

  it('handles `uses:` without a dash prefix (job-level uses)', () => {
    const input = `    uses: ${OLD_SLUG}/.github/workflows/review-pr.yml@${SHA_OLD} # v1.5.4\n`;
    const result = migrateRefs(input);
    expect(result.content).toBe(
      `    uses: ${NEW_SLUG}/.github/workflows/review-pr.yml@${SHA_OLD} # v1.5.4\n`,
    );
    expect(result.usesCount).toBe(1);
  });

  it('handles tag refs', () => {
    const input = `      - uses: ${OLD_SLUG}@v1.4.2\n`;
    const result = migrateRefs(input);
    expect(result.content).toBe(`      - uses: ${NEW_SLUG}@v1.4.2\n`);
  });

  it('handles branch refs', () => {
    const input = `      - uses: ${OLD_SLUG}@main\n`;
    const result = migrateRefs(input);
    expect(result.content).toBe(`      - uses: ${NEW_SLUG}@main\n`);
  });

  it('handles quoted uses values', () => {
    const input = `      - uses: "${OLD_SLUG}@${SHA_OLD}"\n`;
    const result = migrateRefs(input);
    expect(result.content).toBe(`      - uses: "${NEW_SLUG}@${SHA_OLD}"\n`);
  });
});

describe('migrateRefs — uses: sub-actions and reusable workflow', () => {
  it.each([
    'review-pr',
    'review-pr/reply',
    'review-pr/mention-reply',
    'setup-credentials',
    '.github/workflows/review-pr.yml',
    '.github/actions/mention-reply',
  ])('rewrites the %s path', (subpath) => {
    const input = `      - uses: ${OLD_SLUG}/${subpath}@${SHA_OLD} # v1.5.4\n`;
    const result = migrateRefs(input);
    expect(result.content).toBe(`      - uses: ${NEW_SLUG}/${subpath}@${SHA_OLD} # v1.5.4\n`);
    expect(result.usesCount).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// uses: references — repin mode (--sha/--version)
// ═════════════════════════════════════════════════════════════════════════════

describe('migrateRefs — repin mode', () => {
  it('replaces the ref with the new SHA and version comment', () => {
    const input = `      - uses: ${OLD_SLUG}@${SHA_OLD} # v1.5.4\n`;
    const result = migrateRefs(input, { newSha: SHA_NEW, newVersion: 'v2.0.0' });
    expect(result.content).toBe(`      - uses: ${NEW_SLUG}@${SHA_NEW} # v2.0.0\n`);
  });

  it('repins tag refs to the SHA', () => {
    const input = `      - uses: ${OLD_SLUG}/review-pr@v1.4.2\n`;
    const result = migrateRefs(input, { newSha: SHA_NEW, newVersion: 'v2.0.0' });
    expect(result.content).toBe(`      - uses: ${NEW_SLUG}/review-pr@${SHA_NEW} # v2.0.0\n`);
  });

  it('repins the reusable workflow ref', () => {
    const input = `    uses: ${OLD_SLUG}/.github/workflows/review-pr.yml@${SHA_OLD} # v1.5.0\n`;
    const result = migrateRefs(input, { newSha: SHA_NEW, newVersion: 'v2.0.0' });
    expect(result.content).toBe(
      `    uses: ${NEW_SLUG}/.github/workflows/review-pr.yml@${SHA_NEW} # v2.0.0\n`,
    );
  });

  it('migrates the legacy .github/actions/setup-credentials path when re-pinning', () => {
    const input = `        uses: ${OLD_SLUG}/.github/actions/setup-credentials@${SHA_OLD} # v1.5.0\n`;
    const result = migrateRefs(input, { newSha: SHA_NEW, newVersion: 'v2.0.0' });
    expect(result.content).toBe(
      `        uses: ${NEW_SLUG}/setup-credentials@${SHA_NEW} # v2.0.0\n`,
    );
  });

  it('keeps the legacy setup-credentials path in slug-only mode (still valid at old SHAs)', () => {
    const input = `        uses: ${OLD_SLUG}/.github/actions/setup-credentials@${SHA_OLD} # v1.5.0\n`;
    const result = migrateRefs(input);
    expect(result.content).toBe(
      `        uses: ${NEW_SLUG}/.github/actions/setup-credentials@${SHA_OLD} # v1.5.0\n`,
    );
  });

  it('omits the comment when no version is given', () => {
    const input = `      - uses: ${OLD_SLUG}@${SHA_OLD} # v1.5.4\n`;
    const result = migrateRefs(input, { newSha: SHA_NEW });
    expect(result.content).toBe(`      - uses: ${NEW_SLUG}@${SHA_NEW}\n`);
  });

  it('rejects invalid SHAs', () => {
    expect(() => migrateRefs('x', { newSha: 'not-a-sha' })).toThrow(/40-char/);
    expect(() => migrateRefs('x', { newSha: SHA_NEW.toUpperCase() })).toThrow(/40-char/);
    expect(() => migrateRefs('x', { newSha: SHA_NEW.slice(0, 39) })).toThrow(/40-char/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// non-uses references
// ═════════════════════════════════════════════════════════════════════════════

describe('migrateRefs — non-uses references', () => {
  it('rewrites gh api URLs', () => {
    const input = `          OBJ=$(gh api "repos/${OLD_SLUG}/git/ref/tags/$VERSION" --jq .object.type)\n`;
    const result = migrateRefs(input);
    expect(result.content).toContain(`repos/${NEW_SLUG}/git/ref/tags/`);
    expect(result.otherCount).toBe(1);
    expect(result.usesCount).toBe(0);
  });

  it('rewrites --repo flags', () => {
    const input = `          gh release view --repo ${OLD_SLUG} --json tagName\n`;
    const result = migrateRefs(input);
    expect(result.content).toContain(`--repo ${NEW_SLUG} `);
  });

  it('rewrites markdown links', () => {
    const input = `See [the docs](https://github.com/${OLD_SLUG}/blob/main/README.md).\n`;
    const result = migrateRefs(input);
    expect(result.content).toContain(`https://github.com/${NEW_SLUG}/blob/main/README.md`);
  });

  it('rewrites multiple occurrences on a single line, counting it once', () => {
    const input = `echo "${OLD_SLUG} and ${OLD_SLUG} again"\n`;
    const result = migrateRefs(input);
    expect(result.content).toBe(`echo "${NEW_SLUG} and ${NEW_SLUG} again"\n`);
    expect(result.otherCount).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Safety
// ═════════════════════════════════════════════════════════════════════════════

describe('migrateRefs — safety', () => {
  it('does not rewrite similarly-named slugs', () => {
    const input = `      - uses: docker/cagent-action-fork@${SHA_OLD}\n`;
    const result = migrateRefs(input);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(input);
  });

  it('does not rewrite underscore-suffixed slugs on non-uses lines', () => {
    const input = 'gh api repos/docker/cagent-action_extended/releases\n';
    const result = migrateRefs(input);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(input);
  });

  it('still rewrites clone URLs ending in .git', () => {
    const input = 'git clone https://github.com/docker/cagent-action.git\n';
    const result = migrateRefs(input);
    expect(result.changed).toBe(true);
    expect(result.content).toBe(`git clone https://github.com/${NEW_SLUG}.git\n`);
  });

  it('does not rewrite the new slug (idempotent)', () => {
    const input = `      - uses: ${NEW_SLUG}@${SHA_OLD} # v2.0.0\n`;
    const result = migrateRefs(input);
    expect(result.changed).toBe(false);
  });

  it('is idempotent: running twice produces the same output', () => {
    const input = `      - uses: ${OLD_SLUG}@${SHA_OLD} # v1.5.4\n`;
    const once = migrateRefs(input, { newSha: SHA_NEW, newVersion: 'v2.0.0' });
    const twice = migrateRefs(once.content, { newSha: SHA_NEW, newVersion: 'v2.0.0' });
    expect(twice.content).toBe(once.content);
    expect(twice.changed).toBe(false);
  });

  it('returns changed=false for content with no references', () => {
    const input = 'name: CI\non: push\njobs: {}\n';
    const result = migrateRefs(input);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(input);
  });

  it('preserves unrelated lines byte-for-byte', () => {
    const input = [
      'name: Review',
      'jobs:',
      '  review:',
      `    uses: ${OLD_SLUG}/.github/workflows/review-pr.yml@${SHA_OLD} # v1.5.4`,
      '    secrets:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression in a test fixture
      '      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
      '',
    ].join('\n');
    const result = migrateRefs(input);
    const lines = result.content.split('\n');
    expect(lines[0]).toBe('name: Review');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression in a test fixture
    expect(lines[5]).toBe('      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}');
    expect(lines[6]).toBe('');
  });

  it('handles CRLF line endings', () => {
    const input = `      - uses: ${OLD_SLUG}@${SHA_OLD}\r\nname: x\r\n`;
    const result = migrateRefs(input);
    expect(result.content).toBe(`      - uses: ${NEW_SLUG}@${SHA_OLD}\r\nname: x\r\n`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Realistic consumer file shapes
// ═════════════════════════════════════════════════════════════════════════════

describe('migrateRefs — realistic consumer workflows', () => {
  it('two-workflow consumer pattern (reusable workflow caller)', () => {
    const input = [
      'name: PR Review',
      'on:',
      '  pull_request:',
      '    types: [opened, synchronize]',
      'jobs:',
      '  review:',
      `    uses: ${OLD_SLUG}/.github/workflows/review-pr.yml@${SHA_OLD} # v1.5.4`,
      '    secrets: inherit',
      '',
    ].join('\n');
    const result = migrateRefs(input, { newSha: SHA_NEW, newVersion: 'v2.0.0' });
    expect(result.usesCount).toBe(1);
    expect(result.content).toContain(
      `uses: ${NEW_SLUG}/.github/workflows/review-pr.yml@${SHA_NEW} # v2.0.0`,
    );
  });

  it('single-workflow consumer pattern (direct action usage)', () => {
    const input = [
      'jobs:',
      '  agent:',
      '    steps:',
      '      - name: Setup credentials',
      `        uses: ${OLD_SLUG}/setup-credentials@${SHA_OLD} # v1.5.4`,
      '      - name: Run agent',
      `        uses: ${OLD_SLUG}@${SHA_OLD} # v1.5.4`,
      '        with:',
      '          agent: docker/pirate',
      '',
    ].join('\n');
    const result = migrateRefs(input, { newSha: SHA_NEW, newVersion: 'v2.0.0' });
    expect(result.usesCount).toBe(2);
    expect(result.content).toContain(`uses: ${NEW_SLUG}/setup-credentials@${SHA_NEW} # v2.0.0`);
    expect(result.content).toContain(`uses: ${NEW_SLUG}@${SHA_NEW} # v2.0.0`);
    expect(result.content).not.toContain(OLD_SLUG);
  });

  it('mixed file with uses refs and API URL refs', () => {
    const input = [
      `        uses: ${OLD_SLUG}@${SHA_OLD}`,
      '        run: |',
      `          gh api "repos/${OLD_SLUG}/releases/latest"`,
      '',
    ].join('\n');
    const result = migrateRefs(input);
    expect(result.usesCount).toBe(1);
    expect(result.otherCount).toBe(1);
    expect(result.content).not.toContain(OLD_SLUG);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// applyMigration — I/O behaviour
// ═════════════════════════════════════════════════════════════════════════════

describe('applyMigration — I/O behaviour', () => {
  async function makeTmpDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'migrate-refs-test-'));
  }

  it('rewrites files in-place and reports them as changed', async () => {
    const dir = await makeTmpDir();
    try {
      const f1 = join(dir, 'review.yml');
      const f2 = join(dir, 'unrelated.yml');
      await writeFile(f1, `      - uses: ${OLD_SLUG}@${SHA_OLD} # v1.5.4\n`, 'utf-8');
      await writeFile(f2, 'name: CI\non: push\n', 'utf-8');

      const result = applyMigration([f1, f2], { newSha: SHA_NEW, newVersion: 'v2.0.0' });

      expect(result.changedFiles).toEqual([f1]);
      expect(result.errors).toHaveLength(0);
      expect(readFileSync(f1, 'utf-8')).toBe(`      - uses: ${NEW_SLUG}@${SHA_NEW} # v2.0.0\n`);
      expect(readFileSync(f2, 'utf-8')).toBe('name: CI\non: push\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('collects per-file errors without aborting the remaining files', async () => {
    const dir = await makeTmpDir();
    try {
      const good = join(dir, 'good.yml');
      const missing = join(dir, 'does-not-exist.yml');
      await writeFile(good, `      - uses: ${OLD_SLUG}@${SHA_OLD}\n`, 'utf-8');

      // The failing file comes FIRST — the good file after it must still be processed.
      const result = applyMigration([missing, good]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].file).toBe(missing);
      expect(result.changedFiles).toEqual([good]);
      expect(readFileSync(good, 'utf-8')).toBe(`      - uses: ${NEW_SLUG}@${SHA_OLD}\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not list unchanged files as changed', async () => {
    const dir = await makeTmpDir();
    try {
      const f = join(dir, 'already-migrated.yml');
      const content = `      - uses: ${NEW_SLUG}@${SHA_NEW} # v2.0.0\n`;
      await writeFile(f, content, 'utf-8');

      const result = applyMigration([f], { newSha: SHA_NEW, newVersion: 'v2.0.0' });

      expect(result.changedFiles).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(readFileSync(f, 'utf-8')).toBe(content);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws upfront on an invalid SHA (before touching any file)', async () => {
    const dir = await makeTmpDir();
    try {
      const f = join(dir, 'review.yml');
      const content = `      - uses: ${OLD_SLUG}@${SHA_OLD}\n`;
      await writeFile(f, content, 'utf-8');

      expect(() => applyMigration([f], { newSha: 'not-a-sha' })).toThrow(/40-char/);
      expect(readFileSync(f, 'utf-8')).toBe(content);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
