// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for src/caller-permissions.
 *
 * Covers:
 *   - extraction of workflow-level and job-level permissions blocks
 *     (block maps, trailing comments, inline {}, flow maps, read-all/write-all)
 *   - indentation scoping: step inputs and block scalars never leak in
 *   - caller-requirement semantics: job block REPLACES workflow block,
 *     jobs without a block inherit the workflow block, max across jobs
 *   - diffing: increases only (none < read < write), reductions ignored
 *   - warning rendering and the CLI I/O wrapper (first release, errors)
 *   - a pin on the real .github/workflows/review-pr.yml requirement so any
 *     caller-facing permission change is loud in review (issue #72)
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeCallerRequirement,
  diffCallerRequirements,
  generateCallerPermissionsWarning,
  parseWorkflowPermissions,
  renderBreakingChangeWarning,
} from '../caller-permissions.js';

/** Shape of .github/workflows/review-pr.yml at v2.0.2 (review job: no `actions`). */
const WORKFLOW_V202 = `
name: PR Review
on:
  workflow_call:
    inputs:
      pr-number:
        required: false
        type: string

permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write
  actions: read   # download-artifact across workflow_run boundary

# A column-0 comment between blocks must not terminate parsing early.
concurrency:
  group: pr-review-\${{ github.run_id }}
  cancel-in-progress: false

jobs:
  resolve-context:
    if: inputs.trigger-run-id != ''
    runs-on: ubuntu-latest
    steps:
      - name: Read context
        run: echo ok

  review:
    needs: [resolve-context]
    if: |
      always() && (
        (github.event_name == 'issue_comment' &&
         github.event.comment.user.type != 'Bot')
      )
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
      id-token: write
      checks: write
    steps:
      - name: Run review
        run: echo ok

  reply-to-feedback:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
      id-token: write
      actions: read   # download cross-run artifacts
    steps:
      - name: Reply
        run: echo ok
`;

/** Same workflow at v2.0.3: the review job added `actions: write`. */
const WORKFLOW_V203 = WORKFLOW_V202.replace(
  '      checks: write\n',
  '      checks: write\n      actions: write  # cache delete for review-lock release cleanup\n',
);

describe('parseWorkflowPermissions — block extraction', () => {
  it('extracts the workflow-level block with trailing comments', () => {
    const wf = parseWorkflowPermissions(WORKFLOW_V202);
    expect(wf.workflow).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      issues: 'write',
      'id-token': 'write',
      actions: 'read',
    });
  });

  it('extracts job-level blocks and leaves jobs without one undefined', () => {
    const wf = parseWorkflowPermissions(WORKFLOW_V202);
    expect(wf.jobs.map((j) => j.id)).toEqual(['resolve-context', 'review', 'reply-to-feedback']);
    expect(wf.jobs[0].permissions).toBeUndefined();
    expect(wf.jobs[1].permissions).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      issues: 'write',
      'id-token': 'write',
      checks: 'write',
    });
    expect(wf.jobs[2].permissions).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      issues: 'write',
      'id-token': 'write',
      actions: 'read',
    });
  });

  it('returns undefined workflow block and no job blocks when none are declared', () => {
    const wf = parseWorkflowPermissions('name: CI\njobs:\n  build:\n    runs-on: ubuntu-latest\n');
    expect(wf.workflow).toBeUndefined();
    expect(wf.jobs).toEqual([{ id: 'build', permissions: undefined }]);
  });

  it('parses the inline empty map {} as no requested permissions', () => {
    const wf = parseWorkflowPermissions('permissions: {}\njobs:\n  a:\n    permissions: {}\n');
    expect(wf.workflow).toEqual({});
    expect(wf.jobs[0].permissions).toEqual({});
  });

  it('parses inline flow maps', () => {
    const wf = parseWorkflowPermissions(
      'jobs:\n  a:\n    permissions: { contents: read, actions: write }\n',
    );
    expect(wf.jobs[0].permissions).toEqual({ contents: 'read', actions: 'write' });
  });

  it('parses the read-all / write-all shorthands as the * pseudo-scope', () => {
    expect(parseWorkflowPermissions('permissions: read-all\n').workflow).toEqual({ '*': 'read' });
    expect(parseWorkflowPermissions('permissions: write-all\n').workflow).toEqual({
      '*': 'write',
    });
  });

  it('ignores permissions-like keys nested deeper than a job body (step inputs)', () => {
    const source = [
      'jobs:',
      '  deploy:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: some/action@v1',
      '        with:',
      '          permissions: write',
      '',
    ].join('\n');
    const wf = parseWorkflowPermissions(source);
    expect(wf.jobs[0].permissions).toBeUndefined();
  });

  it('is not confused by block-scalar content (if: | conditions, run: | scripts)', () => {
    const wf = parseWorkflowPermissions(WORKFLOW_V202);
    // The `if: |` scalar inside the review job contains colon-bearing lines;
    // none of them may leak into any permissions block.
    expect(wf.jobs[1].permissions).not.toHaveProperty('always()');
    expect(Object.keys(wf.jobs[1].permissions ?? {})).toHaveLength(5);
  });

  it('throws on an unrecognized access level', () => {
    expect(() => parseWorkflowPermissions('permissions:\n  actions: banana\n')).toThrow(
      /Unrecognized permission level "banana" at line 2/,
    );
  });

  it('throws on a malformed block entry', () => {
    expect(() => parseWorkflowPermissions('permissions:\n  nested:\n    deeper: read\n')).toThrow(
      /Malformed permissions entry at line 2/,
    );
  });

  it('throws on an unrecognized inline value', () => {
    expect(() => parseWorkflowPermissions('permissions: everything\n')).toThrow(
      /Unrecognized permissions value "everything" at line 1/,
    );
  });
});

