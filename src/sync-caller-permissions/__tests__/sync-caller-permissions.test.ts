// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for src/sync-caller-permissions.
 *
 * Covers:
 *   - upgrading an insufficient grant in the block that applies to the
 *     calling job (job-level block, else the workflow-level one)
 *   - job block REPLACES workflow block (never merged)
 *   - appending required scopes missing from the applicable block
 *   - grants above the requirement are never reduced; sufficient files are
 *     returned byte-for-byte (idempotency)
 *   - inline `{…}` maps, `read-all`/`write-all` shorthands, empty `{}`
 *   - manual reporting: no explicit block (repo default unknowable),
 *     read-all shorthand with a write requirement, `*` pseudo-requirement
 *   - scoping: non-calling jobs and step-level `uses:` are never touched;
 *     block-scalar content cannot leak into the scan
 *   - formatting preservation: indent, trailing comments, CRLF
 *   - the applySync I/O wrapper (writes only when changed, missing files)
 *   - a pin against the real .github/workflows/review-pr.yml so the
 *     update-consumers PR flow (issue #72: actions read → write) stays covered
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeCallerRequirement,
  type PermissionsMap,
  parseWorkflowPermissions,
} from '../../caller-permissions/caller-permissions.js';
import { applySync, syncCallerPermissions } from '../sync-caller-permissions.js';

const REUSABLE_USES =
  'docker/docker-agent-action/.github/workflows/review-pr.yml@0000000000000000000000000000000000000000 # v9.9.9';

/** The caller requirement of review-pr.yml since v2.0.3 (issue #72). */
const REQUIRED: PermissionsMap = {
  contents: 'read',
  'pull-requests': 'write',
  issues: 'write',
  'id-token': 'write',
  actions: 'write',
};

/** README same-repo caller shape, still granting the pre-v2.0.3 `actions: read`. */
const CALLER_JOB_BLOCK = `name: PR Review
on:
  issue_comment:
    types: [created]

permissions:
  contents: read

jobs:
  review:
    uses: ${REUSABLE_USES}
    permissions:
      contents: read # Read repository files and PR diffs
      pull-requests: write # Post review comments
      issues: write
      id-token: write
      actions: read # Cache read for binary cache
    secrets: inherit
`;

