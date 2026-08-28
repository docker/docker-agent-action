// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic validation of the model-eval fixtures in review-pr/agents/evals/.
 *
 * The docker-agent eval runner (pkg/evaluation in docker/docker-agent) imposes
 * hard environment constraints that repeatedly produced broken fixtures:
 *
 *   - Per-eval criteria accept ONLY `relevance`, `working_dir`, `size`,
 *     `setup`, and `image` (EvalCriteria unmarshals with
 *     DisallowUnknownFields). There is NO per-eval env field.
 *   - The container runs `sh /setup.sh && exec /docker-agent run …`: setup is
 *     a CHILD shell, so `export GITHUB_ACTIONS=true` never reaches the agent
 *     process. Every eval therefore runs in console output mode; a fixture
 *     asserting GitHub posting mode can never pass.
 *   - Some runner versions treat ANY setup stderr as fatal even on exit 0.
 *     Alpine's `apk add nodejs` prints an ICU packaging note to stderr, so
 *     fixtures must not install Node.
 *   - The eval image contains only the mounted agents dir (/configs) and an
 *     empty /working_dir — the repo's gitignored dist/ bundles do not exist,
 *     so `node dist/….js` in setup is always MODULE_NOT_FOUND.
 *   - Evals must never be able to write to real GitHub repositories.
 *
 * These tests pin those invariants for every fixture, plus fixture-specific
 * contracts (the success trio is one repeated payload; the marlin
 * event-firing eval keeps its two essential bugs without the retired
 * redundant duplicate-timestamp criterion).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const EVALS_DIR = resolve(import.meta.dirname, '../../../review-pr/agents/evals');
const POSTING_TEMPLATE_PATH = resolve(
  import.meta.dirname,
  '../../../review-pr/agents/refs/posting-format.md',
);

/** Keys session.EvalCriteria accepts — unknown keys fail the eval run. */
const SUPPORTED_EVAL_KEYS = ['relevance', 'working_dir', 'size', 'setup', 'image'];

interface Fixture {
  name: string;
  raw: string;
  id: string;
  title: string;
  evals: Record<string, unknown>;
  relevance: string[];
  setup: string;
  userContents: string[];
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${context} is not an object`);
  }
  return value as Record<string, unknown>;
}

function loadFixture(name: string): Fixture {
  const raw = readFileSync(resolve(EVALS_DIR, name), 'utf-8');
  const doc = asRecord(JSON.parse(raw), name);
  const evals = asRecord(doc.evals, `${name} evals`);
  const relevance = Array.isArray(evals.relevance)
    ? evals.relevance.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const messages = Array.isArray(doc.messages) ? doc.messages : [];
  const userContents: string[] = [];
  for (const item of messages) {
    const inner = asRecord(asRecord(item, `${name} messages[]`).message, `${name} message`);
    const message = asRecord(inner.message, `${name} message.message`);
    if (message.role === 'user' && typeof message.content === 'string') {
      userContents.push(message.content);
    }
  }
  return {
    name,
    raw,
    id: typeof doc.id === 'string' ? doc.id : '',
    title: typeof doc.title === 'string' ? doc.title : '',
    evals,
    relevance,
    setup: typeof evals.setup === 'string' ? evals.setup : '',
    userContents,
  };
}

const fixtureNames = readdirSync(EVALS_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort();
const fixtures = fixtureNames.map(loadFixture);
const byName = new Map(fixtures.map((fixture) => [fixture.name, fixture]));

function mustGet(name: string): Fixture {
  const fixture = byName.get(name);
  if (!fixture) throw new Error(`expected fixture missing: ${name}`);
  return fixture;
}

describe('eval fixture schema', () => {
  it('finds the eval fixtures', () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  it.each(fixtureNames)('%s parses with a valid basic shape', (name) => {
    const fixture = mustGet(name);
    expect(fixture.id).not.toBe('');
    expect(fixture.title).not.toBe('');
    expect(fixture.relevance.length).toBeGreaterThan(0);
    for (const criterion of fixture.relevance) {
      expect(criterion.trim()).not.toBe('');
    }
    expect(fixture.userContents.length).toBeGreaterThan(0);
    for (const content of fixture.userContents) {
      expect(content.trim()).not.toBe('');
    }
  });

  it.each(fixtureNames)('%s only uses eval keys the runner accepts', (name) => {
    // EvalCriteria rejects unknown fields, so a typo (or an unsupported
    // field like `env`) fails the whole eval run at load time.
    const unknown = Object.keys(mustGet(name).evals).filter(
      (key) => !SUPPORTED_EVAL_KEYS.includes(key),
    );
    expect(unknown).toEqual([]);
  });
});

describe('console-mode honesty (no per-eval env exists)', () => {
  it.each(fixtureNames)('%s does not export GITHUB_ACTIONS from setup', (name) => {
    // Setup runs in a child shell; exported variables never reach the agent
    // process. A fixture relying on this export tests nothing.
    expect(mustGet(name).setup).not.toMatch(/GITHUB_ACTIONS\s*=/);
  });

  it.each(fixtureNames)('%s does not assert GitHub posting mode in relevance', (name) => {
    for (const criterion of mustGet(name).relevance) {
      expect(criterion).not.toMatch(/GITHUB_ACTIONS=true/);
      expect(criterion.toLowerCase()).not.toContain('posting mode');
    }
  });
});

describe('setup environment constraints', () => {
  it.each(fixtureNames)('%s never posts to GitHub from setup', (name) => {
    const { setup } = mustGet(name);
    // Installing github-cli is fine; invoking gh (or pushing) is not.
    expect(setup).not.toMatch(/\bgh\s+(api|pr|repo)\b/);
    expect(setup).not.toMatch(/\bgit\s+push\b/);
    expect(setup).not.toMatch(/\bcurl\b/);
  });

  it.each(fixtureNames)('%s does not depend on Node in the eval container', (name) => {
    const { setup } = mustGet(name);
    // dist/ bundles are gitignored and never staged into the eval image, and
    // Alpine's nodejs package prints an ICU note to stderr that some runner
    // versions treat as a fatal setup failure despite exit 0.
    expect(setup).not.toMatch(/\bnode\s/);
    expect(setup).not.toMatch(/apk\s+add[^&|;]*\bnodejs\b/);
  });

  it.each(fixtureNames)('%s renders every posting-format placeholder it stages', (name) => {
    const { setup } = mustGet(name);
    if (!setup.includes('posting-format.md')) return;
    const template = readFileSync(POSTING_TEMPLATE_PATH, 'utf-8');
    const placeholders = new Set(template.match(/__[A-Z_]+__/g) ?? []);
    expect(placeholders.size).toBeGreaterThan(0);
    for (const placeholder of placeholders) {
      // Each placeholder must be substituted by the staging sed program
      // (any delimiter); otherwise the agent reads a template with literal
      // __X__ markers.
      expect(setup, `${name} setup must substitute ${placeholder}`).toMatch(
        new RegExp(`s[/|#]${placeholder}[/|#]`),
      );
    }
  });
});