describe('computeCallerRequirement', () => {
  it('takes the per-scope maximum across jobs (v2.0.2 shape → actions: read)', () => {
    const req = computeCallerRequirement(parseWorkflowPermissions(WORKFLOW_V202));
    expect(req).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      issues: 'write',
      'id-token': 'write',
      checks: 'write',
      actions: 'read',
    });
  });

  it('reflects the v2.0.3 review-job increase (actions: write)', () => {
    const req = computeCallerRequirement(parseWorkflowPermissions(WORKFLOW_V203));
    expect(req.actions).toBe('write');
  });

  it('lets a job-level block REPLACE the workflow-level block, not merge with it', () => {
    // Every job overrides — the workflow-level `actions: read` never applies.
    const source = [
      'permissions:',
      '  actions: read',
      'jobs:',
      '  a:',
      '    permissions:',
      '      contents: read',
      '',
    ].join('\n');
    const req = computeCallerRequirement(parseWorkflowPermissions(source));
    expect(req).toEqual({ contents: 'read' });
  });

  it('applies the workflow-level block to jobs without their own', () => {
    const source = ['permissions:', '  actions: read', 'jobs:', '  a:', '    runs-on: x', ''].join(
      '\n',
    );
    const req = computeCallerRequirement(parseWorkflowPermissions(source));
    expect(req).toEqual({ actions: 'read' });
  });

  it('drops explicit none entries — they impose no caller requirement', () => {
    const source = ['jobs:', '  a:', '    permissions:', '      contents: none', ''].join('\n');
    expect(computeCallerRequirement(parseWorkflowPermissions(source))).toEqual({});
  });

  it('falls back to the workflow-level block when no jobs are present', () => {
    const req = computeCallerRequirement(
      parseWorkflowPermissions('permissions:\n  actions: read\n'),
    );
    expect(req).toEqual({ actions: 'read' });
  });
});

describe('diffCallerRequirements', () => {
  it('reports a read → write increase', () => {
    expect(diffCallerRequirements({ actions: 'read' }, { actions: 'write' })).toEqual([
      { scope: 'actions', from: 'read', to: 'write' },
    ]);
  });

  it('reports newly required scopes as increases from none', () => {
    expect(diffCallerRequirements({}, { actions: 'read', checks: 'write' })).toEqual([
      { scope: 'actions', from: 'none', to: 'read' },
      { scope: 'checks', from: 'none', to: 'write' },
    ]);
  });

  it('does not flag reductions or removed scopes', () => {
    expect(
      diffCallerRequirements({ actions: 'write', checks: 'write' }, { actions: 'read' }),
    ).toEqual([]);
  });

  it('returns [] when requirements are identical', () => {
    expect(diffCallerRequirements({ actions: 'write' }, { actions: 'write' })).toEqual([]);
  });

  it('detects the v2.0.2 → v2.0.3 incident: only actions read → write', () => {
    const prev = computeCallerRequirement(parseWorkflowPermissions(WORKFLOW_V202));
    const cur = computeCallerRequirement(parseWorkflowPermissions(WORKFLOW_V203));
    expect(diffCallerRequirements(prev, cur)).toEqual([
      { scope: 'actions', from: 'read', to: 'write' },
    ]);
  });

  it('does not flag the reverse direction (a future reduction back to read)', () => {
    const prev = computeCallerRequirement(parseWorkflowPermissions(WORKFLOW_V203));
    const cur = computeCallerRequirement(parseWorkflowPermissions(WORKFLOW_V202));
    expect(diffCallerRequirements(prev, cur)).toEqual([]);
  });

  it('treats a wildcard grant as covering explicit scopes', () => {
    // read-all → an explicit write is an increase; an explicit read is not.
    expect(diffCallerRequirements({ '*': 'read' }, { contents: 'write' })).toEqual([
      { scope: 'contents', from: 'read', to: 'write' },
    ]);
    expect(diffCallerRequirements({ '*': 'read' }, { contents: 'read' })).toEqual([]);
  });
});

