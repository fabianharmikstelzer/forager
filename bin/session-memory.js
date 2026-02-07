#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { indexSessions } from '../src/indexer.js';
import { searchSessions, resolveSessionId } from '../src/search.js';
import { getStats, closeDb } from '../src/db.js';

const program = new Command();

program
  .name('forager')
  .description('Forage through your Claude Code session history')
  .version('1.0.0');

program
  .command('index')
  .description('Index all Claude Code sessions (incremental by default)')
  .option('--full', 'Re-index everything from scratch')
  .action(async (opts) => {
    console.log(chalk.blue('Foraging sessions...'));
    console.log(chalk.dim('(First run will download the embedding model ~22MB)\n'));

    const result = await indexSessions({
      full: opts.full,
      onProgress: (event) => {
        if (event.type === 'start') {
          console.log(chalk.dim(`Found ${event.total} sessions across all projects\n`));
        } else if (event.type === 'indexed') {
          const shortSummary = (event.summary || 'untitled').slice(0, 60);
          console.log(chalk.green(`  + ${shortSummary}`));
        } else if (event.type === 'skip') {
          // silent
        } else if (event.type === 'error') {
          console.log(chalk.red(`  ! ${event.message}`));
        }
      },
    });

    console.log('');
    console.log(chalk.green(`Indexed: ${result.indexed}`));
    if (result.skipped > 0) console.log(chalk.dim(`Skipped (unchanged): ${result.skipped}`));
    if (result.errors > 0) console.log(chalk.red(`Errors: ${result.errors}`));
    closeDb();
  });

program
  .command('search <query>')
  .description('Semantic search across all indexed sessions')
  .option('-n, --limit <number>', 'Number of results', '5')
  .action(async (query, opts) => {
    const limit = parseInt(opts.limit, 10) || 5;
    const results = await searchSessions(query, { limit });

    if (results.length === 0) {
      console.log(chalk.yellow('No sessions indexed yet. Run `forager index` first.'));
      closeDb();
      return;
    }

    console.log('');
    results.forEach((r, i) => {
      const score = r.score.toFixed(2);
      const date = r.modified ? formatDate(r.modified) : '?';
      const summary = r.summary || 'untitled';
      const shortId = r.session_id.slice(0, 8);
      const project = r.project_path ? shortenPath(r.project_path) : '';

      console.log(chalk.white.bold(` ${i + 1}. `) + chalk.dim(`[${score}] `) + chalk.white(summary) + chalk.dim(` (${date})`));
      if (project) {
        let line = `    Project: ${project}`;
        if (r.git_branch) line += `  Branch: ${r.git_branch}`;
        console.log(chalk.dim(line));
      }
      console.log(chalk.cyan(`    Resume: claude --resume ${shortId}`));
      console.log('');
    });

    closeDb();
  });

program
  .command('resume <id>')
  .description('Resume a session by ID, prefix, or result number')
  .action((id) => {
    const sessionId = resolveSessionId(id);
    if (!sessionId) {
      console.log(chalk.red(`Could not find session matching "${id}"`));
      closeDb();
      process.exit(1);
    }

    console.log(chalk.blue(`Resuming session ${sessionId.slice(0, 8)}...`));
    closeDb();
    execFileSync('claude', ['--resume', sessionId], { stdio: 'inherit' });
  });

program
  .command('stats')
  .description('Show index statistics')
  .action(() => {
    const stats = getStats();

    if (stats.totalSessions === 0) {
      console.log(chalk.yellow('No sessions indexed yet. Run `forager index` first.'));
      closeDb();
      return;
    }

    console.log('');
    console.log(chalk.white.bold('Forager Stats'));
    console.log(chalk.dim('─'.repeat(35)));
    console.log(`  Sessions indexed:  ${chalk.green(stats.totalSessions)}`);
    console.log(`  Projects:          ${chalk.green(stats.projectCount)}`);
    console.log(`  Oldest session:    ${stats.oldestSession ? formatDate(stats.oldestSession) : '?'}`);
    console.log(`  Newest session:    ${stats.newestSession ? formatDate(stats.newestSession) : '?'}`);
    console.log('');

    closeDb();
  });

