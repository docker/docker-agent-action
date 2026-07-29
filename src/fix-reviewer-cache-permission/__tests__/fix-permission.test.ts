// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for src/fix-reviewer-cache-permission.
 *
 * Covers:
 *   - the canonical 1-workflow and 2-workflow consumer patterns from
 *     .agents/skills/add-pr-reviewer-to-repo/SKILL.md
 *   - ref shapes (SHA-pinned with comment, tag, branch), quoting, key order
 *   - comment/indentation/CRLF preservation (byte-for-byte except the value)
 *   - scoping: only the reviewer-calling job's permissions block is touched —
 *     never a top-level permissions block, another job, or embedded scripts
 *   - classification: jobs already on `actions: write` are distinguished
 *     from jobs the safe flip cannot fix (no permissions block,
 *     read-all/write-all, no actions entry, actions: none, multi-line flow
 *     mappings), including mixed multi-job files that are flipped AND still
 *     flagged for manual review
 *   - idempotency
 *   - applyFix I/O wrapper: in-place rewrite, changed/compliant/manual/
 *     skipped classification (mixed files land in two buckets), per-file
 *     error collection
 *   - statusLines: the machine-readable stdout contract the
 *     fix-reviewer-cache-permissions workflow greps
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyFix,
  fixReviewerCachePermission,
  REVIEWER_WORKFLOW_PATH,
  statusLines,
} from '../fix-permission.js';

const SHA = '3f5dc9969f307d3c76acb7e9ccaefdd96bd62f4b';

