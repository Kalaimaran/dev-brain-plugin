'use strict';

/**
 * apiClient.js
 * Sends each event immediately (fire-and-forget) to POST /api/events
 * as soon as it is captured — no batching, no flush timer.
 *
 * Backend: DataNexus DevBrainController
 *   POST /api/events
 *   Authorization: Bearer <ACCESS_TOKEN>
 *   Body: { "events": [ DevBrainEventDto ] }
 */

import path from 'path';
import { getValidAuthSession } from './auth.js';
import { getBaseUrl } from './baseUrl.js';

const MAX_RETRIES     = 2;
const RETRY_BASE_MS   = 500;

// ── Event mapper ──────────────────────────────────────────────────────────────

/**
 * Map an internal tracker event → DevBrainEventDto fields.
 * Extra fields are ignored by the server (@JsonIgnoreProperties).
 * Rich data is packed into pageText as JSON for future use.
 */
function toDevBrainDto(event) {
  const base = {
    timestamp: event.timestamp || new Date().toISOString(),
  };

  switch (event.eventType) {

    case 'ai_conversation':
      return {
        ...base,
        eventType : 'ai_response',
        aiService : event.tool ?? 'ai',
        promptText: JSON.stringify(event.messages ?? []),   // full [{request, response}] array
        url       : event.workingDirectory ?? null,
        domain    : event.projectName ?? dirName(event.workingDirectory),
        pageTitle : event._title ?? `${event.tool ?? 'ai'} conversation`,
      };

    case 'ai_cli_prompt':
      return {
        ...base,
        eventType : 'ai_prompt',
        aiService : event.tool ?? event.command?.split(' ')[0] ?? 'unknown-cli',
        promptText: event.prompt ?? null,
        url       : event.workingDirectory ?? null,
        domain    : event.projectName ?? dirName(event.workingDirectory),
        pageTitle : event._title ?? (event.model ? `model: ${event.model}` : 'terminal AI prompt'),
        pageText  : event._fullText ?? JSON.stringify(stripId(event)),
      };

    case 'git_activity':
      return {
        ...base,
        eventType: 'terminal_command',
        domain   : event.repoName ?? event.projectName ?? dirName(event.workingDirectory),
        url      : event.workingDirectory ?? null,
        query    : event.command,
        pageTitle: buildGitTitle(event),
        pageText : JSON.stringify(stripId(event)),
      };

    default:
      return {
        ...base,
        eventType: 'terminal_command',
        domain   : event.git?.repoName ?? event.projectName ?? dirName(event.workingDirectory),
        url      : event.workingDirectory ?? null,
        query    : event.command,
        pageTitle: `[${event.eventType ?? 'cmd'}] ${event.command?.split(' ').slice(0, 3).join(' ')}`,
        pageText : JSON.stringify(stripId(event)),
      };
  }
}

function buildGitTitle(event) {
  const parts = [`git ${event.subCommand}`];
  if (event.branch)        parts.push(`branch: ${event.branch}`);
  if (event.commitMessage) parts.push(`msg: ${event.commitMessage}`);
  if (event.filesCount)    parts.push(`${event.filesCount} file(s) changed`);
  if (event.totalAdditions || event.totalDeletions)
    parts.push(`+${event.totalAdditions ?? 0} -${event.totalDeletions ?? 0}`);
  if (event.commitsAhead)  parts.push(`${event.commitsAhead} commit(s) pushed`);
  return parts.join(' | ');
}

function dirName(dir) {
  return dir ? path.basename(dir) : null;
}

function stripId({ _id, ...rest }) {
  return rest;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _accessToken = null;
let _tokenType   = 'Bearer';
let _baseUrl     = null;

async function init() {
  if (_accessToken) return;
  const session = await getValidAuthSession();
  _accessToken = session.accessToken;
  _tokenType   = session.tokenType || 'Bearer';
  _baseUrl = await getBaseUrl();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send one event immediately to the backend (fire-and-forget).
 * Never throws — tracking must never interrupt the developer's workflow.
 *
 * @param {object} event  Internal tracker event
 */
export async function sendEvent(event) {
  try {
    await init();
    await _post([toDevBrainDto(event)]);
  } catch {
    // Silently swallow — tracking is non-critical
  }
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function _post(dtoEvents) {
  const { default: axios } = await import('axios');
  const url = `${_baseUrl}/api/events`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await axios.post(
        url,
        { events: dtoEvents },
        {
          headers: {
            'Authorization': `${_tokenType} ${_accessToken}`,
            'Content-Type' : 'application/json',
            'User-Agent'   : 'dev-journal-monitor/1.0.0',
          },
          timeout: 8_000,
        },
      );
      return; // success
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        try {
          const session = await getValidAuthSession({ forceRefresh: true });
          _accessToken = session.accessToken;
          _tokenType   = session.tokenType || 'Bearer';
          continue;
        } catch {
          return;
        }
      }
      if (attempt < MAX_RETRIES) await sleep(RETRY_BASE_MS * attempt);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Legacy shim — getApiClient() kept for daemon.js compatibility ─────────────
export async function getApiClient() {
  await init();
  return {
    enqueue: (event) => { sendEvent(event).catch(() => {}); },
    flush  : async () => 0,
    startAutoFlush: () => {},
    stopAutoFlush : () => {},
    queueLength: 0,
  };
}
