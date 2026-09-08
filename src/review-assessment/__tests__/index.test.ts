// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the review-assessment CLI wiring (main with mocked exit).
 *
 * The full shell-level surface (new-run-nonce → sed staging → finalize-body →
 * classify-run inside the action's scripts) is executed end-to-end by the
 * built-CLI harness in src/resolve-trigger-context/__tests__/
 * workflow-security.test.ts; these tests pin the argument validation and file
 * effects at the module boundary.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, newRunNonce } from '../index.js';

const NONCE = '0123456789abcdef0123456789abcdef';
const MARKER = `<!-- docker-agent-review-run:${NONCE} -->`;

let directory: string;
let stdout: string[];
let errors: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'review-assessment-cli-'));
  stdout = [];
  errors = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation((message) => {
    errors.push(String(message));
  });
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe('new-run-nonce', () => {
  it('prints a fresh 32-hex nonce per invocation', () => {
    main(['new-run-nonce']);
    main(['new-run-nonce']);
    const [first, second] = stdout.map((line) => line.trim());
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
  });

  it('generates unique unguessable nonces', () => {
    const nonces = new Set(Array.from({ length: 64 }, () => newRunNonce()));
    expect(nonces.size).toBe(64);
  });
});

describe('finalize-body', () => {
  function stageComments(content: string, name = 'review_comments.json'): string {
    const commentsFile = join(directory, name);
    writeFileSync(commentsFile, content);
    return commentsFile;
  }

  it('validates the body against the staged comments and appends the run marker in place', () => {
    const bodyFile = join(directory, 'review_body.md');
    writeFileSync(bodyFile, '### Assessment: 🟢 NO FINDINGS\n');
    const commentsFile = stageComments('[]\n');
    main(['finalize-body', bodyFile, NONCE, commentsFile]);
    expect(readFileSync(bodyFile, 'utf8')).toBe(`### Assessment: 🟢 NO FINDINGS\n\n${MARKER}\n`);
    // Idempotent: a retried posting command must not double-append.
    main(['finalize-body', bodyFile, NONCE, commentsFile]);
    expect(readFileSync(bodyFile, 'utf8')).toBe(`### Assessment: 🟢 NO FINDINGS\n\n${MARKER}\n`);
  });

  it('accepts staged inline comments for a non-NO-FINDINGS outcome', () => {
    const bodyFile = join(directory, 'review_body.md');
    writeFileSync(bodyFile, '### Assessment: 🟡 NEEDS ATTENTION\n');
    const commentsFile = stageComments('[{"path": "a.go", "line": 1, "body": "**[low] x**"}]\n');
    main(['finalize-body', bodyFile, NONCE, commentsFile]);
    expect(readFileSync(bodyFile, 'utf8')).toContain(MARKER);
  });

  it.each([
    ['missing file', join('nowhere', 'review_body.md'), NONCE, undefined],
    ['empty body', 'empty.md', NONCE, ''],
    ['whitespace-only body', 'blank.md', NONCE, ' \n\t\n'],
    ['malformed nonce', 'valid.md', 'not-a-nonce', '### Assessment: 🟢 NO FINDINGS\n'],
    ['forbidden wording', 'lgtm.md', NONCE, '### Assessment: 🟢 NO FINDINGS\n\nLGTM!\n'],
    ['missing status line', 'prose.md', NONCE, 'looks fine to me\n'],
  ])('refuses posting on %s', (_name, file, nonce, content) => {
    const bodyFile = file.includes('/') ? file : join(directory, file);
    if (content !== undefined) writeFileSync(bodyFile, content);
    const commentsFile = stageComments('[]\n');
    expect(() => main(['finalize-body', bodyFile, nonce, commentsFile])).toThrow('exit:1');
    if (content !== undefined && content !== '') {
      expect(readFileSync(bodyFile, 'utf8')).toBe(content);
    }
  });

  it.each([
    ['missing comments argument', 'omit', 'requires the staged review comments file path'],
    ['missing comments file', 'absent', 'missing or unreadable'],
    ['non-JSON comments file', 'not json', 'not valid JSON'],
    ['non-array comments file', '{"body": "x"}', 'must be a JSON array'],
  ])('refuses posting on %s without touching the body', (_name, comments, reason) => {
    const bodyFile = join(directory, 'review_body.md');
    const body = '### Assessment: 🟡 NEEDS ATTENTION\n';
    writeFileSync(bodyFile, body);
    const argv = ['finalize-body', bodyFile, NONCE];
    if (comments === 'absent') argv.push(join(directory, 'nowhere.json'));
    else if (comments !== 'omit') argv.push(stageComments(comments));
    expect(() => main(argv)).toThrow('exit:1');
    expect(errors.join('\n')).toContain(reason);
    expect(readFileSync(bodyFile, 'utf8')).toBe(body);
  });

  it('refuses 🟢 NO FINDINGS over staged inline comments (runtime enforcement)', () => {
    const bodyFile = join(directory, 'review_body.md');
    const body = '### Assessment: 🟢 NO FINDINGS\n';
    writeFileSync(bodyFile, body);
    const commentsFile = stageComments('[{"path": "a.go", "line": 1, "body": "**[low] x**"}]\n');
    expect(() => main(['finalize-body', bodyFile, NONCE, commentsFile])).toThrow('exit:1');
    expect(errors.join('\n')).toContain(
      '🟢 NO FINDINGS cannot be posted with 1 staged inline comment',
    );
    expect(readFileSync(bodyFile, 'utf8')).toBe(body);
  });
});

describe('classify-run argument validation', () => {
  it.each([
    ['short SHA', ['classify-run', 'abc', '100', NONCE]],
    ['non-numeric baseline', ['classify-run', 'a'.repeat(40), '10x', NONCE]],
    ['malformed nonce', ['classify-run', 'a'.repeat(40), '100', 'zz']],
    ['unknown command', ['what-is-this']],
    ['no command', []],
  ])('exits nonzero on %s before touching stdin', (_name, argv) => {
    expect(() => main(argv)).toThrow('exit:1');
    expect(stdout).toEqual([]);
  });
});
