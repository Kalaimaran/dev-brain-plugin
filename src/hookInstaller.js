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

const HOME       = os.homedir();
const IS_WINDOWS = process.platform === 'win32';

// Sentinel strings so we can locate and remove our block later
const HOOK_START    = '# >>> dev-monitor hooks >>>';
const HOOK_END      = '# <<< dev-monitor hooks <<<';
// PowerShell uses the same sentinel (# is also a comment in PS)
const PS_HOOK_START = '# >>> dev-monitor hooks >>>';
const PS_HOOK_END   = '# <<< dev-monitor hooks <<<';

// ── Shell hook snippets ───────────────────────────────────────────────────────

const BASH_HOOK = `
${HOOK_START}
# Track commands before execution (requires bash >= 4 / macOS bash via Homebrew)
__dev_monitor_preexec() {
  local cmd="$1"
  # Avoid tracking the tracker itself
  [[ "$cmd" == dev-monitor* ]] && return
  (dev-monitor track "$cmd" --dir "$PWD" </dev/null >/dev/null 2>&1 &)
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
# claude is excluded: it stores its own JSONL in ~/.claude/projects/
__dev_monitor_ai_wrap() {
  local tool="$1"; shift
  local _d="$HOME/.dev-monitor/sessions"
  command mkdir -p "$_d"
  local _f="\${_d}/\${tool}-$(date +%s).txt"
  command script -q "$_f" "$tool" "$@"
  printf '%s' "$_f" > "\${_d}/.last"
}
for _dm_t in ollama aider openai gemini; do
  command -v "$_dm_t" &>/dev/null && alias "$_dm_t"="__dev_monitor_ai_wrap $_dm_t"
done
unset _dm_t

# Claude Code — after exit, find the exact JSONL file that was just written
__dev_monitor_claude_wrap() {
  local _d="$HOME/.dev-monitor/sessions"
  command mkdir -p "$_d"
  command claude "$@"
  # Resolve the slug Claude Code uses for this directory (/ and . → -)
  local _slug
  _slug=$(printf '%s' "$PWD" | tr '/.' '-')
  local _proj="$HOME/.claude/projects/$_slug"
  local _jsonl=""
  if [[ -d "$_proj" ]]; then
    _jsonl=$(ls -t "$_proj"/*.jsonl 2>/dev/null | head -1)
  fi
  if [[ -n "$_jsonl" ]]; then
    printf '%s' "claude-jsonl:$_jsonl" > "\${_d}/.last"
  else
    # Fallback: cwd-based lookup (legacy)
    printf '%s' "claude:$PWD" > "\${_d}/.last"
  fi
}
command -v claude &>/dev/null && alias claude="__dev_monitor_claude_wrap"

# Git wrapper — fires rich post-execution tracking after git commit/push/etc.
__dev_monitor_git_wrap() {
  local _sub="$1" _push_file=""
  # For push: snapshot commits BEFORE they leave (after push @{u}..HEAD = 0)
  if [[ "$_sub" == "push" ]]; then
    _push_file="$HOME/.dev-monitor/push-$(date +%s)-$$.txt"
    command mkdir -p "$HOME/.dev-monitor"
    command git log '@{u}..HEAD' --format='%h|%s|%an' 2>/dev/null > "$_push_file" || rm -f "$_push_file"
    [[ -s "$_push_file" ]] || { rm -f "$_push_file"; _push_file=""; }
  fi
  command git "$@"
  local _exit=$?
  case "$_sub" in
    commit|push|pull|merge|rebase|checkout|reset|stash|tag|fetch)
      if [[ -n "$_push_file" ]]; then
        (dev-monitor git-post "$_sub" --dir "$PWD" --push-log-file "$_push_file" </dev/null >/dev/null 2>&1 &)
      else
        (dev-monitor git-post "$_sub" --dir "$PWD" </dev/null >/dev/null 2>&1 &)
      fi
      ;;
  esac
  return $_exit
}
command -v git &>/dev/null && alias git="__dev_monitor_git_wrap"
${HOOK_END}
`;

