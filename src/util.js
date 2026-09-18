import { exec as execCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execAsync = promisify(execCallback);

export const homeDirectory = os.homedir();

export function expandHome(inputPath) {
  return inputPath.startsWith("~") ? path.join(homeDirectory, inputPath.slice(1)) : inputPath;
}

// Runs a shell command and returns trimmed stdout, or null if there's truly nothing
// usable. Use this for quick one-shot commands where you only care about the final
// result. For anything that takes more than ~1s, prefer spawnLines below instead -
// exec buffers everything and gives you nothing until the process fully exits, so it
// can't power a live status. Failures are expected here (missing tool, missing path,
// etc.) so we swallow them rather than throwing - callers treat null as "couldn't
// measure / nothing to do". Commands like `du` can exit non-zero (e.g.
// permission-denied on a subdirectory) while still printing a correct total on
// stdout, so a rejected exec's partial stdout is used too rather than discarded.
export async function run(command, options = {}) {
  try {
    const { stdout } = await execAsync(command, {
      maxBuffer: 1024 * 1024 * 256,
      ...options,
    });
    return stdout.trim();
  } catch (error) {
    const partialStdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    return partialStdout || null;
  }
}

// Runs a command and calls onLine(line, lineNumber) the instant each line of stdout
// is produced - this is what makes real (not predicted) progress possible: `du`
// prints a line per path the moment it finishes that path, `rm -rfv` prints a line
// per file/dir the instant it's removed. Resolves once the process exits, regardless
// of exit code (same reasoning as `run`: a non-zero exit from permission-denied
// subdirectories doesn't mean the lines we already saw are wrong).
export function spawnLines(command, args, { onLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let lineCount = 0;
    rl.on("line", (line) => {
      lineCount += 1;
      onLine?.(line, lineCount);
    });
    child.on("close", (exitCode) => resolve({ exitCode, lineCount }));
    child.on("error", () => resolve({ exitCode: -1, lineCount }));
  });
}

function parseDuLine(line) {
  const tabIndex = line.indexOf("\t");
  if (tabIndex === -1) return null;
  const kilobytes = parseInt(line.slice(0, tabIndex), 10);
  if (!Number.isFinite(kilobytes)) return null;
  return { sizeBytes: kilobytes * 1024, entryPath: line.slice(tabIndex + 1) };
}

export async function directorySizeBytes(targetPath) {
  if (!fs.existsSync(targetPath)) return 0;
  let sizeBytes = 0;
  await spawnLines("du", ["-sk", "--", targetPath], {
    onLine: (line) => {
      const parsed = parseDuLine(line);
      if (parsed) sizeBytes = parsed.sizeBytes;
    },
  });
  return sizeBytes;
}

async function measureDirectoriesBatch(dirPaths) {
  const results = new Map();
  await spawnLines("du", ["-sk", "--", ...dirPaths], {
    onLine: (line) => {
      const parsed = parseDuLine(line);
      if (parsed) results.set(parsed.entryPath, parsed.sizeBytes);
    },
  });
  return results;
}

// A C program's stdout is fully block-buffered (not line-buffered) once it's piped
// rather than attached to a real terminal - true of `du` here no matter how many
// paths you give it. A handful of SLOW paths (e.g. 7 iOS Simulator runtime volumes,
// each 15-20s to mount and measure) is the worst case: the combined output is only a
// few hundred bytes, nowhere near enough to trigger a mid-run flush, so nothing
// appears until the very end regardless of how long that takes - not "coarse"
// progress, no progress at all for the entire duration. And thousands of cheap paths
// (the nix store's ~38k top-level entries) hits the same wall from the other
// direction - one process, one flush, right before exit.
//
// The actual fix is one process per path so each one's own exit is its own real,
// separately-timed checkpoint (spawn overhead is a few ms, irrelevant next to
// multi-second `du` work) - except when there are SO many paths that per-process
// overhead would itself dominate, at which point paths are grouped into batches
// purely to bound that overhead, accepting coarser (but still real, still
// concurrent) per-batch checkpoints instead.
const MANY_PATHS_THRESHOLD = 300;
const LARGE_BATCH_SIZE = 500;
const CONCURRENCY = 8;

// Measures every path, reporting each result the instant it's known - onEach(path,
// sizeBytes, doneCount, totalCount) fires with real completed work, not a guess.
// Paths du couldn't produce a line for at all (e.g. permission denied at the top)
// come back as 0 rather than being silently missing.
export async function measureDirectories(dirPaths, onEach) {
  const existingPaths = [...new Set(dirPaths)].filter((p) => fs.existsSync(p));
  const results = new Map();
  if (existingPaths.length === 0) return results;

  const batchSize = existingPaths.length > MANY_PATHS_THRESHOLD ? LARGE_BATCH_SIZE : 1;
  const batches = [];
  for (let i = 0; i < existingPaths.length; i += batchSize) batches.push(existingPaths.slice(i, i + batchSize));

  let nextBatchIndex = 0;
  const runWorker = async () => {
    while (nextBatchIndex < batches.length) {
      const batch = batches[nextBatchIndex++];
      const batchResults = await measureDirectoriesBatch(batch);
      for (const [entryPath, sizeBytes] of batchResults) {
        results.set(entryPath, sizeBytes);
        onEach?.(entryPath, sizeBytes, results.size, existingPaths.length);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, runWorker));

  for (const p of existingPaths) {
    if (!results.has(p)) {
      results.set(p, 0);
      onEach?.(p, 0, results.size, existingPaths.length);
    }
  }
  return results;
}

export function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function listSubdirectories(parentDirectory) {
  if (!fs.existsSync(parentDirectory)) return [];
  return fs
    .readdirSync(parentDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parentDirectory, entry.name));
}

function assertSafeToRemove(targetPath) {
  if (!targetPath || targetPath === "/" || targetPath === homeDirectory) {
    throw new Error(`Refusing to remove suspicious path: ${targetPath}`);
  }
}

export async function removePath(targetPath) {
  assertSafeToRemove(targetPath);
  await run(`rm -rf -- ${JSON.stringify(targetPath)}`);
}

// Deletes with `rm -rfv`, calling onFileRemoved(lineCount) as each file/dir entry is
// actually removed - real, live evidence of progress for large deletions (a cargo
// target/ dir or the nix store GC can be hundreds of thousands of files) instead of a
// silent multi-minute pause.
export async function removePathsVerbose(dirPaths, onFileRemoved) {
  const targets = dirPaths.filter(Boolean);
  targets.forEach(assertSafeToRemove);
  if (targets.length === 0) return;
  await spawnLines("rm", ["-rfv", "--", ...targets], {
    onLine: (_line, lineCount) => onFileRemoved?.(lineCount),
  });
}
