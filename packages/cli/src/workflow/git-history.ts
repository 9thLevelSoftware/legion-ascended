import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DEFAULT_MAX_COMMITS = 1_000;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface GitHistoryAnalysis {
  readonly hotspots: readonly GitHotspot[];
  readonly ownership: readonly GitOwnership[];
  readonly busFactor: readonly GitBusFactor[];
  readonly coChangePairs: readonly GitCoChange[];
}

export interface GitHotspot {
  readonly path: string;
  readonly changeCount: number;
  readonly lastChanged: string;
}

export interface GitOwnership {
  readonly path: string;
  readonly lastAuthor: string;
  readonly lastChanged: string;
}

export interface GitBusFactor {
  readonly directory: string;
  readonly contributorCount: number;
  readonly topContributors: readonly string[];
}

export interface GitCoChange {
  readonly pathA: string;
  readonly pathB: string;
  readonly coChangeCount: number;
}

interface Commit {
  readonly author: string;
  readonly date: string;
  readonly paths: readonly string[];
}

interface FileStats {
  changeCount: number;
  lastAuthor: string;
  lastChanged: string;
}

interface DirectoryStats {
  readonly contributors: Map<string, number>;
}

const COMMIT_HEADER = /^[0-9a-f]{7,64}\|([^|]*)\|(.+)$/u;

/**
 * Analyze the bounded git history for a set of repository-relative files.
 *
 * Git emits commits newest-first, so the first change observed for a file is
 * its latest change and ownership is derived from that same event. Each commit
 * contributes at most one change to a file and one co-change event to a pair.
 */
export async function analyzeGitHistory(input: {
  readonly repositoryRoot: string;
  readonly files: readonly string[];
  readonly maxCommits?: number;
}): Promise<GitHistoryAnalysis> {
  const maxCommits = resolveMaxCommits(input.maxCommits);
  const analyzedFiles = new Set(input.files.map((filePath) => normalizeRepositoryPath(input.repositoryRoot, filePath)));
  if (analyzedFiles.size === 0 || maxCommits === 0) return emptyAnalysis();

  const { stdout } = await execFile("git", [
    "-C",
    input.repositoryRoot,
    "log",
    `--max-count=${maxCommits}`,
    "--format=%H|%ae|%aI",
    "--name-only",
    "--"
  ], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES
  });

  const fileStats = new Map<string, FileStats>();
  const directoryStats = new Map<string, DirectoryStats>();
  const coChangeCounts = new Map<string, number>();

  for (const commit of parseCommits(stdout)) {
    const changedFiles = [...new Set(commit.paths
      .map((filePath) => normalizeGitPath(filePath))
      .filter((filePath) => analyzedFiles.has(filePath)))]
      .sort((left, right) => left.localeCompare(right));

    for (const filePath of changedFiles) {
      const stats = fileStats.get(filePath);
      if (stats === undefined) {
        fileStats.set(filePath, {
          changeCount: 1,
          lastAuthor: commit.author,
          lastChanged: commit.date
        });
      } else {
        stats.changeCount += 1;
      }

      const directory = topLevelDirectory(filePath);
      let directoryStatsForPath = directoryStats.get(directory);
      if (directoryStatsForPath === undefined) {
        directoryStatsForPath = { contributors: new Map() };
        directoryStats.set(directory, directoryStatsForPath);
      }
      directoryStatsForPath.contributors.set(
        commit.author,
        (directoryStatsForPath.contributors.get(commit.author) ?? 0) + 1
      );
    }

    for (let firstIndex = 0; firstIndex < changedFiles.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < changedFiles.length; secondIndex += 1) {
        const pairKey = `${changedFiles[firstIndex]}\u0000${changedFiles[secondIndex]}`;
        coChangeCounts.set(pairKey, (coChangeCounts.get(pairKey) ?? 0) + 1);
      }
    }
  }

  const hotspots = [...fileStats.entries()]
    .sort(([leftPath, left], [rightPath, right]) =>
      right.changeCount - left.changeCount || leftPath.localeCompare(rightPath)
    )
    .map(([filePath, stats]) => ({
      path: filePath,
      changeCount: stats.changeCount,
      lastChanged: stats.lastChanged
    }));

  const ownership = [...fileStats.entries()]
    .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
    .map(([filePath, stats]) => ({
      path: filePath,
      lastAuthor: stats.lastAuthor,
      lastChanged: stats.lastChanged
    }));

  const busFactor = [...directoryStats.entries()]
    .sort(([leftDirectory], [rightDirectory]) => leftDirectory.localeCompare(rightDirectory))
    .map(([directory, stats]) => {
      const topContributors = [...stats.contributors.entries()]
        .sort(([leftAuthor, leftCount], [rightAuthor, rightCount]) =>
          rightCount - leftCount || leftAuthor.localeCompare(rightAuthor)
        )
        .map(([author]) => author);
      return {
        directory,
        contributorCount: topContributors.length,
        topContributors
      };
    });

  const coChangePairs = [...coChangeCounts.entries()]
    .map(([pairKey, coChangeCount]) => {
      const separatorIndex = pairKey.indexOf("\u0000");
      return {
        pathA: pairKey.slice(0, separatorIndex),
        pathB: pairKey.slice(separatorIndex + 1),
        coChangeCount
      };
    })
    .sort((left, right) =>
      right.coChangeCount - left.coChangeCount
      || left.pathA.localeCompare(right.pathA)
      || left.pathB.localeCompare(right.pathB)
    );

  return { hotspots, ownership, busFactor, coChangePairs };
}

function resolveMaxCommits(value: number | undefined): number {
  const maxCommits = value ?? DEFAULT_MAX_COMMITS;
  if (!Number.isSafeInteger(maxCommits) || maxCommits < 0) {
    throw new RangeError("maxCommits must be a non-negative safe integer");
  }
  return maxCommits;
}

function normalizeRepositoryPath(repositoryRoot: string, filePath: string): string {
  const absolutePath = path.isAbsolute(filePath) ? filePath : undefined;
  const repositoryRelativePath = absolutePath === undefined
    ? filePath
    : path.relative(repositoryRoot, absolutePath);
  return normalizeGitPath(repositoryRelativePath);
}

function normalizeGitPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function topLevelDirectory(filePath: string): string {
  const separatorIndex = filePath.indexOf("/");
  return separatorIndex === -1 ? "." : filePath.slice(0, separatorIndex);
}

function parseCommits(output: string): readonly Commit[] {
  const commits: Commit[] = [];
  let current: { author: string; date: string; paths: string[] } | undefined;

  const finishCurrent = (): void => {
    if (current === undefined) return;
    commits.push({
      author: current.author,
      date: current.date,
      paths: current.paths
    });
  };

  for (const line of output.split(/\r?\n/u)) {
    const header = line.match(COMMIT_HEADER);
    if (header !== null) {
      finishCurrent();
      current = {
        author: header[1] ?? "",
        date: header[2] ?? "",
        paths: []
      };
    } else if (current !== undefined && line.length > 0) {
      current.paths.push(line);
    }
  }
  finishCurrent();

  return commits;
}

function emptyAnalysis(): GitHistoryAnalysis {
  return {
    hotspots: [],
    ownership: [],
    busFactor: [],
    coChangePairs: []
  };
}
