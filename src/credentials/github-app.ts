// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import * as core from '@actions/core';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

const SECRET_ID = 'docker-agent-action/github-app';
const REGION = 'us-east-1';
const MEMBERSHIP_ORG = 'docker';

interface GitHubAppSecret {
  pat: string;
  app_id?: string | number;
  private_key?: string;
  org_membership_token?: string;
}

function isPresent<T>(value: T | undefined): value is T {
  return Boolean(value) && value !== 'null';
}

async function mintInstallationToken(
  appId: string | number,
  privateKey: string,
): Promise<string | undefined> {
  core.setSecret(privateKey);
  const auth = createAppAuth({ appId, privateKey });

  let installationId: number;
  try {
    const { token: appJwt } = await auth({ type: 'app' });
    const octokit = new Octokit({ auth: appJwt });
    const { data } = await octokit.rest.apps.getOrgInstallation({ org: MEMBERSHIP_ORG });
    installationId = data.id;
  } catch (err) {
    core.error(`Failed to look up GitHub App installation for org ${MEMBERSHIP_ORG}: ${err}`);
    process.exit(1);
    return;
  }

  try {
    const { token } = await auth({ type: 'installation', installationId });
    return token;
  } catch (err) {
    core.error(`Failed to mint GitHub App installation token for org ${MEMBERSHIP_ORG}: ${err}`);
    process.exit(1);
    return;
  }
}

async function resolveOrgMembershipToken(secret: GitHubAppSecret): Promise<string | undefined> {
  const { app_id, private_key, org_membership_token } = secret;

  if (isPresent(app_id) && isPresent(private_key)) {
    return mintInstallationToken(app_id, private_key);
  }

  if (!isPresent(org_membership_token)) {
    core.error(
      `Failed to extract app_id and private_key or org_membership_token from secret ${SECRET_ID}`,
    );
    process.exit(1);
    return;
  }

  return org_membership_token;
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

  let secret: GitHubAppSecret | undefined;
  try {
    secret = JSON.parse(secretJson) as GitHubAppSecret;
  } catch {
    core.error(`${SECRET_ID} did not return valid JSON`);
    process.exit(1);
  }

  if (!secret) return;

  const { pat } = secret;

  if (!isPresent(pat)) {
    core.error(`Failed to extract pat from secret ${SECRET_ID}`);
    process.exit(1);
    return;
  }

  const orgMembershipToken = await resolveOrgMembershipToken(secret);
  if (!orgMembershipToken) return;

  core.setSecret(pat);
  core.setSecret(orgMembershipToken);

  core.exportVariable('GITHUB_APP_TOKEN', pat);
  core.exportVariable('ORG_MEMBERSHIP_TOKEN', orgMembershipToken);
}
