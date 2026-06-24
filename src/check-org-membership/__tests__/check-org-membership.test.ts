// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core');

const {
  mockCheckMembershipForUser,
  mockGetPull,
  mockListEventsForTimeline,
  mockPaginate,
  MockOctokit,
  constructorTokens,
} = vi.hoisted(() => {
  const mockCheckMembershipForUser = vi.fn().mockResolvedValue({}); // 204 = member
  const mockGetPull = vi.fn().mockResolvedValue({ data: { user: { login: 'bob' } } });
  const mockListEventsForTimeline = vi.fn();
  const mockPaginate = vi.fn().mockResolvedValue([]);

  // Track which auth token was passed to each new Octokit() instance, in order.
  // Index 0 = first instance created, 1 = second, etc.
  const constructorTokens: string[] = [];

  class MockOctokit {
    paginate = mockPaginate;
    rest = {
      orgs: { checkMembershipForUser: mockCheckMembershipForUser },
      pulls: { get: mockGetPull },
      issues: { listEventsForTimeline: mockListEventsForTimeline },
    };
    constructor({ auth }: { auth: string }) {
      constructorTokens.push(auth);
    }
  }

  return {
    mockCheckMembershipForUser,
    mockGetPull,
    mockListEventsForTimeline,
    mockPaginate,
    MockOctokit,
    constructorTokens,
  };
});

vi.mock('@octokit/rest', () => ({ Octokit: MockOctokit }));

import {
  checkOrgMembership,
  evaluateMembership,
  type MembershipInputs,
  resolvePrAuthor,
  resolveReviewRequester,
} from '../index.js';

const ORG_TOKEN = 'fake-org-token';
const REPO_TOKEN = 'fake-repo-token';
const ORG = 'docker';
const USERNAME = 'alice';

beforeEach(() => {
  vi.clearAllMocks();
  constructorTokens.length = 0;
});

/** Make checkOrgMembership resolve "member" only for the listed logins. */
function membersAre(...members: string[]): void {
  mockCheckMembershipForUser.mockImplementation(({ username }: { username: string }) =>
    members.includes(username)
      ? Promise.resolve({})
      : Promise.reject(Object.assign(new Error('Not Found'), { status: 404 })),
  );
}

/** Build a timeline review_requested event. */
function reviewRequestedEvent(requester: string, reviewer = 'docker-agent') {
  return {
    event: 'review_requested',
    actor: { login: requester },
    review_requester: { login: requester },
    requested_reviewer: { login: reviewer },
  };
}

function inputs(overrides: Partial<MembershipInputs> = {}): MembershipInputs {
  return {
    orgToken: ORG_TOKEN,
    repoToken: REPO_TOKEN,
    org: ORG,
    reviewerLogin: 'docker-agent',
    repository: 'docker/myrepo',
    prSource: 'event',
    eventName: 'pull_request',
    eventAction: 'opened',
    prNumber: 1,
    commentAuthor: '',
    trustedRequester: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkOrgMembership
// ---------------------------------------------------------------------------

describe('checkOrgMembership', () => {
  it('returns true when the API returns 204 (member confirmed)', async () => {
    mockCheckMembershipForUser.mockResolvedValueOnce({});

    const result = await checkOrgMembership(ORG_TOKEN, ORG, USERNAME);

    expect(result).toBe(true);
    expect(mockCheckMembershipForUser).toHaveBeenCalledWith({ org: ORG, username: USERNAME });
  });

  it('returns false when the API returns 404 (not a member)', async () => {
    mockCheckMembershipForUser.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { status: 404 }),
    );

    const result = await checkOrgMembership(ORG_TOKEN, ORG, USERNAME);

    expect(result).toBe(false);
  });

  it('returns false when the API returns 302 (token lacks org visibility)', async () => {
    mockCheckMembershipForUser.mockRejectedValueOnce(
      Object.assign(new Error('Found'), { status: 302 }),
    );

    const result = await checkOrgMembership(ORG_TOKEN, ORG, USERNAME);

    expect(result).toBe(false);
  });

  it('throws a descriptive error when the API returns 401 (bad token)', async () => {
    mockCheckMembershipForUser.mockRejectedValueOnce(
      Object.assign(new Error('Unauthorized'), { status: 401 }),
    );

    const err = await checkOrgMembership(ORG_TOKEN, ORG, USERNAME).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as { status?: number }).status).toBe(401);
  });

  it('re-throws unexpected errors', async () => {
    mockCheckMembershipForUser.mockRejectedValueOnce(
      Object.assign(new Error('Internal Server Error'), { status: 500 }),
    );

    await expect(checkOrgMembership(ORG_TOKEN, ORG, USERNAME)).rejects.toThrow(
      'Internal Server Error',
    );
  });
});

// ---------------------------------------------------------------------------
// resolvePrAuthor
// ---------------------------------------------------------------------------

