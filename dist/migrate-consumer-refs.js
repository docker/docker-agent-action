import { createRequire } from 'node:module'; var require = createRequire(import.meta.url);

// src/migrate-consumer-refs/migrate-refs.ts
import { readFileSync, writeFileSync } from "fs";
var OLD_SLUG = "docker/cagent-action";
var NEW_SLUG = "docker/docker-agent-action";
var SUBPATH_MIGRATIONS = [
  ["/.github/actions/setup-credentials", "/setup-credentials"]
];
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var USES_RE = new RegExp(
  `^(\\s*(?:-\\s*)?uses:\\s*["']?)${escapeRegExp(OLD_SLUG)}((?:/[^@\\s"']*)?)@([^\\s"'#]+)(["']?)([ \\t]*#[^\\n]*)?\\s*$`
);
var PLAIN_RE = new RegExp(`${escapeRegExp(OLD_SLUG)}(?![A-Za-z0-9_-])`, "g");
function migrateRefs(content, options = {}) {
  if (options.newSha !== void 0 && !/^[0-9a-f]{40}$/.test(options.newSha)) {
    throw new Error(`newSha must be a 40-char lowercase hex SHA, got: "${options.newSha}"`);
  }
  const lines = content.split("\n");
  let usesCount = 0;
  let otherCount = 0;
  const out = lines.map((rawLine) => {
    const hasCR = rawLine.endsWith("\r");
    const line = hasCR ? rawLine.slice(0, -1) : rawLine;
    const usesMatch = line.match(USES_RE);
    if (usesMatch) {
      const [, prefix, subpath, ref, closeQuote, comment] = usesMatch;
      usesCount++;
      let newRef = ref;
      let newComment = comment ?? "";
      let newSubpath = subpath;
      if (options.newSha !== void 0) {
        newRef = options.newSha;
        newComment = options.newVersion ? ` # ${options.newVersion}` : "";
        for (const [oldPath, newPath] of SUBPATH_MIGRATIONS) {
          if (newSubpath === oldPath) newSubpath = newPath;
        }
      }
      const rebuilt = `${prefix}${NEW_SLUG}${newSubpath}@${newRef}${closeQuote}${newComment}`;
      return hasCR ? `${rebuilt}\r` : rebuilt;
    }
    if (line.includes(OLD_SLUG)) {
      const rebuilt = line.replace(PLAIN_RE, NEW_SLUG);
      if (rebuilt !== line) {
        otherCount++;
        return hasCR ? `${rebuilt}\r` : rebuilt;
      }
    }
    return rawLine;
  });
  const result = out.join("\n");
  return {
    content: result,
    changed: result !== content,
    usesCount,
    otherCount
  };
}
function applyMigration(files, options = {}) {
  if (options.newSha !== void 0 && !/^[0-9a-f]{40}$/.test(options.newSha)) {
    throw new Error(`newSha must be a 40-char lowercase hex SHA, got: "${options.newSha}"`);
  }
  const changedFiles = [];
  const errors = [];
  for (const file of files) {
    try {
      const before = readFileSync(file, "utf-8");
      const result = migrateRefs(before, options);
      if (result.changed) {
        writeFileSync(file, result.content, "utf-8");
        changedFiles.push(file);
        process.stderr.write(
          `\u2705 ${file}: ${result.usesCount} uses ref(s), ${result.otherCount} other ref(s) rewritten
`
        );
      } else {
        process.stderr.write(`\u2139\uFE0F  ${file}: no old references found
`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ file, message });
      process.stderr.write(`\u26A0\uFE0F  ${file}: ${message}
`);
    }
  }
  return { changedFiles, errors };
}

// src/migrate-consumer-refs/index.ts
function parseArgs(args) {
  const result = { files: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--sha") {
      const val = args[++i];
      if (val === void 0) throw new Error("--sha requires a value");
      result.sha = val;
    } else if (arg === "--version") {
      const val = args[++i];
      if (val === void 0) throw new Error("--version requires a value");
      result.version = val;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      result.files.push(arg);
    }
  }
  return result;
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.files.length === 0) {
    process.stderr.write(
      "Usage: migrate-consumer-refs [--sha <40-hex> --version <vX.Y.Z>] <file> [<file> ...]\n"
    );
    process.exit(1);
  }
  if (args.version !== void 0 && args.sha === void 0) {
    throw new Error("--version requires --sha");
  }
  const { changedFiles, errors } = applyMigration(args.files, {
    newSha: args.sha,
    newVersion: args.version
  });
  for (const file of changedFiles) {
    process.stdout.write(`changed ${file}
`);
  }
  process.stderr.write(`Done: ${changedFiles.length}/${args.files.length} file(s) changed
`);
  if (errors.length > 0) {
    process.stderr.write(
      `Error: ${errors.length} file(s) could not be processed \u2014 failing so callers do not commit a partial migration
`
    );
    process.exit(1);
  }
}
try {
  main();
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}
`);
  process.exit(1);
}
