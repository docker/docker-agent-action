// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for src/main/auth.ts
 *
 * Uses vi.hoisted() to create proper class-based mocks for @octokit/rest,
 * matching the project's existing mock patterns (see check-org-membership tests).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core');

// ── Mocks (must be hoisted to run before imports) ─────────────────────────────

const { mockGetAuthenticated, MockOctokit } = vi.hoisted(() => {
  const mockGetAuthenticated = vi
    .fn()
    .mockResolvedValue({ data: { login: 'github-actions[bot]' } });

  class MockOctokit {
    rest = {
      users: { getAuthenticated: mockGetAuthenticated },
      orgs: { checkMembershipForUser: vi.fn() },
    };
  }

  return { mockGetAuthenticated, MockOctokit };
});

vi.mock('@octokit/rest', () => ({ Octokit: MockOctokit }));

vi.mock('../../check-org-membership/index.js', () => ({
  checkOrgMembership: vi.fn(),
}));

import { checkOrgMembership } from '../../check-org-membership/index.js';
import { checkAuthorization } from '../auth.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let eventPayloadPath: string;

const mockCheckOrgMembership = checkOrgMembership as ReturnType<typeof vi.fn>;

async function writePayload(payload: object): Promise<void> {
  await writeFile(eventPayloadPath, JSON.stringify(payload), 'utf-8');
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'auth-test-'));
  eventPayloadPath = join(tmpDir, 'event.json');
  vi.clearAllMocks();
  // Default: bot token resolves to 'github-actions[bot]'
  mockGetAuthenticated.mockResolvedValue({ data: { login: 'github-actions[bot]' } });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const BASE_OPTS = {
  githubToken: 'ghs_testtoken',
  orgMembershipToken: '',
  authOrg: '',
  eventPayloadPath: '', // set per-test
};

// ── Tier 0: skip-auth ────────────────────────────────────────────────────────

describe('Tier 0: skip-auth', () => {
  it('returns skipped-by-caller when skipAuth=true', async () => {
    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: true,
      eventPayloadPath,
    });
    expect(result.authorized).toBe(true);
    expect(result.outcome).toBe('skipped-by-caller');
  });
});

// ── Tier 1: non-comment event ────────────────────────────────────────────────

describe('Tier 1: non-comment event', () => {
  it('skips auth when payload has no comment fields', async () => {
    await writePayload({ action: 'opened', pull_request: { number: 1 } });
    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      eventPayloadPath,
    });
    expect(result.authorized).toBe(true);
    expect(result.outcome).toBe('skipped');
  });

  it('skips auth when event payload file is missing', async () => {
    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      eventPayloadPath: '/nonexistent/path.json',
    });
    expect(result.authorized).toBe(true);
    expect(result.outcome).toBe('skipped');
  });
});

// ── Tier 2: trusted-bot bypass ───────────────────────────────────────────────

describe('Tier 2: trusted-bot bypass', () => {
  it('authorizes when comment author matches token login', async () => {
    await writePayload({
      comment: {
        author_association: 'NONE',
        user: { login: 'my-bot' },
      },
    });
    mockGetAuthenticated.mockResolvedValue({ data: { login: 'my-bot' } });

    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      eventPayloadPath,
    });
    expect(result.authorized).toBe(true);
    expect(result.outcome).toBe('trusted-bot');
  });

  it('falls through when comment author does not match token login', async () => {
    await writePayload({
      comment: {
        author_association: 'OWNER',
        user: { login: 'human-user' },
      },
    });
    mockGetAuthenticated.mockResolvedValue({ data: { login: 'different-bot' } });

    // No org membership configured → falls to tier 4 (author_association=OWNER → pass)
    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      eventPayloadPath,
    });
    expect(result.authorized).toBe(true);
    expect(result.outcome).toBe('author-association');
  });

  it('continues after trusted-bot API failure', async () => {
    await writePayload({
      comment: {
        author_association: 'OWNER',
        user: { login: 'human-user' },
      },
    });
    mockGetAuthenticated.mockRejectedValue(new Error('Network error'));

    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      eventPayloadPath,
    });
    // Falls through to tier 4 (OWNER is allowed)
    expect(result.authorized).toBe(true);
    expect(result.outcome).toBe('author-association');
  });
});

// ── Tier 3: org membership ────────────────────────────────────────────────────

