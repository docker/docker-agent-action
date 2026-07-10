# Docker Agent Action

A GitHub Action for running [Docker Agent](https://github.com/docker/docker-agent) AI agents in your workflows. This action simplifies the setup and execution of Docker Agent, handling binary downloads and environment configuration automatically.

It is a **generic prompt runner**: you bring your own agent (a Docker Hub agent identifier or a `.yaml` file in your repo), your own prompt, and your own provider API key. What you build on top — reviewers, changelog writers, triage bots — is up to your workflow. See [examples/reviewer](examples/reviewer/) for a complete PR reviewer built on this action.

## Quick Start

1. **Add the action to your workflow**:

   ```yaml
   - uses: docker/docker-agent-action@VERSION
     with:
       agent: path/to/agent.yaml
       prompt: "Analyze this code"
       anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
   ```

2. **Configure API key** in your repository settings:
   - Go to `Settings` → `Secrets and variables` → `Actions`
   - Add `ANTHROPIC_API_KEY` (or another provider's key) from [Anthropic Console](https://console.anthropic.com/)

3. **That's it!** The action will automatically:
   - Download the Docker Agent binary
   - Run your specified agent
   - Scan outputs for leaked secrets
   - Provide results in workflow logs

## 🔒 Security Features

This action includes **built-in security features for all agent executions**:

- **Secret Leak Prevention**: Scans all agent outputs for API keys and tokens (Anthropic, OpenAI, GitHub)
- **Prompt Injection Detection**: Warns about suspicious patterns in user prompts and blocks critical exfiltration attempts
- **Automatic Incident Response**: Creates security issues and fails workflows when secrets are detected

The action performs **no authorization checks** of its own — access control is the calling workflow's responsibility (restrict your triggers and gate who can run them).

To report a vulnerability, see our [Security Policy](SECURITY.md).

## Usage

### Using a Local Agent File

```yaml
- name: Run Custom Agent
  uses: docker/docker-agent-action@VERSION
  with:
    agent: ./agents/my-agent.yaml
    prompt: "Analyze the codebase"
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Advanced Configuration

```yaml
- name: Run Docker Agent with Custom Settings
  uses: docker/docker-agent-action@VERSION
  with:
    agent: docker/code-analyzer
    prompt: "Analyze this codebase"
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    mcp-gateway: true # Set to true to install mcp-gateway
    mcp-gateway-version: v0.22.0
    yolo: false # Require manual approval
    timeout: 600 # 10 minute timeout
    debug: true # Enable debug logging
    working-directory: ./src
    extra-args: "--verbose"
    add-prompt-files: "AGENTS.md,CLAUDE.md" # Append these files to the prompt
```

### Using Outputs

```yaml
- name: Run Docker Agent
  id: agent
  uses: docker/docker-agent-action@VERSION
  with:
    agent: docker/code-analyzer
    prompt: "Analyze this codebase"
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}

- name: Check execution time
  run: |
    echo "Agent took ${{ steps.agent.outputs.execution-time }} seconds"
    if [ "${{ steps.agent.outputs.execution-time }}" -gt 300 ]; then
      echo "Warning: Agent took longer than 5 minutes"
    fi

- name: Upload output log
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: agent-output
    path: ${{ steps.agent.outputs.output-file }}
```

## Inputs

| Input                      | Description                                                                          | Required | Default        |
| -------------------------- | ------------------------------------------------------------------------------------ | -------- | -------------- |
| `agent`                    | Agent identifier (e.g., `docker/code-analyzer`) or path to `.yaml` file              | Yes      | -              |
| `prompt`                   | Prompt to pass to the agent                                                          | No       | -              |
| `mcp-gateway`              | Install mcp-gateway (`true`/`false`)                                                 | No       | `false`        |
| `mcp-gateway-version`      | Version of mcp-gateway to use (specifying this will enable mcp-gateway installation) | No       | `v0.22.0`      |
| `anthropic-api-key`        | Anthropic API key for Claude models (at least one API key required)                  | No\*     | -              |
| `openai-api-key`           | OpenAI API key (at least one API key required)                                       | No\*     | -              |
| `google-api-key`           | Google API key for Gemini models (at least one API key required)                     | No\*     | -              |
| `aws-bearer-token-bedrock` | AWS Bearer token for Bedrock models (at least one API key required)                  | No\*     | -              |
| `xai-api-key`              | xAI API key for Grok models (at least one API key required)                          | No\*     | -              |
| `nebius-api-key`           | Nebius API key (at least one API key required)                                       | No\*     | -              |
| `mistral-api-key`          | Mistral API key (at least one API key required)                                      | No\*     | -              |
| `github-token`             | GitHub token for API access                                                          | No       | `github.token` |
| `timeout`                  | Timeout in seconds for agent execution (0 for no timeout)                            | No       | `0`            |
| `debug`                    | Enable debug mode with verbose logging (`true`/`false`)                              | No       | `false`        |
| `working-directory`        | Working directory to run the agent in                                                | No       | `.`            |
| `yolo`                     | Auto-approve all prompts (`true`/`false`)                                            | No       | `true`         |
| `max-retries`              | Maximum number of retries on failure (0 = no retries)                                | No       | `2`            |
| `retry-delay`              | Base delay in seconds between retries (doubles each attempt)                         | No       | `5`            |
| `retry-on-timeout`         | Number of additional retry attempts when the agent times out (exit code 124). Independent of `max-retries` — both budgets can be consumed in the same run. | No       | `0`            |
| `extra-args`               | Additional arguments to pass to `docker agent run`                                   | No       | -              |
| `add-prompt-files`         | Comma-separated list of files to append to the prompt (e.g., `AGENTS.md,CLAUDE.md`)  | No       | -              |
| `skip-summary`             | Skip writing agent output to the job summary (useful when callers write their own)  | No       | `false`        |

### Prompt Files (`add-prompt-files`)

The `add-prompt-files` input allows you to include additional context files as system messages. This uses Docker Agent's `--prompt-file` flag under the hood.

**File Resolution (handled by Docker Agent):**

- Searches up the directory hierarchy (like `.gitignore`)
- Also checks the home folder (`~/`)
- Files are added as system messages, not appended to the user prompt

**Examples:**

```yaml
# Additional files beyond the auto-discovered AGENTS.md/CLAUDE.md
add-prompt-files: "CONTRIBUTING.md,docs/REVIEW_GUIDELINES.md"

# With custom working directory
working-directory: ./src
add-prompt-files: "STYLE_GUIDE.md"  # Found via hierarchy search
```

## Outputs

| Output                  | Description                                                       |
| ----------------------- | ---------------------------------------------------------------- |
| `exit-code`             | Exit code from docker agent run                                  |
| `output-file`           | Path to the output log file                                      |
| `docker-agent-version`  | Version of Docker Agent that was used                            |
| `mcp-gateway-installed` | Whether mcp-gateway was installed (`true`/`false`)               |
| `execution-time`        | Agent execution time in seconds                                  |
| `verbose-log-file`      | Path to the full verbose agent log (includes tool calls)         |
| `security-blocked`      | Whether execution was blocked due to security concerns (`true`/`false`) |
| `secrets-detected`      | Whether secrets were detected in output                          |
| `prompt-suspicious`     | Whether suspicious content was stripped from the prompt (`true`/`false`) |
| `input-risk-level`      | Risk level of input (`low`/`medium`/`high`)                      |

## API Keys

**At least one API key is required.** The action validates this at startup and fails fast with a clear error if no API key is provided.

Supported providers:

- **Anthropic** (`anthropic-api-key`): Claude models - [Get API key](https://console.anthropic.com/)
- **OpenAI** (`openai-api-key`): GPT models - [Get API key](https://platform.openai.com/)
- **Google** (`google-api-key`): Gemini models - [Get API key](https://aistudio.google.com/)
- **AWS Bedrock** (`aws-bearer-token-bedrock`): Various models via AWS
- **xAI** (`xai-api-key`): Grok models - [Get API key](https://console.x.ai/)
- **Nebius** (`nebius-api-key`): Nebius models
- **Mistral** (`mistral-api-key`): Mistral models - [Get API key](https://console.mistral.ai/)

## Permissions

For GitHub integration features (commenting on PRs, creating issues), ensure your workflow has appropriate permissions:

```yaml
permissions:
  contents: read # Read repository files and PR diffs
  pull-requests: write # (Optional) Only if your workflow posts PR comments
  issues: write # Create security incident issues if secrets are detected in output
```

## Examples

### Multiple Agents in a Workflow

```yaml
name: AI Code Review
on:
  pull_request:
    types: [opened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - uses: actions/checkout@v4

      - name: Security Review
        uses: docker/docker-agent-action@VERSION
        with:
          agent: docker/github-action-security-scanner
          prompt: "Analyze for security issues"
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}

      - name: Code Quality Analysis
        uses: docker/docker-agent-action@VERSION
        with:
          agent: docker/code-quality-analyzer
          prompt: "Analyze code quality and best practices"
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### PR Reviewer

[examples/reviewer](examples/reviewer/) is a complete PR reviewer built on this action: a small agent definition plus a copy-pasteable workflow that fetches the PR diff, reviews the added lines, and posts the result as a PR comment.

### Manual Trigger with Inputs

```yaml
name: Manual Agent Run
on:
  workflow_dispatch:
    inputs:
      agent:
        description: "Agent to run"
        required: true
        default: "docker/code-analyzer"
      prompt:
        description: "Prompt for the agent"
        required: true

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run Agent
        uses: docker/docker-agent-action@VERSION
        with:
          agent: ${{ github.event.inputs.agent }}
          prompt: ${{ github.event.inputs.prompt }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details on:

- Setting up your development environment
- Running tests
- Submitting pull requests
- Reporting security issues

Please also read our [Code of Conduct](CODE_OF_CONDUCT.md).

## Support

- 📖 [Documentation](README.md)
- 🐛 [Report Issues](https://github.com/docker/docker-agent-action/issues)
- 💬 [Discussions](https://github.com/docker/docker-agent-action/discussions)
- 🔒 [Security Policy](SECURITY.md)

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Links

- [Docker Agent Repository](https://github.com/docker/docker-agent)
- [MCP Gateway Repository](https://github.com/docker/mcp-gateway)
