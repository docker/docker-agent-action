import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core');

const { mockCheckMembershipForUser, mockGetPull, MockOctokit, constructorTokens } = vi.hoisted(
  () => {
    const mockCheckMembershipForUser = vi.fn().mockResolvedValue({}); // 204 = member
    const mockGetPull = vi.fn().mockResolvedValue({ data: { user: { login: 'bob' } } });

    // Track which auth token was passed to each new Octokit() instance, in order.
    // Index 0 = first instance created, 1 = second, etc.
    const constructorTokens: string[] = [];

    class MockOctokit {
      constructor({ auth }: { auth: string }) {
        constructorTokens.push(auth);
      }
      rest = {
        orgs: { checkMembershipForUser: mockCheckMembershipForUser },
        pulls: { get: mockGetPull },
      };
    }

    return { mockCheckMembershipForUser, mockGetPull, MockOctokit, constructorTokens };
  },
);

vi.mock('@octokit/rest', () => ({ Octokit: MockOctokit }));

import { checkOrgMembership, resolvePrAuthor } from '../index.js';

const ORG_TOKEN = 'fake-org-token';
const REPO_TOKEN = 'fake-repo-token';
const ORG = 'docker';
const USERNAME = 'alice';

beforeEach(() => {
  constructorTokens.length = 0;
});

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
// Token isolation: checkOrgMembership uses ORG_TOKEN, resolvePrAuthor uses REPO_TOKEN
// ---------------------------------------------------------------------------

describe('token isolation', () => {
  it('checkOrgMembership uses orgToken, resolvePrAuthor uses repoToken — never swapped', async () => {
    mockCheckMembershipForUser.mockResolvedValueOnce({});
    mockGetPull.mockResolvedValueOnce({ data: { user: { login: 'eve' } } });

    await checkOrgMembership(ORG_TOKEN, ORG, USERNAME);
    await resolvePrAuthor(REPO_TOKEN, 'docker', 'myrepo', 5);

    // First Octokit instance (for checkOrgMembership) must use ORG_TOKEN
    // Second Octokit instance (for resolvePrAuthor) must use REPO_TOKEN
    expect(constructorTokens).toEqual([ORG_TOKEN, REPO_TOKEN]);
  });
});
