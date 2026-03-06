'use strict';

/**
 * daemon.js
 * Manages the background monitoring process.
 *
 * The daemon:
 *   1. Watches ~/.bash_history / ~/.zsh_history for new lines (new commands)
 *   2. Watches .git/COMMIT_EDITMSG in the current repo for git commits
 *   3. Keeps the API client alive and auto-flushes every 10 s
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(os.homedir(), '.dev-monitor');
const PID_FILE   = path.join(CONFIG_DIR, 'daemon.pid');
const LOG_FILE   = path.join(CONFIG_DIR, 'daemon.log');

// ── Public: start ─────────────────────────────────────────────────────────────

export async function startDaemon() {
  const { default: chalk } = await import('chalk');

  // Bail out if already running
  if (await isDaemonRunning()) {
    const pid = await readPid();
    console.log(chalk.yellow(`Daemon is already running (PID ${pid}).`));
    return;
  }

  await fs.mkdir(CONFIG_DIR, { recursive: true });

  // Fork the worker script detached so it survives terminal close
  const worker = fork(
    path.join(__dirname, 'daemonWorker.js'),
    [],
    {
      detached : true,
      stdio    : ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );

  // Pipe output to log file
  const logStream = await fs.open(LOG_FILE, 'a');
  worker.stdout?.pipe(logStream.createWriteStream?.() ?? process.stdout);
  worker.stderr?.pipe(logStream.createWriteStream?.() ?? process.stderr);

  worker.unref();

  // Wait briefly for the worker to signal readiness
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Daemon startup timed out')), 5000);
    worker.once('message', (msg) => {
      if (msg === 'ready') { clearTimeout(timeout); resolve(); }
    });
    worker.once('error', (err) => { clearTimeout(timeout); reject(err); });
    worker.once('exit',  (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Daemon exited with code ${code}`));
    });
  });

  await fs.writeFile(PID_FILE, String(worker.pid), 'utf8');
  console.log(chalk.green(`✓ Daemon started (PID ${worker.pid})`));
  console.log(chalk.dim(`  Logs: ${LOG_FILE}`));
}

// ── Public: stop ──────────────────────────────────────────────────────────────

export async function stopDaemon() {
  const { default: chalk } = await import('chalk');

  const pid = await readPid();
  if (!pid) {
    console.log(chalk.yellow('Daemon is not running.'));
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    await fs.unlink(PID_FILE).catch(() => {});
    console.log(chalk.green(`✓ Daemon stopped (PID ${pid})`));
  } catch (err) {
    if (err.code === 'ESRCH') {
      // Process was already dead
      await fs.unlink(PID_FILE).catch(() => {});
      console.log(chalk.yellow('Daemon was not running (stale PID removed).'));
    } else {
      throw err;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readPid() {
  try {
    const raw = await fs.readFile(PID_FILE, 'utf8');
    return parseInt(raw.trim(), 10);
  } catch {
    return null;
  }
}

async function isDaemonRunning() {
  const pid = await readPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