const ZSH_HOOK = `
${HOOK_START}
# Track commands using zsh preexec hook (built-in since zsh 5.1)
__dev_monitor_preexec() {
  local cmd="$1"
  [[ "$cmd" == dev-monitor* ]] && return
  (dev-monitor track "$cmd" --dir "$PWD" </dev/null >/dev/null 2>&1 &)
}

autoload -Uz add-zsh-hook 2>/dev/null
add-zsh-hook preexec __dev_monitor_preexec

# AI session recorder — wraps AI CLI tools so conversations can be saved
# claude is excluded: it stores its own JSONL in ~/.claude/projects/
__dev_monitor_ai_wrap() {
  local tool="$1"; shift
  local _d="$HOME/.dev-monitor/sessions"
  command mkdir -p "$_d"
  local _f="\${_d}/\${tool}-$(date +%s).txt"
  command script -q "$_f" "$tool" "$@"
  printf '%s' "$_f" > "\${_d}/.last"
}
for _dm_t in ollama aider openai gemini; do
  command -v "$_dm_t" >/dev/null 2>&1 && alias "$_dm_t"="__dev_monitor_ai_wrap $_dm_t"
done
unset _dm_t

# Claude Code — after exit, find the exact JSONL file that was just written
__dev_monitor_claude_wrap() {
  local _d="$HOME/.dev-monitor/sessions"
  command mkdir -p "$_d"
  command claude "$@"
  # Resolve the slug Claude Code uses for this directory (/ and . → -)
  local _slug
  _slug=$(printf '%s' "$PWD" | tr '/.' '-')
  local _proj="$HOME/.claude/projects/$_slug"
  local _jsonl=""
  if [[ -d "$_proj" ]]; then
    _jsonl=$(ls -t "$_proj"/*.jsonl 2>/dev/null | head -1)
  fi
  if [[ -n "$_jsonl" ]]; then
    printf '%s' "claude-jsonl:$_jsonl" > "\${_d}/.last"
  else
    # Fallback: cwd-based lookup (legacy)
    printf '%s' "claude:$PWD" > "\${_d}/.last"
  fi
}
command -v claude >/dev/null 2>&1 && alias claude="__dev_monitor_claude_wrap"

# Git wrapper — fires rich post-execution tracking after git commit/push/etc.
__dev_monitor_git_wrap() {
  local _sub="$1" _push_file=""
  # For push: snapshot commits BEFORE they leave (after push @{u}..HEAD = 0)
  if [[ "$_sub" == "push" ]]; then
    _push_file="$HOME/.dev-monitor/push-$(date +%s)-$$.txt"
    command mkdir -p "$HOME/.dev-monitor"
    command git log '@{u}..HEAD' --format='%h|%s|%an' 2>/dev/null > "$_push_file" || rm -f "$_push_file"
    [[ -s "$_push_file" ]] || { rm -f "$_push_file"; _push_file=""; }
  fi
  command git "$@"
  local _exit=$?
  case "$_sub" in
    commit|push|pull|merge|rebase|checkout|reset|stash|tag|fetch)
      if [[ -n "$_push_file" ]]; then
        (dev-monitor git-post "$_sub" --dir "$PWD" --push-log-file "$_push_file" </dev/null >/dev/null 2>&1 &)
      else
        (dev-monitor git-post "$_sub" --dir "$PWD" </dev/null >/dev/null 2>&1 &)
      fi
      ;;
  esac
  return $_exit
}
command -v git >/dev/null 2>&1 && alias git="__dev_monitor_git_wrap"
${HOOK_END}
`;

const FISH_HOOK = `
${HOOK_START}
# dev-monitor fish preexec hook – placed in ~/.config/fish/functions/
${HOOK_END}
`;

// ── PowerShell hook (Windows) ─────────────────────────────────────────────────
// All PowerShell $ variables are escaped as \$ so JS template literal
// doesn't try to interpolate them. Only ${HOOK_START} / ${HOOK_END} are
// real JS interpolations.