describe('renderBreakingChangeWarning', () => {
  it('returns an empty string when there is nothing to warn about', () => {
    expect(renderBreakingChangeWarning([])).toBe('');
  });

  it('renders a labeled warning with scope bullets, migration note, and docs link', () => {
    const warning = renderBreakingChangeWarning([{ scope: 'actions', from: 'read', to: 'write' }]);
    expect(warning).toContain('## ⚠️ Breaking change');
    expect(warning).toContain('- `actions`: `read` → `write`');
    expect(warning).toContain('**before** upgrading');
    expect(warning).toContain("fail GitHub's workflow validation at startup");
    expect(warning).toContain(
      'https://github.com/docker/docker-agent-action/blob/main/review-pr/README.md#quick-start',
    );
  });

  it('renders newly required scopes as "not previously required"', () => {
    const warning = renderBreakingChangeWarning([{ scope: 'checks', from: 'none', to: 'write' }]);
    expect(warning).toContain('- `checks`: not previously required → `write`');
  });
});

describe('generateCallerPermissionsWarning — I/O wrapper', () => {
  async function makeTmpDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'caller-permissions-test-'));
  }

  it('produces the warning for a v2.0.2 → v2.0.3 style increase', async () => {
    const dir = await makeTmpDir();
    try {
      const prev = join(dir, 'previous.yml');
      const cur = join(dir, 'current.yml');
      await writeFile(prev, WORKFLOW_V202, 'utf-8');
      await writeFile(cur, WORKFLOW_V203, 'utf-8');
      const warning = generateCallerPermissionsWarning(prev, cur);
      expect(warning).toContain('- `actions`: `read` → `write`');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty string when the requirement did not increase', async () => {
    const dir = await makeTmpDir();
    try {
      const prev = join(dir, 'previous.yml');
      const cur = join(dir, 'current.yml');
      await writeFile(prev, WORKFLOW_V203, 'utf-8');
      await writeFile(cur, WORKFLOW_V203, 'utf-8');
      expect(generateCallerPermissionsWarning(prev, cur)).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a missing previous file as no baseline (first release is safe)', async () => {
    const dir = await makeTmpDir();
    try {
      const cur = join(dir, 'current.yml');
      await writeFile(cur, WORKFLOW_V203, 'utf-8');
      expect(generateCallerPermissionsWarning(join(dir, 'nope.yml'), cur)).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when the current file is missing (mistyped path must be loud)', async () => {
    const dir = await makeTmpDir();
    try {
      const prev = join(dir, 'previous.yml');
      await writeFile(prev, WORKFLOW_V202, 'utf-8');
      expect(() => generateCallerPermissionsWarning(prev, join(dir, 'nope.yml'))).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('real .github/workflows/review-pr.yml', () => {
  // Pins the caller-facing requirement of the shipped reusable workflow.
  // If this test fails, you are changing what callers must grant: that is a
  // BREAKING change for existing callers when any level increases (see issue
  // #72). Update this expectation consciously, document the new block in
  // README.md / review-pr/README.md, and rely on the release workflow to
  // prepend the migration warning to the release notes.
  const workflowPath = resolve(import.meta.dirname, '../../../.github/workflows/review-pr.yml');

  it('requires exactly the documented caller permissions', () => {
    const source = readFileSync(workflowPath, 'utf-8');
    const requirement = computeCallerRequirement(parseWorkflowPermissions(source));
    expect(requirement).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      issues: 'write',
      'id-token': 'write',
      checks: 'write',
      actions: 'write',
    });
  });
});
