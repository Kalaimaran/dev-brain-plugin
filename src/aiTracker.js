'use strict';

/**
 * aiTracker.js
 * Detects AI CLI tool invocations and extracts structured metadata.
 *
 * Supported tools: claude, openai, gemini, ollama, aider, continue, cody
 *
 * The module is intentionally read-only – it never spawns subprocesses to
 * intercept stdin/stdout (that would be too invasive).  Instead it parses
 * the command line and uses heuristics + optional history files to extract
 * the prompt.
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// ── Tool registry ─────────────────────────────────────────────────────────────

/**
 * Each entry describes one AI CLI tool.
 *
 * @typedef {object} AiToolDef
 * @property {string}   toolId      Canonical identifier stored in the event
 * @property {string[]} binaries    CLI binary names that map to this tool
 * @property {Function} extract     (cmdParts: string[], cwd: string) => Promise<object>
 */

/** @type {AiToolDef[]} */
const AI_TOOLS = [
  {
    toolId  : 'claude-cli',
    binaries: ['claude'],
    async extract(parts, cwd) {
      // claude -p "prompt"  or  claude --print "prompt"  or  claude "prompt"
      const prompt = extractFlagValue(parts, ['-p', '--print', '--prompt'])
                  || positionalArg(parts, 1);
      const model  = extractFlagValue(parts, ['--model', '-m']);
      return { tool: 'claude-cli', prompt: prompt ?? null, model: model ?? null };
    },
  },
  {
    toolId  : 'openai-cli',
    binaries: ['openai'],
    async extract(parts) {
      // openai api chat.completions.create -g user "prompt"
      const prompt = extractFlagValue(parts, ['-g']) || positionalArg(parts, 3);
      const model  = extractFlagValue(parts, ['-m', '--model']);
      return { tool: 'openai-cli', prompt: prompt ?? null, model: model ?? null };
    },
  },
  {
    toolId  : 'gemini-cli',
    binaries: ['gemini'],
    async extract(parts) {
      const prompt = extractFlagValue(parts, ['-p', '--prompt']) || positionalArg(parts, 1);
      const model  = extractFlagValue(parts, ['--model', '-m']);
      return { tool: 'gemini-cli', prompt: prompt ?? null, model: model ?? null };
    },
  },
  {
    toolId  : 'ollama',
    binaries: ['ollama'],
    async extract(parts) {
      // ollama run <model> "prompt"
      const subCmd = parts[1];
      if (subCmd === 'run') {
        const model  = parts[2] ?? null;
        const prompt = parts[3] ?? null;
        return { tool: 'ollama', subCommand: subCmd, model, prompt };
      }
      return { tool: 'ollama', subCommand: subCmd ?? null };
    },
  },
  {
    toolId  : 'aider',
    binaries: ['aider'],
    async extract(parts) {
      const message = extractFlagValue(parts, ['--message', '-m']);
      const model   = extractFlagValue(parts, ['--model']);
      const files   = parts.slice(1).filter((p) => !p.startsWith('-'));
      return {
        tool   : 'aider',
        prompt : message ?? null,
        model  : model ?? null,
        files  : files.length ? files : null,
      };
    },
  },
  {
    toolId  : 'continue-cli',
    binaries: ['continue'],
    async extract(parts) {
      const prompt = positionalArg(parts, 1);
      return { tool: 'continue-cli', prompt: prompt ?? null };
    },
  },
  {
    toolId  : 'cody-cli',
    binaries: ['cody'],
    async extract(parts) {
      // cody chat --message "…"
      const message = extractFlagValue(parts, ['--message', '-m']);
      return { tool: 'cody-cli', prompt: message ?? null };
    },
  },
];

// Build a quick lookup: binary name → tool definition
const BINARY_MAP = new Map();
for (const def of AI_TOOLS) {
  for (const bin of def.binaries) {
    BINARY_MAP.set(bin, def);
  }
}

// ── Arg-parsing helpers ───────────────────────────────────────────────────────

/** Shell-split a command string into an array of parts (simple split). */
function splitCommand(command) {
  // Tokenise respecting single/double-quoted strings
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }

    if (ch === ' ' && !inSingle && !inDouble) {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function extractFlagValue(parts, flags) {
  for (let i = 0; i < parts.length - 1; i++) {
    if (flags.includes(parts[i])) return parts[i + 1];
    // Handle --flag=value
    for (const flag of flags) {
      if (parts[i].startsWith(flag + '=')) {
        return parts[i].slice(flag.length + 1);
      }
    }
  }
  return null;
}

function positionalArg(parts, index) {
  // Skip flags (start with -) when looking for positional args
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith('-')) {
      if (pos === index) return parts[i];
      pos++;
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Given a command string, detect whether it's an AI CLI tool invocation.
 * Returns null if not recognised; otherwise returns an enrichment object.
 *
 * @param {string} command
 * @param {string} [cwd]
 * @returns {Promise<object|null>}
 */
export async function detectAiTool(command, cwd = process.cwd()) {
  const parts   = splitCommand(command);
  const binary  = path.basename(parts[0] || '').toLowerCase();
  const toolDef = BINARY_MAP.get(binary);

  if (!toolDef) return null;

  try {
    const extracted = await toolDef.extract(parts, cwd);
    return {
      eventType      : 'ai_cli_prompt',
      ...extracted,
      workingDirectory: cwd,
      timestamp      : new Date().toISOString(),
    };
  } catch {
    return { eventType: 'ai_cli_prompt', tool: toolDef.toolId };
  }
}

/**
 * Check whether a command binary is one of the tracked AI tools.
 * Useful for quick pre-filtering before calling detectAiTool.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isAiToolCommand(command) {
  const binary = path.basename(command.trim().split(/\s+/)[0]).toLowerCase();
  return BINARY_MAP.has(binary);
}

/** Return the list of all tracked AI tool binary names. */
export function trackedAiBinaries() {
  return [...BINARY_MAP.keys()];
}
