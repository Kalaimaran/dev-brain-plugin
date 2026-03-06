'use strict';

/**
 * gitTracker.js
 * Provides two capabilities:
 *
 *  1. getGitContext(cwd)   – lightweight snapshot of the current repo state
 *                            (used to enrich every command event).
 *
 *  2. buildGitEvent(cmd, cwd) – build a rich git-specific event with
 *                               commit message, diff stats, etc.
 *                               Called by the daemon's git watcher.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { sendEvent } from './apiClient.js';

const execFileAsync = promisify(execFile);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 5000,
    maxBuffer: 1024 * 512,
  });
  return stdout.trim();
}

async function safeGit(args, cwd, fallback = null) {
  try {
    return await git(args, cwd);
  } catch {
    return fallback;
  }
}

// ── Public: lightweight context snapshot ─────────────────────────────────────

/**
 * Return basic git metadata for the given directory.
 * Returns null if the directory is not inside a git repo.
 *
 * @param {string} cwd
 * @returns {Promise<object|null>}
 */
export async function getGitContext(cwd) {
  const repoRoot = await safeGit(['rev-parse', '--show-toplevel'], cwd);
  if (!repoRoot) return null;

  const [branch, remoteUrl, commitHash] = await Promise.all([
    safeGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 'unknown'),
    safeGit(['remote', 'get-url', 'origin'],       cwd, null),
    safeGit(['rev-parse', '--short', 'HEAD'],       cwd, null),
  ]);

  // Derive a friendly repo name from the remote URL or the folder name
  let repoName = null;
  if (remoteUrl) {
    repoName = remoteUrl.replace(/\.git$/, '').split('/').pop();
  }
  repoName = repoName || repoRoot.split('/').pop();

  return {
    repoRoot,
    repoName,
    branch,
    commitHash,
    remoteUrl,
  };
}

// ── Git sub-command handlers ──────────────────────────────────────────────────

/**
 * Enrichments per git sub-command.
 * Each handler receives the full command string and cwd,
 * and returns an object to merge into the event.
 */
const GIT_HANDLERS = {
  async commit(cwd) {
    const [message, hash, diffStat] = await Promise.all([
      safeGit(['log', '-1', '--format=%s'], cwd, null),
      safeGit(['rev-parse', '--short', 'HEAD'], cwd, null),
      safeGit(['diff', '--stat', 'HEAD~1', 'HEAD'], cwd, null),
    ]);
    return { commitMessage: message, commitHash: hash, diffStat };
  },

  async push(cwd) {
    const remote = await safeGit(['remote', 'get-url', 'origin'], cwd, null);
    const ahead  = await safeGit(
      ['rev-list', '--count', '@{u}..HEAD'],
      cwd,
      null,
    ).then((v) => (v !== null ? parseInt(v, 10) : null))
     .catch(() => null);
    return { remoteUrl: remote, commitsAhead: ahead };
  },

  async pull(cwd) {
    const behind = await safeGit(
      ['rev-list', '--count', 'HEAD..@{u}'],
      cwd,
      null,
    ).then((v) => (v !== null ? parseInt(v, 10) : null))
     .catch(() => null);
    return { commitsBehind: behind };
  },

  async checkout(cwd, cmdParts) {
    const newBranch = cmdParts[2] || null;
    return { newBranch };
  },

  async merge(cwd, cmdParts) {
    const sourceBranch = cmdParts[2] || null;
    return { sourceBranch };
  },
};

// Git sub-commands we create specific events for
const TRACKED_GIT_SUBCOMMANDS = new Set([
  'commit', 'push', 'pull', 'checkout', 'merge',
  'rebase', 'reset', 'stash', 'tag', 'fetch',
]);

/**
 * Build and queue a rich git event.
 *
 * @param {string} command   Full git command string, e.g. "git commit -m 'fix'"
 * @param {string} cwd
 */
export async function buildGitEvent(command, cwd) {
  const parts      = command.trim().split(/\s+/);
  const subCommand = parts[1] || '';

  if (!TRACKED_GIT_SUBCOMMANDS.has(subCommand)) return;

  const timestamp  = new Date().toISOString();
  const gitContext = await getGitContext(cwd);
  if (!gitContext) return;

  const event = {
    eventType   : 'git_activity',
    command,
    subCommand,
    workingDirectory: cwd,
    timestamp,
    ...gitContext,
  };

  // Run the sub-command specific handler if one exists
  const handler = GIT_HANDLERS[subCommand];
  if (handler) {
    try {
      const extra = await handler(cwd, parts);
      Object.assign(event, extra);
    } catch { /* ignore enrichment failures */ }
  }

  // Await so the process doesn't exit before the HTTP request completes
  await sendEvent(event);
}
