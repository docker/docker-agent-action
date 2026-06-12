// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import * as core from '@actions/core';
import { fromWebToken } from '@aws-sdk/credential-provider-web-identity';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAWSCredentials } from '../aws-credentials.js';

vi.mock('@actions/core');
vi.mock('@aws-sdk/credential-provider-web-identity', () => ({
  fromWebToken: vi.fn(() => vi.fn()),
}));

beforeEach(() => vi.clearAllMocks());

describe('getAWSCredentials', () => {
  it('returns a credentials provider and calls fromWebToken with the OIDC token', async () => {
    vi.mocked(core.getIDToken).mockResolvedValue('fake-oidc-token');
    const result = await getAWSCredentials();
    expect(result).toBeDefined();
    expect(fromWebToken).toHaveBeenCalledWith(
      expect.objectContaining({ webIdentityToken: 'fake-oidc-token' }),
    );
  });

  it('returns undefined and logs info when OIDC is unavailable', async () => {
    vi.mocked(core.getIDToken).mockRejectedValue(new Error('no id-token permission'));
    const result = await getAWSCredentials();
    expect(result).toBeUndefined();
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('OIDC token unavailable'));
  });
});
