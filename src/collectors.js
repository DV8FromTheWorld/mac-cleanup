import fs from "node:fs";
import path from "node:path";
import {
  homeDirectory,
  run,
  spawnLines,
  measureDirectories,
  listSubdirectories,
  removePathsVerbose,
} from "./util.js";

const REPOS_ROOT = path.join(homeDirectory, "repos");

// Tiers describe how comfortable we are auto-selecting an item in the interactive picker.
// "safe"    - fully regenerable, no meaningful downside, pre-checked by default.
// "caution" - regenerable but costs you something (rebuild time, re-download, re-index), unchecked by default.
// "manual"  - depends on judgment calls a script can't make safely (which repo/device/runtime you still need), unchecked by default.
const TIER_SAFE = "safe";
const TIER_CAUTION = "caution";
const TIER_MANUAL = "manual";

// clean() takes an optional onProgress(count, unit) callback so the UI can show real
// removal progress (files deleted, lines of GC output, etc) instead of a silent pause.
async function removeWithProgress(dirPaths) {
  return async (onProgress) => {
    await removePathsVerbose(dirPaths, (lineCount) => onProgress?.(lineCount, "files removed"));
  };
}

async function runCommandWithProgress(command, args) {
  return async (onProgress) => {
    await spawnLines(command, args, { onLine: (_line, lineCount) => onProgress?.(lineCount, "lines") });
  };
}

// ---------------------------------------------------------------------------
// Rust / Cargo build output
// ---------------------------------------------------------------------------
async function collectCargoTargets(progress) {
  if (!fs.existsSync(REPOS_ROOT)) return [];

  // -prune after matching "target" too - otherwise find keeps walking INTO every
  // target/ dir it finds (hundreds of thousands of files for a 49G build tree) just
  // to look for more matches inside it, which is pure wasted work.
  const findOutput = await run(
    `find ${JSON.stringify(REPOS_ROOT)} \\( -name node_modules -o -name .git -o -name bazel-out -o -name bazel-* \\) -prune -o -type d -name target -prune -print 2>/dev/null`
  );
  if (!findOutput) return [];

  const candidateDirs = findOutput.split("\n").filter(Boolean);
  const confirmedDirs = candidateDirs.filter((targetDir) => {
    const parentDir = path.dirname(targetDir);
    return fs.existsSync(path.join(parentDir, "Cargo.toml")) || fs.existsSync(path.join(parentDir, "Cargo.lock"));
  });
  if (confirmedDirs.length === 0) return [];

  progress?.registerTotal("Rust (cargo)", confirmedDirs.length);
  const sizes = await measureDirectories(confirmedDirs, () => progress?.increment("Rust (cargo)"));
  progress?.finish("Rust (cargo)");

  const totalSizeBytes = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (totalSizeBytes === 0) return [];

  return [
    {
      id: "cargo-targets",
      category: "Rust (cargo)",
      label: `${confirmedDirs.length} cargo target/ dir(s) under ~/repos`,
      detail: confirmedDirs.map((d) => d.replace(homeDirectory, "~")).join("\n    "),
      tier: TIER_SAFE,
      defaultSelected: true,
      sizeBytes: totalSizeBytes,
      clean: await removeWithProgress(confirmedDirs),
    },
  ];
}

// ---------------------------------------------------------------------------
// Bazel: output_base (regenerable build outputs) vs repository_cache (downloaded deps)
// ---------------------------------------------------------------------------
async function findBazelRepoDirs() {
  if (!fs.existsSync(REPOS_ROOT)) return [];
  return listSubdirectories(REPOS_ROOT).filter(
    (repoDir) =>
      fs.existsSync(path.join(repoDir, "WORKSPACE")) ||
      fs.existsSync(path.join(repoDir, "MODULE.bazel")) ||
      fs.existsSync(path.join(repoDir, ".bazelrc"))
  );
}

function resolveBazelOutputBase(repoDir) {
  const bazelOutLink = path.join(repoDir, "bazel-out");
  if (!fs.existsSync(bazelOutLink)) return null;
  try {
    const realPath = fs.realpathSync(bazelOutLink);
    const executionRootMarker = `${path.sep}execroot${path.sep}`;
    const markerIndex = realPath.indexOf(executionRootMarker);
    if (markerIndex === -1) return null;
    return realPath.slice(0, markerIndex);
  } catch {
    return null;
  }
}