describe('resolvePrAuthor', () => {
  it('returns the PR author login', async () => {
    mockGetPull.mockResolvedValueOnce({ data: { user: { login: 'charlie' } } });

    const login = await resolvePrAuthor(REPO_TOKEN, 'docker', 'myrepo', 42);

    expect(login).toBe('charlie');
    expect(mockGetPull).toHaveBeenCalledWith({ owner: 'docker', repo: 'myrepo', pull_number: 42 });
  });

  it('returns empty string when user is null (e.g. deleted account)', async () => {
    mockGetPull.mockResolvedValueOnce({ data: { user: null } });

    const login = await resolvePrAuthor(REPO_TOKEN, 'docker', 'myrepo', 7);

    expect(login).toBe('');
  });

  it('uses a separate Octokit instance with the repo token, not the org token', async () => {
    mockGetPull.mockResolvedValueOnce({ data: { user: { login: 'dave' } } });

    await resolvePrAuthor(REPO_TOKEN, 'docker', 'myrepo', 1);

    // The single Octokit instance created by resolvePrAuthor should use REPO_TOKEN
    expect(constructorTokens).toEqual([REPO_TOKEN]);
  });

  it('propagates API errors', async () => {
    mockGetPull.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));

    await expect(resolvePrAuthor(REPO_TOKEN, 'docker', 'myrepo', 999)).rejects.toThrow('Not Found');
  });
});

// ---------------------------------------------------------------------------
// resolveReviewRequester (trusted, timeline-derived)
// ---------------------------------------------------------------------------

describe('resolveReviewRequester', () => {
  it('returns the requester of the latest review_requested event for the reviewer', async () => {
    mockPaginate.mockResolvedValueOnce([
      { event: 'labeled' },
      reviewRequestedEvent('early-maintainer'),
      reviewRequestedEvent('latest-maintainer'),
    ]);

    const requester = await resolveReviewRequester(
      REPO_TOKEN,
      'docker',
      'myrepo',
      7,
      'docker-agent',
    );

    expect(requester).toBe('latest-maintainer');
    expect(mockPaginate).toHaveBeenCalledWith(mockListEventsForTimeline, {
      owner: 'docker',
      repo: 'myrepo',
      issue_number: 7,
      per_page: 100,
    });
  });

  it('ignores review_requested events targeting a different reviewer', async () => {
    mockPaginate.mockResolvedValueOnce([reviewRequestedEvent('maintainer', 'someone-else')]);

    const requester = await resolveReviewRequester(
      REPO_TOKEN,
      'docker',
      'myrepo',
      7,
      'docker-agent',
    );

    expect(requester).toBe('');
  });

  it('returns empty string when there is no review request', async () => {
    mockPaginate.mockResolvedValueOnce([{ event: 'commented' }, { event: 'labeled' }]);

    const requester = await resolveReviewRequester(
      REPO_TOKEN,
      'docker',
      'myrepo',
      7,
      'docker-agent',
    );

    expect(requester).toBe('');
  });

  it('falls back to actor.login when review_requester is absent', async () => {
    mockPaginate.mockResolvedValueOnce([
      {
        event: 'review_requested',
        actor: { login: 'actor-m' },
        requested_reviewer: { login: 'docker-agent' },
      },
    ]);

    const requester = await resolveReviewRequester(
      REPO_TOKEN,
      'docker',
      'myrepo',
      7,
      'docker-agent',
    );

    expect(requester).toBe('actor-m');
  });

  it('uses the repo token', async () => {
    mockPaginate.mockResolvedValueOnce([]);

    await resolveReviewRequester(REPO_TOKEN, 'docker', 'myrepo', 7, 'docker-agent');

    expect(constructorTokens).toEqual([REPO_TOKEN]);
  });
});

// ---------------------------------------------------------------------------
// evaluateMembership — the two authorization paths
// ---------------------------------------------------------------------------

