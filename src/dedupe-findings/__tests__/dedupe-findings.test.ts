// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the dedupe-findings matching logic.
 *
 * These pin the contract that duplicates are dropped only on a triple match
 * (path + line proximity + signature similarity) against existing REST
 * comments, that severity tags are stripped from the identity signature while
 * category tags survive, that prior review-thread history suppresses
 * re-derived findings only while a thread is explicitly current
 * (`isOutdated: false` — outdated threads get reassessed and a missing or
 * malformed state fails open), that the root comment of an explicitly
 * outdated thread — which the REST layer still returns with only
 * `original_line` — is excluded from the legacy candidates by id while
 * uncorrelatable ids leave the REST behavior untouched, that the
 * anchor-based paraphrase matcher
 * demands multiple shared identifiers plus meaningful heading overlap, that
 * reassessed findings returning at a higher severity than their outdated
 * thread are reported as escalations (never blocked), and that human comments
 * and bot replies never suppress a finding.
 */
import { describe, expect, it } from 'vitest';
import {
  codeAnchors,
  dedupeComments,
  type ExistingComment,
  findingSignature,
  headingSeverity,
  meaningfulHeadingOverlap,
  type NewComment,
  type PriorReviewThread,
  signatureSimilarity,
} from '../dedupe-findings.js';

const MARKER = '<!-- docker-agent-review -->';
const LEGACY_MARKER = '<!-- cagent-review -->';
const REPLY_MARKER = '<!-- docker-agent-review-reply -->';

function existing(overrides: Partial<ExistingComment> = {}): ExistingComment {
  return {
    path: 'src/app.ts',
    line: 42,
    body: `**[high] Nil pointer dereference on user object**\n\ndetails\n\n${MARKER}`,
    ...overrides,
  };
}

function fresh(overrides: Partial<NewComment> = {}): NewComment {
  return {
    path: 'src/app.ts',
    line: 42,
    body: `**[high] Nil pointer dereference on user object**\n\nre-derived details\n\n${MARKER}`,
    ...overrides,
  };
}

function thread(overrides: Partial<PriorReviewThread> = {}): PriorReviewThread {
  return {
    path: 'src/app.ts',
    line: 42,
    originalLine: 42,
    isResolved: false,
    isOutdated: false,
    comments: {
      nodes: [
        {
          body: `**[high] Nil pointer dereference on user object**\n\ndetails\n\n${MARKER}`,
          author: { login: 'docker-agent[bot]' },
          replyTo: null,
        },
      ],
    },
    ...overrides,
  };
}

// Condensed regressions from docker/sandboxes#4890: the same finding
// re-derived with a rephrased heading (low Jaccard) — once with a 13-line
// drift, once at the same line.
const CRED_TEMPLATE_THREAD_BODY =
  '**[high] genericModelMixinTemplate omits SBX_CRED_OPENAI_MODE and SBX_CRED_ANTHROPIC_MODE**\n\n' +
  '`genericModelMixinTemplate` renders the model environment without `SBX_CRED_OPENAI_MODE` or ' +
  '`SBX_CRED_ANTHROPIC_MODE`, so sandboxes launched from the generic mixin cannot select a ' +
  `credential mode.\n\n${MARKER}`;

const CRED_TEMPLATE_REPHRASED_BODY =
  '**[medium] Omission of SBX_CRED_ANTHROPIC_MODE from the rendered model environment**\n\n' +
  'The environment block `genericModelMixinTemplate` produces never sets ' +
  `\`SBX_CRED_ANTHROPIC_MODE\`, leaving the Anthropic credential mode unconfigured.\n\n${MARKER}`;

const LLMMAN_THREAD_BODY =
  '**[medium] Default llmman source switched from the Docker-controlled mirror to a personal repo**\n\n' +
  '`LLMMAN_REPO` now defaults to `github.com/someuser/llmman` instead of the Docker-controlled ' +
  `mirror, so default builds fetch llmman from an individual's repository.\n\n${MARKER}`;

const LLMMAN_REPHRASED_BODY =
  '**[low] llmman fetched from a personal force-push-unprotected repo**\n\n' +
  'With no override set, `LLMMAN_REPO` still resolves to `github.com/someuser/llmman`; that ' +
  `personal account can force-push, so the fetched llmman code can be rewritten at any time.\n\n${MARKER}`;

