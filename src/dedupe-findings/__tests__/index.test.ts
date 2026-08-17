// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the dedupe-findings CLI wiring (run with an injected warn).
 *
 * These pin the file effects and the fail-open contract at the CLI layer:
 * the legacy two-argument invocation still works, a valid third argument
 * (prior review-thread history) suppresses re-derived findings, and the two
 * dedupe sources are independently optional — a missing or malformed
 * existing-comments file warns and continues so valid thread history still
 * suppresses, a missing or malformed third argument warns and continues with
 * the REST-comment dedupe, and with neither source available every finding
 * is kept. Severity escalations against outdated threads are surfaced
 * without blocking, and only missing required arguments produce a non-zero
 * exit.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExistingComment, NewComment, PriorReviewThread } from '../dedupe-findings.js';
import { run } from '../index.js';

const MARKER = '<!-- docker-agent-review -->';
const DUPLICATE_BODY = `**[high] Nil pointer dereference on user object**\n\ndetails\n\n${MARKER}`;
const NOVEL_BODY = `**[medium] Unclosed file handle leaks descriptor**\n\ndetails\n\n${MARKER}`;

describe('dedupe-findings run', () => {
  let dir: string;
  let newPath: string;
  let existingPath: string;
  let threadsPath: string;
  let warnings: string[];
  const warn = (message: string) => warnings.push(message);

  const writeJson = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value), 'utf-8');

  const newComments = (): NewComment[] => [
    { path: 'src/app.ts', line: 42, body: DUPLICATE_BODY },
    { path: 'src/other.ts', line: 7, body: NOVEL_BODY },
  ];

  const existingDuplicate = (): ExistingComment[] => [
    { path: 'src/app.ts', line: 42, body: DUPLICATE_BODY },
  ];

  const currentThread = (overrides: Partial<PriorReviewThread> = {}): PriorReviewThread => ({
    path: 'src/app.ts',
    line: 42,
    originalLine: 42,
    isResolved: false,
    isOutdated: false,
    comments: {
      nodes: [{ body: DUPLICATE_BODY, author: { login: 'docker-agent[bot]' }, replyTo: null }],
    },
    ...overrides,
  });

  const keptPaths = (): string[] =>
    (JSON.parse(readFileSync(newPath, 'utf-8')) as NewComment[]).map((c) => String(c.path));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dedupe-findings-test-'));
    newPath = join(dir, 'review_comments.json');
    existingPath = join(dir, 'existing_review_comments.json');
    threadsPath = join(dir, 'prior_review_threads.json');
    warnings = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails with a usage error when required arguments are missing', () => {
    expect(run([], warn)).toBe(1);
    expect(run([newPath], warn)).toBe(1);
    expect(warnings).toHaveLength(2);
    for (const message of warnings) {
      expect(message).toContain('Usage: dedupe-findings');
    }
  });

  it('dedupes against existing comments with the legacy two-argument form', () => {
    writeJson(newPath, newComments());
    writeJson(existingPath, existingDuplicate());

    expect(run([newPath, existingPath], warn)).toBe(0);

    expect(keptPaths()).toEqual(['src/other.ts']);
    expect(warnings.join('\n')).toContain('matches existing comment at line 42');
    expect(warnings.join('\n')).toContain('kept 1, dropped 1');
  });

  it('suppresses a re-derived finding via a valid third history argument', () => {
    writeJson(newPath, newComments());
    writeJson(existingPath, []);
    writeJson(threadsPath, [currentThread()]);

    expect(run([newPath, existingPath, threadsPath], warn)).toBe(0);

    expect(keptPaths()).toEqual(['src/other.ts']);
    expect(warnings.join('\n')).toContain('matches prior review thread at line 42');
  });

  it('warns and continues with the REST dedupe when the history file is missing', () => {
    writeJson(newPath, newComments());
    writeJson(existingPath, existingDuplicate());

    expect(run([newPath, existingPath, join(dir, 'nope.json')], warn)).toBe(0);

    expect(warnings.join('\n')).toContain('No prior review threads file');
    expect(warnings.join('\n')).toContain('continuing without thread history');
    expect(keptPaths()).toEqual(['src/other.ts']);
  });

  it('warns and continues with the REST dedupe when the history file is malformed', () => {
    writeJson(newPath, newComments());
    writeJson(existingPath, existingDuplicate());

    writeFileSync(threadsPath, 'not json', 'utf-8');
    expect(run([newPath, existingPath, threadsPath], warn)).toBe(0);
    expect(warnings.join('\n')).toContain('continuing without thread history');
    expect(keptPaths()).toEqual(['src/other.ts']);

    warnings = [];
    writeJson(newPath, newComments());
    writeJson(threadsPath, { not: 'an array' });
    expect(run([newPath, existingPath, threadsPath], warn)).toBe(0);
    expect(warnings.join('\n')).toContain('is not a JSON array');
    expect(keptPaths()).toEqual(['src/other.ts']);
  });

  it('suppresses via valid thread history when the existing-comments file is missing', () => {
    writeJson(newPath, newComments());
    writeJson(threadsPath, [currentThread()]);

    expect(run([newPath, existingPath, threadsPath], warn)).toBe(0);

    expect(warnings.join('\n')).toContain('No existing comments file');
    expect(warnings.join('\n')).toContain('continuing without existing comments');
    expect(warnings.join('\n')).toContain('matches prior review thread at line 42');
    expect(keptPaths()).toEqual(['src/other.ts']);
  });

  it('suppresses via valid thread history when the existing-comments file is malformed', () => {
    writeJson(newPath, newComments());
    writeJson(threadsPath, [currentThread()]);

    writeFileSync(existingPath, 'not json', 'utf-8');
    expect(run([newPath, existingPath, threadsPath], warn)).toBe(0);
    expect(warnings.join('\n')).toContain('continuing without existing comments');
    expect(keptPaths()).toEqual(['src/other.ts']);

    warnings = [];
    writeJson(newPath, newComments());
    writeJson(existingPath, { not: 'an array' });
    expect(run([newPath, existingPath, threadsPath], warn)).toBe(0);
    expect(warnings.join('\n')).toContain('is not a JSON array');
    expect(keptPaths()).toEqual(['src/other.ts']);
  });

  it('exits 0 without touching anything when the new-comments file is unusable', () => {
    writeJson(existingPath, existingDuplicate());

    expect(run([newPath, existingPath], warn)).toBe(0);
    expect(warnings.join('\n')).toContain('skipping deduplication');

    writeFileSync(newPath, '{', 'utf-8');
    expect(run([newPath, existingPath], warn)).toBe(0);
    expect(readFileSync(newPath, 'utf-8')).toBe('{');
  });

  it('continues with an empty REST list when the existing file is unusable', () => {
    writeJson(newPath, newComments());
    const before = readFileSync(newPath, 'utf-8');

    expect(run([newPath, existingPath], warn)).toBe(0);

    expect(warnings.join('\n')).toContain('No existing comments file');
    expect(warnings.join('\n')).toContain('continuing without existing comments');
    expect(warnings.join('\n')).toContain('kept 2, dropped 0');
    expect(readFileSync(newPath, 'utf-8')).toBe(before);
  });

  it('keeps every finding when both dedupe sources are unavailable', () => {
    writeJson(newPath, newComments());
    const before = readFileSync(newPath, 'utf-8');

    expect(run([newPath, existingPath, join(dir, 'nope.json')], warn)).toBe(0);

    expect(warnings.join('\n')).toContain('continuing without existing comments');
    expect(warnings.join('\n')).toContain('continuing without thread history');
    expect(warnings.join('\n')).toContain('kept 2, dropped 0');
    expect(readFileSync(newPath, 'utf-8')).toBe(before);
  });

  it('does not rewrite the comments file when nothing is dropped', () => {
    writeJson(newPath, newComments());
    writeJson(existingPath, []);
    const before = readFileSync(newPath, 'utf-8');

    expect(run([newPath, existingPath], warn)).toBe(0);

    expect(readFileSync(newPath, 'utf-8')).toBe(before);
    expect(warnings.join('\n')).toContain('dropped 0 (no changes)');
  });

  it('surfaces severity escalations against outdated threads without dropping', () => {
    writeJson(newPath, [{ path: 'src/app.ts', line: 42, body: DUPLICATE_BODY }]);
    writeJson(existingPath, []);
    const outdated = currentThread({
      isOutdated: true,
      comments: {
        nodes: [
          {
            body: `**[medium] Nil pointer dereference on user object**\n\ndetails\n\n${MARKER}`,
            author: { login: 'docker-agent[bot]' },
            replyTo: null,
          },
        ],
      },
    });
    writeJson(threadsPath, [outdated]);
    const before = readFileSync(newPath, 'utf-8');

    expect(run([newPath, existingPath, threadsPath], warn)).toBe(0);

    // The finding stays posted; the escalation is only flagged for the
    // severity-continuity policy.
    expect(readFileSync(newPath, 'utf-8')).toBe(before);
    const output = warnings.join('\n');
    expect(output).toContain('Severity escalation on src/app.ts:42');
    expect(output).toContain('[high] vs [medium]');
    expect(output).toContain('changed-code evidence');
    expect(output).toContain('kept 1, dropped 0');
  });
});
