#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

/**
 * Best-effort port freeing helper for dev/start hooks.
 * Uses `lsof` (preferred) and/or `fuser` when available.
 *
 * Usage:
 *   node scripts/free-port.js [port]
 *
 * Environment:
 *   PORT: used when no CLI arg is provided (defaults to 3001)
 */
function main() {
  const portArg = process.argv[2];
  const port = Number(portArg || process.env.PORT || 3001);

  if (!Number.isFinite(port) || port <= 0) {
    // Keep this quiet and non-fatal for pre* scripts.
    process.exit(0);
  }

  // Try lsof first (common on macOS/Linux)
  if (hasCmd('lsof')) {
    const pids = listListeningPidsWithLsof(port);
    if (pids.length > 0) {
      // TERM first, then KILL for anything that remains.
      killPids(pids, 'SIGTERM');
      // Give processes a brief moment (no async; just proceed best-effort).
      killPids(pids, 'SIGKILL');
    }
  }

  // Fallback to fuser if available (common on Linux)
  if (hasCmd('fuser')) {
    // `fuser -k` returns non-zero if nothing is using the port; ignore errors.
    run('fuser', ['-k', '-TERM', `${port}/tcp`]);
    run('fuser', ['-k', '-KILL', `${port}/tcp`]);
  }

  process.exit(0);
}

function hasCmd(cmd) {
  const res = spawnSync('command', ['-v', cmd], { shell: '/bin/bash', stdio: 'ignore' });
  return res.status === 0;
}

function run(cmd, args) {
  try {
    const res = spawnSync(cmd, args, { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

function listListeningPidsWithLsof(port) {
  // Use the simplest, most portable invocation:
  //   lsof -nP -iTCP:<port> -sTCP:LISTEN -t
  // -nP avoids DNS/service name lookups; -t prints only PIDs.
  try {
    const res = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    if (res.status !== 0 || !res.stdout) return [];
    return res.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function killPids(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // ignore (process may already be gone / permission denied)
    }
  }
}

main();
