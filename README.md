# dev-journal-monitor

A developer activity monitoring CLI that silently tracks every meaningful terminal command, git operation, and AI CLI interaction — feeding a daily developer journal.

## Features

| Category | What's tracked |
|---|---|
| **Terminal commands** | `npm`, `node`, `docker`, `kubectl`, `git`, `mvn`, `gradle`, `python`, `java`, `curl`, `ssh`, and more |
| **Git activity** | `commit`, `push`, `pull`, `checkout`, `merge` with branch, commit message & diff stats |
| **AI CLI tools** | Claude CLI, OpenAI CLI, Gemini CLI, Ollama, Aider, Continue, Cody – prompt text captured |
| **Project context** | Working directory, repository name, active branch on every event |

Events are **batched** and sent every 10 seconds to `POST /api/events`.

---

## Installation

### From npm (once published)

```bash
npm install -g dev-journal-monitor
```

### From source

```bash
git clone <repo-url>
cd dev-monitor
npm install
npm link          # makes `dev-monitor` available globally
```

---

## Quick start

```bash
# 1. Authenticate
dev-monitor login

# 2. Install shell hooks (tracks every command automatically)
dev-monitor install-hooks

# 3. Restart your terminal (or source your rc file)
source ~/.zshrc   # or ~/.bashrc

# 4. Start the background daemon (keeps the event queue flushing)
dev-monitor start
```

---

## Commands

```
dev-monitor login            Authenticate with your API key
dev-monitor logout           Remove stored API key
dev-monitor status           Show auth + daemon status
dev-monitor start            Start the background daemon
dev-monitor stop             Stop the background daemon
dev-monitor install-hooks    Add shell hooks to ~/.zshrc / ~/.bashrc
dev-monitor uninstall-hooks  Remove shell hooks
dev-monitor flush            Force-send all queued events now
dev-monitor track <cmd>      Record a command (called by shell hooks)
```

---

## Architecture

```
dev-monitor/
├── bin/
│   └── index.js            CLI entry point (commander.js)
├── src/
│   ├── auth.js             API key storage in ~/.dev-monitor/config.json
│   ├── commandTracker.js   Classifies & enqueues terminal commands
│   ├── gitTracker.js       Git context + rich git activity events
│   ├── aiTracker.js        AI CLI tool detection & prompt extraction
│   ├── apiClient.js        Event queue, batching, HTTP with retry
│   ├── daemon.js           Spawn / stop the background worker
│   ├── daemonWorker.js     Long-running history watcher + git watcher
│   └── hookInstaller.js    Injects / removes shell preexec hooks
```

### Data flow

```
Terminal keystroke
      │
      ▼
Shell preexec hook  ──────────────────────────────► dev-monitor track "<cmd>"
      │                                                     │
      ▼                                                     ▼
~/.zsh_history (appended)                        commandTracker.js
      │                                               │       │
      ▼                                         gitTracker  aiTracker
daemonWorker.js (watches history)                    │       │
      │                                              └───┬───┘
      └────────────────────────────────────────────► apiClient.js
                                                         │
                                                   queue (in-memory + disk)
                                                         │
                                              every 10 s │
                                                         ▼
                                              POST /api/events  (batched)
```

---

## Event shapes

### Terminal command

```json
{
  "eventType": "terminal_command",
  "command": "npm install axios",
  "workingDirectory": "/projects/crm",
  "projectName": "crm",
  "exitCode": 0,
  "git": {
    "repoName": "crm",
    "branch": "feature/auth",
    "commitHash": "a1b2c3d"
  },
  "timestamp": "2024-01-15T10:23:45.000Z"
}
```

### Git activity

```json
{
  "eventType": "git_activity",
  "command": "git commit -m 'feat: add user auth'",
  "subCommand": "commit",
  "repoName": "crm",
  "branch": "feature/auth",
  "commitMessage": "feat: add user auth",
  "commitHash": "d4e5f6a",
  "diffStat": " src/auth.js | 42 ++++++\n 1 file changed, 42 insertions(+)",
  "workingDirectory": "/projects/crm",
  "timestamp": "2024-01-15T10:23:45.000Z"
}
```

### AI CLI prompt

```json
{
  "eventType": "ai_cli_prompt",
  "tool": "claude-cli",
  "prompt": "generate a spring boot rest controller",
  "model": "claude-opus-4-6",
  "workingDirectory": "/projects/crm",
  "timestamp": "2024-01-15T10:23:45.000Z"
}
```

---

## Backend API contract

### Authentication

Every request carries:

```
Authorization: Bearer <USER_API_KEY>
```

### POST /api/events

**Request body:**

```json
{
  "events": [ /* array of event objects */ ]
}
```

**Success response:** `200 OK`

**Validation endpoint:**

```
GET /api/auth/validate
Authorization: Bearer <USER_API_KEY>
```

---

## Configuration

| File | Purpose |
|---|---|
| `~/.dev-monitor/config.json` | API key + login timestamp |
| `~/.dev-monitor/queue.json` | Persisted event queue (survives restarts) |
| `~/.dev-monitor/daemon.pid` | Daemon PID |
| `~/.dev-monitor/daemon.log` | Daemon stdout/stderr |

### Environment variables

| Variable | Default | Description |
|---|---|---|

---

## Shell hook details

### Zsh (preexec)

Uses zsh's built-in `preexec` hook via `add-zsh-hook`. Fires **before** each command executes.

### Bash (DEBUG trap + PROMPT_COMMAND)

Uses the `PROMPT_COMMAND` mechanism to compare history entries after each command. Commands are de-duplicated.

### Fish

A named function `__dev_monitor_preexec` is written to `~/.config/fish/functions/` and auto-loaded by fish.

---

## Publishing to npm

### Prerequisites

```bash
npm login   # login to your npm account
```

### Steps

```bash
# 1. Ensure version is correct
npm version patch   # or minor / major

# 2. Dry-run to verify what will be published
npm pack --dry-run

# 3. Publish
npm publish --access public
```

### Update a published version

```bash
npm version patch          # bumps 1.0.0 → 1.0.1
npm publish --access public
```

### Scoped package (optional)

If you want `@yourorg/dev-journal-monitor`:

```json
// package.json
{
  "name": "@yourorg/dev-journal-monitor"
}
```

```bash
npm publish --access public   # required for scoped public packages
```

---

## Development

```bash
# Install dependencies
npm install

# Test the CLI locally without installing globally
node bin/index.js login
node bin/index.js status

# Link globally for testing
npm link
dev-monitor status

# Unlink
npm unlink -g dev-journal-monitor
```

---

## Privacy note

`dev-journal-monitor` tracks commands that start with specific well-known tool prefixes (npm, git, docker, etc.). It deliberately ignores noisy commands like `ls`, `cat`, `echo`, and `clear`. The API key is stored with `chmod 600` permissions. Event queues are stored locally and only sent to the configured backend.