// Two DIFFERENT findings about the same function: they share two code anchors
// (`processPayment`, `paymentAmount`) but describe unrelated defects, so the
// paraphrase matcher must never collapse them.
const PAYMENT_LOG_THREAD_BODY =
  '**[medium] processPayment logs paymentAmount in plaintext**\n\n' +
  `\`processPayment\` writes \`paymentAmount\` to the request log without masking.\n\n${MARKER}`;

const PAYMENT_RETRY_BODY =
  '**[high] processPayment double-charges paymentAmount on retry**\n\n' +
  'When the gateway times out, `processPayment` retries without an idempotency key, so ' +
  `\`paymentAmount\` is charged twice.\n\n${MARKER}`;

describe('findingSignature', () => {
  it('extracts normalized tokens and strips the leading severity tag', () => {
    expect(findingSignature('**[high] Race condition in cache-refresh**\n\nbody')).toEqual([
      'race',
      'condition',
      'in',
      'cache',
      'refresh',
    ]);
  });

  it('keeps a leading category tag such as [security]', () => {
    expect(findingSignature('**[security] Hardcoded credential in template**')).toEqual([
      'security',
      'hardcoded',
      'credential',
      'in',
      'template',
    ]);
  });

  it('strips the severity but keeps the category when both tags lead the heading', () => {
    expect(findingSignature('**[high] [security] SSRF via unvalidated redirect**')).toEqual([
      'security',
      'ssrf',
      'via',
      'unvalidated',
      'redirect',
    ]);
  });

  it('keeps severity words that are part of the summary itself', () => {
    expect(findingSignature('**[low] High memory usage during cache warmup**')).toEqual([
      'high',
      'memory',
      'usage',
      'during',
      'cache',
      'warmup',
    ]);
  });

  it('falls back to the first non-empty line when no bold block exists', () => {
    expect(findingSignature('\n\nUnchecked error return\nmore')).toEqual([
      'unchecked',
      'error',
      'return',
    ]);
  });

  it('ignores bold spans that wrap across lines and falls back to the first line', () => {
    expect(findingSignature('**[high] Race condition\nin cache-refresh**\n\nbody')).toEqual([
      'race',
      'condition',
    ]);
  });

  it('deduplicates repeated tokens', () => {
    expect(findingSignature('**error error error**')).toEqual(['error']);
  });

  it('returns null for empty, symbol-only, or severity-only bodies', () => {
    expect(findingSignature('')).toBeNull();
    expect(findingSignature('***')).toBeNull();
    expect(findingSignature('**[medium]**')).toBeNull();
  });
});

describe('headingSeverity', () => {
  it('parses the leading severity tag', () => {
    expect(headingSeverity('**[high] Nil pointer dereference**\n\nbody')).toBe('high');
    expect(headingSeverity('**[medium] Unclosed file handle**')).toBe('medium');
    expect(headingSeverity('**[low] Retry loop never backs off**')).toBe('low');
  });

  it('finds the severity in a later leading tag', () => {
    expect(headingSeverity('**[security] [high] SSRF via unvalidated redirect**')).toBe('high');
  });

  it('ignores severity words that are part of the summary itself', () => {
    expect(headingSeverity('**[security] High memory usage during cache warmup**')).toBeNull();
  });

  it('returns null when no leading severity tag exists', () => {
    expect(headingSeverity('Unchecked error return')).toBeNull();
    expect(headingSeverity('')).toBeNull();
  });
});