describe('Tier 3: org membership', () => {
  it('authorizes org member', async () => {
    await writePayload({
      comment: {
        author_association: 'NONE',
        user: { login: 'org-member-user' },
      },
    });
    mockGetAuthenticated.mockResolvedValue({ data: { login: 'other-bot' } });
    mockCheckOrgMembership.mockResolvedValue(true);

    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      orgMembershipToken: 'org-token',
      authOrg: 'my-org',
      eventPayloadPath,
    });
    expect(result.authorized).toBe(true);
    expect(result.outcome).toBe('org-member');
    expect(mockCheckOrgMembership).toHaveBeenCalledWith('org-token', 'my-org', 'org-member-user');
  });

  it('denies non-org member', async () => {
    await writePayload({
      comment: {
        author_association: 'NONE',
        user: { login: 'outsider' },
      },
    });
    mockGetAuthenticated.mockResolvedValue({ data: { login: 'other-bot' } });
    mockCheckOrgMembership.mockResolvedValue(false);

    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      orgMembershipToken: 'org-token',
      authOrg: 'my-org',
      eventPayloadPath,
    });
    expect(result.authorized).toBe(false);
    expect(result.outcome).toBe('denied');
  });

  it('denies when org membership check throws', async () => {
    await writePayload({
      comment: {
        author_association: 'NONE',
        user: { login: 'outsider' },
      },
    });
    mockGetAuthenticated.mockResolvedValue({ data: { login: 'other-bot' } });
    mockCheckOrgMembership.mockRejectedValue(new Error('Token invalid'));

    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      orgMembershipToken: 'org-token',
      authOrg: 'my-org',
      eventPayloadPath,
    });
    expect(result.authorized).toBe(false);
    expect(result.outcome).toBe('denied');
  });

  it('falls through to author_association when org check throws a non-401 error', async () => {
    // Non-401 errors (network timeouts, 5xx) warn and fall through to Tier 4.
    // Using OWNER association so Tier 4 authorizes — this distinguishes
    // fallthrough from hard-deny and confirms the code path under test.
    await writePayload({
      comment: { author_association: 'OWNER', user: { login: 'repo-owner' } },
    });
    mockGetAuthenticated.mockResolvedValue({ data: { login: 'bot' } });
    // Explicitly non-401: plain Error with no .status property
    mockCheckOrgMembership.mockRejectedValue(new Error('Network timeout'));

    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      orgMembershipToken: 'org-token',
      authOrg: 'my-org',
      eventPayloadPath,
    });
    // Non-401: falls through to Tier 4 → OWNER is authorized
    expect(result.authorized).toBe(true);
    expect(result.outcome).toBe('author-association');
  });

  it('hard-denies when org membership token returns HTTP 401 (does not fall through to Tier 4)', async () => {
    // A revoked / invalid token returns 401. This must hard-deny and must NOT
    // fall through to the weaker Tier 4 author_association check.
    // Using OWNER association: if the code fell through, Tier 4 would authorize;
    // the expected `denied` outcome proves hard-deny fired instead.
    await writePayload({
      comment: { author_association: 'OWNER', user: { login: 'repo-owner' } },
    });
    mockGetAuthenticated.mockResolvedValue({ data: { login: 'bot' } });
    const err401 = Object.assign(new Error('Unauthorized'), { status: 401 });
    mockCheckOrgMembership.mockRejectedValue(err401);

    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      orgMembershipToken: 'org-token',
      authOrg: 'my-org',
      eventPayloadPath,
    });
    // Hard-deny: 401 must NOT fall through to Tier 4 (which would authorize OWNER)
    expect(result.authorized).toBe(false);
    expect(result.outcome).toBe('denied');
  });
});

// ── Tier 4: author_association fallback ──────────────────────────────────────

describe('Tier 4: author_association', () => {
  it('authorizes OWNER', async () => {
    await writePayload({
      comment: {
        author_association: 'OWNER',
        user: { login: 'repo-owner' },
      },
    });
    mockGetAuthenticated.mockResolvedValue({ data: { login: 'bot' } });

    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      eventPayloadPath,
    });
    expect(result.authorized).toBe(true);
    expect(result.outcome).toBe('author-association');
  });

  it('authorizes MEMBER', async () => {
    await writePayload({
      comment: { author_association: 'MEMBER', user: { login: 'member' } },
    });
    mockGetAuthenticated.mockResolvedValue({ data: { login: 'bot' } });

    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      eventPayloadPath,
    });
    expect(result.authorized).toBe(true);
    expect(result.outcome).toBe('author-association');
  });

  it('authorizes COLLABORATOR', async () => {
    await writePayload({
      comment: { author_association: 'COLLABORATOR', user: { login: 'collaborator' } },
    });
    mockGetAuthenticated.mockResolvedValue({ data: { login: 'bot' } });

    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      eventPayloadPath,
    });
    expect(result.authorized).toBe(true);
    expect(result.outcome).toBe('author-association');
  });

  it('denies CONTRIBUTOR (not in allowed list)', async () => {
    await writePayload({
      comment: { author_association: 'CONTRIBUTOR', user: { login: 'contributor' } },
    });
    mockGetAuthenticated.mockResolvedValue({ data: { login: 'bot' } });

    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      eventPayloadPath,
    });
    expect(result.authorized).toBe(false);
    expect(result.outcome).toBe('denied');
  });

  it('denies NONE', async () => {
    await writePayload({
      comment: { author_association: 'NONE', user: { login: 'stranger' } },
    });
    mockGetAuthenticated.mockResolvedValue({ data: { login: 'bot' } });

    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      eventPayloadPath,
    });
    expect(result.authorized).toBe(false);
    expect(result.outcome).toBe('denied');
  });

  it('denies when no association and no org token (no method available)', async () => {
    // comment.user.login present but no author_association → falls to tier 4 which has no association
    await writePayload({
      comment: { user: { login: 'stranger' } },
    });
    mockGetAuthenticated.mockResolvedValue({ data: { login: 'bot' } });

    const result = await checkAuthorization({
      ...BASE_OPTS,
      skipAuth: false,
      eventPayloadPath,
    });
    expect(result.authorized).toBe(false);
    expect(result.outcome).toBe('denied');
  });
});
