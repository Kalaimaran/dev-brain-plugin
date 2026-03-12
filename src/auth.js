'use strict';

/**
 * auth.js
 * Manages auth session storage and token lifecycle in ~/.dev-monitor/config.json
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { getBaseUrl } from './baseUrl.js';

const CONFIG_DIR  = path.join(os.homedir(), '.dev-monitor');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeTokenType(tokenType) {
  return tokenType || 'Bearer';
}

function computeExpiresAt(expiresInMs) {
  const expiresIn = Number(expiresInMs);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return new Date(Date.now() + expiresIn).toISOString();
}

function parseAuthPayload(raw) {
  const payload = raw?.data ?? raw ?? {};
  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    tokenType: normalizeTokenType(payload.tokenType),
    expiresIn: payload.expiresIn,
    user: payload.user ?? null,
  };
}

function parseUserPayload(raw) {
  return raw?.data ?? raw ?? null;
}

function formatAxiosError(err) {
  const status = err.response?.status;
  const data = err.response?.data;

  let message = null;
  if (typeof data === 'string' && data.trim()) {
    message = data.trim();
  } else if (typeof data?.message === 'string' && data.message.trim()) {
    message = data.message.trim();
  } else if (typeof data?.error === 'string' && data.error.trim()) {
    message = data.error.trim();
  } else if (Array.isArray(data?.errors) && data.errors.length > 0) {
    message = data.errors
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (typeof entry?.message === 'string') return entry.message;
        return null;
      })
      .filter(Boolean)
      .join(', ');
  } else if (typeof data?.detail === 'string' && data.detail.trim()) {
    message = data.detail.trim();
  }

  if (!message) message = err.message;
  return status ? `HTTP ${status}: ${message}` : message;
}

function isAuthError(err) {
  const status = err.response?.status;
  return status === 401 || status === 403;
}

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
  await fs.chmod(CONFIG_FILE, 0o600);
}

async function saveAuthSession(session, loggedInAt = new Date().toISOString()) {
  const config = await readConfig();
  config.auth = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    tokenType: normalizeTokenType(session.tokenType),
    expiresIn: session.expiresIn ?? null,
    expiresAt: computeExpiresAt(session.expiresIn),
    user: session.user ?? config.auth?.user ?? null,
  };
  config.loggedInAt = loggedInAt;

  // Remove legacy API-key auth storage.
  delete config.apiKey;

  await writeConfig(config);
}

async function clearAuthSession() {
  const config = await readConfig();
  delete config.auth;
  delete config.apiKey;
  delete config.loggedInAt;
  await writeConfig(config);
}

async function fetchCurrentUser(accessToken, tokenType = 'Bearer') {
  const { default: axios } = await import('axios');
  const baseUrl = await getBaseUrl();
  const response = await axios.get(`${baseUrl}/api/v1/auth/me`, {
    headers: {
      'Authorization': `${normalizeTokenType(tokenType)} ${accessToken}`,
      'User-Agent': 'dev-journal-monitor/1.0.0',
    },
    timeout: 8_000,
  });

  return parseUserPayload(response.data);
}

async function refreshTokens(refreshToken) {
  const { default: axios } = await import('axios');
  const baseUrl = await getBaseUrl();

  const response = await axios.post(
    `${baseUrl}/api/v1/auth/refresh`,
    { refreshToken },
    {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'dev-journal-monitor/1.0.0',
      },
      timeout: 8_000,
    },
  );

  const refreshed = parseAuthPayload(response.data);
  if (!refreshed.accessToken) {
    throw new Error('Refresh response did not include an access token.');
  }
  return refreshed;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Login: prompt for email/password → login → validate /auth/me → save → install hooks.
 *
 * @param {object} [opts]
 * @param {string} [opts.email]
 * @param {string} [opts.password]
 */
export async function login(opts = {}) {
  const { default: chalk } = await import('chalk');
  const { default: inquirer } = await import('inquirer');
  const { default: ora } = await import('ora');
  const { default: axios } = await import('axios');

  let identifier = opts.email?.trim();
  let password = opts.password;

  if (!identifier || !password) {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'identifier',
        message: 'Enter your email or username:',
        when: () => !identifier,
        validate: (v) => {
          const value = v.trim();
          if (!value) return 'Email or username cannot be empty';
          return true;
        },
      },
      {
        type: 'password',
        name: 'password',
        message: 'Enter your password:',
        when: () => !password,
        mask: '*',
        validate: (v) => (v.trim().length > 0 ? true : 'Password cannot be empty'),
      },
    ]);

    identifier = identifier || answers.identifier?.trim();
    password = password || answers.password;
  }

  if (!identifier) {
    throw new Error('Email or username cannot be empty.');
  }

  const spinner = ora('Logging in...').start();

  try {
    const baseUrl = await getBaseUrl();
    const response = await axios.post(
      `${baseUrl}/api/v1/auth/login/ext`,
      {
        email: identifier,
        username: identifier,
        emailOrUsername: identifier,
        password,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'dev-journal-monitor/1.0.0',
        },
        timeout: 8_000,
      },
    );

    const session = parseAuthPayload(response.data);
    if (!session.accessToken || !session.refreshToken) {
      throw new Error('Login response did not include access and refresh tokens.');
    }

    const user = await fetchCurrentUser(session.accessToken, session.tokenType);
    session.user = user;

    await saveAuthSession(session);
    spinner.succeed('Login successful.');
  } catch (err) {
    const formattedError = formatAxiosError(err);
    spinner.fail(`Login failed: ${formattedError}`);
    throw new Error(formattedError);
  }

  console.log(chalk.cyan('\nInstalling shell hooks...'));
  const { installHooks } = await import('./hookInstaller.js');
  await installHooks({ skipKeyPrompt: true });
}

