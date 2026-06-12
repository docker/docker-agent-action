// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import * as core from '@actions/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGitHubAppCredentials } from '../github-app.js';

vi.mock('@actions/core');

const { mockSend, MockSecretsManagerClient } = vi.hoisted(() => {
  const mockSend = vi.fn();
  class MockSecretsManagerClient {
    send = mockSend;
  }
  return { mockSend, MockSecretsManagerClient };
});

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: MockSecretsManagerClient,
  GetSecretValueCommand: vi.fn(),
}));

const VALID_SECRET = JSON.stringify({
  pat: 'test-pat-token',
  org_membership_token: 'test-org-token',
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

describe('fetchGitHubAppCredentials', () => {
  it('sets env vars and masks fields on valid secret', async () => {
    mockSend.mockResolvedValue({ SecretString: VALID_SECRET });
    await fetchGitHubAppCredentials();
    expect(core.exportVariable).toHaveBeenCalledWith('GITHUB_APP_TOKEN', 'test-pat-token');
    expect(core.exportVariable).toHaveBeenCalledWith('ORG_MEMBERSHIP_TOKEN', 'test-org-token');
    expect(core.setSecret).toHaveBeenCalledWith(expect.stringContaining('test-pat-token'));
  });

  it('exits with error when pat is missing', async () => {
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify({ pat: '', org_membership_token: 'test-org-token' }),
    });
    await fetchGitHubAppCredentials();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('exits with error when org_membership_token is missing', async () => {
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify({ pat: 'test-pat-token', org_membership_token: '' }),
    });
    await fetchGitHubAppCredentials();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('exits with error on invalid JSON', async () => {
    mockSend.mockResolvedValue({ SecretString: 'not-json' });
    await fetchGitHubAppCredentials();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('throws when AWS is unavailable', async () => {
    mockSend.mockRejectedValue(new Error('network error'));
    await expect(fetchGitHubAppCredentials()).rejects.toThrow(
      'AWS Secrets Manager call failed for required secret docker-agent-action/github-app: Error: network error',
    );
    expect(core.exportVariable).not.toHaveBeenCalled();
  });

  it('accepts an explicit credentials provider', async () => {
    mockSend.mockResolvedValue({ SecretString: VALID_SECRET });
    const fakeCredentials = vi.fn();
    await fetchGitHubAppCredentials(fakeCredentials as never);
    expect(core.exportVariable).toHaveBeenCalledWith('GITHUB_APP_TOKEN', 'test-pat-token');
  });
});