describe('evaluateMembership', () => {
  it('auto-run: authorizes an org-member PR author (via author)', async () => {
    membersAre('alice-author');
    mockGetPull.mockResolvedValueOnce({ data: { user: { login: 'alice-author' } } });

    const decision = await evaluateMembership(inputs({ eventAction: 'synchronize', prNumber: 3 }));

    expect(decision).toEqual({ isMember: true, subject: 'alice-author', via: 'author' });
    // Author membership is enough — no requester lookup needed.
    expect(mockPaginate).not.toHaveBeenCalled();
  });

  it('auto-run: denies an external (non-member) PR author', async () => {
    membersAre(); // nobody is a member
    mockGetPull.mockResolvedValueOnce({ data: { user: { login: 'ext-author' } } });

    const decision = await evaluateMembership(inputs({ eventAction: 'opened' }));

    expect(decision).toEqual({ isMember: false, subject: 'ext-author', via: 'none' });
    expect(mockPaginate).not.toHaveBeenCalled();
  });

  it('review_requested (direct): authorizes an external PR via the requesting maintainer', async () => {
    membersAre('maintainer');
    mockGetPull.mockResolvedValueOnce({ data: { user: { login: 'ext-author' } } });

    const decision = await evaluateMembership(
      inputs({ eventAction: 'review_requested', trustedRequester: 'maintainer' }),
    );

    expect(decision).toEqual({ isMember: true, subject: 'maintainer', via: 'requester' });
    // Direct path uses the trusted event sender — no timeline lookup.
    expect(mockPaginate).not.toHaveBeenCalled();
  });

  it('review_requested: the REQUESTER env value is only trusted on the direct same-repo triple', async () => {
    // Defense-in-depth: a PR_SOURCE=event path whose event is NOT a
    // pull_request:review_requested must never trust the env-supplied requester,
    // even if that login is a real org member. Here an auto-run "opened" event
    // carries a member login in trustedRequester; it must be ignored.
    membersAre('sneaky-member');
    mockGetPull.mockResolvedValueOnce({ data: { user: { login: 'ext-author' } } });

    const decision = await evaluateMembership(
      inputs({ eventAction: 'opened', trustedRequester: 'sneaky-member' }),
    );

    expect(decision).toEqual({ isMember: false, subject: 'ext-author', via: 'none' });
    expect(mockPaginate).not.toHaveBeenCalled();
  });

  it('review_requested (direct): denies when the requester is not an org member', async () => {
    membersAre(); // neither author nor requester is a member
    mockGetPull.mockResolvedValueOnce({ data: { user: { login: 'ext-author' } } });

    const decision = await evaluateMembership(
      inputs({ eventAction: 'review_requested', trustedRequester: 'outsider' }),
    );

    expect(decision).toEqual({ isMember: false, subject: 'ext-author', via: 'none' });
  });

  it('review_requested (fork/trigger): authorizes via the timeline-derived requester', async () => {
    membersAre('maintainer');
    mockGetPull.mockResolvedValueOnce({ data: { user: { login: 'ext-author' } } });
    mockPaginate.mockResolvedValueOnce([reviewRequestedEvent('maintainer')]);

    const decision = await evaluateMembership(
      inputs({
        prSource: 'trigger',
        eventName: 'workflow_run',
        eventAction: 'completed',
        prNumber: 7,
      }),
    );

    expect(decision).toEqual({ isMember: true, subject: 'maintainer', via: 'requester' });
  });

  it('fork/trigger auto-run (no review requested): denies an external PR', async () => {
    membersAre('maintainer');
    mockGetPull.mockResolvedValueOnce({ data: { user: { login: 'ext-author' } } });
    mockPaginate.mockResolvedValueOnce([]); // no review_requested event in the timeline

    const decision = await evaluateMembership(
      inputs({
        prSource: 'trigger',
        eventName: 'workflow_run',
        eventAction: 'completed',
        prNumber: 7,
      }),
    );

    expect(decision).toEqual({ isMember: false, subject: 'ext-author', via: 'none' });
  });

  it('fork/trigger: a forged timeline requester is still validated against real org membership', async () => {
    // Even if the (fork-influenced) PR claimed a member, the requester is taken
    // from the trusted timeline AND re-checked against the org. A non-member there
    // is denied.
    membersAre(); // the timeline actor is NOT actually a member
    mockGetPull.mockResolvedValueOnce({ data: { user: { login: 'ext-author' } } });
    mockPaginate.mockResolvedValueOnce([reviewRequestedEvent('not-a-member')]);

    const decision = await evaluateMembership(
      inputs({
        prSource: 'trigger',
        eventName: 'workflow_run',
        eventAction: 'completed',
        prNumber: 7,
      }),
    );

    expect(decision).toEqual({ isMember: false, subject: 'ext-author', via: 'none' });
  });

  it('issue_comment: authorizes an org-member commenter (via comment)', async () => {
    membersAre('commenter');

    const decision = await evaluateMembership(
      inputs({ eventName: 'issue_comment', eventAction: 'created', commentAuthor: 'commenter' }),
    );

    expect(decision).toEqual({ isMember: true, subject: 'commenter', via: 'comment' });
    // Comment path never resolves the PR author or the timeline.
    expect(mockGetPull).not.toHaveBeenCalled();
    expect(mockPaginate).not.toHaveBeenCalled();
  });

  it('issue_comment: denies a non-member commenter', async () => {
    membersAre();

    const decision = await evaluateMembership(
      inputs({ eventName: 'issue_comment', eventAction: 'created', commentAuthor: 'ext' }),
    );

    expect(decision).toEqual({ isMember: false, subject: 'ext', via: 'none' });
  });

  it('throws on an invalid PR number for PR-driven paths', async () => {
    await expect(evaluateMembership(inputs({ prNumber: Number.NaN }))).rejects.toThrow(
      /Invalid pr-number/,
    );
  });
});
