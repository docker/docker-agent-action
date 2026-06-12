// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import type { Octokit } from '@octokit/rest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignedCommit } from '../signed-commit.js';

const mockGetRef = vi.fn();
const mockCreateRef = vi.fn();
const mockUpdateRef = vi.fn();
const mockDeleteRef = vi.fn();
const mockGraphql = vi.fn();

const mockOctokit = {
  graphql: mockGraphql,
  rest: {
    git: {
      getRef: mockGetRef,
      createRef: mockCreateRef,
      updateRef: mockUpdateRef,
      deleteRef: mockDeleteRef,
    },
  },
} as unknown as Octokit;

const HEAD_SHA = 'abc123def456abc123def456abc123def456abc1';
const COMMIT_OID = 'deadbeef1234deadbeef1234deadbeef12345678';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRef.mockResolvedValue({ data: { object: { sha: HEAD_SHA } } });
  mockCreateRef.mockResolvedValue({});
  mockUpdateRef.mockResolvedValue({});
  mockDeleteRef.mockResolvedValue({});
  mockGraphql.mockResolvedValue({
    createCommitOnBranch: {
      commit: { oid: COMMIT_OID, url: `https://github.com/owner/repo/commit/${COMMIT_OID}` },
    },
  });
});

describe('createSignedCommit', () => {
  it('handles a single file addition', async () => {
    const oid = await createSignedCommit(mockOctokit, {
      repo: 'owner/repo',
      branch: 'main',
      message: 'Add file',
      additions: [{ path: 'hello.txt', contents: 'aGVsbG8=' }],
    });

    expect(oid).toBe(COMMIT_OID);
    expect(mockGetRef).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', ref: 'heads/main' });
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        input: expect.objectContaining({
          fileChanges: { additions: [{ path: 'hello.txt', contents: 'aGVsbG8=' }] },
          expectedHeadOid: HEAD_SHA,
        }),
      }),
    );
  });

  it('handles multiple file additions', async () => {
    const additions = [
      { path: 'file1.txt', contents: 'ZmlsZTE=' },
      { path: 'file2.txt', contents: 'ZmlsZTI=' },
    ];

    await createSignedCommit(mockOctokit, {
      repo: 'owner/repo',
      branch: 'feature',
      message: 'Add files',
      additions,
    });

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        input: expect.objectContaining({
          fileChanges: { additions },
        }),
      }),
    );
  });

  it('handles deletions only', async () => {
    await createSignedCommit(mockOctokit, {
      repo: 'owner/repo',
      branch: 'main',
      message: 'Delete file',
      additions: [],
      deletions: [{ path: 'old.txt' }],
    });

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        input: expect.objectContaining({
          fileChanges: { deletions: [{ path: 'old.txt' }] },
        }),
      }),
    );
  });

  it('handles mixed additions and deletions', async () => {
    await createSignedCommit(mockOctokit, {
      repo: 'owner/repo',
      branch: 'main',
      message: 'Mixed changes',
      additions: [{ path: 'new.txt', contents: 'bmV3' }],
      deletions: [{ path: 'old.txt' }],
    });

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        input: expect.objectContaining({
          fileChanges: {
            additions: [{ path: 'new.txt', contents: 'bmV3' }],
            deletions: [{ path: 'old.txt' }],
          },
        }),
      }),
    );
  });

  it('includes body in message when provided', async () => {
    await createSignedCommit(mockOctokit, {
      repo: 'owner/repo',
      branch: 'main',
      message: 'Headline',
      body: 'This is the body',
      additions: [{ path: 'file.txt', contents: 'dGVzdA==' }],
    });

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        input: expect.objectContaining({
          message: { headline: 'Headline', body: 'This is the body' },
        }),
      }),
    );
  });

  it('omits body from message when not provided', async () => {
    await createSignedCommit(mockOctokit, {
      repo: 'owner/repo',
      branch: 'main',
      message: 'Headline only',
      additions: [{ path: 'file.txt', contents: 'dGVzdA==' }],
    });

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        input: expect.objectContaining({
          message: { headline: 'Headline only' },
        }),
      }),
    );

    const callArg = mockGraphql.mock.calls[0][1] as {
      input: { message: Record<string, unknown> };
    };
    expect(callArg.input.message).not.toHaveProperty('body');
  });

  it('creates new branch from baseRef when force is false', async () => {
    await createSignedCommit(mockOctokit, {
      repo: 'owner/repo',
      branch: 'new-branch',
      message: 'Initial commit',
      baseRef: 'main',
      force: false,
      additions: [{ path: 'file.txt', contents: 'dGVzdA==' }],
    });

    expect(mockGetRef).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', ref: 'heads/main' });
    expect(mockCreateRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'refs/heads/new-branch',
      sha: HEAD_SHA,
    });
    expect(mockUpdateRef).not.toHaveBeenCalled();
  });

  it('force-updates branch from baseRef when force is true', async () => {
    await createSignedCommit(mockOctokit, {
      repo: 'owner/repo',
      branch: 'existing-branch',
      message: 'Force update',
      baseRef: 'main',
      force: true,
      additions: [{ path: 'file.txt', contents: 'dGVzdA==' }],
    });

    expect(mockUpdateRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'heads/existing-branch',
      sha: HEAD_SHA,
      force: true,
    });
    expect(mockCreateRef).not.toHaveBeenCalled();
  });

  it('falls back to createRef when updateRef returns 404', async () => {
    const notFoundError = Object.assign(new Error('Not Found'), { status: 404 });
    mockUpdateRef.mockRejectedValueOnce(notFoundError);

    await createSignedCommit(mockOctokit, {
      repo: 'owner/repo',
      branch: 'brand-new-branch',
      message: 'Force create',
      baseRef: 'main',
      force: true,
      additions: [{ path: 'file.txt', contents: 'dGVzdA==' }],
    });

    expect(mockUpdateRef).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(mockCreateRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'refs/heads/brand-new-branch',
      sha: HEAD_SHA,
    });
  });

  it('falls back to createRef when updateRef returns 422 (Reference does not exist)', async () => {
    const unprocessableError = Object.assign(new Error('Reference does not exist'), {
      status: 422,
    });
    mockUpdateRef.mockRejectedValueOnce(unprocessableError);

    await createSignedCommit(mockOctokit, {
      repo: 'owner/repo',
      branch: 'brand-new-branch',
      message: 'Force create',
      baseRef: 'main',
      force: true,
      additions: [{ path: 'file.txt', contents: 'dGVzdA==' }],
    });

    expect(mockUpdateRef).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(mockCreateRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'refs/heads/brand-new-branch',
      sha: HEAD_SHA,
    });
  });

  it('uses branch ref directly when no baseRef is provided', async () => {
    await createSignedCommit(mockOctokit, {
      repo: 'owner/repo',
      branch: 'main',
      message: 'Direct commit',
      additions: [{ path: 'file.txt', contents: 'dGVzdA==' }],
    });

    expect(mockGetRef).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', ref: 'heads/main' });
    expect(mockCreateRef).not.toHaveBeenCalled();
    expect(mockUpdateRef).not.toHaveBeenCalled();
  });

  it('throws when additions and deletions are both empty', async () => {
    await expect(
      createSignedCommit(mockOctokit, {
        repo: 'owner/repo',
        branch: 'main',
        message: 'Nothing',
        additions: [],
        deletions: [],
      }),
    ).rejects.toThrow('At least one file addition or deletion is required.');
  });

  it('throws on invalid repo format', async () => {
    await expect(
      createSignedCommit(mockOctokit, {
        repo: 'invalid-repo-no-slash',
        branch: 'main',
        message: 'Oops',
        additions: [{ path: 'file.txt', contents: 'dGVzdA==' }],
      }),
    ).rejects.toThrow('Invalid repo format');
  });

  it('throws when GraphQL returns null OID', async () => {
    mockGraphql.mockResolvedValueOnce({
      createCommitOnBranch: { commit: { oid: null } },
    });

    await expect(
      createSignedCommit(mockOctokit, {
        repo: 'owner/repo',
        branch: 'main',
        message: 'Broken commit',
        additions: [{ path: 'file.txt', contents: 'dGVzdA==' }],
      }),
    ).rejects.toThrow('GraphQL mutation returned null OID');
  });

  it('deletes stale branch and recreates when updateRef returns 422 Reference already exists', async () => {
    // This covers the narrow case: GitHub says the reference already exists and
    // cannot be force-updated. We delete it and recreate at the new base SHA.
    const staleError = Object.assign(new Error('Reference already exists'), { status: 422 });
    mockUpdateRef.mockRejectedValueOnce(staleError);

    await createSignedCommit(mockOctokit, {
      repo: 'owner/repo',
      branch: 'release-staging/v1.4.4',
      message: 'Force create after stale branch',
      baseRef: 'main',
      force: true,
      additions: [{ path: 'dist/credentials.js', contents: 'dGVzdA==' }],
    });

    expect(mockUpdateRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'heads/release-staging/v1.4.4',
      sha: HEAD_SHA,
      force: true,
    });
    expect(mockDeleteRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'heads/release-staging/v1.4.4',
    });
    expect(mockCreateRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'refs/heads/release-staging/v1.4.4',
      sha: HEAD_SHA,
    });
    expect(mockGraphql).toHaveBeenCalled();
  });

  it('re-throws 422 errors that are not Reference does not exist or Reference already exists', async () => {
    // Any other 422 (e.g. invalid ref name) should propagate unchanged, not trigger
    // a silent delete+recreate.
    const unexpectedError = Object.assign(new Error('Invalid ref name: refs/heads/bad..name'), {
      status: 422,
    });
    mockUpdateRef.mockRejectedValueOnce(unexpectedError);

    await expect(
      createSignedCommit(mockOctokit, {
        repo: 'owner/repo',
        branch: 'bad..name',
        message: 'Should fail',
        baseRef: 'main',
        force: true,
        additions: [{ path: 'file.txt', contents: 'dGVzdA==' }],
      }),
    ).rejects.toThrow('Invalid ref name');

    expect(mockDeleteRef).not.toHaveBeenCalled();
    expect(mockCreateRef).not.toHaveBeenCalled();
  });

  it('proceeds to createRef when deleteRef fails with 404 (concurrent deletion race)', async () => {
    // The branch may be concurrently deleted between our deleteRef call and createRef;
    // a 404 from deleteRef is treated as success (the branch is already gone).
    const staleError = Object.assign(new Error('Reference already exists'), { status: 422 });
    mockUpdateRef.mockRejectedValueOnce(staleError);
    const notFoundOnDelete = Object.assign(new Error('Not Found'), { status: 404 });
    mockDeleteRef.mockRejectedValueOnce(notFoundOnDelete);

    await createSignedCommit(mockOctokit, {
      repo: 'owner/repo',
      branch: 'release-staging/v1.5.0',
      message: 'Force create after concurrent delete',
      baseRef: 'main',
      force: true,
      additions: [{ path: 'dist/credentials.js', contents: 'dGVzdA==' }],
    });

    expect(mockDeleteRef).toHaveBeenCalled();
    expect(mockCreateRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'refs/heads/release-staging/v1.5.0',
      sha: HEAD_SHA,
    });
    expect(mockGraphql).toHaveBeenCalled();
  });

  it('wraps and re-throws when deleteRef fails with a non-race error', async () => {
    // If deleteRef fails for any reason other than 404, we cannot safely recreate
    // the branch.  The error should be wrapped with context from the original
    // updateRef failure and re-thrown.
    const staleError = Object.assign(new Error('Reference already exists'), { status: 422 });
    mockUpdateRef.mockRejectedValueOnce(staleError);
    const permissionError = Object.assign(new Error('Must have admin rights to Repository'), {
      status: 403,
    });
    mockDeleteRef.mockRejectedValueOnce(permissionError);

    await expect(
      createSignedCommit(mockOctokit, {
        repo: 'owner/repo',
        branch: 'release-staging/v1.5.0',
        message: 'Should fail',
        baseRef: 'main',
        force: true,
        additions: [{ path: 'dist/credentials.js', contents: 'dGVzdA==' }],
      }),
    ).rejects.toThrow(
      /Failed to delete stale branch.*deleteRef status 403.*Must have admin rights.*Original force-update error.*Reference already exists/,
    );

    expect(mockCreateRef).not.toHaveBeenCalled();
  });

  it('propagates API error on getRef', async () => {
    mockGetRef.mockRejectedValueOnce(new Error('API rate limit exceeded'));

    await expect(
      createSignedCommit(mockOctokit, {
        repo: 'owner/repo',
        branch: 'main',
        message: 'Will fail',
        additions: [{ path: 'file.txt', contents: 'dGVzdA==' }],
      }),
    ).rejects.toThrow('API rate limit exceeded');
  });
});
