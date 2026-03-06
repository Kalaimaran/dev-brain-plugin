'use strict';

/**
 * conversationSaver.js
 *
 * Two modes:
 *   1. AUTO  (default when run interactively after an AI session)
 *      Reads ~/.dev-monitor/sessions/.last → parses the recorded session file
 *      into [{request, response}] pairs → sends as ai_conversation event.
 *
 *   2. PIPE  (when stdin is piped)
 *      Reads raw text from stdin, sends it as a single ai_prompt event.
 *      e.g. pbpaste | dev-monitor save --title "bug fix"
 */

import { promises as fs } from 'fs';
import { createInterface }  from 'readline';
import path                 from 'path';
import os                   from 'os';
import { sendEvent }        from './apiClient.js';

const SESSIONS_DIR  = path.join(os.homedir(), '.dev-monitor', 'sessions');
const LAST_PTR_FILE = path.join(SESSIONS_DIR, '.last');

// ── ANSI stripper ────────────────────────────────────────────────────────────

function stripAllAnsi(str) {
  return str
    .replace(/\x1b\[[\d;?]*[A-Za-z]/g, '')  // CSI sequences (colors, cursor, erase…)
    .replace(/\x1b[()][AB012]/g, '')          // charset designations
    .replace(/\x1b./g, '')                    // any other ESC+char
    .replace(/\x00/g, '')                     // null bytes
    .replace(/\r/g, '');                      // carriage returns
}

// ── Session parsers ───────────────────────────────────────────────────────────

/**
 * Parse ollama terminal sessions recorded by `script`.
 *
 * Each raw `\n`-delimited line is one of:
 *   a) User-input line  — raw bytes contain the literal string ">>> "
 *   b) Response line    — spinner chars followed by actual response text
 *   c) Noise/blank      — loading spinners before first prompt, blank lines
 *
 * Returns [{request: string, response: string}]
 */
function parseOllamaSession(rawContent) {
  const lines    = rawContent.split('\n');
  const messages = [];
  let curReq     = null;
  let resLines   = [];

  for (const rawLine of lines) {
    if (rawLine.includes('>>> ')) {
      // ── User-input line ─────────────────────────────────────────────────
      // Flush previous turn
      if (curReq !== null) {
        const response = resLines.join('\n').trim();
        if (response && !curReq.startsWith('/')) {
          messages.push({ request: curReq, response });
        }
      }
      curReq   = extractUserInput(rawLine);
      resLines = [];

    } else if (curReq !== null) {
      // ── Response / noise line ────────────────────────────────────────────
      const text = extractResponseText(rawLine);
      if (text) resLines.push(text);
    }
    // Lines before the first '>>> ' (model loading) are silently ignored
    // because curReq === null
  }

  // Flush last turn
  if (curReq && !curReq.startsWith('/')) {
    const response = resLines.join('\n').trim();
    if (response) messages.push({ request: curReq, response });
  }

  return messages;
}

/**
 * Extract user input from a raw `>>> ` line.
 *
 * ollama writes:  >>> <placeholder text>\x1b[28D\x1b[0m\x1b[K<user_input>\r
 * The \x1b[K (erase-to-EOL) clears the placeholder; user text follows it.
 * So we take everything after the LAST \x1b[K.
 */
function extractUserInput(rawLine) {
  const ERASE_EOL = '\x1b[K';
  const idx = rawLine.lastIndexOf(ERASE_EOL);
  if (idx !== -1) {
    return stripAllAnsi(rawLine.slice(idx + ERASE_EOL.length)).trim();
  }
  // Fallback: strip ANSI → find '>>> ' → take text after placeholder
  const clean = stripAllAnsi(rawLine);
  const promptIdx = clean.lastIndexOf('>>> ');
  if (promptIdx === -1) return '';
  // Remove the known "Send a message (/? for help)" placeholder if present
  return clean
    .slice(promptIdx + 4)
    .replace(/^Send a message \([^)]*\)/, '')
    .trim();
}

/**
 * Extract response text from a non-prompt raw line.
 *
 * ollama streams tokens with cursor-hide/show between each word.
 * Before the text, there are spinner chars (U+2800 braille block).
 * We use two strategies:
 *   1. \x1b[2K (erase-full-line) marks where the spinner was cleared and
 *      real text begins — take everything after the last one.
 *   2. Fallback: strip ANSI then skip leading non-ASCII (spinner) characters.
 */
function extractResponseText(rawLine) {
  const ERASE_LINE = '\x1b[2K';
  const idx = rawLine.lastIndexOf(ERASE_LINE);
  const slice = idx !== -1 ? rawLine.slice(idx + ERASE_LINE.length) : rawLine;

  const cleaned = stripAllAnsi(slice).trim();

  // Skip lines that are only spinner chars (braille U+2800-U+28FF) / spaces
  // by removing any leading non-ASCII run before the first ASCII letter/digit.
  const text = cleaned.replace(/^[^a-zA-Z0-9]*/, '').trim();
  return /[a-zA-Z0-9]/.test(text) ? text : '';
}

