'use strict';

/**
 * daemonWorker.js
 * Long-running background process spawned by daemon.js.
 *
 * Responsibilities:
 *   • Watch shell history files for new commands
 *   • Watch active git repos (.git/COMMIT_EDITMSG) for commits
 *   • Keep the API client flushing on a 10-second cadence
 */

import { promises as fs } from 'fs';
import { watch } from 'fs';
import path from 'path';
import os from 'os';
import { trackCommand }  from './commandTracker.js';
import { buildGitEvent } from './gitTracker.js';
import { getApiClient }  from './apiClient.js';

const HOME = os.homedir();

// ── History file paths (per-shell) ────────────────────────────────────────────

const HISTORY_FILES = [
  path.join(HOME, '.bash_history'),
  path.join(HOME, '.zsh_history'),
  path.join(HOME, '.local', 'share', 'fish', 'fish_history'),
].filter(Boolean);

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main() {
  // Initialise the API client (loads persisted queue, starts auto-flush timer)
  try {
    const client = await getApiClient();
    client.startAutoFlush();
  } catch (err) {
    // Not authenticated – daemon still starts but events won't be sent
    console.warn('[daemon] API client unavailable:', err.message);
  }

  // Watch shell history files
  for (const histFile of HISTORY_FILES) {
    watchHistory(histFile).catch(() => {/* file may not exist yet */});
  }

  // Tell the parent process we're ready
  if (process.send) process.send('ready');

  // Stay alive
  process.stdin.resume();

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    try {
      const client = await getApiClient();
      await client.flush();
    } catch { /* ignore */ }
    process.exit(0);
  });
}

// ── History watcher ───────────────────────────────────────────────────────────

/**
 * Track new lines appended to a shell history file.
 */
async function watchHistory(histFile) {
  let lastSize = 0;
  try {
    const stat = await fs.stat(histFile);
    lastSize = stat.size;
  } catch {
    return; // file doesn't exist yet
  }

  watch(histFile, async (eventType) => {
    if (eventType !== 'change') return;

    try {
      const stat = await fs.stat(histFile);
      if (stat.size <= lastSize) return;

      // Read only the newly appended bytes
      const fh     = await fs.open(histFile, 'r');
      const buf    = Buffer.alloc(stat.size - lastSize);
      await fh.read(buf, 0, buf.length, lastSize);
      await fh.close();
      lastSize = stat.size;

      const newLines = buf.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);

      for (const rawLine of newLines) {
        const command = parseHistoryLine(rawLine);
        if (!command) continue;

        // Route git commands through the git tracker for richer events
        if (command.startsWith('git ')) {
          buildGitEvent(command, process.cwd()).catch(() => {});
        }

        trackCommand({ command, workingDirectory: process.cwd() }).catch(() => {});
      }
    } catch { /* ignore read errors */ }
  });
}

// ── History line parsers ──────────────────────────────────────────────────────

/**
 * Parse a raw history line into a clean command string.
 * Handles zsh extended history format: `: <timestamp>:<elapsed>;<command>`
 */
function parseHistoryLine(line) {
  // zsh extended history: ": 1700000000:0;npm install axios"
  const zshMatch = line.match(/^:\s*\d+:\d+;(.+)$/);
  if (zshMatch) return zshMatch[1].trim();

  // fish history format starts with "- cmd:" lines
  const fishMatch = line.match(/^-\s*cmd:\s*(.+)$/);
  if (fishMatch) return fishMatch[1].trim();

  // Plain bash history line
  return line.trim() || null;
}

main().catch((err) => {
  console.error('[daemon] Fatal error:', err.message);
  process.exit(1);
});