const POWERSHELL_HOOK = `
${PS_HOOK_START}
# Command tracker — hooks into the prompt function to fire after each command
if (-not \$global:__dm_installed) {
  \$global:__dm_installed = \$true
  \$global:__dm_last_cmd  = ''

  function global:prompt {
    \$cmd = (Get-History -Count 1 -ErrorAction SilentlyContinue)?.CommandLine
    if (\$cmd -and \$cmd -ne \$global:__dm_last_cmd -and \$cmd -notlike 'dev-monitor*') {
      \$global:__dm_last_cmd = \$cmd
      Start-Job -ScriptBlock { dev-monitor track \$using:cmd --dir \$using:PWD } | Out-Null
    }
    "PS \$PWD> "
  }
}

# AI session recorder — wraps AI CLI tools so conversations can be saved
function global:Invoke-DevMonitorAIWrap {
  param([string]\$Tool, [Parameter(ValueFromRemainingArguments)][string[]]\$Rest)
  \$d = "\$HOME/.dev-monitor/sessions"
  New-Item -ItemType Directory -Force -Path \$d | Out-Null
  \$ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  \$f  = "\$d/\$Tool-\$ts.txt"
  Start-Transcript -Path \$f -NoClobber | Out-Null
  try { & \$Tool @\$Rest } finally {
    Stop-Transcript | Out-Null
    [System.IO.File]::WriteAllText("\$d/.last", \$f)
  }
}

# claude excluded — it stores its own JSONL in ~/.claude/projects/
foreach (\$t in @('ollama','aider','openai','gemini')) {
  if (Get-Command \$t -ErrorAction SilentlyContinue) {
    Set-Item -Path "Function:global:\$t" -Value ([ScriptBlock]::Create("Invoke-DevMonitorAIWrap '\$t' @args"))
  }
}

# Claude Code — after exit, find the exact JSONL that was just written
if (Get-Command claude -ErrorAction SilentlyContinue) {
  function global:claude {
    \$d = "\$HOME/.dev-monitor/sessions"
    New-Item -ItemType Directory -Force -Path \$d | Out-Null
    & claude @args
    # Resolve the slug Claude Code uses (/ and . replaced by -)
    \$slug = \$PWD.Path -replace '[/\\\\.]', '-'
    \$proj = "\$HOME/.claude/projects/\$slug"
    \$jsonl = ''
    if (Test-Path \$proj) {
      \$jsonl = Get-ChildItem "\$proj/*.jsonl" -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1 -ExpandProperty FullName
    }
    if (\$jsonl) {
      [System.IO.File]::WriteAllText("\$d/.last", "claude-jsonl:\$jsonl")
    } else {
      [System.IO.File]::WriteAllText("\$d/.last", "claude:\$PWD")
    }
  }
}

# Git wrapper — fires rich post-execution tracking after git commit/push/etc.
\$__dm_git_exe = (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)?.Source
if (\$__dm_git_exe) {
  function global:git {
    & \$global:__dm_git_exe @args
    \$exit = \$LASTEXITCODE
    \$sub  = if (\$args.Count -gt 0) { \$args[0] } else { '' }
    if (\$sub -in @('commit','push','pull','merge','rebase','checkout','reset','stash','tag','fetch')) {
      Start-Job -ScriptBlock { dev-monitor git-post \$using:sub --dir \$using:PWD } | Out-Null
    }
    return \$exit
  }
}
${PS_HOOK_END}
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

/**
 * Detect the active PowerShell profile path on Windows.
 * Prefers PS 7+ (Documents/PowerShell) over PS 5.x (Documents/WindowsPowerShell).
 */
async function detectPSProfile() {
  // PowerShell 7+ (pwsh)
  const ps7 = path.join(HOME, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
  // Windows PowerShell 5.x (powershell.exe)
  const ps5 = path.join(HOME, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');

  // If PS7 profile directory exists, prefer it
  try { await fs.access(path.dirname(ps7)); return ps7; } catch {}
  // Otherwise fall back to PS5 path (dir will be created if needed)
  return ps5;
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

  // ── Windows: inject into PowerShell profile ────────────────────────────────
  if (IS_WINDOWS) {
    const profileFile = await detectPSProfile();
    await fs.mkdir(path.dirname(profileFile), { recursive: true });
    await appendHook(profileFile, POWERSHELL_HOOK);
    console.log(chalk.green('✓ Shell hook installed (PowerShell)'));
    console.log(chalk.dim(`  ${profileFile}`));
    console.log(chalk.cyan('\nReload PowerShell or run:'));
    console.log('  . $PROFILE');

  // ── Fish ───────────────────────────────────────────────────────────────────
  } else if (isFish) {
    const fishFunctionsDir = path.join(HOME, '.config', 'fish', 'functions');
    await fs.mkdir(fishFunctionsDir, { recursive: true });
    const fishFnFile = path.join(fishFunctionsDir, '__dev_monitor_preexec.fish');
    await fs.writeFile(fishFnFile, FISH_FUNCTION, 'utf8');
    console.log(chalk.green('✓ Shell hook installed (fish)'));
    console.log(chalk.dim(`  ${fishFnFile}`));

  // ── Zsh / Bash (macOS / Linux) ────────────────────────────────────────────
  } else {
    const rcFile = await detectRcFile();
    const hook   = shell.includes('zsh') ? ZSH_HOOK : BASH_HOOK;
    await appendHook(rcFile, hook);
    console.log(chalk.cyan('\nRestart your terminal or run:'));
    console.log(`  source ${rcFile}`);
  }

  if (!skipKeyPrompt) {
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

  // ── Windows ────────────────────────────────────────────────────────────────
  if (IS_WINDOWS) {
    const profileFile = await detectPSProfile();
    await removeHook(profileFile);
    if (!silent) {
      console.log(chalk.cyan('Reload PowerShell or run:'));
      console.log('  . $PROFILE\n');
    }
    return;
  }

  // ── Fish ───────────────────────────────────────────────────────────────────
  if (isFish) {
    const fishFnFile = path.join(HOME, '.config', 'fish', 'functions', '__dev_monitor_preexec.fish');
    await fs.unlink(fishFnFile).catch(() => {});
    console.log(chalk.green('✓ Shell hook removed (fish)'));
    return;
  }

  // ── Zsh / Bash ─────────────────────────────────────────────────────────────
  const rcFile = await detectRcFile();
  await removeHook(rcFile);

  if (!silent) {
    console.log(chalk.cyan('Restart your terminal or run:'));
    console.log(`  source ${rcFile}\n`);
  }
}