/**
 * Generic fallback parser for non-ollama tools.
 * Alternating blank-line-delimited blocks → {request, response} pairs.
 */
function parseGenericSession(rawContent) {
  const clean  = stripAllAnsi(rawContent);
  const blocks = clean.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const messages = [];
  for (let i = 0; i + 1 < blocks.length; i += 2) {
    messages.push({ request: blocks[i], response: blocks[i + 1] });
  }
  return messages;
}

function parseSession(rawContent, tool) {
  // ollama uses ">>> " prompts; check raw bytes (not stripped)
  if (tool === 'ollama' || rawContent.includes('>>> ')) {
    return parseOllamaSession(rawContent);
  }
  return parseGenericSession(rawContent);
}

// ── stdin reader ──────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    const rl    = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const lines = [];
    rl.on('line',  (l) => lines.push(l));
    rl.on('close', ()  => resolve(lines.join('\n')));
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Save a conversation to the Dev Journal.
 *
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.aiService]
 * @param {string} [opts.workingDirectory]
 */
export async function saveConversation({ title, aiService, workingDirectory } = {}) {
  const { default: chalk } = await import('chalk');

  const cwd     = workingDirectory || process.cwd();
  const project = path.basename(cwd);

  // ── PIPE MODE ─────────────────────────────────────────────────────────────
  if (!process.stdin.isTTY) {
    const text = await readStdin();
    if (!text.trim()) {
      console.log(chalk.yellow('Nothing to save — empty input.'));
      return;
    }
    const service    = aiService || detectService(text) || 'ai';
    const eventTitle = title || `Saved conversation – ${project}`;

    await sendEvent({
      eventType       : 'ai_cli_prompt',
      tool            : service,
      prompt          : text.slice(0, 2000),
      workingDirectory: cwd,
      projectName     : project,
      timestamp       : new Date().toISOString(),
      _fullText       : text,
      _title          : eventTitle,
    });

    console.log(chalk.green('✓ Conversation saved to Dev Journal'));
    console.log(chalk.dim(`  service : ${service}`));
    console.log(chalk.dim(`  title   : ${eventTitle}`));
    console.log(chalk.dim(`  length  : ${text.length} chars`));
    return;
  }

  // ── AUTO MODE — read last recorded session ────────────────────────────────
  let sessionFile;
  try {
    sessionFile = (await fs.readFile(LAST_PTR_FILE, 'utf8')).trim();
  } catch {
    console.log(chalk.yellow(
      'No recorded AI session found.\n' +
      'Start a new conversation — ollama, claude, etc. are now wrapped automatically.\n' +
      'Or pipe text:  pbpaste | dev-monitor save --title "topic"'
    ));
    return;
  }

  // Detect tool name from filename  (e.g. "ollama-1741234567.txt" → "ollama")
  const toolFromFile = path.basename(sessionFile).split('-')[0];
  const service      = aiService || toolFromFile || 'ai';

  let rawContent;
  try {
    rawContent = await fs.readFile(sessionFile, 'utf8');
  } catch {
    console.log(chalk.red(`Could not read session file: ${sessionFile}`));
    return;
  }

  const messages = parseSession(rawContent, service);

  if (messages.length === 0) {
    console.log(chalk.yellow('Could not parse any conversation turns from the session file.'));
    console.log(chalk.dim(`  File: ${sessionFile}`));
    return;
  }

  const eventTitle = title || `${service} session – ${project}`;

  await sendEvent({
    eventType       : 'ai_conversation',
    tool            : service,
    messages,                          // [{request, response}]
    workingDirectory: cwd,
    projectName     : project,
    timestamp       : new Date().toISOString(),
    _title          : eventTitle,
    _sessionFile    : sessionFile,
  });

  console.log(chalk.green('✓ Conversation saved to Dev Journal'));
  console.log(chalk.dim(`  service : ${service}`));
  console.log(chalk.dim(`  title   : ${eventTitle}`));
  console.log(chalk.dim(`  turns   : ${messages.length}`));
  console.log(chalk.dim(`  file    : ${sessionFile}`));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectService(text) {
  const lower = text.toLowerCase();
  if (lower.includes('claude'))                         return 'claude';
  if (lower.includes('chatgpt') || lower.includes('gpt-')) return 'chatgpt';
  if (lower.includes('gemini'))                         return 'gemini';
  if (lower.includes('ollama'))                         return 'ollama';
  if (lower.includes('copilot'))                        return 'copilot';
  return null;
}
