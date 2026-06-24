// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core');

const { mockPaginate, mockListComments, mockListReviewComments, MockOctokit } = vi.hoisted(() => {
  const mockListComments = { endpoint: 'issues.listComments' };
  const mockListReviewComments = { endpoint: 'pulls.listReviewComments' };
  const mockPaginate = vi.fn();

  class MockOctokit {
    paginate = mockPaginate;
    rest = {
      issues: { listComments: mockListComments },
      pulls: { listReviewComments: mockListReviewComments },
    };
  }
  return { mockPaginate, mockListComments, mockListReviewComments, MockOctokit };
});

vi.mock('@octokit/rest', () => ({ Octokit: MockOctokit }));

import { detectRateAnomaly } from '../index.js';

const NOW = Date.parse('2026-06-24T10:10:00.000Z');
const within = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();

const BOT = 'docker-agent';
const REVIEW_MARKER = '<!-- docker-agent-review -->';
const REPLY_MARKER = '<!-- docker-agent-review-reply -->';

function agentComment(secAgo: number, marker = REVIEW_MARKER) {
  return { user: { login: BOT }, body: `Review body ${marker}`, created_at: within(secAgo) };
}

// Route paginate() to the right dataset based on which endpoint it was given.
function routePaginate(issue: unknown[], review: unknown[]) {
  mockPaginate.mockImplementation((endpoint: unknown) => {
    if (endpoint === mockListReviewComments) return Promise.resolve(review);
    return Promise.resolve(issue);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('detectRateAnomaly', () => {
  const base = {
    owner: 'docker',
    repo: 'repo',
    prNumber: 5,
    windowSeconds: 600,
    threshold: 3,
    botLogin: BOT,
    nowMs: NOW,
  };

  it('counts agent review + reply comments within the window across both comment types', async () => {
    routePaginate(
      [agentComment(60), agentComment(120, REPLY_MARKER)],
      [agentComment(30), agentComment(90)],
    );

    const r = await detectRateAnomaly('tok', base);

    expect(r.count).toBe(4);
    expect(r.anomalous).toBe(true);
    expect(r.threshold).toBe(3);
  });

  it('is not anomalous below the threshold', async () => {
    routePaginate([agentComment(60)], [agentComment(30)]);
    const r = await detectRateAnomaly('tok', base);
    expect(r.count).toBe(2);
    expect(r.anomalous).toBe(false);
  });

  it('ignores comments outside the window (created before windowStart)', async () => {
    routePaginate(
      [agentComment(60), agentComment(2000 /* 33min ago, outside 600s */)],
      [agentComment(30)],
    );
    const r = await detectRateAnomaly('tok', base);
    expect(r.count).toBe(2);
  });

  it('ignores comments from other users', async () => {
    routePaginate(
      [{ user: { login: 'mallory' }, body: `spam ${REVIEW_MARKER}`, created_at: within(10) }],
      [],
    );
    const r = await detectRateAnomaly('tok', base);
    expect(r.count).toBe(0);
    expect(r.anomalous).toBe(false);
  });

  it('ignores agent comments that lack a review marker (e.g. ordinary chatter)', async () => {
    routePaginate(
      [{ user: { login: BOT }, body: 'just a plain comment', created_at: within(10) }],
      [],
    );
    const r = await detectRateAnomaly('tok', base);
    expect(r.count).toBe(0);
  });

  it('counts legacy cagent markers during the migration window', async () => {
    routePaginate(
      [{ user: { login: BOT }, body: 'old <!-- cagent-review -->', created_at: within(10) }],
      [],
    );
    const r = await detectRateAnomaly('tok', { ...base, threshold: 1 });
    expect(r.count).toBe(1);
    expect(r.anomalous).toBe(true);
  });

  it('passes a since timestamp derived from the window to the API', async () => {
    routePaginate([], []);
    await detectRateAnomaly('tok', base);
    const issueCall = mockPaginate.mock.calls.find((c) => c[0] === mockListComments);
    expect(issueCall?.[1]).toMatchObject({
      owner: 'docker',
      repo: 'repo',
      issue_number: 5,
      since: new Date(NOW - 600 * 1000).toISOString(),
    });
  });
});