describe('success clean-control trio', () => {
  const runNames = ['success-1.json', 'success-2.json', 'success-3.json'];

  it('keeps all three runs present', () => {
    for (const name of runNames) expect(byName.has(name)).toBe(true);
  });

  it('repeats one identical payload, varying only id and run-numbered title', () => {
    const [first, second, third] = runNames.map(mustGet);
    const payload = (fixture: Fixture) => {
      const doc = asRecord(JSON.parse(fixture.raw), fixture.name);
      delete doc.id;
      delete doc.title;
      return JSON.stringify(doc);
    };
    expect(payload(second)).toBe(payload(first));
    expect(payload(third)).toBe(payload(first));
    const ids = new Set(runNames.map((name) => mustGet(name).id));
    expect(ids.size).toBe(3);
    runNames.forEach((name, index) => {
      expect(mustGet(name).title).toMatch(new RegExp(`\\(run ${index + 1}\\)$`));
    });
  });

  it('embeds the authoritative context that retired each historical false positive', () => {
    const [content] = mustGet('success-1.json').userContents;
    // RootCmd is the matched hook config string, so "buildx build" is a live
    // map entry (docker/cli#6794) …
    expect(content).toContain('docker/cli#6794');
    expect(content).toContain('"buildx build": `Debug this build failure with Gordon');
    expect(content).toContain('never just the top-level command token');
    // … TestMain sets version.GoTest so tests need no Docker Desktop …
    expect(content).toContain('version.GoTest = true');
    expect(content).toContain('never need a running Docker Desktop');
    // … and writing to the process streams is deliberate and test-covered.
    expect(content).toContain('return handleHook(args, os.Stdout, os.Stderr)');
    expect(content).toContain('Hook output deliberately goes to the process streams');
    expect(content).toContain('stdoutPath := setStdout(t, tmp)');
  });

  it('requires neutral comment-only semantics and no surviving high findings', () => {
    const { relevance } = mustGet('success-1.json');
    const joined = relevance.join('\n');
    expect(joined).toContain("it is NOT '🔴 CRITICAL'");
    expect(joined).toContain(
      "No findings have severity 'high' with verdict 'CONFIRMED' or 'LIKELY'",
    );
    expect(joined).toContain('neutral comment-only semantics');
    expect(joined).toContain("does not use approval wording such as 'APPROVE' or 'LGTM'");
    // The retired 🟢 APPROVE label must not resurface in criteria.
    expect(joined).not.toContain('🟢 APPROVE');
  });
});

describe('marlin event-firing criteria', () => {
  it('keeps both essential bugs and drops the redundant duplicate-timestamp criterion', () => {
    const { relevance } = mustGet('marlin-event-firing-react-1.json');
    const joined = relevance.join('\n');
    // Essential bug 1: track() runs in the render body, firing every render.
    expect(joined).toContain('render body, not inside a useEffect');
    // Essential bug 2: Date.now() is the wrong type for a Timestamp field.
    expect(joined).toContain('wrong type for a Timestamp field');
    // Retired: a third criterion re-demanding Date.now() duplicate-timestamp
    // phrasing was redundant with the two above and failed correct reviews.
    expect(joined.toLowerCase()).not.toContain('duplicate timestamps');
  });
});

describe('console-mode git fixtures', () => {
  const gitFixtures = ['large-diff-chunking-1.json', 'auto-filter-integration-1.json'];

  it.each(gitFixtures)('%s builds a local git repo so console mode has a real diff', (name) => {
    const { setup } = mustGet(name);
    // The console flow diffs merge-base(main, HEAD)..HEAD; setup must create
    // both refs and must silence benign git stderr (quiet flags) because
    // some runner versions treat any setup stderr as fatal.
    expect(setup).toContain('git init -q -b main');
    expect(setup).toContain('git checkout -q -b');
    expect(setup).toMatch(/git commit -q/);
    expect(setup).toContain('set -eu');
  });

  it('keeps the SQL-injection signal and console expectations in both fixtures', () => {
    for (const name of gitFixtures) {
      const { relevance, setup } = mustGet(name);
      const joined = relevance.join('\n');
      expect(setup).toContain('fmt.Sprintf("SELECT');
      expect(joined).toContain('SQL injection');
      expect(joined).toContain('pkg/storage/db.go');
      expect(joined).toContain("severity 'high'");
      expect(joined).toContain('console');
    }
  });
});
