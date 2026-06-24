// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockNotice, mockWarning, mockAddRaw, mockAppendFileSync, mockMkdirSync } = vi.hoisted(
  () => ({
    mockNotice: vi.fn(),
    mockWarning: vi.fn(),
    mockAddRaw: vi.fn(),
    mockAppendFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
  }),
);

vi.mock('@actions/core', () => ({
  notice: mockNotice,
  warning: mockWarning,
  info: vi.fn(),
  setOutput: vi.fn(),
  summary: { addRaw: mockAddRaw, write: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('node:fs', () => ({
  appendFileSync: mockAppendFileSync,
  mkdirSync: mockMkdirSync,
}));

import {
  buildAuditRecord,
  emitAuditRecord,
  formatNotice,
  formatSummaryLine,
  resolveAuditFilePath,
} from '../index.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildAuditRecord', () => {
  it('maps environment variables into a full record', () => {
    const r = buildAuditRecord({
      AUDIT_TIMESTAMP: '2026-06-24T10:00:00.000Z',
      AUDIT_EVENT: 'pull_request',
      AUDIT_TRIGGER: 'review_requested',
      AUDIT_ACTOR: 'alice',
      AUDIT_PR_NUMBER: '42',
      AUDIT_HEAD_SHA: 'abc123def456',
      AUDIT_DECISION: 'authorized',
      AUDIT_REASON: 'org member',
      GITHUB_REPOSITORY: 'docker/repo',
      GITHUB_RUN_ID: '999',
      GITHUB_SERVER_URL: 'https://github.com',
    });

    expect(r).toMatchObject({
      timestamp: '2026-06-24T10:00:00.000Z',
      event: 'pull_request',
      trigger: 'review_requested',
      actor: 'alice',
      repository: 'docker/repo',
      prNumber: '42',
      headSha: 'abc123def456',
      decision: 'authorized',
      reason: 'org member',
      runId: '999',
      runUrl: 'https://github.com/docker/repo/actions/runs/999',
    });
  });

  it('falls back to safe defaults for missing fields', () => {
    const r = buildAuditRecord({});
    expect(r.trigger).toBe('unknown');
    expect(r.actor).toBe('unknown');
    expect(r.prNumber).toBe('');
    expect(r.runUrl).toBe('');
    // timestamp defaults to a valid ISO string
    expect(Number.isNaN(Date.parse(r.timestamp))).toBe(false);
  });

  it('coerces an invalid decision to "skipped"', () => {
    expect(buildAuditRecord({ AUDIT_DECISION: 'bogus' }).decision).toBe('skipped');
    expect(buildAuditRecord({ AUDIT_DECISION: 'denied' }).decision).toBe('denied');
    expect(buildAuditRecord({ AUDIT_DECISION: 'throttled' }).decision).toBe('throttled');
  });

  it('falls back to GITHUB_EVENT_NAME when AUDIT_EVENT is unset', () => {
    expect(buildAuditRecord({ GITHUB_EVENT_NAME: 'issue_comment' }).event).toBe('issue_comment');
  });

  it('omits runUrl when repository or run id is missing', () => {
    expect(buildAuditRecord({ GITHUB_REPOSITORY: 'docker/repo' }).runUrl).toBe('');
    expect(buildAuditRecord({ GITHUB_RUN_ID: '1' }).runUrl).toBe('');
  });
});

describe('resolveAuditFilePath', () => {
  it('prefers REVIEW_AUDIT_FILE', () => {
    expect(resolveAuditFilePath({ REVIEW_AUDIT_FILE: '/custom/audit.jsonl' })).toBe(
      '/custom/audit.jsonl',
    );
  });
  it('falls back to RUNNER_TEMP', () => {
    expect(resolveAuditFilePath({ RUNNER_TEMP: '/runner/tmp' })).toBe(
      '/runner/tmp/review-audit.jsonl',
    );
  });
  it('falls back to /tmp', () => {
    expect(resolveAuditFilePath({})).toBe('/tmp/review-audit.jsonl');
  });
});

describe('formatters', () => {
  const record = buildAuditRecord({
    AUDIT_TIMESTAMP: '2026-06-24T10:00:00.000Z',
    AUDIT_TRIGGER: 'mention',
    AUDIT_ACTOR: 'bob',
    AUDIT_PR_NUMBER: '7',
    AUDIT_HEAD_SHA: 'deadbeefcafe',
    AUDIT_DECISION: 'denied',
    AUDIT_REASON: 'not an org member',
  });

  it('formatNotice prefixes with a greppable tag and embeds JSON', () => {
    const msg = formatNotice(record);
    expect(msg.startsWith('[review-request-audit] ')).toBe(true);
    const parsed = JSON.parse(msg.slice('[review-request-audit] '.length));
    expect(parsed.actor).toBe('bob');
    expect(parsed.decision).toBe('denied');
  });

  it('formatSummaryLine renders a concise markdown bullet with a short SHA', () => {
    const line = formatSummaryLine(record);
    expect(line).toContain('**denied**');
    expect(line).toContain('@bob');
    expect(line).toContain('PR #7');
    expect(line).toContain('`deadbeef`'); // short SHA
    expect(line).toContain('not an org member');
  });
});

describe('emitAuditRecord', () => {
  it('emits a notice, a summary line, and appends JSONL to the audit file', () => {
    const record = buildAuditRecord({ AUDIT_ACTOR: 'carol', AUDIT_DECISION: 'authorized' });
    emitAuditRecord(record, { auditFilePath: '/tmp/x/review-audit.jsonl' });

    expect(mockNotice).toHaveBeenCalledTimes(1);
    expect(mockAddRaw).toHaveBeenCalledTimes(1);
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/x', { recursive: true });
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    const [path, line] = mockAppendFileSync.mock.calls[0];
    expect(path).toBe('/tmp/x/review-audit.jsonl');
    expect(JSON.parse((line as string).trim()).actor).toBe('carol');
  });

  it('downgrades a file-write failure to a warning (never throws)', () => {
    mockAppendFileSync.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const record = buildAuditRecord({ AUDIT_ACTOR: 'dave' });
    expect(() => emitAuditRecord(record, { auditFilePath: '/tmp/y.jsonl' })).not.toThrow();
    expect(mockWarning).toHaveBeenCalledTimes(1);
    // The notice still fired despite the persistence failure.
    expect(mockNotice).toHaveBeenCalledTimes(1);
  });
});
