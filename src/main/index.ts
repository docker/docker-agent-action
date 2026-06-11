/**
 * src/main/index.ts — root action entrypoint.
 *
 * This is the `main:` script for the `using: node24` action that replaces the
 * 872-line composite action.yml.  It orchestrates all the same steps in order:
 *
 *   1.  Obtain docker-agent version from build-time constant
 *   2.  Validate inputs
 *   3.  Authorization check (4-tier waterfall)
 *   4.  Resolve GitHub token
 *   5.  Sanitize input prompt
 *   6.  Setup binaries (docker-agent + optional mcp-gateway)
 *   7.  Run docker-agent (with retry loop)
 *   8.  Post-process verbose log → clean output file
 *   9.  Sanitize output (secret leak scan)
 *   10. Upload verbose log artifact
 *   11. Write job summary (if not skipped)
 *   12. Handle security incident (open issue + fail)
 *   13. Exit with agent's exit code
 *
 * All 24 inputs and 10 outputs are preserved verbatim (public contract).
 */

// __DOCKER_AGENT_VERSION__ is injected at build time by tsup's `define` option
// (see tsup.config.ts).  It is replaced with a string literal in the bundle, so
// the action never needs to locate the DOCKER_AGENT_VERSION file on disk at
// runtime — which would fail when ACTION_PATH points at a sub-directory (e.g.
// review-pr/) rather than the action root.
declare const __DOCKER_AGENT_VERSION__: string;

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { sanitizeInput } from '../security/sanitize-input.js';
import { sanitizeOutput } from '../security/sanitize-output.js';
import { makeArtifactName, uploadVerboseLog } from './artifact.js';
import { checkAuthorization } from './auth.js';
import { setupBinaries } from './binary.js';
import { runAgent } from './exec.js';
import { extractDockerAgentOutputBlock, filterAgentOutput } from './outputs.js';
import { writeJobSummary } from './summary.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Return true if `s` looks like a semver version string (vX.Y.Z…). */
function isValidVersion(s: string): boolean {
  return /^v\d+\.\d+\.\d+/.test(s);
}

/**
 * Create a GitHub issue to record the security incident and fail the run.
 * Mirrors the `Handle security incident` step.
 */