/**
 * Return true if an auth session (access token) is stored.
 */
export async function hasApiKey() {
  const config = await readConfig();
  return !!config.auth?.accessToken;
}

/**
 * Returns a valid auth session. Tries /auth/me first, then /auth/refresh + /auth/me.
 * If refresh fails, stored auth is cleared and caller must login again.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh=false]
 */
export async function getValidAuthSession({ forceRefresh = false } = {}) {
  const config = await readConfig();
  const auth = config.auth;

  if (!auth?.accessToken) {
    throw new Error('Not logged in. Run `dev-monitor login` first.');
  }

  const tokenType = normalizeTokenType(auth.tokenType);

  if (!forceRefresh) {
    try {
      const user = await fetchCurrentUser(auth.accessToken, tokenType);
      if (user && JSON.stringify(user) !== JSON.stringify(auth.user ?? null)) {
        auth.user = user;
        config.auth = auth;
        await writeConfig(config);
      }
      return {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        tokenType,
        user: user ?? auth.user ?? null,
      };
    } catch (err) {
      if (!isAuthError(err)) {
        throw new Error(`Could not validate session: ${formatAxiosError(err)}`);
      }
      // Auth failure: fall through to refresh attempt.
    }
  }

  if (!auth.refreshToken) {
    await clearAuthSession();
    throw new Error('Session expired and no refresh token available. Run `dev-monitor login` again.');
  }

  try {
    const refreshed = await refreshTokens(auth.refreshToken);
    const user = await fetchCurrentUser(refreshed.accessToken, refreshed.tokenType);

    await saveAuthSession({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || auth.refreshToken,
      tokenType: refreshed.tokenType || tokenType,
      expiresIn: refreshed.expiresIn ?? auth.expiresIn,
      user,
    }, config.loggedInAt);

    return {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || auth.refreshToken,
      tokenType: normalizeTokenType(refreshed.tokenType || tokenType),
      user,
    };
  } catch (err) {
    if (isAuthError(err)) {
      await clearAuthSession();
      throw new Error(`Session expired. Please login again. (${formatAxiosError(err)})`);
    }
    throw new Error(`Could not refresh session: ${formatAxiosError(err)}`);
  }
}

/**
 * Return a valid access token (legacy function name for compatibility).
 */
export async function getApiKey() {
  const session = await getValidAuthSession();
  return session.accessToken;
}

/**
 * Logout: uninstall shell hooks and clear stored auth session.
 */
export async function logout() {
  const { default: chalk } = await import('chalk');

  console.log(chalk.cyan('Removing shell hooks...'));
  const { uninstallHooks } = await import('./hookInstaller.js');
  await uninstallHooks({ silent: false });

  await clearAuthSession();

  console.log(chalk.green('✓ Logged out. Tracking has stopped.'));
}

/**
 * Print auth status and user details.
 */
export async function status() {
  const { default: chalk } = await import('chalk');

  const config = await readConfig();
  if (!config.auth?.accessToken) {
    console.log(chalk.red('✗ Not logged in'));
    console.log('  Run `dev-monitor login` to authenticate and start tracking.');
    return;
  }

  try {
    const session = await getValidAuthSession();
    const token = session.accessToken;
    const masked = `${token.slice(0, 6)}...${token.slice(-4)}`;
    const user = session.user ?? {};

    console.log(chalk.green('✓ Authenticated'));
    console.log(`  Access token : ${masked}`);
    console.log(`  Since        : ${config.loggedInAt ?? 'unknown'}`);
    console.log(`  Email        : ${user.email ?? 'unknown'}`);
    console.log(`  Name         : ${user.fullName ?? 'unknown'}`);
    console.log(`  Role         : ${user.role ?? 'unknown'}`);

    const orgName = user.organization?.name || user.organization?.id || 'unknown';
    console.log(`  Organization : ${orgName}`);
  } catch (err) {
    const isExpired = /Session expired/i.test(err.message);
    console.log(chalk.red(isExpired ? '✗ Session expired' : '✗ Unable to verify session'));
    console.log(`  ${err.message}`);
    if (isExpired) {
      console.log('  Run `dev-monitor login` to continue.');
    }
  }
}