async function collectBazelBuildOutputs(progress) {
  const candidates = [];
  for (const repoDir of await findBazelRepoDirs()) {
    const outputBase = resolveBazelOutputBase(repoDir);
    if (outputBase && fs.existsSync(outputBase)) candidates.push({ repoDir, outputBase });
  }
  if (candidates.length === 0) return [];

  progress?.registerTotal("Bazel build outputs", candidates.length);
  const sizes = await measureDirectories(
    candidates.map((c) => c.outputBase),
    () => progress?.increment("Bazel build outputs")
  );
  progress?.finish("Bazel build outputs");

  const items = [];
  for (const { repoDir, outputBase } of candidates) {
    const sizeBytes = sizes.get(outputBase) ?? 0;
    if (sizeBytes === 0) continue;

    const repoName = path.basename(repoDir);
    const convenienceSymlinks = ["bazel-out", "bazel-bin", "bazel-testlogs", `bazel-${repoName}`].map((name) =>
      path.join(repoDir, name)
    );

    items.push({
      id: `bazel-output-${repoName}`,
      category: "Bazel",
      label: `${repoName}: bazel output base (build outputs, not repository cache)`,
      detail: outputBase,
      tier: TIER_SAFE,
      defaultSelected: true,
      sizeBytes,
      clean: await removeWithProgress([outputBase, ...convenienceSymlinks]),
    });
  }
  return items;
}

