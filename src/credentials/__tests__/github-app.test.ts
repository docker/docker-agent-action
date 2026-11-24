// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import * as core from '@actions/core';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGitHubAppCredentials } from '../github-app.js';

vi.mock('@actions/core');

const { mockAuth, mockGetOrgInstallation } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockGetOrgInstallation: vi.fn(),
}));

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(() => mockAuth),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(
    class {
      rest = { apps: { getOrgInstallation: mockGetOrgInstallation } };
    },
  ),
}));

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
  mockAuth.mockReset();
  mockGetOrgInstallation.mockReset();
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

describe('fetchGitHubAppCredentials', () => {
  it.each([undefined, 'legacy-org-token'])('mints App token (legacy: %s)', async (legacyToken) => {
    const privateKey = `-----BEGIN RSA PRIVATE KEY-----
test-private-key-line-one
test-private-key-line-two
-----END RSA PRIVATE KEY-----`;
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify({
        pat: 'test-pat-token',
        app_id: '12345',
        private_key: privateKey,
        org_membership_token: legacyToken,
      }),
    });
    mockAuth
      .mockResolvedValueOnce({ token: 'test-app-jwt' })
      .mockResolvedValueOnce({ token: 'test-installation-token' });
    mockGetOrgInstallation.mockResolvedValue({ data: { id: 67890 } });

    await fetchGitHubAppCredentials();

    expect(createAppAuth).toHaveBeenCalledWith({
      appId: '12345',
      privateKey,
    });
    expect(mockAuth).toHaveBeenNthCalledWith(1, { type: 'app' });
    expect(Octokit).toHaveBeenCalledWith({ auth: 'test-app-jwt' });
    expect(mockGetOrgInstallation).toHaveBeenCalledWith({ org: 'docker' });
    expect(mockAuth).toHaveBeenNthCalledWith(2, {
      type: 'installation',
      installationId: 67890,
    });
    expect(core.setSecret).toHaveBeenCalledWith(privateKey);
    expect(core.setSecret).toHaveBeenCalledWith('test-installation-token');
    expect(core.setSecret).toHaveBeenCalledWith('test-pat-token');
    expect(core.setSecret).toHaveBeenCalledWith('test-app-jwt');
    expect(core.exportVariable).toHaveBeenCalledWith(
      'ORG_MEMBERSHIP_TOKEN',
      'test-installation-token',
    );
    expect(core.exportVariable).toHaveBeenCalledWith('GITHUB_APP_TOKEN', 'test-pat-token');
    expect(core.exportVariable).toHaveBeenCalledTimes(2);
    const maskCalls = vi.mocked(core.setSecret).mock;
    const patMaskIndex = maskCalls.calls.findIndex(([value]) => value === 'test-pat-token');
    expect(maskCalls.invocationCallOrder[patMaskIndex]).toBeLessThan(
      vi.mocked(createAppAuth).mock.invocationCallOrder[0],
    );
    expect(maskCalls.invocationCallOrder[patMaskIndex]).toBeLessThan(
      mockAuth.mock.invocationCallOrder[0],
    );
    const jwtMaskIndex = maskCalls.calls.findIndex(([value]) => value === 'test-app-jwt');
    expect(maskCalls.invocationCallOrder[jwtMaskIndex]).toBeLessThan(
      mockGetOrgInstallation.mock.invocationCallOrder[0],
    );
    const privateKeyMaskIndex = maskCalls.calls.findIndex(([value]) => value === privateKey);
    expect(maskCalls.invocationCallOrder[privateKeyMaskIndex]).toBeLessThan(
      vi.mocked(createAppAuth).mock.invocationCallOrder[0],
    );
    expect(maskCalls.invocationCallOrder[privateKeyMaskIndex]).toBeLessThan(
      mockAuth.mock.invocationCallOrder[0],
    );
    const tokenMaskIndex = maskCalls.calls.findIndex(
      ([value]) => value === 'test-installation-token',
    );
    const exportCalls = vi.mocked(core.exportVariable).mock;
    const tokenExportIndex = exportCalls.calls.findIndex(
      ([name]) => name === 'ORG_MEMBERSHIP_TOKEN',
    );
    expect(maskCalls.invocationCallOrder[tokenMaskIndex]).toBeLessThan(
      exportCalls.invocationCallOrder[tokenExportIndex],
    );
    expect(core.error).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it.each([
    ['installation lookup', /look.*up.*installation/i],
    ['token mint', /mint.*installation token/i],
  ])('exports nothing and never falls back when %s fails', async (step, errorPattern) => {
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify({
        pat: 'test-pat-token',
        app_id: '12345',
        private_key: 'test-private-key',
        org_membership_token: 'legacy-org-token',
      }),
    });
    mockAuth.mockResolvedValueOnce({ token: 'test-app-jwt' });
    if (step === 'installation lookup') {
      mockGetOrgInstallation.mockRejectedValue(new Error('installation unavailable'));
    } else {
      mockGetOrgInstallation.mockResolvedValue({ data: { id: 67890 } });
      mockAuth.mockRejectedValueOnce(new Error('token unavailable'));
    }

    await fetchGitHubAppCredentials();

    expect(core.error).toHaveBeenCalledWith(expect.stringMatching(errorPattern));
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(core.exportVariable).not.toHaveBeenCalled();
    expect(core.setSecret).toHaveBeenCalledWith('test-private-key');
  });

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

  it('exports nothing and exits with error when neither App nor legacy credentials are present', async () => {
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify({ pat: 'test-pat-token', org_membership_token: '' }),
    });
    await fetchGitHubAppCredentials();
    expect(core.error).toHaveBeenCalledWith(expect.stringMatching(/org_membership_token/));
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(core.exportVariable).not.toHaveBeenCalled();
    expect(createAppAuth).not.toHaveBeenCalled();
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
