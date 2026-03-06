#!/usr/bin/env node

'use strict';

async function main() {
  const { Command } = await import('commander');
  const { default: chalk } = await import('chalk');

  const program = new Command();

  program
    .name('dev-monitor')
    .description('Developer activity monitoring tool — tracks terminal commands for your Dev Journal')
    .version('1.0.0');

  // ── login  → save key + auto-install hooks (tracking starts) ──────────────
  program
    .command('login')
    .description('Authenticate with your API key and start tracking automatically')
    .option('-k, --key <apiKey>', 'API key (skip interactive prompt)')
    .action(async (opts) => {
      const { login } = await import('../src/auth.js');
      try {
        await login(opts.key);
      } catch (err) {
        console.error(chalk.red('Login failed:'), err.message);
        process.exit(1);
      }
    });

  // ── logout  → uninstall hooks + remove key (tracking stops) ───────────────
  program
    .command('logout')
    .description('Remove your API key and stop tracking')
    .action(async () => {
      const { logout } = await import('../src/auth.js');
      try {
        await logout();
      } catch (err) {
        console.error(chalk.red('Logout failed:'), err.message);
        process.exit(1);
      }
    });

  // ── status ─────────────────────────────────────────────────────────────────
  program
    .command('status')
    .description('Show login and hook status')
    .action(async () => {
      const { status } = await import('../src/auth.js');
      await status();
    });

  // ── save  → manually capture an AI conversation ───────────────────────────
  program
    .command('save')
    .description('Save last AI conversation to Dev Journal (auto-reads recorded session, or pipe text)')
    .option('-t, --title <title>',   'Short title / topic for this conversation')
    .option('-s, --service <name>',  'AI service name (ollama, claude, chatgpt…)')
    .option('-d, --dir <directory>', 'Working directory')
    .action(async (opts) => {
      const { saveConversation } = await import('../src/conversationSaver.js');
      try {
        await saveConversation({
          title           : opts.title,
          aiService       : opts.service,
          workingDirectory: opts.dir || process.cwd(),
        });
      } catch (err) {
        console.error(chalk.red('Save failed:'), err.message);
        process.exit(1);
      }
    });

  // ── update-hooks  → refresh hook block without logout/login ──────────────
  program
    .command('update-hooks')
    .description('Refresh shell hooks to the latest version (no logout needed)')
    .action(async () => {
      const { uninstallHooks, installHooks } = await import('../src/hookInstaller.js');
      try {
        await uninstallHooks({ silent: true });
        await installHooks({ skipKeyPrompt: true });
        console.log(chalk.green('✓ Hooks updated.'));
        console.log(chalk.cyan('Run:  source ~/.zshrc'));
      } catch (err) {
        console.error(chalk.red('Update failed:'), err.message);
        process.exit(1);
      }
    });

  // ── track  (internal — called by shell preexec hook on every command) ──────
  program
    .command('track <command...>')
    .description('Record a terminal command (called automatically by shell hooks)')
    .option('-d, --dir <directory>', 'Working directory')
    .option('--exit-code <code>',   'Exit code', '0')
    .action(async (cmdParts, opts) => {
      const { trackCommand } = await import('../src/commandTracker.js');
      try {
        await trackCommand({
          command         : cmdParts.join(' '),
          workingDirectory: opts.dir || process.cwd(),
          exitCode        : parseInt(opts.exitCode, 10),
        });
      } catch {
        // Never interrupt the shell
      }
    });

  program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
