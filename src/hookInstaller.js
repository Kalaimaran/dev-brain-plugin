'use strict';

/**
 * hookInstaller.js
 * Injects / removes dev-monitor shell hooks into the user's rc file.
 *
 * Bash: uses the DEBUG trap + PROMPT_COMMAND to capture pre-exec commands.
 * Zsh:  uses the preexec / precmd hooks from zsh-hooks (built-in since zsh 5.1).
 * Fish: writes a fish function file.
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const HOME = os.homedir();

// Sentinel strings so we can locate and remove our block later
const HOOK_START = '# >>> dev-monitor hooks >>>';
const HOOK_END   = '# <<< dev-monitor hooks <<<';

// ── Shell hook snippets ───────────────────────────────────────────────────────

const BASH_HOOK = `
${HOOK_START}
# Track commands before execution (requires bash >= 4 / macOS bash via Homebrew)
__dev_monitor_preexec() {
  local cmd="$1"
  # Avoid tracking the tracker itself
  [[ "$cmd" == dev-monitor* ]] && return
  dev-monitor track "$cmd" --dir "$PWD" 2>/dev/null &
}

# Install via DEBUG trap + PROMPT_COMMAND trick for bash
__dev_monitor_trap() {
  [ -n "$COMP_LINE" ] && return   # ignore tab-completion calls
  local cmd
  cmd="$(history 1 | sed 's/^ *[0-9]* *//')"
  [ "$cmd" = "$__dev_monitor_last" ] && return
  __dev_monitor_last="$cmd"
  __dev_monitor_preexec "$cmd"
}

if [[ "$__dev_monitor_installed" != "1" ]]; then
  export __dev_monitor_installed=1
  export PROMPT_COMMAND="__dev_monitor_trap\${PROMPT_COMMAND:+; \$PROMPT_COMMAND}"
fi

# AI session recorder — wraps AI CLI tools so conversations can be saved
__dev_monitor_ai_wrap() {
  local tool="$1"; shift
  local _d="$HOME/.dev-monitor/sessions"
  command mkdir -p "$_d"
  local _f="\${_d}/\${tool}-$(date +%s).txt"
  command script -q "$_f" "$tool" "$@"
  printf '%s' "$_f" > "\${_d}/.last"
}
for _dm_t in ollama claude aider openai gemini; do
  command -v "$_dm_t" &>/dev/null && alias "$_dm_t"="__dev_monitor_ai_wrap $_dm_t"
done
unset _dm_t
${HOOK_END}
`;

const ZSH_HOOK = `
${HOOK_START}
# Track commands using zsh preexec hook (built-in since zsh 5.1)
__dev_monitor_preexec() {
  local cmd="$1"
  [[ "$cmd" == dev-monitor* ]] && return
  dev-monitor track "$cmd" --dir "$PWD" 2>/dev/null &
}

autoload -Uz add-zsh-hook 2>/dev/null
add-zsh-hook preexec __dev_monitor_preexec

# AI session recorder — wraps AI CLI tools so conversations can be saved
__dev_monitor_ai_wrap() {
  local tool="$1"; shift
  local _d="$HOME/.dev-monitor/sessions"
  command mkdir -p "$_d"
  local _f="\${_d}/\${tool}-$(date +%s).txt"
  command script -q "$_f" "$tool" "$@"
  printf '%s' "$_f" > "\${_d}/.last"
}
for _dm_t in ollama claude aider openai gemini; do
  command -v "$_dm_t" >/dev/null 2>&1 && alias "$_dm_t"="__dev_monitor_ai_wrap $_dm_t"
done
unset _dm_t
${HOOK_END}
`;

const FISH_HOOK = `
${HOOK_START}
# dev-monitor fish preexec hook – placed in ~/.config/fish/functions/
${HOOK_END}
`;

// Fish needs its own function file
const FISH_FUNCTION = `
function __dev_monitor_preexec --on-event fish_preexec
    set -l cmd $argv[1]
    if string match --quiet 'dev-monitor*' "$cmd"
        return
    end
    dev-monitor track "$cmd" --dir (pwd) &>/dev/null &
