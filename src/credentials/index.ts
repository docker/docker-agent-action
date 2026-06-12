// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import * as core from '@actions/core';
import { fetchAIApiKeys } from './ai-keys.js';
import { getAWSCredentials } from './aws-credentials.js';
import { fetchGitHubAppCredentials } from './github-app.js';

async function run(): Promise<void> {
  const credentials = await getAWSCredentials();
  await fetchGitHubAppCredentials(credentials);
  await fetchAIApiKeys(credentials);
}

run().catch(core.setFailed);
