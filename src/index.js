#!/usr/bin/env node
import chalk from "chalk";
import prompts from "prompts";
import { collectAllItems, TIER_SAFE, TIER_CAUTION, TIER_MANUAL } from "./collectors.js";
import { formatBytes, run } from "./util.js";
import { ScanTracker, LiveCounterStatus } from "./progress.js";

const isDryRun = process.argv.includes("--dry-run") || process.argv.includes("--report");

const TIER_STYLE = {
  [TIER_SAFE]: { label: "safe", color: chalk.green },
  [TIER_CAUTION]: { label: "caution", color: chalk.yellow },
  [TIER_MANUAL]: { label: "manual", color: chalk.magenta },
};

function printReport(items) {
  const byCategory = new Map();
  for (const item of items) {
    if (!byCategory.has(item.category)) byCategory.set(item.category, []);
    byCategory.get(item.category).push(item);
  }

  let grandTotalBytes = 0;
  for (const [category, categoryItems] of byCategory) {
    const categoryTotalBytes = categoryItems.reduce((sum, item) => sum + item.sizeBytes, 0);
    grandTotalBytes += categoryTotalBytes;
    console.log(chalk.bold(`\n${category}`) + chalk.dim(`  (${formatBytes(categoryTotalBytes)})`));
    for (const item of categoryItems) {
      const style = TIER_STYLE[item.tier];
      console.log(
        `  ${style.color(`[${style.label.padEnd(7)}]`)} ${formatBytes(item.sizeBytes).padStart(8)}  ${item.label}`
      );
      if (item.detail) {
        console.log(chalk.dim(`             ${item.detail.split("\n").join("\n             ")}`));
      }
    }
  }
  console.log(chalk.bold(`\nTotal scanned: ${formatBytes(grandTotalBytes)}`));
  console.log(
    chalk.dim(
      `Legend: ${TIER_STYLE.safe.color("safe")} = regenerable, no real downside  |  ${TIER_STYLE.caution.color(
        "caution"
      )} = costs a rebuild/re-download  |  ${TIER_STYLE.manual.color("manual")} = your call, changes over time\n`
    )
  );
}

async function getFreeSpace() {
  const output = await run("df -h / | tail -1 | awk '{print $4}'");
  return output || "unknown";
}

async function main() {
  console.log(chalk.bold.cyan("\nDisk Cleanup - scanning known disk-space sinks..."));
  const scanTracker = new ScanTracker();
  scanTracker.start();
  const items = await collectAllItems(scanTracker);
  scanTracker.stop();
  console.log();

  if (items.length === 0) {
    console.log(chalk.green("Nothing found above the noise threshold. Disk looks clean."));
    return;
  }

  items.sort((a, b) => b.sizeBytes - a.sizeBytes);

  // --dry-run / --report: print the full annotated breakdown and stop there.
  // Default: skip straight to the picker - it already shows size + tier per line,
  // so a separate report first would just be the same information twice.
  if (isDryRun) {
    printReport(items);
    console.log(chalk.dim("Report only - nothing was deleted. Run without --dry-run to select items to clean.\n"));
    return;
  }

  console.log(
    chalk.dim(
      `Legend: ${TIER_STYLE.safe.color("safe")} = regenerable, no real downside  |  ${TIER_STYLE.caution.color(
        "caution"
      )} = costs a rebuild/re-download  |  ${TIER_STYLE.manual.color("manual")} = your call, changes over time`
    )
  );

  const { selectedIds } = await prompts({
    type: "multiselect",
    name: "selectedIds",
    message: "Select items to clean up (space to toggle, a to toggle all, enter to confirm)",
    hint: "- Space to select. Return to submit",
    instructions: false,
    choices: items.map((item) => ({
      title: `${formatBytes(item.sizeBytes).padStart(8)}  [${TIER_STYLE[item.tier].label}]  [${item.category}] ${item.label}`,
      value: item.id,
      selected: item.defaultSelected,
    })),
  });

  if (!selectedIds || selectedIds.length === 0) {
    console.log(chalk.dim("Nothing selected. Exiting without changes."));
    return;
  }

  const selectedItems = items.filter((item) => selectedIds.includes(item.id));
  const selectedTotalBytes = selectedItems.reduce((sum, item) => sum + item.sizeBytes, 0);

  console.log(chalk.bold(`\nAbout to clean ${selectedItems.length} item(s), ~${formatBytes(selectedTotalBytes)}:`));
  for (const item of selectedItems) {
    console.log(`  - [${item.category}] ${item.label}`);
    if (item.detail) console.log(chalk.dim(`    ${item.detail.split("\n").join("\n    ")}`));
  }

  const { confirmed } = await prompts({
    type: "confirm",
    name: "confirmed",
    message: "Proceed?",
    initial: false,
  });

  if (!confirmed) {
    console.log(chalk.dim("Cancelled. Nothing was deleted."));
    return;
  }

  const freeSpaceBefore = await getFreeSpace();

  console.log();
  for (const item of selectedItems) {
    const status = new LiveCounterStatus(`[${item.category}] ${item.label}`);
    status.start();
    try {
      await item.clean((count, unit) => status.update(count, unit));
      status.stop();
    } catch (error) {
      status.stop(error);
    }
  }

  const freeSpaceAfter = await getFreeSpace();
  console.log(chalk.bold(`\nFree space: ${freeSpaceBefore} -> ${freeSpaceAfter}`));
}

main().catch((error) => {
  console.error(chalk.red(`\nUnexpected error: ${error.stack || error.message}`));
  process.exitCode = 1;
});