describe('syncCallerPermissions', () => {
  it('upgrades an insufficient job-level grant in place, preserving the comment', () => {
    const result = syncCallerPermissions(CALLER_JOB_BLOCK, REQUIRED);
    expect(result.changed).toBe(true);
    expect(result.applied).toEqual([
      { block: 'job:review', scope: 'actions', from: 'read', to: 'write' },
    ]);
    expect(result.manual).toEqual([]);
    expect(result.content).toContain('      actions: write # Cache read for binary cache');
    // Only that single line differs.
    const before = CALLER_JOB_BLOCK.split('\n');
    const after = result.content.split('\n');
    expect(after.length).toBe(before.length);
    expect(after.filter((line, i) => line !== before[i])).toEqual([
      '      actions: write # Cache read for binary cache',
    ]);
  });

  it('is idempotent: a synced file is returned unchanged', () => {
    const first = syncCallerPermissions(CALLER_JOB_BLOCK, REQUIRED);
    const second = syncCallerPermissions(first.content, REQUIRED);
    expect(second.changed).toBe(false);
    expect(second.applied).toEqual([]);
    expect(second.content).toBe(first.content);
  });

  it('appends required scopes missing from the applicable block', () => {
    const source = `jobs:
  review:
    uses: ${REUSABLE_USES}
    permissions:
      contents: read
      pull-requests: write
`;
    const result = syncCallerPermissions(source, REQUIRED);
    expect(result.applied).toEqual([
      { block: 'job:review', scope: 'actions', from: 'none', to: 'write' },
      { block: 'job:review', scope: 'id-token', from: 'none', to: 'write' },
      { block: 'job:review', scope: 'issues', from: 'none', to: 'write' },
    ]);
    expect(result.content).toBe(`jobs:
  review:
    uses: ${REUSABLE_USES}
    permissions:
      contents: read
      pull-requests: write
      actions: write
      id-token: write
      issues: write
`);
  });

  it('never reduces a grant above the requirement', () => {
    const source = `permissions:
  contents: write
  pull-requests: write
  issues: write
  id-token: write
  actions: write

jobs:
  review:
    uses: ${REUSABLE_USES}
`;
    const result = syncCallerPermissions(source, REQUIRED);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(source);
  });

  it('falls back to the workflow-level block when the calling job has none', () => {
    const source = `permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write
  actions: read

jobs:
  review:
    uses: ${REUSABLE_USES}
`;
    const result = syncCallerPermissions(source, REQUIRED);
    expect(result.applied).toEqual([
      { block: 'workflow', scope: 'actions', from: 'read', to: 'write' },
    ]);
    expect(result.content).toContain('\n  actions: write\n');
  });

  it('job block replaces the workflow block: only the job block is edited', () => {
    const source = `permissions:
  actions: read

jobs:
  review:
    uses: ${REUSABLE_USES}
    permissions:
      contents: read
      pull-requests: write
      issues: write
      id-token: write
      actions: read
`;
    const result = syncCallerPermissions(source, REQUIRED);
    expect(result.applied).toEqual([
      { block: 'job:review', scope: 'actions', from: 'read', to: 'write' },
    ]);
    // Workflow-level block (which does not apply to the calling job) untouched.
    expect(result.content).toContain('permissions:\n  actions: read\n');
    expect(result.content).toContain('      actions: write\n');
  });

  it('edits a shared workflow-level block once for multiple calling jobs', () => {
    const source = `permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write
  actions: read

jobs:
  review-a:
    uses: ${REUSABLE_USES}
  review-b:
    uses: ${REUSABLE_USES}
`;
    const result = syncCallerPermissions(source, REQUIRED);
    expect(result.applied).toEqual([
      { block: 'workflow', scope: 'actions', from: 'read', to: 'write' },
    ]);
  });

  it('rewrites inline maps and appends missing scopes', () => {
    const source = `jobs:
  review:
    uses: ${REUSABLE_USES}
    permissions: {contents: read, pull-requests: write, issues: write, actions: read} # inline
`;
    const result = syncCallerPermissions(source, REQUIRED);
    expect(result.applied).toEqual([
      { block: 'job:review', scope: 'actions', from: 'read', to: 'write' },
      { block: 'job:review', scope: 'id-token', from: 'none', to: 'write' },
    ]);
    expect(result.content).toContain(
      'permissions: {contents: read, pull-requests: write, issues: write, actions: write, id-token: write} # inline',
    );
  });

  it('fills an empty inline {} block with every required scope', () => {
    const source = `jobs:
  review:
    uses: ${REUSABLE_USES}
    permissions: {}
`;
    const result = syncCallerPermissions(source, REQUIRED);
    expect(result.content).toContain(
      'permissions: {actions: write, contents: read, id-token: write, issues: write, pull-requests: write}',
    );
    expect(result.manual).toEqual([]);
  });

  it('treats write-all as sufficient', () => {
    const source = `jobs:
  review:
    uses: ${REUSABLE_USES}
    permissions: write-all
`;
    const result = syncCallerPermissions(source, REQUIRED);
    expect(result.changed).toBe(false);
    expect(result.manual).toEqual([]);
  });

  it('reports read-all with write requirements as manual (read scopes satisfied)', () => {
    const source = `jobs:
  review:
    uses: ${REUSABLE_USES}
    permissions: read-all
`;
    const result = syncCallerPermissions(source, REQUIRED);
    expect(result.changed).toBe(false);
    expect(result.manual).toEqual([
      { block: 'job:review', scope: 'actions', from: 'read', to: 'write' },
      { block: 'job:review', scope: 'id-token', from: 'read', to: 'write' },
      { block: 'job:review', scope: 'issues', from: 'read', to: 'write' },
      { block: 'job:review', scope: 'pull-requests', from: 'read', to: 'write' },
    ]);
  });

  it('reports every required scope as manual when no explicit block exists', () => {
    const source = `jobs:
  review:
    uses: ${REUSABLE_USES}
`;
    const result = syncCallerPermissions(source, REQUIRED);
    expect(result.changed).toBe(false);
    expect(result.manual).toHaveLength(Object.keys(REQUIRED).length);
    expect(result.manual[0]).toEqual({
      block: 'job:review',
      scope: 'actions',
      from: 'unknown',
      to: 'write',
    });
  });

  it('reports a * pseudo-requirement (reusable declares write-all) as manual', () => {
    const source = `jobs:
  review:
    uses: ${REUSABLE_USES}
    permissions:
      contents: read
`;
    const result = syncCallerPermissions(source, { '*': 'write', contents: 'read' });
    expect(result.changed).toBe(false);
    expect(result.manual).toEqual([{ block: 'job:review', scope: '*', from: 'none', to: 'write' }]);
  });

  it('never touches jobs that do not call the reusable workflow', () => {
    const source = `jobs:
  build:
    permissions:
      actions: read
    steps:
      - uses: docker/docker-agent-action@0000000000000000000000000000000000000000
`;
    const result = syncCallerPermissions(source, REQUIRED);
    expect(result.changed).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.manual).toEqual([]);
  });

  it('does nothing when the file has no calling job at all', () => {
    const source = 'name: CI\njobs:\n  test:\n    steps:\n      - run: echo ok\n';
    const result = syncCallerPermissions(source, REQUIRED);
    expect(result.changed).toBe(false);
  });

  it('ignores permissions/uses lines inside block scalars', () => {
    const source = `jobs:
  review:
    uses: ${REUSABLE_USES}
    permissions:
      contents: read
      pull-requests: write
      issues: write
      id-token: write
      actions: write
  docs:
    steps:
      - run: |
          echo "permissions:"
          echo "  actions: read"
          echo "uses: ${REUSABLE_USES}"
`;
    const result = syncCallerPermissions(source, REQUIRED);
    expect(result.changed).toBe(false);
    expect(result.manual).toEqual([]);
  });

  it('preserves CRLF line endings on edited and inserted lines', () => {
    const source = [
      'jobs:',
      '  review:',
      `    uses: ${REUSABLE_USES}`,
      '    permissions:',
      '      contents: read',
      '      pull-requests: write',
      '      issues: write',
      '      id-token: write',
      '      actions: read',
      '',
    ].join('\r\n');
    const result = syncCallerPermissions(source, { ...REQUIRED, checks: 'write' });
    const lines = result.content.split('\n');
    expect(lines).toContain('      actions: write\r');
    expect(lines).toContain('      checks: write\r');
  });

  it('upgrades quoted levels without breaking the quoting', () => {
    const source = `jobs:
  review:
    uses: ${REUSABLE_USES}
    permissions:
      contents: read
      pull-requests: write
      issues: write
      id-token: write
      actions: 'read'
`;
    const result = syncCallerPermissions(source, REQUIRED);
    expect(result.content).toContain("      actions: 'write'\n");
  });

  it('throws on a malformed permissions entry instead of silently skipping', () => {
    const source = `jobs:
  review:
    uses: ${REUSABLE_USES}
    permissions:
      actions: [read]
`;
    expect(() => syncCallerPermissions(source, REQUIRED)).toThrow(/Unrecognized permission level/);
  });
});

