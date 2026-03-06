'use strict';

/**
 * auth.js
 * Manages API key storage and retrieval in ~/.dev-monitor/config.json
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR  = path.join(os.homedir(), '.dev-monitor');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

async function readConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeConfig(data) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  // Restrict permissions so only the owner can read the file
  await fs.chmod(CONFIG_FILE, 0o600);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Interactive login: prompts for an API key, validates it against the backend,
 * and persists it to ~/.dev-monitor/config.json.
 *
 * @param {string|undefined} keyOverride  Pre-supplied key (from --key flag).
 */
/**
 * Login: prompt for API key → validate → save → auto-install shell hooks.
 * Tracking starts automatically after this completes.
 *
 * @param {string|undefined} keyOverride  Key passed via --key flag (skips prompt).
 */
export async function login(keyOverride) {
  const { default: chalk }    = await import('chalk');
  const { default: inquirer } = await import('inquirer');
  const { default: ora }      = await import('ora');

  let apiKey = keyOverride;

  if (!apiKey) {
    const { key } = await inquirer.prompt([
      {
        type    : 'password',
        name    : 'key',
        message : 'Enter your Dev Monitor API key:',
        mask    : '*',
        validate: (v) => v.trim().length > 0 ? true : 'API key cannot be empty',
      },
    ]);
    apiKey = key.trim();
  }

  // ── Validate against backend ──────────────────────────────────────────────
  const spinner = ora('Validating API key…').start();
  try {
    const { validateApiKey } = await import('./apiClient.js');
    await validateApiKey(apiKey);
    spinner.succeed('API key validated.');
  } catch (err) {
    spinner.fail(`Could not reach backend: ${err.message}`);
    const { proceed } = await inquirer.prompt([
      {
        type   : 'confirm',
        name   : 'proceed',
        message: 'Save key anyway and continue?',
        default: true,
      },
    ]);
    if (!proceed) return;
  }

  // ── Save key ──────────────────────────────────────────────────────────────
  const config = await readConfig();
  config.apiKey     = apiKey;
  config.loggedInAt = new Date().toISOString();
  await writeConfig(config);
  console.log(chalk.green('✓ API key saved.'));

  // ── Auto-install shell hooks so tracking starts immediately ───────────────
  console.log(chalk.cyan('\nInstalling shell hooks…'));
  const { installHooks } = await import('./hookInstaller.js');
  await installHooks({ skipKeyPrompt: true });
}

/**
 * Save an API key directly (used by hookInstaller during setup).
 */
export async function saveApiKey(apiKey) {
  const config = await readConfig();
  config.apiKey     = apiKey;
  config.loggedInAt = new Date().toISOString();
  await writeConfig(config);
}

/**
 * Return true if an API key is already stored.
 */
export async function hasApiKey() {
  const config = await readConfig();
  return !!config.apiKey;
}

/**
 * Logout: auto-uninstall shell hooks → remove API key.
 * Tracking stops immediately.
 */
export async function logout() {
  const { default: chalk } = await import('chalk');

  // ── Remove shell hooks first so no more events fire ───────────────────────
  console.log(chalk.cyan('Removing shell hooks…'));
  const { uninstallHooks } = await import('./hookInstaller.js');
  await uninstallHooks({ silent: false });

  // ── Wipe stored key ───────────────────────────────────────────────────────
  const config = await readConfig();
  delete config.apiKey;
  delete config.loggedInAt;
  await writeConfig(config);

  console.log(chalk.green('✓ Logged out. Tracking has stopped.'));
}

/**
 * Return the stored API key, or throw if not found.
 */
export async function getApiKey() {
  const config = await readConfig();
  if (!config.apiKey) {
    throw new Error('Not logged in. Run `dev-monitor login` first.');
  }
  return config.apiKey;
}

/**
 * Print auth + daemon status to stdout.
 */
export async function status() {
  const { default: chalk } = await import('chalk');

  const config = await readConfig();

  if (config.apiKey) {
    const masked = config.apiKey.slice(0, 4) + '****' + config.apiKey.slice(-4);
    console.log(chalk.green('✓ Authenticated'));
    console.log(`  API key : ${masked}`);
    console.log(`  Since   : ${config.loggedInAt ?? 'unknown'}`);
  } else {
    console.log(chalk.red('✗ Not logged in'));
    console.log('  Run `dev-monitor login` to authenticate and start tracking.');
  }
}