// Bazel's repository_cache holds downloaded external deps - same category as the pnpm
// store: don't blindly wipe it, just surface the size so it's a deliberate choice.
async function collectBazelRepositoryCache(progress) {
  const seenPaths = new Set();
  for (const repoDir of await findBazelRepoDirs()) {
    const bazelrcPath = path.join(repoDir, ".bazelrc");
    if (!fs.existsSync(bazelrcPath)) continue;
    const bazelrcContents = fs.readFileSync(bazelrcPath, "utf8");
    const match = bazelrcContents.match(/--repository_cache=(\S+)/);
    if (!match) continue;
    const cachePath = match[1].replace(/^~/, homeDirectory).replace(/\/$/, "");
    if (fs.existsSync(cachePath)) seenPaths.add(cachePath);
  }
  if (seenPaths.size === 0) return [];

  const cachePaths = [...seenPaths];
  progress?.registerTotal("Bazel repository cache", cachePaths.length);
  const sizes = await measureDirectories(cachePaths, () => progress?.increment("Bazel repository cache"));
  progress?.finish("Bazel repository cache");

  const items = [];
  for (const cachePath of cachePaths) {
    const sizeBytes = sizes.get(cachePath) ?? 0;
    if (sizeBytes === 0) continue;

    items.push({
      id: `bazel-repo-cache-${cachePath}`,
      category: "Bazel",
      label: `Bazel repository cache (downloaded external deps) - ${cachePath.replace(homeDirectory, "~")}`,
      detail:
        "Deleting forces re-downloading every external dependency on the next build. Same category as the pnpm store - only clear if you're trying to reclaim space, not as routine maintenance.",
      tier: TIER_CAUTION,
      defaultSelected: false,
      sizeBytes,
      clean: await removeWithProgress([cachePath]),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// pnpm global store - prune only, never a blind wipe (that's a full re-download).
// ---------------------------------------------------------------------------
async function collectPnpmStorePrune(progress) {
  const storePathOutput = await run("pnpm store path 2>/dev/null");
  const storePath = storePathOutput || path.join(homeDirectory, "Library", "pnpm", "store");
  if (!fs.existsSync(storePath)) return [];

  progress?.registerTotal("pnpm store", 1);
  const sizes = await measureDirectories([storePath], () => progress?.increment("pnpm store"));
  progress?.finish("pnpm store");

  const sizeBytes = sizes.get(storePath) ?? 0;
  if (sizeBytes === 0) return [];

  return [
    {
      id: "pnpm-store-prune",
      category: "pnpm",
      label: `pnpm store prune (global content-addressable store is ${path.dirname(storePath).replace(homeDirectory, "~")})`,
      detail:
        "Runs `pnpm store prune`, which only removes packages no longer referenced by any project on disk - never touches packages you're still using. The size shown is the whole store, not the reclaimable amount.",
      tier: TIER_SAFE,
      defaultSelected: true,
      sizeBytes,
      isEstimateOnly: true,
      clean: await runCommandWithProgress("pnpm", ["store", "prune"]),
    },
  ];
}

// ---------------------------------------------------------------------------
// Nix garbage collection - old generations + now-unreferenced store paths.
// ---------------------------------------------------------------------------
async function collectNixGarbageCollection(progress) {
  const nixStorePath = "/nix/store";
  if (!fs.existsSync(nixStorePath)) return [];

  // Measured as individual top-level store entries (tens of thousands of them) rather
  // than one opaque whole-store `du`, so the picker's overall bar can show real
  // completed-entry progress through what's usually the single slowest scan - see the
  // batching note on measureDirectories for why that matters at this scale.
  const entryPaths = fs.readdirSync(nixStorePath).map((name) => path.join(nixStorePath, name));
  if (entryPaths.length === 0) return [];
  progress?.registerTotal("Nix", entryPaths.length);
  const sizes = await measureDirectories(entryPaths, () => progress?.increment("Nix"));
  progress?.finish("Nix");
  const sizeBytes = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (sizeBytes === 0) return [];

  const generationsOutput = await run("nix-env --list-generations 2>/dev/null");
  const generationCount = generationsOutput ? generationsOutput.split("\n").filter(Boolean).length : null;

  return [
    {
      id: "nix-gc",
      category: "Nix",
      label: `Nix garbage collection (/nix/store${
        generationCount ? `, ${generationCount} profile generations kept` : ""
      })`,
      detail:
        "Runs `nix-collect-garbage -d`, which deletes old profile generations and any store paths no longer reachable from your current generation. Never touches what your current environment needs.",
      tier: TIER_SAFE,
      defaultSelected: true,
      sizeBytes,
      isEstimateOnly: true,
      clean: await runCommandWithProgress("nix-collect-garbage", ["-d"]),
    },
  ];
}

// ---------------------------------------------------------------------------
// Xcode: DerivedData + DocumentationCache are pure compiled/local output, no re-download.
// ---------------------------------------------------------------------------
async function collectXcodeBuildCaches(progress) {
  const xcodeDir = path.join(homeDirectory, "Library", "Developer", "Xcode");
  const targets = [path.join(xcodeDir, "DerivedData"), path.join(xcodeDir, "DocumentationCache")].filter((p) =>
    fs.existsSync(p)
  );
  if (targets.length === 0) return [];

  progress?.registerTotal("Xcode build caches", targets.length);
  const sizes = await measureDirectories(targets, () => progress?.increment("Xcode build caches"));
  progress?.finish("Xcode build caches");

  const totalSizeBytes = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (totalSizeBytes === 0) return [];

  return [
    {
      id: "xcode-build-caches",
      category: "Xcode",
      label: "Xcode DerivedData + DocumentationCache",
      detail:
        "Purely local compiled output - deleting costs you a full rebuild (and Xcode re-indexing) but zero network download.",
      tier: TIER_SAFE,
      defaultSelected: true,
      sizeBytes: totalSizeBytes,
      clean: await removeWithProgress(targets),
    },
  ];
}

// iOS DeviceSupport - per physical-device-per-OS-version symbol caches. Whether one is
// "still needed" depends on whether you still own/use that device, so this stays manual.
async function collectXcodeDeviceSupport(progress) {
  const deviceSupportDir = path.join(homeDirectory, "Library", "Developer", "Xcode", "iOS DeviceSupport");
  const versionDirs = listSubdirectories(deviceSupportDir);
  if (versionDirs.length === 0) return [];

  progress?.registerTotal("Xcode DeviceSupport", versionDirs.length);
  const sizes = await measureDirectories(versionDirs, () => progress?.increment("Xcode DeviceSupport"));
  progress?.finish("Xcode DeviceSupport");

  const items = [];
  for (const versionDir of versionDirs) {
    const sizeBytes = sizes.get(versionDir) ?? 0;
    if (sizeBytes === 0) continue;
    const mtime = fs.statSync(versionDir).mtime.toISOString().slice(0, 10);

    items.push({
      id: `device-support-${path.basename(versionDir)}`,
      category: "Xcode",
      label: `iOS DeviceSupport: ${path.basename(versionDir)} (last touched ${mtime})`,
      detail:
        "Only regenerates (small, fast) if you reconnect that exact physical device on that exact OS version. Safe to remove if you no longer use that device/OS combo.",
      tier: TIER_MANUAL,
      defaultSelected: false,
      sizeBytes,
      clean: await removeWithProgress([versionDir]),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// iOS Simulator runtimes - always manual, since "which version to keep" changes over time
// and we never touch a runtime with a currently booted device.
// ---------------------------------------------------------------------------
async function collectSimulatorRuntimes(progress) {
  const runtimesJson = await run("xcrun simctl list runtimes --json 2>/dev/null");
  const devicesJson = await run("xcrun simctl list devices --json 2>/dev/null");
  if (!runtimesJson || !devicesJson) return [];

  let runtimes;
  let devicesByRuntime;
  try {
    runtimes = JSON.parse(runtimesJson).runtimes || [];
    devicesByRuntime = JSON.parse(devicesJson).devices || {};
  } catch {
    return [];
  }

  const candidates = [];
  for (const runtime of runtimes) {
    const devicesForRuntime = devicesByRuntime[runtime.identifier] || [];
    const hasBootedDevice = devicesForRuntime.some((device) => device.state === "Booted");
    if (hasBootedDevice) continue; // never touch a runtime that's actively in use
    if (!runtime.runtimeRoot || !fs.existsSync(runtime.runtimeRoot)) continue;
    candidates.push({ runtime, deviceUdids: devicesForRuntime.map((device) => device.udid) });
  }
  if (candidates.length === 0) return [];

  progress?.registerTotal("iOS Simulator runtimes", candidates.length);
  const sizes = await measureDirectories(
    candidates.map((c) => c.runtime.runtimeRoot),
    () => progress?.increment("iOS Simulator runtimes")
  );
  progress?.finish("iOS Simulator runtimes");

  const items = [];
  for (const { runtime, deviceUdids } of candidates) {
    const sizeBytes = sizes.get(runtime.runtimeRoot) ?? 0;
    if (sizeBytes === 0) continue;

    items.push({
      id: `simulator-runtime-${runtime.identifier}`,
      category: "iOS Simulator",
      label: `${runtime.name} runtime (build ${runtime.buildversion}, ${deviceUdids.length} device(s), all shutdown)`,
      detail: runtime.runtimeRoot,
      tier: TIER_MANUAL,
      defaultSelected: false,
      sizeBytes,
      clean: async (onProgress) => {
        for (const udid of deviceUdids) await run(`xcrun simctl delete ${udid}`);
        onProgress?.(deviceUdids.length, "devices removed");
        await run(`xcrun simctl runtime delete ${JSON.stringify(runtime.identifier)}`);
      },
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// ~/Library/Caches - dynamically discovered, with a lookup table encoding what we know
// about common dev-tool caches. Unknown caches default to manual/unselected.
// ---------------------------------------------------------------------------
const KNOWN_CACHE_NOTES = {
  "com.microsoft.VSCode.ShipIt": {
    tier: TIER_SAFE,
    note: "Leftover Sparkle/ShipIt updater packages. Pure junk.",
  },
  "com.hnc.DiscordCanary.ShipIt": { tier: TIER_SAFE, note: "Leftover updater packages. Pure junk." },
  "com.todesktop.230313mzl4w4u92.ShipIt": { tier: TIER_SAFE, note: "Leftover updater packages. Pure junk." },
  "go-build": { tier: TIER_SAFE, note: "Go build cache, regenerates automatically (like cargo target/)." },
  electron: { tier: TIER_SAFE, note: "Electron binary cache used by build tooling, regenerates on demand." },
  "com.googlecode.iterm2": { tier: TIER_SAFE, note: "iTerm2 UI cache, regenerates automatically." },
  Homebrew: {
    tier: TIER_SAFE,
    note: "Use `brew cleanup -s` instead of deleting the folder directly - it's the real GC.",
    customClean: async (cacheDir) => await runCommandWithProgress("brew", ["cleanup", "-s"]),
  },
  CocoaPods: {
    tier: TIER_CAUTION,
    note: "Prefer `pod cache clean --all` if you use CocoaPods regularly - re-fetches specs/pods on next `pod install`.",
  },
  JetBrains: {
    tier: TIER_CAUTION,
    note: "IDE indices - safe to delete, but the next project open will re-index (can take a while).",
  },
  Google: { tier: TIER_CAUTION, note: "Usually Chrome/gcloud cache - regenerates, but re-warms slowly." },
  "vscode-cpptools": { tier: TIER_CAUTION, note: "C/C++ IntelliSense cache - re-parses headers on next use." },
  "ms-playwright": { tier: TIER_CAUTION, note: "Playwright browser binaries - deleting forces a real re-download." },
  pip: { tier: TIER_CAUTION, note: "pip's wheel cache - re-downloads on next install." },
  Cypress: { tier: TIER_CAUTION, note: "Cypress binary cache - deleting forces a real re-download." },
  bazelisk: { tier: TIER_CAUTION, note: "Cached Bazel version binaries - re-downloads the pinned version." },
  dotslash: { tier: TIER_CAUTION, note: "DotSlash-fetched binaries - re-fetches on demand, usually small/fast." },
  Yarn: { tier: TIER_CAUTION, note: "Yarn package cache - re-downloads packages on next install." },
  "com.spotify.client": { tier: TIER_CAUTION, note: "Spotify's offline/stream cache - re-downloads as you play." },
  Firefox: { tier: TIER_CAUTION, note: "Browser cache, regenerates as you browse." },
};

const MINIMUM_CACHE_SIZE_BYTES = 25 * 1024 * 1024; // ignore noise under 25MB

async function collectLibraryCaches(progress) {
  const cachesDir = path.join(homeDirectory, "Library", "Caches");
  const cacheDirs = listSubdirectories(cachesDir);
  if (cacheDirs.length === 0) return [];

  progress?.registerTotal("Library Caches", cacheDirs.length);
  const sizes = await measureDirectories(cacheDirs, () => progress?.increment("Library Caches"));
  progress?.finish("Library Caches");

  const items = [];
  for (const cacheDir of cacheDirs) {
    const sizeBytes = sizes.get(cacheDir) ?? 0;
    if (sizeBytes < MINIMUM_CACHE_SIZE_BYTES) continue;

    const name = path.basename(cacheDir);
    const known = KNOWN_CACHE_NOTES[name];
    const tier = known?.tier ?? TIER_MANUAL;
    const note = known?.note ?? "Unrecognized cache - check what it is before clearing.";

    items.push({
      id: `library-cache-${name}`,
      category: "Library Caches",
      label: `${name} (~/Library/Caches/${name})`,
      detail: note,
      tier,
      defaultSelected: tier === TIER_SAFE,
      sizeBytes,
      clean: known?.customClean ? await known.customClean(cacheDir) : await removeWithProgress([cacheDir]),
    });
  }
  return items;
}

// Named so progress reporting can label "currently scanning: Nix, iOS Simulator..."
const COLLECTORS = [
  { name: "Rust (cargo)", collect: collectCargoTargets },
  { name: "Bazel build outputs", collect: collectBazelBuildOutputs },
  { name: "Bazel repository cache", collect: collectBazelRepositoryCache },
  { name: "pnpm store", collect: collectPnpmStorePrune },
  { name: "Nix", collect: collectNixGarbageCollection },
  { name: "Xcode build caches", collect: collectXcodeBuildCaches },
  { name: "Xcode DeviceSupport", collect: collectXcodeDeviceSupport },
  { name: "iOS Simulator runtimes", collect: collectSimulatorRuntimes },
  { name: "Library Caches", collect: collectLibraryCaches },
];

export async function collectAllItems(progress) {
  const results = await Promise.all(COLLECTORS.map(({ collect }) => collect(progress)));
  return results.flat();
}

export { TIER_SAFE, TIER_CAUTION, TIER_MANUAL };