describe('against the real .github/workflows/review-pr.yml', () => {
  const workflowPath = resolve(import.meta.dirname, '../../../.github/workflows/review-pr.yml');
  const required = computeCallerRequirement(
    parseWorkflowPermissions(readFileSync(workflowPath, 'utf-8')),
  );

  it('upgrades a pre-v2.0.3 caller (actions: read) to the current requirement', () => {
    const result = syncCallerPermissions(CALLER_JOB_BLOCK, required);
    const actions = result.applied.find((inc) => inc.scope === 'actions');
    expect(actions).toEqual({ block: 'job:review', scope: 'actions', from: 'read', to: 'write' });
    expect(result.manual).toEqual([]);
  });

  it('leaves the README quick-start caller block unchanged (docs stay sufficient)', () => {
    const readme = readFileSync(
      resolve(import.meta.dirname, '../../../review-pr/README.md'),
      'utf-8',
    );
    // Extract the same-repo quick-start caller from the README so drift
    // between docs and the actual requirement fails this test.
    const yaml = readme.match(/```yaml\n(name: PR Review\non:\n {2}pull_request:[\s\S]*?)```/);
    expect(yaml).not.toBeNull();
    const result = syncCallerPermissions(
      (yaml as RegExpMatchArray)[1].replace(
        '@VERSION',
        '@0000000000000000000000000000000000000000',
      ),
      required,
    );
    expect(result.changed).toBe(false);
    expect(result.manual).toEqual([]);
  });
});

describe('applySync (I/O wrapper)', () => {
  async function makeTempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'sync-caller-permissions-test-'));
  }

  const REUSABLE = `on:
  workflow_call:

permissions:
  contents: read

jobs:
  review:
    permissions:
      contents: read
      actions: write
    steps:
      - run: echo ok
`;

  it('writes the consumer file only when a grant was raised', async () => {
    const dir = await makeTempDir();
    try {
      const reusable = join(dir, 'review-pr.yml');
      const consumer = join(dir, 'caller.yml');
      await writeFile(reusable, REUSABLE);
      await writeFile(
        consumer,
        `jobs:\n  review:\n    uses: ${REUSABLE_USES}\n    permissions:\n      contents: read\n      actions: read\n`,
      );
      const result = applySync(reusable, consumer);
      expect(result.changed).toBe(true);
      expect(result.applied).toEqual([
        { block: 'job:review', scope: 'actions', from: 'read', to: 'write' },
      ]);
      expect(await readFile(consumer, 'utf-8')).toContain('      actions: write\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not rewrite an already-sufficient consumer file', async () => {
    const dir = await makeTempDir();
    try {
      const reusable = join(dir, 'review-pr.yml');
      const consumer = join(dir, 'caller.yml');
      await writeFile(reusable, REUSABLE);
      await writeFile(
        consumer,
        `jobs:\n  review:\n    uses: ${REUSABLE_USES}\n    permissions:\n      contents: read\n      actions: write\n`,
      );
      const before = await stat(consumer);
      const result = applySync(reusable, consumer);
      expect(result.changed).toBe(false);
      const after = await stat(consumer);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when the reusable workflow file is missing', async () => {
    const dir = await makeTempDir();
    try {
      const consumer = join(dir, 'caller.yml');
      await writeFile(consumer, 'jobs: {}\n');
      expect(() => applySync(join(dir, 'nope.yml'), consumer)).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
