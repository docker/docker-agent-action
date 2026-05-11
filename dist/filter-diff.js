import { createRequire } from 'node:module'; var require = createRequire(import.meta.url);

// src/filter-diff/filter-diff.ts
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
function parseExcludePrefixes(excludePathsStr) {
  return excludePathsStr.split("\n").map((p) => p.replace(/\r/g, "").trim()).filter((p) => p.length > 0);
}
function filterDiff(diffContent, excludePrefixes) {
  const prefixes = excludePrefixes.filter((p) => p.length > 0);
  if (prefixes.length === 0 || diffContent === "") {
    const remainingCount2 = (diffContent.match(/^diff --git /gm) ?? []).length;
    return { filtered: diffContent, excludedFiles: [], remainingCount: remainingCount2 };
  }
  const isExcluded = (filePath) => prefixes.some((prefix) => filePath.startsWith(prefix));
  const lines = diffContent.split("\n");
  const outputLines = [];
  let sectionLines = [];
  let skip = false;
  const excludedFiles = [];
  let remainingCount = 0;
  const flushSection = () => {
    if (sectionLines.length === 0) return;
    if (!skip) {
      for (const l of sectionLines) outputLines.push(l);
      remainingCount++;
    }
    sectionLines = [];
    skip = false;
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushSection();
      sectionLines.push(line);
    } else if (sectionLines.length > 0) {
      if (!skip) {
        let filePath = null;
        if (line.startsWith("--- a/")) {
          filePath = line.slice(6);
        } else if (line.startsWith("+++ b/")) {
          filePath = line.slice(6);
        } else if (line.startsWith("rename to ")) {
          filePath = line.slice(10);
        }
        if (filePath !== null && isExcluded(filePath)) {
          skip = true;
          excludedFiles.push(filePath);
        }
      }
      sectionLines.push(line);
    } else {
      outputLines.push(line);
    }
  }
  flushSection();
  return {
    filtered: outputLines.join("\n"),
    excludedFiles,
    remainingCount
  };
}
function applyFilter(diffPath2, excludePathsStr) {
  const prefixes = parseExcludePrefixes(excludePathsStr);
  if (prefixes.length === 0) {
    process.stderr.write("\u2139\uFE0F  No valid prefixes in exclude-paths \u2014 skipping filter\n");
    return;
  }
  process.stderr.write(`\u{1F50D} Filtering diff against ${prefixes.length} excluded prefix(es):
`);
  for (const p of prefixes) {
    process.stderr.write(`   - ${p}
`);
  }
  const diffContent = readFileSync(diffPath2, "utf-8");
  const result = filterDiff(diffContent, prefixes);
  for (const file of result.excludedFiles) {
    process.stderr.write(`\u23ED\uFE0F Excluded from review: ${file}
`);
  }
  process.stderr.write(
    `\u2705 Filtered diff: ${result.excludedFiles.length} files excluded, ${result.remainingCount} files remaining
`
  );
  if (result.remainingCount === 0) {
    if (existsSync(diffPath2)) rmSync(diffPath2);
    process.stderr.write(
      "\u2139\uFE0F  All files excluded \u2014 removed pr.diff so downstream diff steps are skipped\n"
    );
  } else {
    writeFileSync(diffPath2, result.filtered, "utf-8");
  }
}

// src/filter-diff/index.ts
var [, , diffPath, excludePathsArg] = process.argv;
if (!diffPath) {
  process.stderr.write("Usage: filter-diff <diffPath> <excludePaths>\n");
  process.exit(1);
}
try {
  applyFilter(diffPath, excludePathsArg ?? "");
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}
`);
  process.exit(1);
}
