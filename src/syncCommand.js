'use strict';

/**
 * syncCommand.js
 *
 * Bulk-imports AI conversations from two sources:
 *
 *   1. Claude Code  — scans ~/.claude/projects/ for all JSONL session files
 *      and sends each session as an ai_conversation event.
 *      A sync-state file (~/.dev-monitor/sync-state.json) tracks which files
 *      have already been sent so only new/changed sessions are uploaded.
 *
 *   2. Claude desktop app (--app flag) — reads the Electron app's IndexedDB
 *      (LevelDB) from ~/Library/Application Support/Claude/IndexedDB/ and
 *      extracts cached conversation messages.
 *      Requires the optional `level` npm package (npm i -g level).
 */

import { promises as fs } from 'fs';
import path               from 'path';
import os                 from 'os';
import { sendEvent }      from './apiClient.js';
import { parseClaudeJsonl } from './conversationSaver.js';

const HOME              = os.homedir();
const CLAUDE_PROJECTS   = path.join(HOME, '.claude', 'projects');
const SYNC_STATE_FILE   = path.join(HOME, '.dev-monitor', 'sync-state.json');

// macOS/Windows paths for Claude desktop app IndexedDB
const APP_SUPPORT_PATHS = [
  // macOS
  path.join(HOME, 'Library', 'Application Support', 'Claude', 'IndexedDB',
            'https_claude.ai_0.indexeddb.leveldb'),
  // Windows
  path.join(HOME, 'AppData', 'Roaming', 'Claude', 'IndexedDB',
            'https_claude.ai_0.indexeddb.leveldb'),
  // Linux
  path.join(HOME, '.config', 'Claude', 'IndexedDB',
            'https_claude.ai_0.indexeddb.leveldb'),
];

// ── Sync state helpers ────────────────────────────────────────────────────────

