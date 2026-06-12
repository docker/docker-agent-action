// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import * as core from '@actions/core';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';

const SECRET_ID = 'docker-agent-action/ai-api-keys';
const REGION = 'us-east-1';

interface AIApiKeysSecret {
  anthropic_api_key?: string;
  openai_api_key?: string;
}

export async function fetchAIApiKeys(credentials?: AwsCredentialIdentityProvider): Promise<void> {
  const client = new SecretsManagerClient({ region: REGION, credentials });

  let secretJson: string;
  try {
    const res = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
    secretJson = res.SecretString ?? '';
  } catch (err) {
    core.warning(`AWS Secrets Manager unavailable, skipping ${SECRET_ID}: ${err}`);
    return;
  }

  core.setSecret(secretJson);

  let secret: AIApiKeysSecret;
  try {
    secret = JSON.parse(secretJson) as AIApiKeysSecret;
  } catch {
    core.warning(`${SECRET_ID} did not return valid JSON; AI API keys will be empty`);
    return;
  }

  if (secret.anthropic_api_key) {
    core.setSecret(secret.anthropic_api_key);
    core.exportVariable('ANTHROPIC_API_KEY_FROM_SSM', secret.anthropic_api_key);
  }
  if (secret.openai_api_key) {
    core.setSecret(secret.openai_api_key);
    core.exportVariable('OPENAI_API_KEY_FROM_SSM', secret.openai_api_key);
  }
}