end
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function detectRcFile() {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh'))  return path.join(HOME, '.zshrc');
  if (shell.includes('bash')) return path.join(HOME, '.bashrc');
  if (shell.includes('fish')) return null; // handled separately
  // Fallback: try zshrc first, then bashrc
  try { await fs.access(path.join(HOME, '.zshrc')); return path.join(HOME, '.zshrc'); } catch {}
  try { await fs.access(path.join(HOME, '.bashrc')); return path.join(HOME, '.bashrc'); } catch {}
  return path.join(HOME, '.bashrc');
}

async function appendHook(rcFile, hookText) {
  const current = await fs.readFile(rcFile, 'utf8').catch(() => '');
  if (current.includes(HOOK_START)) {
    console.log(`  ${rcFile} already has hooks – skipping.`);
    return;
  }
  await fs.appendFile(rcFile, hookText, 'utf8');
  console.log(`  Hooks added to ${rcFile}`);
}

async function removeHook(rcFile) {
  let content;
  try { content = await fs.readFile(rcFile, 'utf8'); }
  catch { return; }

  const start = content.indexOf(HOOK_START);
  const end   = content.indexOf(HOOK_END);
  if (start === -1) { console.log(`  No hooks found in ${rcFile}`); return; }

  const cleaned = content.slice(0, start) + content.slice(end + HOOK_END.length);
  await fs.writeFile(rcFile, cleaned.replace(/\n{3,}/g, '\n\n'), 'utf8');
  console.log(`  Hooks removed from ${rcFile}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Install shell preexec hooks.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.skipKeyPrompt=false]  When true (called from login),
 *   skip the key prompt since the key was already saved by the caller.
 */
export async function installHooks({ skipKeyPrompt = false } = {}) {
  const { default: chalk } = await import('chalk');
  const shell  = process.env.SHELL || '';
  const isFish = shell.includes('fish');

  if (isFish) {
    const fishFunctionsDir = path.join(HOME, '.config', 'fish', 'functions');
    await fs.mkdir(fishFunctionsDir, { recursive: true });
    const fishFnFile = path.join(fishFunctionsDir, '__dev_monitor_preexec.fish');
    await fs.writeFile(fishFnFile, FISH_FUNCTION, 'utf8');
    console.log(chalk.green('✓ Shell hook installed (fish)'));
    console.log(chalk.dim(`  ${fishFnFile}`));
  } else {
    const rcFile = await detectRcFile();
    const hook   = shell.includes('zsh') ? ZSH_HOOK : BASH_HOOK;
    await appendHook(rcFile, hook);
    console.log(chalk.cyan('\nRestart your terminal or run:'));
    console.log(`  source ${rcFile}`);
  }

  if (!skipKeyPrompt) {
    // Called standalone (dev-monitor install-hooks) — print full ready message
    console.log(chalk.green('\n✓ Dev Monitor is active. Commands are sent automatically.\n'));
  }
}

/**
 * Remove shell preexec hooks.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.silent=false]  Suppress the "restart terminal" hint
 *   when called from logout (it prints its own summary).
 */
export async function uninstallHooks({ silent = false } = {}) {
  const { default: chalk } = await import('chalk');
  const shell  = process.env.SHELL || '';
  const isFish = shell.includes('fish');

  if (isFish) {
    const fishFnFile = path.join(HOME, '.config', 'fish', 'functions', '__dev_monitor_preexec.fish');
    await fs.unlink(fishFnFile).catch(() => {});
    console.log(chalk.green('✓ Shell hook removed (fish)'));
    return;
  }

  const rcFile = await detectRcFile();
  await removeHook(rcFile);

  if (!silent) {
    console.log(chalk.cyan('Restart your terminal or run:'));
    console.log(`  source ${rcFile}\n`);
  }
}
