'use strict';

/**
 * commandTracker.js
 * Detects, classifies, and queues terminal command events.
 *
 * Called two ways:
 *  1. From the shell preexec hook  →  `dev-monitor track <cmd>`
 *  2. Programmatically from the daemon when it detects shell history changes.
 */

import path from 'path';
import { sendEvent }     from './apiClient.js';
import { getGitContext } from './gitTracker.js';
import { detectAiTool }  from './aiTracker.js';

// Git subcommands handled POST-execution by the git wrapper → skip basic event
// to avoid duplicates (buildGitEvent sends a richer git_activity event instead)
const GIT_RICH_SUBCOMMANDS = new Set([
  'commit', 'push', 'pull', 'merge', 'rebase',
  'checkout', 'reset', 'stash', 'tag', 'fetch',
]);

// Commands that are noisy / useless to track
const IGNORED_EXACT = new Set([
  'clear', 'cls', 'history', 'pwd', 'ls', 'dir',
  'echo', 'cat', 'less', 'more', 'man',
  'dev-monitor', // avoid recursion
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getRootCommand(command) {
  return command.trim().split(/\s+/)[0].toLowerCase();
}

function isTracked(command) {
  const root = getRootCommand(command);
  if (!root) return false;

  if (IGNORED_EXACT.has(root)) return false;
  return true;
}

function classifyCommand(command) {
  const root = getRootCommand(command);

  if (['git'].includes(root))                                      return 'git_command';
  if (['claude', 'openai', 'gemini', 'ollama', 'aider',
       'continue', 'cody'].includes(root))                         return 'ai_cli_prompt';
  if (['npm', 'npx', 'pnpm', 'yarn', 'bun'].includes(root))       return 'package_manager';
  if (['docker', 'docker-compose', 'kubectl',
       'helm'].includes(root))                                     return 'container_orchestration';
  if (['mvn', 'gradle', './gradlew', './mvnw'].includes(root))     return 'build_tool';
  if (['python', 'python3', 'pip', 'pip3'].includes(root))         return 'python';
  if (['java', 'javac'].includes(root))                            return 'java';
  if (['curl', 'wget'].includes(root))                             return 'http_request';
  if (['ssh', 'scp', 'rsync'].includes(root))                      return 'remote_access';
  if (['terraform', 'ansible'].includes(root))                     return 'infrastructure';
  return 'terminal_command';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record one terminal command.
 *
 * @param {object} opts
 * @param {string} opts.command          Full command string
 * @param {string} [opts.workingDirectory]
 * @param {number} [opts.exitCode]
 */
export async function trackCommand({ command, workingDirectory, exitCode = 0 }) {
  if (!command || !isTracked(command)) return;

  const cwd = workingDirectory || process.cwd();
  const eventType = classifyCommand(command);

  // For git subcommands with rich post-execution handling, skip the basic event.
  // The shell git wrapper calls `dev-monitor git-post <subcmd>` after git exits
  // and buildGitEvent sends a full git_activity event with file-level diff data.
  if (eventType === 'git_command') {
    const sub = command.trim().split(/\s+/)[1] || '';
    if (GIT_RICH_SUBCOMMANDS.has(sub)) return;
  }
  const timestamp = new Date().toISOString();

  // Build base event
  const event = {
    eventType,
    command,
    workingDirectory : cwd,
    projectName      : path.basename(cwd),
    exitCode,
    timestamp,
  };

  // Enrich with git context (non-blocking)
  try {
    const git = await getGitContext(cwd);
    if (git) Object.assign(event, { git });
  } catch { /* ignore */ }

  // If this is an AI CLI command, enrich with AI-specific fields
  if (eventType === 'ai_cli_prompt') {
    try {
      const ai = await detectAiTool(command, cwd);
      if (ai) Object.assign(event, ai);
    } catch { /* ignore */ }
  }

  // Await so the process doesn't exit before the HTTP request completes
  await sendEvent(event);
}
