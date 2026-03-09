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

import { execFile }    from 'child_process';
import { promisify }   from 'util';
import { promises as fs } from 'fs';
import { sendEvent }   from './apiClient.js';

const execFileAsync = promisify(execFile);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function git(args, cwd, opts = {}) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: opts.timeout || 5000,
    maxBuffer: opts.maxBuffer || 1024 * 512,
  });
  return stdout.trim();
}

async function safeGit(args, cwd, fallback = null, opts = {}) {
  try {
    return await git(args, cwd, opts);
  } catch {
    return fallback;
  }
}

// ── Parse helpers ─────────────────────────────────────────────────────────────

/**
 * Parse `git diff-tree --numstat` output into structured per-file data.
 * Format per line: "<additions>\t<deletions>\t<file>"
 * Binary files use "-" for counts.
 */
function parseNumStat(raw) {
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    const [add, del, file] = line.split('\t');
    return {
      file,
      additions: add === '-' ? null : parseInt(add, 10),
      deletions: del === '-' ? null : parseInt(del, 10),
    };
  });
}

/**
 * Parse `git diff-tree --name-status` output into structured file status data.
 * Format: "<status>\t<file>"  or  "<status>\t<old>\t<new>"  (renames/copies)
 * Status codes: M=modified, A=added, D=deleted, R=renamed, C=copied
 */
function parseNameStatus(raw) {
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t');
    const status = parts[0][0]; // first char covers R100, C100, etc.
    if (parts.length === 3) {
      return { status, oldFile: parts[1], file: parts[2] };
    }
    return { status, file: parts[1] };
  });
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
    // Use diff-tree so it works even on the very first commit (no HEAD~1 needed)
    const [message, hash, author, numStatRaw, nameStatusRaw, diffStatRaw, diffPatchRaw] =
      await Promise.all([
        safeGit(['log', '-1', '--format=%s'],          cwd, null),
        safeGit(['rev-parse', '--short', 'HEAD'],      cwd, null),
        safeGit(['log', '-1', '--format=%an <%ae>'],   cwd, null),
        safeGit(['diff-tree', '--no-commit-id', '-r', '--numstat',     'HEAD'], cwd, null),
        safeGit(['diff-tree', '--no-commit-id', '-r', '--name-status', 'HEAD'], cwd, null),
        safeGit(['diff-tree', '--no-commit-id', '-r', '--stat',        'HEAD'], cwd, null),
        // Full unified patch — use a larger buffer (4 MB) for big commits
        safeGit(
          ['diff-tree', '--no-commit-id', '-r', '-p', '--unified=3', 'HEAD'],
          cwd,
          null,
          { maxBuffer: 1024 * 1024 * 4 },
        ),
      ]);

    const filesChanged = parseNumStat(numStatRaw);
    const fileStatuses = parseNameStatus(nameStatusRaw);

    const totalAdditions = filesChanged.reduce((s, f) => s + (f.additions ?? 0), 0);
    const totalDeletions = filesChanged.reduce((s, f) => s + (f.deletions ?? 0), 0);

    return {
      commitMessage  : message,
      commitHash     : hash,
      author,
      diffStat       : diffStatRaw,     // human-readable: "2 files changed, 10 ins(+), 3 del(-)"
      diffPatch      : diffPatchRaw,    // full unified diff patch for the commit
      filesChanged,                     // [{file, additions, deletions}]
      fileStatuses,                     // [{status:'M'|'A'|'D'|'R'|'C', file, oldFile?}]
      totalAdditions,
      totalDeletions,
      filesCount     : filesChanged.length,
    };
  },

  async push(cwd, _cmdParts, { pushLogFile } = {}) {
    // Read pre-push commit log from temp file (written by shell wrapper before push ran)
    // After push completes @{u}..HEAD = 0, so we must use the pre-push snapshot.
    let prePushLog = null;
    if (pushLogFile) {
      try {
        prePushLog = (await fs.readFile(pushLogFile, 'utf8')).trim();
      } catch { /* file may have already been cleaned up */ }
      // Always clean up the temp file
      await fs.unlink(pushLogFile).catch(() => {});
    }

    const [remote, branchAheadRaw] = await Promise.all([
      safeGit(['remote', 'get-url', 'origin'],       cwd, null),
      // After push this is 0, but capture it for cases like --dry-run push
      safeGit(['rev-list', '--count', '@{u}..HEAD'], cwd, null),
    ]);

    const commitsAhead  = branchAheadRaw !== null ? parseInt(branchAheadRaw, 10) : null;
    const commitsPushed = prePushLog
      ? prePushLog.split('\n').filter(Boolean).map(line => {
          const [hash, message, author] = line.split('|');
          return { hash, message, author };
        })
      : [];

    return {
      remoteUrl    : remote,
      commitsCount : commitsPushed.length,
      commitsPushed,
      // commitsAhead will be 0 after a successful push (expected)
      commitsAheadAfterPush: commitsAhead,
    };
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
 * @param {object} [opts]    Extra options forwarded to sub-command handlers
 * @param {string} [opts.pushLogFile]  Path to temp file with pre-push commit log
 */
export async function buildGitEvent(command, cwd, opts = {}) {
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
      const extra = await handler(cwd, parts, opts);
      Object.assign(event, extra);
    } catch { /* ignore enrichment failures */ }
  }

  // Await so the process doesn't exit before the HTTP request completes
  await sendEvent(event);
}
