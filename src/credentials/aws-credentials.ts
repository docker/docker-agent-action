// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import * as core from '@actions/core';
import { fromWebToken } from '@aws-sdk/credential-provider-web-identity';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';

const ROLE_ARN = 'arn:aws:iam::710015040892:role/docker-agent-action-20260409141318957000000001';
const REGION = 'us-east-1';

export async function getAWSCredentials(): Promise<AwsCredentialIdentityProvider | undefined> {
  try {
    const token = await core.getIDToken('sts.amazonaws.com');
    const repo = process.env.GITHUB_REPOSITORY ?? 'unknown';
    const runId = process.env.GITHUB_RUN_ID ?? 'unknown';

    return fromWebToken({
      webIdentityToken: token,
      roleArn: ROLE_ARN,
      roleSessionName: `gha-${repo.replace(/\//g, '-')}-${runId}`.slice(0, 64),
      clientConfig: { region: REGION },
    });
  } catch (err) {
    // id-token: write not available — non-docker repo, graceful no-op
    core.info(`OIDC token unavailable, skipping AWS credentials: ${err}`);
    return undefined;
  }
}
