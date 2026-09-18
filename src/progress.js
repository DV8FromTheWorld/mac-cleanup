import chalk from "chalk";

const BAR_WIDTH = 28;

function clearLine() {
  process.stdout.write(`\r${" ".repeat(process.stdout.columns || 100)}\r`);
}

function renderBar(fraction) {
  const filled = Math.round(BAR_WIDTH * Math.min(Math.max(fraction, 0), 1));
  return chalk.cyan("█".repeat(filled)) + chalk.dim("░".repeat(BAR_WIDTH - filled));
}

// Tracks real completed work across collectors running in parallel, then predicts the
// overall finish time from each collector's OWN observed rate in this run (elapsed /
// fractionDone, extrapolated) - not a guess from a past run, and not a naive item
// count either. Item count alone is the wrong unit: the nix store has ~38,000 cheap
// entries (~ms each) while an iOS Simulator runtime is one of only ~8 expensive
// entries (~15-20s each, mounted on its own volume) - equal-weighting those would let
// 38,000 trivial increments hide the one thing that's actually the long pole. Since
// collectors run concurrently (Promise.all), overall wall time is the MAX across
// them, not the sum, so the bar tracks whichever collector's own live-extrapolated
// ETA is currently largest - the genuine bottleneck, and it can change hands as the
// run progresses and better data comes in.
export class ScanTracker {
  constructor() {
    this.collectors = new Map();
    this.startedAt = Date.now();
    this.intervalHandle = null;
  }

  registerTotal(name, total) {
    this.collectors.set(name, { done: 0, total: Math.max(total, 1), startedAt: Date.now(), finishedAt: null });
  }

  increment(name, amount = 1) {
    const entry = this.collectors.get(name);
    if (entry) entry.done = Math.min(entry.done + amount, entry.total);
  }

  finish(name) {
    const entry = this.collectors.get(name);
    if (entry) {
      entry.done = entry.total;
      entry.finishedAt = Date.now();
    }
  }

  summary() {
    const now = Date.now();
    let bottleneckEstimatedTotalMs = 0;
    const activeDescriptions = [];
    for (const [name, entry] of this.collectors) {
      const elapsedMs = (entry.finishedAt ?? now) - entry.startedAt;
      const fractionDone = entry.done / entry.total;
      // Before a collector has completed even one unit there's no rate to extrapolate
      // from yet - treat its ETA as "at least what's elapsed so far" rather than
      // fabricating a number from nothing. With only a handful of highly variable-cost
      // items (e.g. 7-8 iOS Simulator runtime volumes, each 15-20s to mount+measure)
      // this extrapolation can still undershoot if early items happened to be cheaper
      // than later ones - real per-collector done/total counts are shown alongside it
      // so that's visible rather than hidden behind a single number.
      const estimatedTotalMs = fractionDone > 0 ? elapsedMs / fractionDone : elapsedMs;
      bottleneckEstimatedTotalMs = Math.max(bottleneckEstimatedTotalMs, estimatedTotalMs);
      if (!entry.finishedAt) activeDescriptions.push(`${name} (${entry.done}/${entry.total})`);
    }
    const overallElapsedMs = now - this.startedAt;
    const rawFraction = bottleneckEstimatedTotalMs > 0 ? overallElapsedMs / bottleneckEstimatedTotalMs : 0;
    // Never show 100% while anything is still genuinely running - an extrapolated
    // estimate can undershoot, but "done" should only ever mean actually done.
    const fraction = activeDescriptions.length > 0 ? Math.min(rawFraction, 0.97) : 1;
    return { fraction, activeDescriptions };
  }

  start() {
    this.intervalHandle = setInterval(() => this.render(), 200);
    this.render();
  }

  render() {
    const { fraction, activeDescriptions } = this.summary();
    const percent = String(Math.round(fraction * 100)).padStart(3);
    const elapsedSeconds = ((Date.now() - this.startedAt) / 1000).toFixed(0);
    const label = activeDescriptions.length > 0 ? activeDescriptions.join(", ") : "finishing up";
    clearLine();
    process.stdout.write(`  ${renderBar(fraction)} ${percent}%  ${elapsedSeconds}s  ${chalk.dim(label)}`);
  }

  stop() {
    clearInterval(this.intervalHandle);
    clearLine();
  }
}

// A live single-line status for one running task, driven entirely by a real counter
// the caller updates as actual work happens (files removed, du lines parsed, etc).
// If nothing ever increments the counter (some CLIs print nothing, e.g. `xcrun simctl
// delete`), it still shows elapsed time so it's obvious the process hasn't hung.
export class LiveCounterStatus {
  constructor(label) {
    this.label = label;
    this.count = 0;
    this.unit = null;
    this.startedAt = Date.now();
    this.intervalHandle = null;
  }

  update(count, unit) {
    this.count = count;
    this.unit = unit;
  }

  start() {
    this.intervalHandle = setInterval(() => this.render(), 200);
    this.render();
  }

  render() {
    const elapsedSeconds = ((Date.now() - this.startedAt) / 1000).toFixed(0);
    const progressText = this.count > 0 ? `${this.count.toLocaleString()} ${this.unit ?? "items"}, ` : "";
    clearLine();
    process.stdout.write(`  ${this.label} ${chalk.dim(`${progressText}${elapsedSeconds}s`)}`);
  }

  stop(outcome) {
    clearInterval(this.intervalHandle);
    clearLine();
    const elapsedSeconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const countText = this.count > 0 ? `, ${this.count.toLocaleString()} ${this.unit ?? "items"}` : "";
    if (outcome instanceof Error) {
      console.log(`  ${this.label} ${chalk.red("failed")}: ${outcome.message}`);
    } else {
      console.log(`  ${this.label} ${chalk.green("done")} ${chalk.dim(`(${elapsedSeconds}s${countText})`)}`);
    }
  }
}