async function handleSecurityIncident(githubToken: string): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const runId = process.env.GITHUB_RUN_ID ?? '';
  const [owner, repo] = repository.split('/');

  const banner = [
    '═══════════════════════════════════════════════════════',
    '🚨 SECURITY INCIDENT: SECRET LEAK DETECTED',
    '═══════════════════════════════════════════════════════',
    '',
    'A secret was detected in the AI agent response.',
    'Check the workflow logs for the leaked secret.',
    '',
    'IMMEDIATE ACTIONS REQUIRED:',
    '  1. Review workflow logs for the leaked secret',
    '  2. Investigate the prompt/input that triggered this',
    '  3. Review who triggered this workflow',
    '  4. ROTATE ALL SECRETS IMMEDIATELY',
    '═══════════════════════════════════════════════════════',
  ].join('\n');
  core.error(banner);

  const body = `**CRITICAL SECURITY INCIDENT**

A secret was detected in the AI agent response for workflow run ${runId}.

## Actions Taken
✓ Workflow failed with error
✓ Security incident issue created

## Required Actions
1. Review workflow logs: https://github.com/${repository}/actions
2. **ROTATE COMPROMISED SECRETS IMMEDIATELY**
   - ANTHROPIC_API_KEY
   - GITHUB_TOKEN
   - OPENAI_API_KEY
   - GOOGLE_API_KEY
   - AWS_BEARER_TOKEN_BEDROCK
   - XAI_API_KEY
   - NEBIUS_API_KEY
   - MISTRAL_API_KEY
   - Any other exposed credentials
3. Investigate the workflow trigger and input prompt
4. Review workflow run history for suspicious patterns

## Timeline
- Incident detected: ${new Date().toISOString()}
- Workflow run: https://github.com/${repository}/actions/runs/${runId}

## Next Steps
- [ ] Secrets rotated
- [ ] Logs reviewed
- [ ] Incident investigated
- [ ] Incident report filed
- [ ] Post-mortem completed`;

  try {
    if (owner && repo) {
      const octokit = new Octokit({ auth: githubToken });
      await octokit.rest.issues.create({
        owner,
        repo,
        title: '🚨 Security Alert: Secret Leak Detected in Agent Execution',
        body,
        labels: ['security'],
      });
      core.info('🚨 Security incident issue created');
    }
  } catch (err: unknown) {
    core.error(`Failed to create security incident issue: ${(err as Error).message}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  // Track outputs so finally block can set them on failure paths
  let outputFile = '';
  let verboseLogFile = '';
  let verboseLogArtifactName = '';
  let exitCode = 1;
  let executionTime = 0;
  let dockerAgentVersion = '';
  let mcpInstalled = false;
  let promptBlocked = false;
  let promptStripped = false;
  let inputRiskLevel: 'low' | 'medium' | 'high' = 'low';
  let outputLeaked = false;

  // Resolve token early so we can use it in error paths
  const explicitToken = core.getInput('github-token');
  const resolvedToken = explicitToken || process.env.GITHUB_TOKEN || '';

  // Register token with setSecret immediately after resolving
  if (resolvedToken) {
    core.setSecret(resolvedToken);
  }

  try {
    // ── Step 1: Obtain docker-agent version ──────────────────────────────────
    // __DOCKER_AGENT_VERSION__ is a build-time constant injected by tsup (see
    // tsup.config.ts).  This avoids a filesystem read at runtime that would
    // fail when ACTION_PATH resolves to a sub-directory (e.g. review-pr/).
    dockerAgentVersion = __DOCKER_AGENT_VERSION__;
    core.debug(`Docker Agent version: ${dockerAgentVersion}`);

    // ── Step 2: Validate inputs ───────────────────────────────────────────
    const agent = core.getInput('agent', { required: true });
    if (!agent) {
      core.setFailed("'agent' input is required");
      return;
    }

    if (!isValidVersion(dockerAgentVersion)) {
      core.setFailed(
        `Invalid Docker Agent version format '${dockerAgentVersion}'. Expected format: v1.2.3`,
      );
      return;
    }

    const mcpGateway = core.getBooleanInput('mcp-gateway');
    const mcpGatewayVersion = core.getInput('mcp-gateway-version');
    if (mcpGateway && !isValidVersion(mcpGatewayVersion)) {
      core.setFailed(
        `Invalid mcp-gateway version format '${mcpGatewayVersion}'. Expected format: v1.2.3`,
      );
      return;
    }

    // API keys — explicit inputs only, no env-var fallback
    const anthropicApiKey = core.getInput('anthropic-api-key');
    const openaiApiKey = core.getInput('openai-api-key');
    const googleApiKey = core.getInput('google-api-key');
    const awsBearerTokenBedrock = core.getInput('aws-bearer-token-bedrock');
    const xaiApiKey = core.getInput('xai-api-key');
    const nebiusApiKey = core.getInput('nebius-api-key');
    const mistralApiKey = core.getInput('mistral-api-key');

    const hasApiKey =
      anthropicApiKey ||
      openaiApiKey ||
      googleApiKey ||
      awsBearerTokenBedrock ||
      xaiApiKey ||
      nebiusApiKey ||
      mistralApiKey;

    if (!hasApiKey) {
      core.setFailed(
        'At least one API key is required. Provide one of: anthropic-api-key, openai-api-key, ' +
          'google-api-key, aws-bearer-token-bedrock, xai-api-key, nebius-api-key, or mistral-api-key',
      );
      return;
    }

    const debug = core.getBooleanInput('debug');
    // skip-summary is read in the finally block via core.getBooleanInput
    const skipAuth = core.getBooleanInput('skip-auth');
    const timeout = parseInt(core.getInput('timeout') || '0', 10);
    const maxRetries = parseInt(core.getInput('max-retries') || '2', 10);
    const retryDelay = parseInt(core.getInput('retry-delay') || '5', 10);
    const yolo = core.getBooleanInput('yolo');
    const workingDirectory = core.getInput('working-directory') || '.';
    const extraArgs = core.getInput('extra-args');
    const addPromptFiles = core.getInput('add-prompt-files');
    const promptInput = core.getInput('prompt');
    const orgMembershipToken = core.getInput('org-membership-token');
    const authOrg = core.getInput('auth-org');

    if (debug) {
      core.debug(`agent: ${agent}`);
      core.debug(`Docker Agent version: ${dockerAgentVersion}`);
      core.debug(`mcp-gateway: ${mcpGateway}, version: ${mcpGatewayVersion}`);
    }

    // ── Step 3: Authorization check ───────────────────────────────────────
    // Mask tokens before using them
    if (orgMembershipToken) {
      core.setSecret(orgMembershipToken);
    }

    const eventPayloadPath = process.env.GITHUB_EVENT_PATH ?? '';
    const authResult = await checkAuthorization({
      skipAuth,
      githubToken: resolvedToken,
      orgMembershipToken,
      authOrg,
      eventPayloadPath,
    });

    core.setOutput('authorized', authResult.outcome);

    if (!authResult.authorized) {
      core.setFailed('Authorization failed');
      return;
    }

    // ── Step 4: Token already resolved above ─────────────────────────────
    // resolvedToken is set above; just log which path we took
    if (explicitToken) {
      core.info('✅ Using provided github-token');
    } else {
      core.info('ℹ️ Using default GITHUB_TOKEN');
    }

    // ── Step 5: Sanitize input ────────────────────────────────────────────
    const promptCleanFile = '/tmp/prompt-clean.txt';

    if (promptInput) {
      core.info('🔍 Checking user-provided prompt for injection patterns...');
      const promptInputFile = '/tmp/prompt-input.txt';
      fs.writeFileSync(promptInputFile, promptInput, 'utf-8');

      const sanitizeResult = sanitizeInput(promptInputFile, promptCleanFile);
      promptBlocked = sanitizeResult.blocked;
      promptStripped = sanitizeResult.stripped;
      inputRiskLevel = sanitizeResult.riskLevel;

      core.setOutput('prompt-suspicious', String(promptStripped));
      core.setOutput('input-risk-level', inputRiskLevel);

      if (promptBlocked) {
        core.setOutput('security-blocked', 'true');
        core.setFailed('Execution blocked: critical security pattern detected in prompt');
        return;
      }
    } else {
      core.setOutput('prompt-suspicious', 'false');
      core.setOutput('input-risk-level', 'low');
    }

    // ── Step 6: Setup binaries ────────────────────────────────────────────
    const binaryResult = await setupBinaries({
      version: dockerAgentVersion,
      mcpGateway,
      mcpGatewayVersion,
      githubToken: resolvedToken,
      debug,
    });
    mcpInstalled = binaryResult.mcpInstalled;
    dockerAgentVersion = binaryResult.dockerAgentVersion;

    core.setOutput('docker-agent-version', dockerAgentVersion);
    // Deprecated alias, kept for backward compatibility with consumers reading
    // the old output name. Remove in a future release.
    core.setOutput('cagent-version', dockerAgentVersion);
    core.warning(
      "The 'cagent-version' output is deprecated and will be removed in a future release. " +
        "Use 'docker-agent-version' instead.",
    );
    core.setOutput('mcp-gateway-installed', String(mcpInstalled));

    // ── Step 7: Run docker-agent ──────────────────────────────────────────
    // Create temp files for output
    const tmpSuffix = `docker-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    outputFile = path.join(os.tmpdir(), `${tmpSuffix}-output`);
    verboseLogFile = path.join(os.tmpdir(), `${tmpSuffix}-verbose`);

    // Touch the files so downstream steps always have valid paths
    fs.writeFileSync(outputFile, '', 'utf-8');
    fs.writeFileSync(verboseLogFile, '', 'utf-8');

    // Compute artifact name
    const runId = process.env.GITHUB_RUN_ID ?? '0';
    const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
    const job = process.env.GITHUB_JOB ?? 'unknown';
    verboseLogArtifactName = makeArtifactName(runId, runAttempt, job, verboseLogFile);

    // Set output-file early so downstream always has a reference
    core.setOutput('output-file', outputFile);
    core.setOutput('verbose-log-file', verboseLogFile);

    // Resolve absolute working directory
    const resolvedWorkingDir = path.resolve(workingDirectory);

    // Build telemetry tags
    const repository = process.env.GITHUB_REPOSITORY ?? '';
    const workflow = process.env.GITHUB_WORKFLOW ?? '';
    const telemetryTags = `source=github-actions,repo=${repository},workflow=${workflow},run_id=${runId}`;

    const runResult = await runAgent({
      dockerAgentPath: binaryResult.dockerAgentPath,
      agent,
      promptInput,
      promptCleanFile,
      workingDir: resolvedWorkingDir,
      yolo,
      addPromptFiles,
      extraArgs,
      timeout,
      maxRetries,
      retryDelay,
      debug,
      anthropicApiKey,
      openaiApiKey,
      googleApiKey,
      awsBearerTokenBedrock,
      xaiApiKey,
      nebiusApiKey,
      mistralApiKey,
      ghToken: resolvedToken,
      telemetryTags,
      verboseLogFile,
    });

    exitCode = runResult.exitCode;
    executionTime = runResult.executionTime;

    core.setOutput('exit-code', String(exitCode));
    core.setOutput('execution-time', String(executionTime));

    // ── Step 8: Post-process verbose log → clean output ───────────────────
    if (fs.existsSync(verboseLogFile)) {
      const rawVerbose = fs.readFileSync(verboseLogFile, 'utf-8');
      // Trim to only the final retry attempt's content. The original bash
      // truncated $OUTPUT_FILE before each retry; mirroring that here prevents
      // a partial docker-agent-output block from an earlier attempt from
      // corrupting the extracted output.
      // When there are no retries, parts has length 1 and parts[0] is the full log.
      const lastAttemptMarker = /^={10,} RETRY ATTEMPT \d+/m;
      const parts = rawVerbose.split(lastAttemptMarker);
      const lastAttemptContent = parts[parts.length - 1];
      // Step 8a: awk-equivalent noise filter. Writes FULL filtered text so
      // sanitizeOutput (Step 9) can scan it before block extraction narrows it.
      const filteredOutput = filterAgentOutput(lastAttemptContent);
      fs.writeFileSync(outputFile, filteredOutput, 'utf-8');
    }
  } catch (err: unknown) {
    core.setFailed(`Unexpected error: ${(err as Error).message}`);
    // Fall through to finally block for cleanup outputs
  } finally {
    // ── Step 9: Sanitize output (always runs) ─────────────────────────────
    if (outputFile && fs.existsSync(outputFile)) {
      try {
        core.info('🔍 Scanning AI response for leaked secrets...');
        const sanitizeResult = sanitizeOutput(outputFile);
        outputLeaked = sanitizeResult.leaked;
        core.setOutput('secrets-detected', String(outputLeaked));
      } catch (err: unknown) {
        core.warning(`Output sanitization failed: ${(err as Error).message}`);
        core.setOutput('secrets-detected', 'false');
      }

      // Step 9b: block extraction — runs AFTER sanitizeOutput.
      // Replace outputFile with only the docker-agent-output block if present.
      // Skipped when a secret was detected so the incident flow sees the full text.
      if (!outputLeaked) {
        try {
          const fullFiltered = fs.readFileSync(outputFile, 'utf-8');
          const block = extractDockerAgentOutputBlock(fullFiltered);
          if (block !== null) {
            fs.writeFileSync(outputFile, block, 'utf-8');
          }
        } catch {
          // Non-fatal — leave the file as-is
        }
      }
    } else {
      core.info('⚠️ No output file to scan (agent may have failed during validation)');
      core.setOutput('secrets-detected', 'false');
    }

    // security-blocked = prompt blocked OR output leaked
    const securityBlocked = promptBlocked || outputLeaked;
    core.setOutput('security-blocked', String(securityBlocked));

    // ── Step 10: Upload verbose log artifact ──────────────────────────────
    if (verboseLogFile && verboseLogArtifactName) {
      await uploadVerboseLog({
        name: verboseLogArtifactName,
        filePath: verboseLogFile,
        retentionDays: 14,
      });
    }

    // ── Step 11: Write job summary ─────────────────────────────────────────
    const skipSummary = core.getBooleanInput('skip-summary');
    if (!skipSummary) {
      try {
        await writeJobSummary({
          agent: core.getInput('agent') || '',
          exitCode,
          executionTime,
          dockerAgentVersion,
          mcpInstalled,
          timeout: parseInt(core.getInput('timeout') || '0', 10),
          outputFile: outputFile || undefined,
        });
      } catch (err: unknown) {
        core.warning(`Failed to write job summary: ${(err as Error).message}`);
      }
    }

    // ── Step 12: Handle security incident ────────────────────────────────
    if (outputLeaked) {
      await handleSecurityIncident(resolvedToken);
      process.exitCode = 1;
      // Do NOT return — fall through to let the process exit naturally.
      // process.exitCode is already set to 1 for the security incident.
    } else if (exitCode !== 0) {
      // ── Step 13: Exit with agent's exit code ────────────────────────────
      // Use process.exitCode so the runner marks the step as failed
      // without an additional core.setFailed error annotation.
      process.exitCode = exitCode;
    }
  }
}

export { run };

// Auto-invoke only when running as the real action entrypoint (not under Vitest).
if (!process.env.VITEST) {
  run().catch((err: unknown) => {
    core.setFailed(`Fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
