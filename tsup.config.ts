import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

// Read the docker-agent version at build time so it can be embedded as a
// compile-time constant.  This means the bundle never needs to locate the
// DOCKER_AGENT_VERSION file on disk at action runtime — which would fail when
// ACTION_PATH points at a sub-directory (e.g. review-pr/) rather than the
// action root.
const dockerAgentVersion = readFileSync(
  resolve(import.meta.dirname, 'DOCKER_AGENT_VERSION'),
  'utf-8',
).trim();

// Explicit entry list: only modules that back an actual action.yml entrypoint.
// Pure library sub-modules (add-reaction, get-pr-meta, post-comment) are imported
// by mention-reply but have no standalone action, so they don't get their own
// top-level dist bundle. check-org-membership is both a library and a standalone
// node24 action, so it IS in the entry map.
const src = (name: string) => {
  const p = resolve(import.meta.dirname, 'src', name, 'index.ts');
  if (!existsSync(p)) throw new Error(`tsup entry not found: ${p}`);
  return p;
};
const entry = {
  'auto-filter-diff': src('auto-filter-diff'),
  'check-org-membership': src('check-org-membership'),
  credentials: src('credentials'),
  'filter-diff': src('filter-diff'),
  main: src('main'),
  'mention-reply': src('mention-reply'),
  'migrate-consumer-refs': src('migrate-consumer-refs'),
  'post-mention-reply': src('post-mention-reply'),
  'score-risk': src('score-risk'),
  security: src('security'),
  'signed-commit': src('signed-commit'),
};

export default defineConfig({
  entry,
  // Inject the docker-agent version as a build-time constant so the bundle
  // never reads DOCKER_AGENT_VERSION from disk at runtime.
  define: {
    __DOCKER_AGENT_VERSION__: JSON.stringify(dockerAgentVersion),
  },
  format: ['esm'],
  // Target Node.js explicitly so esbuild resolves the "node" export condition
  // in AWS SDK packages instead of the browser variant (which pulls in
  // DOMParser / document and breaks at runtime in a GitHub Action).
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  // Keep .js extension so the action can `node dist/credentials.js` directly.
  // Without this tsup would emit .mjs for ESM format.
  outExtension: () => ({ js: '.js' }),
  // Sourcemaps disabled: this action is consumed via `uses: docker/docker-agent-action@v1`,
  // which clones the tagged release including dist/. Sourcemaps would add ~10MB to every
  // consumer clone with no runtime benefit (Node doesn't load them by default).
  sourcemap: false,
  clean: true,
  // Disable code splitting so each entry is fully self-contained.
  splitting: false,
  // tsup's externalizeDepsPlugin marks all node_modules as external by default.
  // The action runs `node dist/credentials.js` with no node_modules present at
  // runtime, so every npm dependency (AWS SDK, @actions/core, @octokit/…) must
  // be bundled in. Node.js built-ins stay external automatically (platform:'node').
  noExternal: [/.*/],
  // CJS packages bundled into ESM (e.g. tunnel@0.0.6 via @actions/http-client)
  // call require('net') / require('tls') at runtime. esbuild's __require shim
  // checks `typeof require !== "undefined"` — which is false in pure ESM — and
  // throws "Dynamic require of 'net' is not supported". Injecting createRequire
  // as a top-level banner supplies a real require() before the shim runs,
  // so those CJS modules can load Node.js built-ins normally.
  // NOTE: this banner uses import/import.meta.url — only valid in ESM output.
  // If format is ever extended to include 'cjs', this must be conditioned or
  // moved to a format-specific banner ({ esm: '...' }) to avoid a parse error.
  banner: {
    js: "import { createRequire } from 'node:module'; var require = createRequire(import.meta.url);",
  },
});
