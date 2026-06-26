// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core');

const { mockPaginate, mockListComments, mockListReviewComments, mockListReviews, MockOctokit } =
  vi.hoisted(() => {
    const mockListComments = { endpoint: 'issues.listComments' };
    const mockListReviewComments = { endpoint: 'pulls.listReviewComments' };
    const mockListReviews = { endpoint: 'pulls.listReviews' };
    const mockPaginate = vi.fn();

    class MockOctokit {
      paginate = mockPaginate;
      rest = {
        issues: { listComments: mockListComments },
        pulls: { listReviewComments: mockListReviewComments, listReviews: mockListReviews },
      };
    }
    return {
      mockPaginate,
      mockListComments,
      mockListReviewComments,
      mockListReviews,
      MockOctokit,
    };
  });

vi.mock('@octokit/rest', () => ({ Octokit: MockOctokit }));

import { detectRateAnomaly } from '../index.js';

const NOW = Date.parse('2026-06-24T10:10:00.000Z');
const within = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();

const BOT = 'docker-agent';
const REVIEW_MARKER = '<!-- docker-agent-review -->';
const REPLY_MARKER = '<!-- docker-agent-review-reply -->';

// A conversational reply (issue comment or inline review-comment reply): one per
// reply LLM run, identified by the reply marker.
function reply(secAgo: number, marker = REPLY_MARKER, login = BOT) {
  return { user: { login }, body: `Reply ${marker}`, created_at: within(secAgo) };
}

// A full review posted via the Reviews API: one per review LLM run, identified by
// bot author plus a non-empty assessment/status body (no inline marker).
function review(secAgo: number, body = '### Assessment: 🟢 APPROVE', login = BOT) {
  return { user: { login }, body, submitted_at: within(secAgo) };
}

// Route paginate() to the right dataset based on which endpoint it was given.
function routePaginate(issue: unknown[], reviewComments: unknown[], reviews: unknown[]) {
  mockPaginate.mockImplementation((endpoint: unknown) => {
    if (endpoint === mockListReviewComments) return Promise.resolve(reviewComments);
    if (endpoint === mockListReviews) return Promise.resolve(reviews);
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

  it('counts full reviews plus reply comments within the window', async () => {
    routePaginate(
      [reply(120)], // top-level reply (issue comment)
      [reply(60)], // inline review-comment reply
      [review(30), review(90)], // two full review runs
    );

    const r = await detectRateAnomaly('tok', base);

    expect(r.count).toBe(4);
    expect(r.anomalous).toBe(true);
    expect(r.threshold).toBe(3);
  });

  it('counts a zero-finding APPROVE review (no marker, non-empty body)', async () => {
    // Regression: review bodies have no inline marker and zero-finding reviews
    // post no inline comments, so this is invisible to the comment endpoints.
    routePaginate([], [], [review(30, '### Assessment: 🟢 APPROVE')]);
    const r = await detectRateAnomaly('tok', { ...base, threshold: 1 });
    expect(r.count).toBe(1);
    expect(r.anomalous).toBe(true);
  });

  it('counts timeout / error / LGTM fallback reviews (no marker)', async () => {
    routePaginate(
      [],
      [],
      [
        review(30, '⏱️ **PR Review Timed Out** — …'),
        review(60, '❌ **PR Review Failed** — …'),
        review(90, '🟢 **No issues found** — LGTM!'),
      ],
    );
    const r = await detectRateAnomaly('tok', base);
    expect(r.count).toBe(3);
    expect(r.anomalous).toBe(true);
  });

  it('is not anomalous below the threshold', async () => {
    routePaginate([reply(120)], [], [review(30)]);
    const r = await detectRateAnomaly('tok', base);
    expect(r.count).toBe(2);
    expect(r.anomalous).toBe(false);
  });

  it('does not double-count a review by also counting its inline finding comments', async () => {
    // A findings review is one run: the review object (counted) carries N inline
    // comments with the review marker (NOT counted — they are part of that run).
    routePaginate(
      [],
      [reply(40, REVIEW_MARKER), reply(40, REVIEW_MARKER), reply(40, REVIEW_MARKER)],
      [review(40, '### Assessment: 🟡 NEEDS ATTENTION')],
    );
    const r = await detectRateAnomaly('tok', { ...base, threshold: 1 });
    expect(r.count).toBe(1);
  });

  it('ignores empty-body review entries (standalone inline comments/replies)', async () => {
    // Inline comments/replies surface in listReviews as empty-body review entries;
    // they must not be counted as review runs.
    routePaginate([], [], [review(30, ''), review(60, '   ')]);
    const r = await detectRateAnomaly('tok', base);
    expect(r.count).toBe(0);
    expect(r.anomalous).toBe(false);
  });

  it('ignores reviews and replies outside the window', async () => {
    routePaginate([reply(2000 /* 33min ago */)], [], [review(30), review(2000 /* outside 600s */)]);
    const r = await detectRateAnomaly('tok', base);
    expect(r.count).toBe(1);
  });

  it('ignores reviews and comments from other users', async () => {
    routePaginate(
      [{ user: { login: 'mallory' }, body: `spam ${REPLY_MARKER}`, created_at: within(10) }],
      [],
      [review(20, '### Assessment: 🟢 APPROVE', 'mallory')],
    );
    const r = await detectRateAnomaly('tok', base);
    expect(r.count).toBe(0);
    expect(r.anomalous).toBe(false);
  });

  it('matches the docker-agent[bot] App-token identity', async () => {
    routePaginate(
      [reply(60, REPLY_MARKER, 'docker-agent[bot]')],
      [],
      [review(30, '### Assessment: 🟢 APPROVE', 'docker-agent[bot]')],
    );
    const r = await detectRateAnomaly('tok', { ...base, threshold: 2 });
    expect(r.count).toBe(2);
    expect(r.anomalous).toBe(true);
  });

  it('ignores agent reply comments that lack a reply marker (ordinary chatter)', async () => {
    routePaginate(
      [{ user: { login: BOT }, body: 'just a plain comment', created_at: within(10) }],
      [],
      [],
    );
    const r = await detectRateAnomaly('tok', base);
    expect(r.count).toBe(0);
  });

  it('counts the legacy cagent reply marker during the migration window', async () => {
    routePaginate(
      [{ user: { login: BOT }, body: 'old <!-- cagent-review-reply -->', created_at: within(10) }],
      [],
      [],
    );
    const r = await detectRateAnomaly('tok', { ...base, threshold: 1 });
    expect(r.count).toBe(1);
    expect(r.anomalous).toBe(true);
  });

  it('passes a since timestamp to the comment endpoints', async () => {
    routePaginate([], [], []);
    await detectRateAnomaly('tok', base);
    const issueCall = mockPaginate.mock.calls.find((c) => c[0] === mockListComments);
    expect(issueCall?.[1]).toMatchObject({
      owner: 'docker',
      repo: 'repo',
      issue_number: 5,
      since: new Date(NOW - 600 * 1000).toISOString(),
    });
  });

  it('queries listReviews without a since parameter (the API has none)', async () => {
    routePaginate([], [], []);
    await detectRateAnomaly('tok', base);
    const reviewCall = mockPaginate.mock.calls.find((c) => c[0] === mockListReviews);
    expect(reviewCall?.[1]).toMatchObject({ owner: 'docker', repo: 'repo', pull_number: 5 });
    expect(reviewCall?.[1]).not.toHaveProperty('since');
  });
});