/** Canonical 1-workflow consumer (SKILL.md §4a) with a given actions value. */
function oneWorkflowConsumer(actionsLine: string, ref = 'v2.0.0'): string {
  return [
    'name: PR Review',
    'on:',
    '  pull_request:',
    '    types: [ready_for_review, opened, review_requested]',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  review:',
    `    uses: ${REVIEWER_WORKFLOW_PATH}@${ref}`,
    '    permissions:',
    '      contents: read # Read repository files and PR diffs',
    '      pull-requests: write # Post review comments',
    '      issues: write # Create security incident issues if secrets detected',
    '      checks: write # (Optional) Show review progress as a check run',
    '      id-token: write # Required for OIDC authentication to AWS Secrets Manager',
    actionsLine,
    '',
  ].join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// Basic fix behaviour
// ═════════════════════════════════════════════════════════════════════════════

describe('fixReviewerCachePermission — basic fix', () => {
  it('flips actions: read to actions: write in the calling job', () => {
    const input = oneWorkflowConsumer('      actions: read');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(true);
    expect(result.hasReviewerJob).toBe(true);
    expect(result.replacedCount).toBe(1);
    expect(result.manualJobs).toEqual([]);
    expect(result.content).toBe(oneWorkflowConsumer('      actions: write'));
  });

  it('preserves a trailing comment on the actions line', () => {
    const input = oneWorkflowConsumer('      actions: read # Cache and artifact access');
    const result = fixReviewerCachePermission(input);
    expect(result.content).toBe(
      oneWorkflowConsumer('      actions: write # Cache and artifact access'),
    );
  });

  it('changes nothing else in the file (byte-for-byte)', () => {
    const input = oneWorkflowConsumer('      actions: read');
    const result = fixReviewerCachePermission(input);
    const inLines = input.split('\n');
    const outLines = result.content.split('\n');
    expect(outLines).toHaveLength(inLines.length);
    for (let i = 0; i < inLines.length; i++) {
      if (inLines[i] === '      actions: read') {
        expect(outLines[i]).toBe('      actions: write');
      } else {
        expect(outLines[i]).toBe(inLines[i]);
      }
    }
  });

  it.each([
    ['SHA-pinned with version comment', `${SHA} # v2.0.0`],
    ['SHA-pinned', SHA],
    ['tag', 'v2.0.0'],
    ['branch', 'main'],
  ])('matches the reusable workflow ref: %s', (_name, ref) => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@${ref}`,
      '    permissions:',
      '      actions: read',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('      actions: write');
  });

  it('handles a quoted uses value', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: "${REVIEWER_WORKFLOW_PATH}@v2.0.0"`,
      '    permissions:',
      '      actions: read',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(true);
  });

  it.each([
    ['double-quoted', '      actions: "read"', '      actions: "write"'],
    ['single-quoted', "      actions: 'read'", "      actions: 'write'"],
  ])('handles %s permission values', (_name, before, after) => {
    const input = oneWorkflowConsumer(before);
    const result = fixReviewerCachePermission(input);
    expect(result.content).toBe(oneWorkflowConsumer(after));
  });

  it('handles permissions listed before uses (key order is not fixed)', () => {
    const input = [
      'jobs:',
      '  review:',
      '    permissions:',
      '      contents: read',
      '      actions: read',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    secrets: inherit',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('      actions: write');
    expect(result.content).toContain('      contents: read');
  });

  it('handles blank lines and comment lines inside the permissions block', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions:',
      '      contents: read',
      '',
      '      # cache access',
      '      actions: read',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('      # cache access\n      actions: write');
  });

  it('handles a comment after the permissions: key', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions: # least privilege',
      '      actions: read',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(true);
  });

  it('handles a single-line flow mapping', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions: { contents: read, actions: read, id-token: write }',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(true);
    expect(result.content).toContain(
      '    permissions: { contents: read, actions: write, id-token: write }',
    );
  });

  it('handles a flow mapping where actions is the only entry', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions: {actions: read}',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.content).toContain('    permissions: {actions: write}');
  });

  it('preserves CRLF line endings', () => {
    const input = oneWorkflowConsumer('      actions: read').replace(/\n/g, '\r\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(true);
    expect(result.content).toBe(oneWorkflowConsumer('      actions: write').replace(/\n/g, '\r\n'));
  });

  it('fixes deeper-indented (4-space) consumer files', () => {
    const input = [
      'jobs:',
      '    review:',
      `        uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '        permissions:',
      '            actions: read',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('            actions: write');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scoping — never modify anything but the calling job's permissions
// ═════════════════════════════════════════════════════════════════════════════

describe('fixReviewerCachePermission — scoping', () => {
  it('never modifies a top-level permissions block', () => {
    const input = [
      'name: PR Review',
      'permissions:',
      '  contents: read',
      '  actions: read',
      '',
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions:',
      '      actions: read',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.replacedCount).toBe(1);
    const lines = result.content.split('\n');
    expect(lines[3]).toBe('  actions: read'); // top-level untouched
    expect(lines[9]).toBe('      actions: write');
  });

  it('never modifies a job that does not call the reviewer workflow', () => {
    const input = [
      'jobs:',
      '  other:',
      '    runs-on: ubuntu-latest',
      '    permissions:',
      '      actions: read',
      '    steps:',
      '      - run: echo hi',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions:',
      '      actions: read',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.replacedCount).toBe(1);
    const lines = result.content.split('\n');
    expect(lines[4]).toBe('      actions: read'); // other job untouched
    expect(lines[10]).toBe('      actions: write');
  });

  it('fixes every job that calls the reviewer workflow', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions:',
      '      actions: read',
      '  review-again:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@main`,
      '    permissions:',
      '      actions: read',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.replacedCount).toBe(2);
    expect(result.manualJobs).toEqual([]);
    expect(result.content).not.toContain('actions: read');
  });

  it('ignores step-level uses of the root action', () => {
    const input = [
      'jobs:',
      '  agent:',
      '    runs-on: ubuntu-latest',
      '    permissions:',
      '      actions: read',
      '    steps:',
      `      - uses: docker/docker-agent-action@${SHA} # v2.0.0`,
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.hasReviewerJob).toBe(false);
  });

  it('ignores a local self-reference to review-pr.yml (this repo dogfooding)', () => {
    const input = [
      'jobs:',
      '  review:',
      '    uses: ./.github/workflows/review-pr.yml',
      '    permissions:',
      '      actions: read',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.hasReviewerJob).toBe(false);
  });

  it('ignores the old docker/cagent-action slug', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: docker/cagent-action/.github/workflows/review-pr.yml@${SHA}`,
      '    permissions:',
      '      actions: read',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.hasReviewerJob).toBe(false);
  });

  it('ignores other reusable workflows from the same repo', () => {
    const input = [
      'jobs:',
      '  e2e:',
      `    uses: docker/docker-agent-action/.github/workflows/test-e2e.yml@${SHA}`,
      '    permissions:',
      '      actions: read',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.hasReviewerJob).toBe(false);
  });

  it('ignores workflow-shaped text inside a run block scalar', () => {
    const input = [
      'jobs:',
      '  helper:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: |',
      "          cat <<'EOF' > fake.yml",
      '          jobs:',
      '            review:',
      `              uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '              permissions:',
      '                actions: read',
      '          EOF',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.hasReviewerJob).toBe(false);
  });

  it('does not touch an actions: read entry in a sibling block after jobs', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions:',
      '      actions: read',
      'env:',
      '  FOO: bar',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.replacedCount).toBe(1);
    expect(result.content).toContain('  FOO: bar');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Already compliant — every reviewer-calling job has actions: write