async function readSyncState() {
  try {
    const raw = await fs.readFile(SYNC_STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { code: {}, app: {} };
  }
}

async function writeSyncState(state) {
  await fs.mkdir(path.dirname(SYNC_STATE_FILE), { recursive: true });
  await fs.writeFile(SYNC_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ── Slug helpers ──────────────────────────────────────────────────────────────

/**
 * Convert a Claude Code project slug back to a human-readable project name.
 * Example: -Users-kalaimaran-m-Documents-DataNexus-Tools-dev-brain-plugin
 *          → dev-brain-plugin
 */
function slugToProjectName(slug) {
  // Take the last dash-separated segment (the actual repo/folder name)
  const segments = slug.replace(/^-/, '').split('-');
  // Re-join segments — project names often have dashes too, so we heuristically
  // look for the last meaningful run of segments after well-known path prefixes
  const knownPrefixes = ['Users', 'home', 'Documents', 'Desktop', 'Downloads',
                         'Projects', 'workspace', 'code', 'dev', 'src'];
  let lastPrefixIdx = -1;
  for (let i = 0; i < segments.length; i++) {
    if (knownPrefixes.some(p => p.toLowerCase() === segments[i].toLowerCase())) {
      lastPrefixIdx = i;
    }
  }
  // Skip the username segment right after a prefix
  const start = lastPrefixIdx + 2;   // +1 for prefix itself, +1 to skip username
  return segments.slice(start).join('-') || slug;
}

/**
 * Best-effort reconstruction of the working directory from a slug.
 * (/ and . are both → - so reconstruction is lossy, but fine for display.)
 */
function slugToApproxCwd(slug) {
  return '/' + slug.replace(/^-/, '').replace(/-/g, '/');
}

// ── Source 1: Claude Code sessions ───────────────────────────────────────────

/**
 * Scan ~/.claude/projects/ and return metadata for all JSONL session files.
 */
async function listAllCodeSessions() {
  const sessions = [];

  let slugs;
  try { slugs = await fs.readdir(CLAUDE_PROJECTS); }
  catch { return sessions; }

  for (const slug of slugs) {
    const projectDir = path.join(CLAUDE_PROJECTS, slug);
    let entries;
    try { entries = await fs.readdir(projectDir); }
    catch { continue; }

    const jsonlFiles = entries.filter(f => f.endsWith('.jsonl'));

    for (const file of jsonlFiles) {
      const fullPath = path.join(projectDir, file);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat) continue;
      sessions.push({
        path       : fullPath,
        slug,
        sessionId  : path.basename(file, '.jsonl'),
        mtime      : stat.mtimeMs,
        projectName: slugToProjectName(slug),
        cwd        : slugToApproxCwd(slug),
      });
    }
  }

  return sessions;
}

/**
 * Sync all Claude Code JSONL sessions to the backend.
 *
 * @param {object} opts
 * @param {boolean} [opts.dryRun]   Print what would be sent without sending
 * @param {boolean} [opts.force]    Re-send even already-synced sessions
 * @param {string}  [opts.project]  Only sync sessions for this project name
 */
export async function syncCodeSessions({ dryRun = false, force = false, project = null } = {}) {
  const { default: chalk } = await import('chalk');
  const state = await readSyncState();
  if (!state.code) state.code = {};

  const sessions = await listAllCodeSessions();

  if (sessions.length === 0) {
    console.log(chalk.yellow('No Claude Code sessions found in ~/.claude/projects/'));
    return { sent: 0, skipped: 0, total: 0 };
  }

  let sent = 0, skipped = 0, updated = 0;

  for (const sess of sessions) {
    // Optional project filter
    if (project && !sess.projectName.toLowerCase().includes(project.toLowerCase())) {
      skipped++;
      continue;
    }

    const prev = state.code[sess.path];

    // Skip if mtime unchanged and not forced
    if (!force && prev && prev.mtime === sess.mtime) {
      skipped++;
      continue;
    }

    // Parse
    const raw = await fs.readFile(sess.path, 'utf8').catch(() => null);
    if (!raw) { skipped++; continue; }

    const messages = parseClaudeJsonl(raw);
    if (messages.length === 0) { skipped++; continue; }

    const isUpdate  = !!prev;
    const dateLabel = new Date(sess.mtime).toLocaleDateString();
    const title     = `${sess.projectName} – ${dateLabel}`;
    const label     = isUpdate ? chalk.blue('[updated]') : chalk.green('[new]');
    const sessionShort = sess.sessionId.slice(0, 8) + '…';

    if (dryRun) {
      console.log(`  ${chalk.dim('[dry-run]')} ${chalk.bold(sess.projectName)} | ${chalk.cyan(messages.length + ' turns')} | ${chalk.dim(sessionShort)}`);
    } else {
      await sendEvent({
        eventType       : 'ai_conversation',
        tool            : 'claude',
        messages,
        workingDirectory: sess.cwd,
        projectName     : sess.projectName,
        timestamp       : new Date(sess.mtime).toISOString(),
        _title          : title,
        _sessionFile    : `claude-jsonl:${sess.path}`,
        _sessionId      : sess.sessionId,
      });

      state.code[sess.path] = {
        mtime    : sess.mtime,
        turns    : messages.length,
        syncedAt : new Date().toISOString(),
      };

      console.log(`  ${label} ${chalk.bold(sess.projectName)} | ${chalk.cyan(messages.length + ' turns')} | ${chalk.dim(sessionShort)}`);
    }

    if (isUpdate) updated++; else sent++;
  }

  if (!dryRun) await writeSyncState(state);

  return { sent, updated, skipped, total: sessions.length };
}

// ── Source 2: Claude desktop app (IndexedDB / LevelDB) ───────────────────────

/**
 * Find the Claude desktop app's IndexedDB directory (cross-platform).
 */
async function findAppIndexedDb() {
  for (const p of APP_SUPPORT_PATHS) {
    try { await fs.access(p); return p; }
    catch {}
  }
  return null;
}

/**
 * Extract all JSON objects from LevelDB .log and .ldb binary files directly.
 *
 * Chromium/Electron uses a custom IndexedDB LevelDB format that is not fully
 * compatible with the `level` npm package. Instead we read the binary data
 * directly and extract any valid JSON objects embedded in it.
 *
 * LevelDB stores records in SSTable (.ldb) and Write-Ahead Log (.log) files.
 * Values that originated as JSON strings appear as UTF-8 text runs within the
 * binary data, making them extractable via a sliding-window JSON scanner.
 *
 * @param {string} dbPath  Path to the .indexeddb.leveldb directory
 * @returns {object[]}  All successfully parsed JSON objects found in the files
 */
async function readJsonFromLevelDbFiles(dbPath) {
  const entries = await fs.readdir(dbPath);
  const dataFiles = entries.filter(f => f.endsWith('.ldb') || f.endsWith('.log'));

  const allObjects = [];

  for (const file of dataFiles) {
    const buf = await fs.readFile(path.join(dbPath, file));
    const str = buf.toString('binary');

    // Scan for JSON objects: find every '{' and try to parse forward from it
    let i = 0;
    while (i < str.length) {
      const start = str.indexOf('{', i);
      if (start === -1) break;

      // Try increasing lengths to find the shortest valid JSON object
      let parsed = null;
      for (let end = start + 2; end <= Math.min(start + 200_000, str.length); end++) {
        if (str[end - 1] !== '}') continue;
        try {
          const candidate = Buffer.from(str.slice(start, end), 'binary').toString('utf8');
          parsed = JSON.parse(candidate);
          allObjects.push(parsed);
          i = end;
          break;
        } catch {}
      }
      if (!parsed) i = start + 1;
    }
  }

  return allObjects;
}

/**
 * Extract claude.ai conversation messages from the Electron app's IndexedDB.
 *
 * Reads LevelDB .log and .ldb binary files directly (no third-party LevelDB
 * bindings needed) and extracts JSON objects that match conversation message
 * schema:  { uuid, content, sender:'human'|'assistant', created_at }
 *
 * @param {string} dbPath  Path to the .indexeddb.leveldb directory
 * @returns {Array<{request, response}>} Paired conversation turns
 */
async function extractAppConversations(dbPath) {
  const rawObjects = await readJsonFromLevelDbFiles(dbPath);

  // ── Extract conversation messages ─────────────────────────────────────────
  // Look for objects with role + content (individual message records)
  const msgRecords = rawObjects.filter(o =>
    typeof o === 'object' && o !== null &&
    typeof o.uuid === 'string' &&
    typeof o.content === 'string' &&
    (o.sender === 'human' || o.sender === 'assistant')
  );

  if (msgRecords.length === 0) return [];

  // Group by conversation (parent conversation uuid)
  const byConversation = new Map();
  for (const msg of msgRecords) {
    const convId = msg.conversation_uuid ?? msg.conversation_id ?? 'unknown';
    if (!byConversation.has(convId)) byConversation.set(convId, []);
    byConversation.get(convId).push(msg);
  }

  // Pair human + assistant turns within each conversation
  const allPairs = [];
  for (const [, msgs] of byConversation) {
    // Sort by created_at
    msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const pairs = [];
    let pendingHuman = null;

    for (const msg of msgs) {
      if (msg.sender === 'human') {
        pendingHuman = msg.content?.trim();
      } else if (msg.sender === 'assistant' && pendingHuman) {
        pairs.push({ request: pendingHuman, response: msg.content?.trim() ?? '' });
        pendingHuman = null;
      }
    }

    if (pairs.length > 0) allPairs.push(...pairs);
  }

  return allPairs;
}

/**
 * Explain what is (and isn't) stored locally by the Claude desktop app.
 *
 * The Claude.ai web/desktop app stores conversations SERVER-SIDE only.
 * The local IndexedDB (LevelDB) only caches transient UI state:
 *   - Draft messages being composed (TipTap editor state)
 *   - UI settings / preferences
 * Full conversation history is fetched from Anthropic's servers on demand
 * and is NOT persisted to disk in a readable format.
 *
 * To capture claude.ai chat conversations:
 *   → Use the dev-brain browser extension (dev-brain-ext) which captures
 *     conversations from the live web UI at claude.ai.
 */
export async function syncAppConversations({ dryRun: _dryRun = false } = {}) {
  const { default: chalk } = await import('chalk');

  const dbPath = await findAppIndexedDb();

  if (dbPath) {
    console.log(chalk.dim(`  Found: ${path.basename(path.dirname(dbPath))}`));
  }

  console.log(chalk.yellow(
    '  Claude.ai chat conversations are stored server-side only.\n' +
    '  The local IndexedDB only caches draft editor state (text being typed),\n' +
    '  not the full conversation history.\n'
  ));
  console.log(chalk.cyan(
    '  To capture claude.ai web chat → use the dev-brain browser extension:\n' +
    '  it reads conversations from the live claude.ai UI and sends them to\n' +
    '  the Dev Journal automatically.'
  ));

  return { sent: 0, skipped: 0 };
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Main sync function — called by the `dev-monitor sync` CLI command.
 *
 * @param {object} opts
 * @param {boolean} [opts.dryRun]    Show what would be sent, don't actually send
 * @param {boolean} [opts.force]     Re-send all sessions (ignore sync state)
 * @param {boolean} [opts.app]       Also sync Claude desktop app conversations
 * @param {string}  [opts.project]   Only sync sessions matching this project name
 */
export async function syncAll({ dryRun = false, force = false, app = false, project = null } = {}) {
  const { default: chalk } = await import('chalk');

  console.log(chalk.bold('\n── Claude Code sessions ─────────────────────────────────────────'));
  const codeResult = await syncCodeSessions({ dryRun, force, project });

  let appResult = { sent: 0, skipped: 0 };
  if (app) {
    console.log(chalk.bold('\n── Claude desktop app ───────────────────────────────────────────'));
    appResult = await syncAppConversations({ dryRun });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(chalk.bold('\n─────────────────────────────────────────────────────────────────'));
  const totalSent = codeResult.sent + (codeResult.updated ?? 0) + appResult.sent;
  if (dryRun) {
    console.log(chalk.cyan(`Dry run — nothing was sent. Remove --dry-run to sync for real.`));
  } else {
    console.log(chalk.green(`✓ Synced ${totalSent} session(s)`) +
                chalk.dim(` (${codeResult.skipped} already up to date)`));
  }
  console.log('');
}