describe('signatureSimilarity', () => {
  it('is 1 for identical token sets', () => {
    expect(signatureSimilarity(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('is 0 for disjoint token sets', () => {
    expect(signatureSimilarity(['a'], ['b'])).toBe(0);
  });

  it('computes Jaccard for partial overlap', () => {
    // {a,b,c} ∩ {b,c,d} = 2, union = 4
    expect(signatureSimilarity(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(0.5);
  });

  it('is 0 when either side is empty', () => {
    expect(signatureSimilarity([], ['a'])).toBe(0);
    expect(signatureSimilarity(['a'], [])).toBe(0);
  });
});

describe('meaningfulHeadingOverlap', () => {
  it('counts shared tokens that are neither stopwords nor classification vocabulary', () => {
    const prior = findingSignature(PAYMENT_LOG_THREAD_BODY) ?? [];
    const rederived = findingSignature(PAYMENT_RETRY_BODY) ?? [];
    // Only the two identifiers are shared; 'in'/'on' are glue.
    expect(meaningfulHeadingOverlap(rederived, prior)).toBe(2);
  });

  it('ignores glue words and category tags entirely', () => {
    const a = findingSignature('**[security] The token is logged in the clear**') ?? [];
    const b = findingSignature('**[security] The nonce is reused in the handshake**') ?? [];
    // Shared tokens: security (category), the/is/in (glue) — all noise.
    expect(meaningfulHeadingOverlap(a, b)).toBe(0);
  });
});

describe('codeAnchors', () => {
  it('collects inline code spans and identifier-shaped words, lowercased', () => {
    expect(
      codeAnchors(
        'Rendered `model.yaml` embeds `SBX_CRED_*` values that `genericModelMixinTemplate` interpolates',
      ),
    ).toEqual(['model.yaml', 'sbx_cred_*', 'genericmodelmixintemplate', 'sbx_cred_']);
  });

  it('ignores prose, classification vocabulary, markers, fenced code, and lone lowercase spans', () => {
    const body = [
      '**[high] Credential value logged on the error_handling path**',
      'The token MUST NOT be printed. See `err` and `nil` notes.',
      '```suggestion',
      'const SECRET_TOKEN = redact(rawToken);',
      '```',
      '',
      MARKER,
    ].join('\n');
    expect(codeAnchors(body)).toEqual([]);
  });
});

describe('dedupeComments', () => {
  it('drops a comment matching an existing finding on path, line, and signature', () => {
    const result = dedupeComments([fresh()], [existing()]);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([
      expect.objectContaining({
        path: 'src/app.ts',
        line: 42,
        matchedLine: 42,
        source: 'existing-comment',
        matchedBy: 'heading',
      }),
    ]);
  });

  it('drops a comment whose line shifted within the tolerance', () => {
    const result = dedupeComments([fresh({ line: 44 })], [existing()]);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toHaveLength(1);
  });

  it('drops a duplicate re-derived at a different severity (severity is not identity)', () => {
    const result = dedupeComments(
      [fresh({ body: `**[medium] Nil pointer dereference on user object**\n\n${MARKER}` })],
      [existing()],
    );
    expect(result.dropped).toHaveLength(1);
  });

  it('drops a duplicate even when the existing bold heading wraps across lines', () => {
    const wrapped =
      '**[high] Nil pointer dereference on user object\n' +
      'which can crash the request handler when the session store returns an expired entry**';
    const result = dedupeComments(
      [fresh()],
      [existing({ body: `${wrapped}\n\ndetails\n\n${MARKER}` })],
    );
    expect(result.kept).toEqual([]);
    expect(result.dropped).toHaveLength(1);
  });

  it('keeps a comment whose line is beyond the tolerance', () => {
    const result = dedupeComments([fresh({ line: 50 })], [existing()]);
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });

  it('keeps a comment on a different file even with identical text', () => {
    const result = dedupeComments([fresh({ path: 'src/other.ts' })], [existing()]);
    expect(result.kept).toHaveLength(1);
  });

  it('keeps a comment whose finding text differs (same spot, new issue)', () => {
    const result = dedupeComments(
      [fresh({ body: `**[medium] Unclosed file handle leaks descriptor**\n\n${MARKER}` })],
      [existing()],
    );
    expect(result.kept).toHaveLength(1);
  });

  it('never applies the anchor matcher to legacy REST comments', () => {
    // Same #4890 pair that the thread layer catches: rephrased heading plus a
    // 13-line drift stays outside the REST rule (±3 + Jaccard).
    const result = dedupeComments(
      [
        fresh({
          path: 'images/model/entrypoint.sh',
          line: 223,
          body: CRED_TEMPLATE_REPHRASED_BODY,
        }),
      ],
      [
        existing({
          path: 'images/model/entrypoint.sh',
          line: 210,
          body: CRED_TEMPLATE_THREAD_BODY,
        }),
      ],
    );
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });

  it('never dedupes against human comments (no marker)', () => {
    const result = dedupeComments(
      [fresh()],
      [existing({ body: '**[high] Nil pointer dereference on user object**\n\nI agree' })],
    );
    expect(result.kept).toHaveLength(1);
  });

  it('never dedupes against bot conversational replies', () => {
    const result = dedupeComments(
      [fresh()],
      [
        existing({
          body: `**[high] Nil pointer dereference on user object**\n\nreply\n\n${REPLY_MARKER}`,
        }),
      ],
    );
    expect(result.kept).toHaveLength(1);
  });

  it('dedupes against legacy cagent-review comments during migration', () => {
    const result = dedupeComments(
      [fresh()],
      [
        existing({
          body: `**[high] Nil pointer dereference on user object**\n\n${LEGACY_MARKER}`,
        }),
      ],
    );
    expect(result.dropped).toHaveLength(1);
  });

  it('matches outdated existing comments via original_line when line is null', () => {
    const result = dedupeComments([fresh()], [existing({ line: null, original_line: 41 })]);
    expect(result.dropped).toHaveLength(1);
  });

  it('skips existing comments with no usable anchor at all', () => {
    const result = dedupeComments([fresh()], [existing({ line: null, original_line: null })]);
    expect(result.kept).toHaveLength(1);
  });

  it('keeps malformed new comments for downstream validation to handle', () => {
    const malformed: NewComment[] = [
      { body: 'no path or line' },
      { path: 'src/app.ts', line: 'not-a-number', body: 'x' },
    ];
    const result = dedupeComments(malformed, [existing()]);
    expect(result.kept).toEqual(malformed);
  });

  it('returns everything unchanged when there are no existing bot comments', () => {
    const comments = [fresh(), fresh({ path: 'b.ts' })];
    const result = dedupeComments(comments, []);
    expect(result.kept).toEqual(comments);
    expect(result.dropped).toEqual([]);
  });

  it('preserves extra fields (side, start_line) on kept comments', () => {
    const comment = fresh({ path: 'src/other.ts', side: 'LEFT', start_line: 40 });
    const result = dedupeComments([comment], [existing()]);
    expect(result.kept[0]).toBe(comment);
  });

  it('honors custom tolerance and similarity options', () => {
    const strict = dedupeComments([fresh({ line: 44 })], [existing()], { lineTolerance: 1 });
    expect(strict.kept).toHaveLength(1);

    const lax = dedupeComments(
      [fresh({ body: `**[high] Nil pointer somewhere else entirely**\n\n${MARKER}` })],
      [existing()],
      { similarityThreshold: 0.2 },
    );
    expect(lax.dropped).toHaveLength(1);
  });
});

describe('dedupeComments with prior review threads', () => {
  it('drops a re-derived finding matching a current unresolved bot thread', () => {
    const result = dedupeComments([fresh()], [], { priorThreads: [thread()] });
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([
      expect.objectContaining({ source: 'prior-thread', matchedBy: 'heading', matchedLine: 42 }),
    ]);
  });

  it('drops a re-derived finding matching a current resolved bot thread', () => {
    const result = dedupeComments([fresh()], [], {
      priorThreads: [thread({ isResolved: true })],
    });
    expect(result.kept).toEqual([]);
    expect(result.dropped).toHaveLength(1);
  });

  it('keeps a finding whose only match is an outdated thread (reassess against new code)', () => {
    const outdated = thread({ isOutdated: true, line: null, originalLine: 42 });
    const result = dedupeComments([fresh()], [], { priorThreads: [outdated] });
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });

  it('never suppresses via threads whose isOutdated state is missing or malformed', () => {
    // Only an explicit boolean false marks a thread current; anything else
    // fails open so malformed history cannot swallow findings.
    const { isOutdated: _omitted, ...withoutState } = thread();
    const malformedStates = [undefined, null, 'false', 0] as unknown as (boolean | null)[];
    for (const priorThreads of [
      [withoutState as PriorReviewThread],
      ...malformedStates.map((isOutdated) => [thread({ isOutdated })]),
    ]) {
      const result = dedupeComments([fresh()], [], { priorThreads });
      expect(result.kept).toHaveLength(1);
      expect(result.dropped).toEqual([]);
      expect(result.escalations).toEqual([]);
    }
  });

  it('anchors a current thread via originalLine when line is null', () => {
    const result = dedupeComments([fresh()], [], {
      priorThreads: [thread({ line: null, originalLine: 41 })],
    });
    expect(result.dropped).toHaveLength(1);
  });

  it('ignores threads whose root comment is not a marked bot review comment', () => {
    const humanThread = thread({
      comments: {
        nodes: [
          {
            body: '**[high] Nil pointer dereference on user object**\n\nplease fix',
            author: { login: 'alice' },
          },
        ],
      },
    });
    const markedReplyOnly = thread({
      comments: {
        nodes: [
          { body: 'thanks, looking into it', author: { login: 'alice' } },
          {
            body: `**[high] Nil pointer dereference on user object**\n\nsame issue\n\n${MARKER}`,
            author: { login: 'docker-agent[bot]' },
            replyTo: { databaseId: 1001 },
          },
        ],
      },
    });
    const result = dedupeComments([fresh()], [], {
      priorThreads: [humanThread, markedReplyOnly],
    });
    expect(result.kept).toHaveLength(1);
  });

  it('preserves REST-comment dedupe when thread history is missing or malformed', () => {
    const duplicate = fresh();
    const novel = fresh({ path: 'src/other.ts' });
    const malformed = [
      null,
      42,
      'thread',
      {},
      { path: 'src/app.ts', line: 42 },
    ] as unknown as PriorReviewThread[];
    for (const priorThreads of [undefined, null, [], malformed]) {
      const result = dedupeComments([duplicate, novel], [existing()], { priorThreads });
      expect(result.dropped).toEqual([expect.objectContaining({ source: 'existing-comment' })]);
      expect(result.kept).toEqual([novel]);
    }
  });

  it('drops the sandboxes#4890 credential-template finding rephrased with a 13-line drift', () => {
    const prior = thread({
      path: 'images/model/entrypoint.sh',
      line: 210,
      originalLine: 210,
      comments: {
        nodes: [
          {
            body: CRED_TEMPLATE_THREAD_BODY,
            author: { login: 'docker-agent[bot]' },
            replyTo: null,
          },
        ],
      },
    });
    const result = dedupeComments(
      [
        fresh({
          path: 'images/model/entrypoint.sh',
          line: 223,
          body: CRED_TEMPLATE_REPHRASED_BODY,
        }),
      ],
      [],
      { priorThreads: [prior] },
    );
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([
      expect.objectContaining({ source: 'prior-thread', matchedBy: 'anchors', matchedLine: 210 }),
    ]);
  });

  it('drops the sandboxes#4890 personal-repository finding rephrased at the same line', () => {
    const prior = thread({
      path: 'scripts/install-llmman.sh',
      line: 57,
      originalLine: 57,
      comments: {
        nodes: [
          { body: LLMMAN_THREAD_BODY, author: { login: 'docker-agent[bot]' }, replyTo: null },
        ],
      },
    });
    const result = dedupeComments(
      [fresh({ path: 'scripts/install-llmman.sh', line: 57, body: LLMMAN_REPHRASED_BODY })],
      [],
      { priorThreads: [prior] },
    );
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([
      expect.objectContaining({ source: 'prior-thread', matchedBy: 'anchors', matchedLine: 57 }),
    ]);
  });

  it('keeps an unrelated finding at the same location as a prior thread', () => {
    const prior = thread({
      comments: {
        nodes: [
          {
            body: `**[high] Session lookup dereferences nil user**\n\n\`loadUserSession\` may return nil and \`currentUser\` is dereferenced without a check.\n\n${MARKER}`,
            author: { login: 'docker-agent[bot]' },
            replyTo: null,
          },
        ],
      },
    });
    const unrelated = fresh({
      body: `**[medium] Retry loop never backs off**\n\n\`runRetryLoop\` retries immediately because \`backoffDelay\` is never applied between attempts.\n\n${MARKER}`,
    });
    const result = dedupeComments([unrelated], [], { priorThreads: [prior] });
    expect(result.kept).toEqual([unrelated]);
    expect(result.dropped).toEqual([]);
  });

  it('keeps a high-severity unrelated finding sharing two identifiers with a current thread', () => {
    // The docker/sandboxes#4890 counter-case: same function, two shared
    // anchors, but a different defect — plaintext logging vs double-charging.
    // Without meaningful heading overlap the anchor matcher must not fire.
    const prior = thread({
      path: 'src/payments/charge.ts',
      line: 88,
      originalLine: 88,
      comments: {
        nodes: [
          { body: PAYMENT_LOG_THREAD_BODY, author: { login: 'docker-agent[bot]' }, replyTo: null },
        ],
      },
    });
    const rederived = fresh({ path: 'src/payments/charge.ts', line: 88, body: PAYMENT_RETRY_BODY });
    const result = dedupeComments([rederived], [], { priorThreads: [prior] });
    expect(result.kept).toEqual([rederived]);
    expect(result.dropped).toEqual([]);
  });

  it('keeps a two-anchor finding when only identifiers, category, and glue words are shared', () => {
    const prior = thread({
      comments: {
        nodes: [
          {
            body: `**[security] validateToken skips the expiry check in refreshSession**\n\n\`validateToken\` accepts tokens after \`refreshSession\` rotates them.\n\n${MARKER}`,
            author: { login: 'docker-agent[bot]' },
            replyTo: null,
          },
        ],
      },
    });
    const rederived = fresh({
      body: `**[security] validateToken leaks the bearer token in refreshSession logs**\n\n\`validateToken\` prints the raw token whenever \`refreshSession\` fails.\n\n${MARKER}`,
    });
    const result = dedupeComments([rederived], [], { priorThreads: [prior] });
    expect(result.kept).toEqual([rederived]);
    expect(result.dropped).toEqual([]);
  });

  it('keeps a different finding that shares only one identifier with a prior thread', () => {
    const prior = thread({
      comments: {
        nodes: [
          {
            body: `**[high] parseManifest ignores read failures**\n\n\`parseManifest\` swallows the error from \`readFile\` and returns an empty manifest.\n\n${MARKER}`,
            author: { login: 'docker-agent[bot]' },
            replyTo: null,
          },
        ],
      },
    });
    const rederived = fresh({
      body: `**[medium] parseManifest mutates its argument**\n\n\`parseManifest\` sorts the caller's entries slice in place.\n\n${MARKER}`,
    });
    const result = dedupeComments([rederived], [], { priorThreads: [prior] });
    expect(result.kept).toEqual([rederived]);
    expect(result.dropped).toEqual([]);
  });

  it('keeps an anchor-matched finding once the drift exceeds the anchor line tolerance', () => {
    const prior = thread({
      path: 'images/model/entrypoint.sh',
      line: 210,
      originalLine: 210,
      comments: {
        nodes: [
          {
            body: CRED_TEMPLATE_THREAD_BODY,
            author: { login: 'docker-agent[bot]' },
            replyTo: null,
          },
        ],
      },
    });
    const result = dedupeComments(
      [
        fresh({
          path: 'images/model/entrypoint.sh',
          line: 245,
          body: CRED_TEMPLATE_REPHRASED_BODY,
        }),
      ],
      [],
      { priorThreads: [prior] },
    );
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });

  it('does not stretch the heading matcher to the anchor tolerance for threads', () => {
    // Identical heading but no shared code anchors: a 10-line drift is beyond
    // the ±3 heading rule, and without anchor evidence it must stay posted.
    const result = dedupeComments([fresh({ line: 52 })], [], { priorThreads: [thread()] });
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });
});

describe('dedupeComments cross-layer outdated-thread exclusion', () => {
  // GitHub returns a thread's root comment through BOTH layers: the REST list
  // (numeric `id`, with `line` nulled and the anchor kept in `original_line`
  // once outdated) and the GraphQL snapshot (`databaseId`). The REST copy
  // must not suppress the reassessment an explicitly outdated thread
  // mandates, so its root is excluded from the legacy candidates by id.
  const ROOT_ID = 5001;

  const restRoot = (id: unknown): ExistingComment =>
    existing({ id: id as number, line: null, original_line: 42 });

  const rootedThread = (
    isOutdated: PriorReviewThread['isOutdated'],
    databaseId: unknown,
    overrides: Partial<PriorReviewThread> = {},
  ): PriorReviewThread =>
    thread({
      isOutdated,
      comments: {
        nodes: [
          {
            databaseId: databaseId as number,
            body: `**[high] Nil pointer dereference on user object**\n\ndetails\n\n${MARKER}`,
            author: { login: 'docker-agent[bot]' },
            replyTo: null,
          },
        ],
      },
      ...overrides,
    });

  it('keeps a finding whose only REST match is the root of an explicitly outdated thread', () => {
    const result = dedupeComments([fresh()], [restRoot(ROOT_ID)], {
      priorThreads: [rootedThread(true, ROOT_ID)],
    });
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });

  it('still suppresses when the same root id belongs to an explicitly current thread', () => {
    const result = dedupeComments([fresh()], [restRoot(ROOT_ID)], {
      priorThreads: [rootedThread(false, ROOT_ID)],
    });
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([expect.objectContaining({ source: 'existing-comment' })]);
  });

  it('excludes the REST root even when the outdated thread has no usable anchor', () => {
    const result = dedupeComments([fresh()], [restRoot(ROOT_ID)], {
      priorThreads: [rootedThread(true, ROOT_ID, { line: null, originalLine: null })],
    });
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });

  it('feeds the reassessed finding to the escalation audit once the REST root is excluded', () => {
    const mediumRoot = `**[medium] Nil pointer dereference on user object**\n\ndetails\n\n${MARKER}`;
    const outdated = thread({
      isOutdated: true,
      comments: {
        nodes: [
          {
            databaseId: ROOT_ID,
            body: mediumRoot,
            author: { login: 'docker-agent[bot]' },
            replyTo: null,
          },
        ],
      },
    });
    const result = dedupeComments(
      [fresh()],
      [existing({ id: ROOT_ID, line: null, original_line: 42, body: mediumRoot })],
      { priorThreads: [outdated] },
    );
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toEqual([]);
    expect(result.escalations).toEqual([
      expect.objectContaining({ newSeverity: 'high', priorSeverity: 'medium' }),
    ]);
  });

  it('never excludes a REST comment whose id is missing, malformed, or nonmatching', () => {
    // An id that cannot be correlated safely leaves the legacy candidate in
    // place, so the REST comment keeps suppressing exactly as before.
    for (const id of [undefined, null, '5001', 5001.5, 0, -1, 6002]) {
      const result = dedupeComments([fresh()], [restRoot(id)], {
        priorThreads: [rootedThread(true, ROOT_ID)],
      });
      expect(result.kept).toEqual([]);
      expect(result.dropped).toEqual([expect.objectContaining({ source: 'existing-comment' })]);
    }
  });

  it('never excludes when the outdated root databaseId is missing or malformed', () => {
    for (const databaseId of [undefined, null, '5001', 3.5]) {
      const result = dedupeComments([fresh()], [restRoot(ROOT_ID)], {
        priorThreads: [rootedThread(true, databaseId)],
      });
      expect(result.kept).toEqual([]);
      expect(result.dropped).toEqual([expect.objectContaining({ source: 'existing-comment' })]);
    }
  });

  it('never excludes via a matching id on a thread with malformed lifecycle state', () => {
    const malformedStates = [undefined, null, 'true', 1] as unknown as (boolean | null)[];
    for (const isOutdated of malformedStates) {
      const result = dedupeComments([fresh()], [restRoot(ROOT_ID)], {
        priorThreads: [rootedThread(isOutdated, ROOT_ID)],
      });
      expect(result.kept).toEqual([]);
      expect(result.dropped).toEqual([expect.objectContaining({ source: 'existing-comment' })]);
    }
  });

  it('never excludes via a matching id on an unmarked human root or a marked reply', () => {
    const humanRooted = thread({
      isOutdated: true,
      comments: {
        nodes: [
          {
            databaseId: ROOT_ID,
            body: '**[high] Nil pointer dereference on user object**\n\nplease fix',
            author: { login: 'alice' },
            replyTo: null,
          },
        ],
      },
    });
    const markedReplyOnly = thread({
      isOutdated: true,
      comments: {
        nodes: [
          {
            databaseId: ROOT_ID,
            body: `**[high] Nil pointer dereference on user object**\n\nsame issue\n\n${MARKER}`,
            author: { login: 'docker-agent[bot]' },
            replyTo: { databaseId: 1001 },
          },
        ],
      },
    });
    for (const priorThreads of [[humanRooted], [markedReplyOnly]]) {
      const result = dedupeComments([fresh()], [restRoot(ROOT_ID)], { priorThreads });
      expect(result.kept).toEqual([]);
      expect(result.dropped).toEqual([expect.objectContaining({ source: 'existing-comment' })]);
    }
  });
});

describe('dedupeComments severity-escalation audit', () => {
  const outdatedAt = (body: string, path: string, line: number): PriorReviewThread =>
    thread({
      path,
      line,
      originalLine: line,
      isOutdated: true,
      comments: { nodes: [{ body, author: { login: 'docker-agent[bot]' }, replyTo: null }] },
    });

  it('reports a kept finding re-deriving an outdated thread at a higher severity', () => {
    const prior = outdatedAt(
      `**[medium] Nil pointer dereference on user object**\n\ndetails\n\n${MARKER}`,
      'src/app.ts',
      42,
    );
    const result = dedupeComments([fresh()], [], { priorThreads: [prior] });
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toEqual([]);
    expect(result.escalations).toEqual([
      expect.objectContaining({
        path: 'src/app.ts',
        line: 42,
        matchedLine: 42,
        newSeverity: 'high',
        priorSeverity: 'medium',
        matchedBy: 'heading',
      }),
    ]);
  });

  it('reports an anchor-matched escalation across a rephrased heading', () => {
    const prior = outdatedAt(
      CRED_TEMPLATE_THREAD_BODY.replace('**[high]', '**[low]'),
      'images/model/entrypoint.sh',
      210,
    );
    const result = dedupeComments(
      [
        fresh({
          path: 'images/model/entrypoint.sh',
          line: 223,
          body: CRED_TEMPLATE_REPHRASED_BODY,
        }),
      ],
      [],
      { priorThreads: [prior] },
    );
    expect(result.kept).toHaveLength(1);
    expect(result.escalations).toEqual([
      expect.objectContaining({
        newSeverity: 'medium',
        priorSeverity: 'low',
        matchedBy: 'anchors',
        matchedLine: 210,
      }),
    ]);
  });

  it('reports nothing for same or lower severity or unmatched findings', () => {
    const nilPointerAt = (severity: string) =>
      outdatedAt(
        `**[${severity}] Nil pointer dereference on user object**\n\ndetails\n\n${MARKER}`,
        'src/app.ts',
        42,
      );

    const same = dedupeComments([fresh()], [], { priorThreads: [nilPointerAt('high')] });
    expect(same.escalations).toEqual([]);

    const lower = fresh({
      body: `**[medium] Nil pointer dereference on user object**\n\n${MARKER}`,
    });
    const downgraded = dedupeComments([lower], [], { priorThreads: [nilPointerAt('high')] });
    expect(downgraded.escalations).toEqual([]);

    const unrelated = fresh({
      body: `**[high] Unclosed file handle leaks descriptor**\n\n${MARKER}`,
    });
    const unmatched = dedupeComments([unrelated], [], { priorThreads: [nilPointerAt('low')] });
    expect(unmatched.kept).toEqual([unrelated]);
    expect(unmatched.escalations).toEqual([]);
  });

  it('reports nothing when either side has no parseable severity', () => {
    const untagged = `**Nil pointer dereference on user object**\n\ndetails\n\n${MARKER}`;
    const priorUntagged = outdatedAt(untagged, 'src/app.ts', 42);
    expect(dedupeComments([fresh()], [], { priorThreads: [priorUntagged] }).escalations).toEqual(
      [],
    );

    const priorLow = outdatedAt(
      `**[low] Nil pointer dereference on user object**\n\ndetails\n\n${MARKER}`,
      'src/app.ts',
      42,
    );
    const newUntagged = fresh({ body: untagged });
    expect(dedupeComments([newUntagged], [], { priorThreads: [priorLow] }).escalations).toEqual([]);
  });

  it('records no escalation for findings suppressed by a current thread', () => {
    // A current [medium] thread suppresses the re-derived [high] duplicate
    // entirely, so nothing reaches the reassessment audit.
    const current = thread({
      comments: {
        nodes: [
          {
            body: `**[medium] Nil pointer dereference on user object**\n\ndetails\n\n${MARKER}`,
            author: { login: 'docker-agent[bot]' },
            replyTo: null,
          },
        ],
      },
    });
    const result = dedupeComments([fresh()], [], { priorThreads: [current] });
    expect(result.dropped).toHaveLength(1);
    expect(result.escalations).toEqual([]);
  });
});
