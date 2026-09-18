# mac-cleanup

Interactive scanner/cleaner for the recurring disk-space sinks on a dev Mac: repo build
artifacts (cargo/bazel), the nix store, iOS Simulator runtimes, Xcode caches, pnpm's
global store, and `~/Library/Caches`. Ships as a globally-installed `disk-cleanup`
command.

## Install (once)

```sh
git clone https://github.com/DV8FromTheWorld/mac-cleanup.git
cd mac-cleanup
npm install
pnpm link --global
```

This symlinks the `disk-cleanup` command onto your PATH via pnpm's global bin -
edits to the source here take effect immediately, no reinstall needed. If you ever
move or delete this checkout, run `pnpm uninstall --global disk-cleanup` first.

## Usage

Runs from anywhere, no `cd` required:

```sh
disk-cleanup             # scan, then pick items with a checkbox prompt, confirm, clean
disk-cleanup --dry-run   # just scan and print the full annotated report, delete nothing
```

The interactive picker already shows size + tier per line, so `--dry-run` isn't a
separate mode you need for everyday use - it exists for when you want the longer
per-item explanation text without going through the picker.

Scanning takes a while (mostly `du` over the nix store and iOS Simulator volumes), so
a progress bar tracks it. There's no way to know total bytes up front without doing the
scan itself, so instead of guessing from a past run, each collector's own live rate
this run (items done ÷ elapsed time) extrapolates its own ETA, and the bar tracks
whichever one is currently the real bottleneck - since collectors scan in parallel,
overall time is the slowest one, not the sum. It's capped at 97% until everything is
actually finished, so it never falsely claims "done" while something's still running,
and shows real done/total counts (e.g. `Nix (37552/38052)`) alongside it. The same
real-count approach applies during cleanup: deletions report actual files-removed
counts as `rm -rfv` reports them, not a prediction.

## How it decides what to pre-check

Every item is tagged with a tier:

- **safe** (pre-checked) - fully regenerable, no real downside beyond a rebuild. cargo
  `target/` dirs, bazel's output base, Xcode DerivedData/DocumentationCache, nix
  garbage collection, pnpm store prune, and a short list of known-junk app caches
  (updater leftovers, go build cache, etc).
- **caution** (unchecked) - regenerable but costs you something concrete: a real
  network re-download (Playwright/Cypress binaries, bazel's repository cache, pip/yarn
  caches), or a slow re-index (JetBrains). You have to opt in.
- **manual** (unchecked) - a script can't safely guess this one. iOS Simulator
  runtimes (which version you still need changes over time - and this tool always
  skips any runtime with a currently-booted device, never deletes an active session),
  Xcode `iOS DeviceSupport` entries (depends on whether you still use that physical
  device), and any `~/Library/Caches` subfolder we don't recognize.

## Deliberately out of scope

- **`~/Library/Application Support`** - this is mostly real app data/config (Spotify
  library, Slack, Notion, etc), not disposable cache. Not scanned at all.
- **pnpm/bazel package downloads** - never wiped wholesale. pnpm uses `pnpm store
  prune` (only removes truly unreferenced packages); bazel's repository cache is
  reported but never pre-selected.
- **Individual repos** (old worktrees, stale clones, uncommitted work) - these need a
  human to check `git status`/`git log` first. This tool only touches build
  artifacts, never source or history.

## Adding a new check

Add a collector function in `src/collectors.js` - `async function collectXyz(progress)`
- that returns an array of items shaped like:

```js
{
  id: "unique-id",
  category: "Some Category",
  label: "Human readable line shown in the picker",
  detail: "Optional longer explanation shown under the line",
  tier: TIER_SAFE | TIER_CAUTION | TIER_MANUAL,
  defaultSelected: true | false,
  sizeBytes: 12345,
  clean: async (onProgress) => { /* do the deletion; call onProgress(count, unit) as real work happens */ },
}
```

then add `{ name: "Some Category", collect: collectXyz }` to the `COLLECTORS` array at
the bottom of the file. If your check has multiple measurable sub-items (several
directories, several devices, etc), call `progress?.registerTotal(name, count)` once
you know how many, then `progress?.increment(name)` as each one is actually measured
(see `measureDirectories` in `util.js`) and `progress?.finish(name)` when done - that's
what lets the overall bar reflect real progress instead of guessing.
