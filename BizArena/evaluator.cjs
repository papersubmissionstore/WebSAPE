#!/usr/bin/env node
'use strict';

const VERSION = '2.0.0';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SITE_INDEX_FILES = {
  outlook: [
    path.join(__dirname, 'outlook_tasks.jsonl'),
  ],
  teams: [
    path.join(__dirname, 'teams_tasks.jsonl'),
  ],
  scrumboard: [
    path.join(__dirname, 'scrumboard_tasks.jsonl'),
  ],
  cross_site: [
    path.join(__dirname, 'cross_site_tasks.jsonl'),
  ],
};

function usage() {
  console.error('Usage:');
  console.error('  node evaluator.js <query_hash> <output_dir>');
  console.error('    output_dir should contain per-site subfolders:');
  console.error('      <output_dir>/outlook/localStorage_snapshot.json');
  console.error('      <output_dir>/outlook/event_log.ndjson');
  console.error('      <output_dir>/scrumboard/localStorage_snapshot.json');
  console.error('      ...');
  console.error('');
  console.error('  node evaluator.js <query_hash> <snapshot_file> <event_log_file>');
  console.error('    (legacy) pass snapshot and event log as individual files');
}

function toEvalTaskId(taskId) {
  const n = Number(taskId);
  if (!Number.isInteger(n) || n <= 0) return null;
  return `EVAL-${String(n).padStart(2, '0')}`;
}

function parseJsonl(filePath, site) {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(line => line.trim().length > 0);
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const row = JSON.parse(lines[i]);
      entries.push({ ...row, __site: site });
    } catch (err) {
      console.warn(`[WARN] Skipping malformed JSONL row in ${path.basename(filePath)}:${i + 1} (${err.message})`);
    }
  }

  return entries;
}

function loadIndexRows() {
  let rows = [];
  for (const [site, filePaths] of Object.entries(SITE_INDEX_FILES)) {
    for (const filePath of filePaths) {
      rows = rows.concat(parseJsonl(filePath, site));
    }
  }
  // Deduplicate by query_hash (v2 overrides v1 if same hash appears in both)
  const seen = new Map();
  for (const row of rows) {
    seen.set(row.query_hash, row);
  }
  return [...seen.values()];
}

function resolveQuery(queryHash) {
  const rows = loadIndexRows();
  const match = rows.find(row => row.query_hash === queryHash);
  if (!match) return null;

  // cross_site tasks have multiple sites; detect via __site from the JSONL file
  const isCrossSite = match.__site === 'cross_site';

  const site = isCrossSite
    ? 'cross_site'
    : (Array.isArray(match.sites) && match.sites.length > 0
      ? String(match.sites[0]).toLowerCase()
      : match.__site);

  const taskId = toEvalTaskId(match.task_id);
  if (!taskId) {
    throw new Error(`Invalid task_id for ${queryHash}: ${match.task_id}`);
  }

  return { site, taskId, rawTaskId: match.task_id, isCrossSite };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3) {
    usage();
    process.exit(1);
  }

  console.log(`workarena evaluator v${VERSION}`);

  const queryHash = args[0];
  let snapshotFile, eventLogFile;

  if (args.length === 2) {
    // New style: <query_hash> <output_dir>
    // Resolve site first to find the right subfolder
    let resolved;
    try {
      resolved = resolveQuery(queryHash);
    } catch (err) {
      console.error(`ERROR: ${err.message}`);
      process.exit(1);
    }
    if (!resolved) {
      console.error(`ERROR: query_hash not found: ${queryHash}`);
      process.exit(1);
    }

    const outputDir = path.resolve(process.cwd(), args[1]);

    if (resolved.isCrossSite) {
      runEvaluator(resolved, undefined, undefined, outputDir);
      return;
    }

    const siteDir = path.join(outputDir, resolved.site);

    snapshotFile = path.join(siteDir, 'localStorage_snapshot.json');
    eventLogFile = path.join(siteDir, 'event_log.ndjson');

    if (!fs.existsSync(snapshotFile)) {
      console.error(`ERROR: Snapshot file not found: ${snapshotFile}`);
      console.error(`  Expected folder layout: ${outputDir}/${resolved.site}/localStorage_snapshot.json`);
      process.exit(1);
    }
    if (!fs.existsSync(eventLogFile)) {
      console.error(`ERROR: Event log file not found: ${eventLogFile}`);
      console.error(`  Expected folder layout: ${outputDir}/${resolved.site}/event_log.ndjson`);
      process.exit(1);
    }

    runEvaluator(resolved, snapshotFile, eventLogFile);
  } else {
    // Legacy style: <query_hash> <snapshot_file> <event_log_file>
    snapshotFile = path.resolve(process.cwd(), args[1]);
    eventLogFile = path.resolve(process.cwd(), args[2]);

    if (!fs.existsSync(snapshotFile)) {
      console.error(`ERROR: Snapshot file not found: ${snapshotFile}`);
      process.exit(1);
    }
    if (!fs.existsSync(eventLogFile)) {
      console.error(`ERROR: Event log file not found: ${eventLogFile}`);
      process.exit(1);
    }

    let resolved;
    try {
      resolved = resolveQuery(queryHash);
    } catch (err) {
      console.error(`ERROR: ${err.message}`);
      process.exit(1);
    }
    if (!resolved) {
      console.error(`ERROR: query_hash not found: ${queryHash}`);
      process.exit(1);
    }

    if (resolved.isCrossSite) {
      const outputDir = path.dirname(path.dirname(snapshotFile));
      runEvaluator(resolved, undefined, undefined, outputDir);
      return;
    }

    runEvaluator(resolved, snapshotFile, eventLogFile);
  }
}

function runEvaluator(resolved, snapshotFile, eventLogFile, outputDir) {
  const evaluatorPath = path.join(__dirname, resolved.site, 'evaluator.js');
  if (!fs.existsSync(evaluatorPath)) {
    console.error(`ERROR: Evaluator not found for site "${resolved.site}": ${evaluatorPath}`);
    process.exit(1);
  }

  const childArgs = [evaluatorPath, resolved.taskId];

  if (resolved.isCrossSite) {
    childArgs.push('--output-dir', outputDir || path.resolve(process.cwd()));
  } else {
    childArgs.push('--snapshot', snapshotFile, '--events', eventLogFile);
  }

  const result = spawnSync(process.execPath, childArgs, {
    stdio: 'inherit'
  });

  if (result.error) {
    console.error(`ERROR: Failed to run evaluator: ${result.error.message}`);
    process.exit(1);
  }

  process.exit(typeof result.status === 'number' ? result.status : 1);
}

main();
