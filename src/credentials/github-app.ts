// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import * as core from '@actions/core';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';

const SECRET_ID = 'docker-agent-action/github-app';
const REGION = 'us-east-1';

interface GitHubPATSecret {
  pat: string;
  org_membership_token: string;
}

export async function fetchGitHubAppCredentials(
  credentials?: AwsCredentialIdentityProvider,
): Promise<void> {
  const client = new SecretsManagerClient({ region: REGION, credentials });

  let secretJson: string;
  try {
    const res = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
    secretJson = res.SecretString ?? '';
  } catch (err) {
    throw new Error(`AWS Secrets Manager call failed for required secret ${SECRET_ID}: ${err}`);
  }

  core.setSecret(secretJson);

  let secret: GitHubPATSecret | undefined;
  try {
    secret = JSON.parse(secretJson) as GitHubPATSecret;
  } catch {
    core.error(`${SECRET_ID} did not return valid JSON`);
    process.exit(1);
  }

  if (!secret) return;

  const { pat, org_membership_token } = secret;

  for (const [field, value] of Object.entries({ pat, org_membership_token })) {
    if (!value || value === 'null') {
      core.error(`Failed to extract ${field} from secret ${SECRET_ID}`);
      process.exit(1);
      return;
    }
  }

  core.setSecret(pat);
  core.setSecret(org_membership_token);

  core.exportVariable('GITHUB_APP_TOKEN', pat);
  core.exportVariable('ORG_MEMBERSHIP_TOKEN', org_membership_token);
}