// --- Setup / Teardown ---

const LAUNCHD_LABEL = 'com.session-forager.index';
const LAUNCHD_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const CRON_MARKER = '# session-forager auto-index';

function buildPlist(nodePath, binPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${binPath}</string>
    <string>index</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/session-forager.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/session-forager.log</string>
</dict>
</plist>`;
}

program
  .command('setup')
  .description('Install daily auto-indexing (launchd on macOS, cron on Linux)')
  .action(() => {
    const binPath = fileURLToPath(import.meta.url);
    const nodePath = process.execPath;

    if (platform() === 'darwin') {
      setupLaunchd(nodePath, binPath);
    } else {
      setupCron(nodePath, binPath);
    }
  });

program
  .command('teardown')
  .description('Remove daily auto-indexing')
  .action(() => {
    if (platform() === 'darwin') {
      teardownLaunchd();
    } else {
      teardownCron();
    }
  });

function setupLaunchd(nodePath, binPath) {
  try {
    // Unload existing agent if present
    if (existsSync(LAUNCHD_PLIST)) {
      try { execSync(`launchctl unload ${LAUNCHD_PLIST} 2>/dev/null`); } catch { /* ok */ }
    }

    writeFileSync(LAUNCHD_PLIST, buildPlist(nodePath, binPath));
    execSync(`launchctl load ${LAUNCHD_PLIST}`);

    console.log(chalk.green('Launch agent installed — sessions will auto-index daily at 3am.'));
    console.log(chalk.dim('Missed runs (e.g. laptop was asleep) will run on next wake.'));
    console.log(chalk.dim('Logs: /tmp/session-forager.log'));
  } catch (err) {
    console.log(chalk.red(`Failed to install launch agent: ${err.message}`));
    process.exit(1);
  }
}

function teardownLaunchd() {
  if (!existsSync(LAUNCHD_PLIST)) {
    console.log(chalk.dim('No launch agent found — nothing to remove.'));
    return;
  }
  try {
    execSync(`launchctl unload ${LAUNCHD_PLIST} 2>/dev/null`);
  } catch { /* ok */ }
  unlinkSync(LAUNCHD_PLIST);
  console.log(chalk.green('Launch agent removed.'));
}

function setupCron(nodePath, binPath) {
  const cronLine = `0 3 * * * ${nodePath} ${binPath} index >> /tmp/session-forager.log 2>&1 ${CRON_MARKER}`;
  try {
    let existing = '';
    try {
      existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
    } catch { /* no existing crontab */ }

    const filtered = existing
      .split('\n')
      .filter((line) => !line.includes(CRON_MARKER))
      .join('\n')
      .replace(/\n+$/, '');

    const newCrontab = filtered ? `${filtered}\n${cronLine}\n` : `${cronLine}\n`;
    execSync('crontab -', { input: newCrontab, encoding: 'utf-8' });

    console.log(chalk.green('Cron job installed — sessions will auto-index daily at 3am.'));
    console.log(chalk.dim('Logs: /tmp/session-forager.log'));
  } catch (err) {
    console.log(chalk.red(`Failed to install cron job: ${err.message}`));
    process.exit(1);
  }
}

function teardownCron() {
  try {
    let existing = '';
    try {
      existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
    } catch {
      console.log(chalk.dim('No crontab found — nothing to remove.'));
      return;
    }

    const filtered = existing
      .split('\n')
      .filter((line) => !line.includes(CRON_MARKER))
      .join('\n')
      .replace(/\n+$/, '');

    if (filtered) {
      execSync('crontab -', { input: filtered + '\n', encoding: 'utf-8' });
    } else {
      execSync('crontab -r 2>/dev/null', { encoding: 'utf-8' });
    }

    console.log(chalk.green('Cron job removed.'));
  } catch (err) {
    console.log(chalk.red(`Failed to remove cron job: ${err.message}`));
    process.exit(1);
  }
}

// --- Helpers ---

function formatDate(isoString) {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '?';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function shortenPath(p) {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

program.parseAsync();
