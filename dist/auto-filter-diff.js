import { createRequire } from 'node:module'; var require = createRequire(import.meta.url);

// src/auto-filter-diff/index.ts
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";

// src/auto-filter-diff/auto-filter-diff.ts
function extractFilePath(diffGitLine) {
  const after = diffGitLine.slice("diff --git a/".length);
  const sepIdx = after.indexOf(" b/");
  return sepIdx >= 0 ? after.slice(0, sepIdx) : after;
}
function parseSections(diffContent) {
  const lines = diffContent.split("\n");
  const sections = [];
  const preamble = [];
  let startLine = -1;
  let currentPath = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      if (startLine >= 0) {
        sections.push({ path: currentPath, lines: lines.slice(startLine, i) });
      }
      currentPath = extractFilePath(line);
      startLine = i;
    } else if (startLine < 0) {
      preamble.push(line);
    }
  }
  if (startLine >= 0) {
    sections.push({ path: currentPath, lines: lines.slice(startLine) });
  }
  return { preamble, sections };
}
function assembleFiltered(preamble, sections) {
  if (sections.length === 0 && preamble.length === 0) return "";
  const allLines = [...preamble];
  for (const s of sections) {
    allLines.push(...s.lines);
  }
  return allLines.join("\n");
}
function autoFilterDiff(diffContent, riskScores, maxDiffLines2) {
  if (!diffContent) {
    return {
      filtered: "",
      autoExcludedFiles: [],
      progressivelyExcludedFiles: [],
      remainingFiles: 0,
      remainingLines: 0,
      originalLines: 0,
      allFilesKept: false
    };
  }
  const originalLines = diffContent.split("\n").length;
  const { preamble, sections } = parseSections(diffContent);
  const candidateExcluded = [];
  const afterPhase1 = sections.filter((section) => {
    if (section.path in riskScores && riskScores[section.path] === 0) {
      candidateExcluded.push(section.path);
      return false;
    }
    return true;
  });
  let allFilesKept = false;
  let autoExcludedFiles;
  let keptSections;
  if (afterPhase1.length === 0 && sections.length > 0) {
    allFilesKept = true;
    autoExcludedFiles = [];
    keptSections = sections;
  } else {
    autoExcludedFiles = candidateExcluded;
    keptSections = afterPhase1;
  }
  const progressivelyExcludedFiles = [];
  if (maxDiffLines2 > 0 && keptSections.length > 1) {
    let totalLines = keptSections.reduce((sum, s) => sum + s.lines.length, 0);
    if (totalLines > maxDiffLines2) {
      const sortedAsc = [...keptSections].sort((a, b) => {
        const sa = riskScores[a.path] !== void 0 ? riskScores[a.path] : Infinity;
        const sb = riskScores[b.path] !== void 0 ? riskScores[b.path] : Infinity;
        return sa - sb;
      });
      const removable = sortedAsc.slice(0, -1).filter((s) => riskScores[s.path] !== void 0);
      for (const section of removable) {
        if (totalLines <= maxDiffLines2) break;
        progressivelyExcludedFiles.push(section.path);
        totalLines -= section.lines.length;
        keptSections = keptSections.filter((s) => s.path !== section.path);
      }
    }
  }
  const filtered = keptSections.length === 0 ? "" : assembleFiltered(preamble, keptSections);
  const remainingLines = keptSections.reduce((sum, s) => sum + s.lines.length, 0);
  return {
    filtered,
    autoExcludedFiles,
    progressivelyExcludedFiles,
    remainingFiles: keptSections.length,
    remainingLines,
    originalLines,
    allFilesKept
  };
}

// src/auto-filter-diff/index.ts
var SCORES_PATH = "/tmp/file_risk_scores.json";
var [, , diffPath, maxDiffLinesArg] = process.argv;
if (!diffPath) {
  process.stderr.write("Usage: auto-filter-diff <diffPath> [maxDiffLines]\n");
  process.exit(1);
}
var maxDiffLines = (() => {
  const parsed = parseInt(maxDiffLinesArg ?? "3000", 10);
  return Number.isNaN(parsed) ? 3e3 : parsed;
})();
try {
  if (!existsSync(SCORES_PATH)) {
    process.stderr.write(`\u26A0\uFE0F  No risk scores found at ${SCORES_PATH} \u2014 skipping auto-filter
`);
    process.exit(0);
  }
  const diffContent = readFileSync(diffPath, "utf-8");
  const riskScores = JSON.parse(readFileSync(SCORES_PATH, "utf-8"));
  const result = autoFilterDiff(diffContent, riskScores, maxDiffLines);
  for (const path of result.autoExcludedFiles) {
    process.stderr.write(`\u23ED\uFE0F Auto-excluded (score 0): ${path}
`);
  }
  if (result.allFilesKept) {
    process.stderr.write(
      "\u2139\uFE0F  All files scored 0 \u2014 keeping all files for review (Phase 2 cap still applies)\n"
    );
  }
  for (const path of result.progressivelyExcludedFiles) {
    const score = riskScores[path] ?? "unknown";
    process.stderr.write(`\u23ED\uFE0F Progressive cap (score ${score}): ${path}
`);
  }
  const totalExcluded = result.autoExcludedFiles.length + result.progressivelyExcludedFiles.length;
  const removedLines = result.originalLines - result.remainingLines;
  process.stderr.write(
    `\u2705 Auto-filter complete: ${totalExcluded} files excluded (${removedLines} lines removed), ${result.remainingFiles} files / ${result.remainingLines} lines remaining
`
  );
  if (result.remainingFiles === 0) {
    if (existsSync(diffPath)) rmSync(diffPath);
    process.stderr.write(
      "\u2139\uFE0F  All files excluded \u2014 removed pr.diff so downstream diff steps are skipped\n"
    );
  } else {
    writeFileSync(diffPath, result.filtered, "utf-8");
  }
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}
`);
  process.exit(1);
}