// ═════════════════════════════════════════════════════════════════════════════

describe('fixReviewerCachePermission — already compliant', () => {
  it('is a no-op when actions: write is already set', () => {
    const input = oneWorkflowConsumer('      actions: write # Cache read/write');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.hasReviewerJob).toBe(true);
    expect(result.manualJobs).toEqual([]);
    expect(result.content).toBe(input);
  });

  it('recognises a quoted actions: "write" as compliant', () => {
    const result = fixReviewerCachePermission(oneWorkflowConsumer('      actions: "write"'));
    expect(result.changed).toBe(false);
    expect(result.hasReviewerJob).toBe(true);
    expect(result.manualJobs).toEqual([]);
  });

  it('recognises actions: write inside a single-line flow mapping as compliant', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions: { contents: read, actions: write }',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.hasReviewerJob).toBe(true);
    expect(result.manualJobs).toEqual([]);
  });

  it('is idempotent: running twice produces the same output and reports compliant', () => {
    const input = oneWorkflowConsumer('      actions: read');
    const once = fixReviewerCachePermission(input);
    const twice = fixReviewerCachePermission(once.content);
    expect(twice.changed).toBe(false);
    expect(twice.manualJobs).toEqual([]);
    expect(twice.content).toBe(once.content);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Needs manual review — reviewer jobs the safe flip cannot make compliant.
// ═════════════════════════════════════════════════════════════════════════════

describe('fixReviewerCachePermission — needs manual review', () => {
  it('reports a calling job without a permissions block (inserting keys is out of scope)', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    secrets: inherit',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.hasReviewerJob).toBe(true);
    expect(result.manualJobs).toEqual(['review']);
    expect(result.content).toBe(input);
  });

  it('reports permissions: read-all (not a per-scope mapping the flip can edit)', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions: read-all',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.hasReviewerJob).toBe(true);
    expect(result.manualJobs).toEqual(['review']);
  });

  it('reports permissions: write-all (only an explicit actions: write counts as compliant)', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions: write-all',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.manualJobs).toEqual(['review']);
  });

  it('reports an explicit actions: none instead of overriding it silently', () => {
    const input = oneWorkflowConsumer('      actions: none');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.hasReviewerJob).toBe(true);
    expect(result.manualJobs).toEqual(['review']);
    expect(result.content).toBe(input);
  });

  it('reports a permissions block without an actions entry', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions:',
      '      contents: read',
      '      pull-requests: write',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.hasReviewerJob).toBe(true);
    expect(result.manualJobs).toEqual(['review']);
  });

  it('reports a single-line flow mapping without an actions entry', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions: { contents: read, pull-requests: write }',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.manualJobs).toEqual(['review']);
  });

  it('reports a multi-line flow mapping as unsupported (documented limitation)', () => {
    // The scanner only recognises single-line flow mappings; spanning lines
    // is valid YAML but out of scope, so the job must surface as manual —
    // and the file must NOT be half-edited.
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions: {',
      '      actions: read }',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.manualJobs).toEqual(['review']);
    expect(result.content).toBe(input);
  });

  it('flips the fixable job AND reports the non-fixable one in a mixed file', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions:',
      '      actions: read',
      '  review-fork:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@main`,
      '    secrets: inherit',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(true);
    expect(result.replacedCount).toBe(1);
    expect(result.content).toContain('      actions: write');
    expect(result.manualJobs).toEqual(['review-fork']);
  });

  it('reports the manual job even when another job is already compliant', () => {
    const input = [
      'jobs:',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions:',
      '      actions: write',
      '  review-fork:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@main`,
      '    permissions: read-all',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.hasReviewerJob).toBe(true);
    expect(result.manualJobs).toEqual(['review-fork']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// No reviewer job / degenerate files
// ═════════════════════════════════════════════════════════════════════════════

describe('fixReviewerCachePermission — no reviewer job', () => {
  it('returns unchanged for a file with no jobs section', () => {
    const input = 'name: CI\non: push\n';
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
    expect(result.hasReviewerJob).toBe(false);
    expect(result.manualJobs).toEqual([]);
    expect(result.content).toBe(input);
  });

  it('returns unchanged for an empty jobs section', () => {
    const input = 'name: CI\non: push\njobs:\n';
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(false);
  });

  it('returns unchanged for an empty file', () => {
    const result = fixReviewerCachePermission('');
    expect(result.changed).toBe(false);
    expect(result.content).toBe('');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Realistic consumer file shapes
// ═════════════════════════════════════════════════════════════════════════════

describe('fixReviewerCachePermission — realistic consumer workflows', () => {
  it('2-workflow fork pattern with a multi-line if condition', () => {
    const input = [
      'name: PR Review',
      'on:',
      '  issue_comment:',
      '    types: [created]',
      '  workflow_run:',
      '    workflows: ["PR Review - Trigger"]',
      '    types: [completed]',
      '',
      'permissions:',
      '  contents: read',
      '',
      'jobs:',
      '  review:',
      '    if: |',
      "      (github.event_name == 'issue_comment' &&",
      "       github.event.comment.user.login != 'docker-agent' &&",
      "       github.event.comment.user.type != 'Bot') ||",
      "      github.event.workflow_run.conclusion == 'success'",
      `    uses: ${REVIEWER_WORKFLOW_PATH}@${SHA} # v2.0.0`,
      '    permissions:',
      '      contents: read # Read repository files and PR diffs',
      '      pull-requests: write # Post review comments',
      '      issues: write # Create security incident issues if secrets detected',
      '      checks: write # (Optional) Show review progress as a check run',
      '      id-token: write # Required for OIDC authentication to AWS Secrets Manager',
      '      actions: read # download-artifact across workflow_run boundary',
      '    with:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression in a test fixture
      "      trigger-run-id: ${{ github.event_name == 'workflow_run' && format('{0}', github.event.workflow_run.id) || '' }}",
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.changed).toBe(true);
    expect(result.replacedCount).toBe(1);
    expect(result.content).toContain(
      '      actions: write # download-artifact across workflow_run boundary',
    );
    expect(result.content).toContain('  contents: read\n'); // top-level untouched
  });

  it('caller with trigger job and reviewer job in the same file', () => {
    const input = [
      'jobs:',
      '  save-context:',
      '    runs-on: ubuntu-latest',
      '    permissions:',
      '      actions: read',
      '    steps:',
      '      - name: Save event context',
      '        run: echo saved',
      '  review:',
      `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
      '    permissions:',
      '      contents: read',
      '      actions: read',
      '    secrets: inherit',
      '',
    ].join('\n');
    const result = fixReviewerCachePermission(input);
    expect(result.replacedCount).toBe(1);
    const lines = result.content.split('\n');
    expect(lines[4]).toBe('      actions: read'); // save-context untouched
    expect(lines[12]).toBe('      actions: write');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// applyFix — I/O behaviour
// ═════════════════════════════════════════════════════════════════════════════

describe('applyFix — I/O behaviour', () => {
  async function makeTmpDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'fix-reviewer-cache-permission-test-'));
  }

  it('rewrites files in-place and classifies changed/compliant/manual/skipped', async () => {
    const dir = await makeTmpDir();
    try {
      const toFix = join(dir, 'pr-review.yml');
      const alreadyFixed = join(dir, 'pr-review-fixed.yaml');
      const manual = join(dir, 'pr-review-read-all.yml');
      const unrelated = join(dir, 'ci.yml');
      const readAll = [
        'jobs:',
        '  review:',
        `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
        '    permissions: read-all',
        '',
      ].join('\n');
      await writeFile(toFix, oneWorkflowConsumer('      actions: read'), 'utf-8');
      await writeFile(alreadyFixed, oneWorkflowConsumer('      actions: write'), 'utf-8');
      await writeFile(manual, readAll, 'utf-8');
      await writeFile(unrelated, 'name: CI\non: push\njobs:\n  build:\n    steps: []\n', 'utf-8');

      const result = applyFix([toFix, alreadyFixed, manual, unrelated]);

      expect(result.changedFiles).toEqual([toFix]);
      expect(result.compliantFiles).toEqual([alreadyFixed]);
      expect(result.manualFiles).toEqual([manual]);
      expect(result.skippedFiles).toEqual([unrelated]);
      expect(result.errors).toHaveLength(0);
      expect(readFileSync(toFix, 'utf-8')).toBe(oneWorkflowConsumer('      actions: write'));
      expect(readFileSync(alreadyFixed, 'utf-8')).toBe(oneWorkflowConsumer('      actions: write'));
      expect(readFileSync(manual, 'utf-8')).toBe(readAll);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('puts a mixed file in BOTH changedFiles and manualFiles (flipped but unfinished)', async () => {
    const dir = await makeTmpDir();
    try {
      const mixed = join(dir, 'pr-review.yml');
      const content = [
        'jobs:',
        '  review:',
        `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
        '    permissions:',
        '      actions: read',
        '  review-fork:',
        `    uses: ${REVIEWER_WORKFLOW_PATH}@main`,
        '    secrets: inherit',
        '',
      ].join('\n');
      await writeFile(mixed, content, 'utf-8');

      const result = applyFix([mixed]);

      expect(result.changedFiles).toEqual([mixed]);
      expect(result.manualFiles).toEqual([mixed]);
      expect(result.compliantFiles).toHaveLength(0);
      expect(result.skippedFiles).toHaveLength(0);
      // The safe flip IS applied on disk even though the file stays flagged.
      expect(readFileSync(mixed, 'utf-8')).toContain('      actions: write');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('collects per-file errors without aborting the remaining files', async () => {
    const dir = await makeTmpDir();
    try {
      const good = join(dir, 'good.yml');
      const missing = join(dir, 'does-not-exist.yml');
      await writeFile(good, oneWorkflowConsumer('      actions: read'), 'utf-8');

      // The failing file comes FIRST — the good file after it must still be processed.
      const result = applyFix([missing, good]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].file).toBe(missing);
      expect(result.changedFiles).toEqual([good]);
      expect(readFileSync(good, 'utf-8')).toBe(oneWorkflowConsumer('      actions: write'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not rewrite files that need no change (mtime-safe by content check)', async () => {
    const dir = await makeTmpDir();
    try {
      const f = join(dir, 'no-permissions.yml');
      const content = [
        'jobs:',
        '  review:',
        `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
        '    secrets: inherit',
        '',
      ].join('\n');
      await writeFile(f, content, 'utf-8');

      const result = applyFix([f]);

      expect(result.changedFiles).toHaveLength(0);
      // No permissions block: not fixable by the safe flip, so it must land
      // in manualFiles — never in compliantFiles.
      expect(result.manualFiles).toEqual([f]);
      expect(result.compliantFiles).toHaveLength(0);
      expect(readFileSync(f, 'utf-8')).toBe(content);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// statusLines — the CLI stdout contract grepped by the workflow
// ═════════════════════════════════════════════════════════════════════════════

describe('statusLines — CLI stdout contract', () => {
  it('renders one status-prefixed line per file, in bucket order', () => {
    const lines = statusLines({
      changedFiles: ['a.yml'],
      manualFiles: ['b.yml'],
      compliantFiles: ['c.yml'],
      skippedFiles: ['d.yml'],
      errors: [],
    });
    expect(lines).toEqual([
      'changed a.yml',
      'needs-manual b.yml',
      'compliant c.yml',
      'skipped d.yml',
    ]);
  });

  it('emits BOTH changed and needs-manual for a mixed file', () => {
    const lines = statusLines({
      changedFiles: ['mixed.yml'],
      manualFiles: ['mixed.yml'],
      compliantFiles: [],
      skippedFiles: [],
      errors: [],
    });
    expect(lines).toEqual(['changed mixed.yml', 'needs-manual mixed.yml']);
  });

  it('matches the end-to-end applyFix output for a mixed + compliant set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fix-reviewer-cache-permission-test-'));
    try {
      const mixed = join(dir, 'mixed.yml');
      const compliant = join(dir, 'ok.yml');
      await writeFile(
        mixed,
        [
          'jobs:',
          '  review:',
          `    uses: ${REVIEWER_WORKFLOW_PATH}@v2.0.0`,
          '    permissions:',
          '      actions: read',
          '  review-fork:',
          `    uses: ${REVIEWER_WORKFLOW_PATH}@main`,
          '    permissions: read-all',
          '',
        ].join('\n'),
        'utf-8',
      );
      await writeFile(compliant, oneWorkflowConsumer('      actions: write'), 'utf-8');

      const lines = statusLines(applyFix([mixed, compliant]));

      expect(lines).toEqual([
        `changed ${mixed}`,
        `needs-manual ${mixed}`,
        `compliant ${compliant}`,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
