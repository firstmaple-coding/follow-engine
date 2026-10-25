#!/usr/bin/env node
// Manual blog workflow. stdout is preparation JSON; fetch logs go to stderr.
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TIME_ZONE, localDate, refreshReason } from './daily-freshness.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));

function run(script, args) {
  const result = spawnSync(process.execPath, [join(scriptDir, script), ...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    throw new Error(`${script} failed; no cached digest will be returned. ${result.error?.message || `Exit ${result.status}`}`);
  }
  return result.stdout;
}

async function main() {
  const args = process.argv.slice(2);
  const options = { '--feed-dir': '.runtime', '--timezone': process.env.DIGEST_TIMEZONE || DEFAULT_TIME_ZONE, '--language': 'zh' };
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force-refresh') { force = true; continue; }
    if (!(args[i] in options) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${args[i]}`);
    options[args[i]] = args[++i];
  }
  if (!['en', 'zh', 'bilingual'].includes(options['--language'])) throw new Error('Invalid --language');
  const feedDir = resolve(options['--feed-dir']);
  const timeZone = options['--timezone'];
  let feed = null;
  try { feed = JSON.parse(await readFile(join(feedDir, 'feed-blogs.json'), 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err; }
  const reason = refreshReason(feed, { timeZone, force });
  if (reason) {
    console.error(`Refreshing blogs: ${reason} (${timeZone})`);
    run('generate-feed.js', ['--blogs-only', '--feed-dir', feedDir]);
  }
  const output = JSON.parse(run('prepare-digest.js', [
    '--local', '--blogs-only', '--daily', '--timezone', timeZone,
    '--feed-dir', feedDir, '--max-feed-age-hours', '24', '--language', options['--language']
  ]));
  // The daily report curates for personal usefulness instead of summarizing every source.
  // Override both old editorial templates so they cannot reintroduce a technical news roundup.
  const personalPrompt = await readFile(join(scriptDir, '..', 'prompts', 'personal-daily-digest.md'), 'utf8');
  output.prompts.summarize_blogs = personalPrompt;
  output.prompts.digest_intro = personalPrompt;
  output.editorial = { profile: 'personal-use', maxItems: 3, maxExperiments: 1 };
  output.run = {
    mode: reason ? 'refreshed' : 'cache', refreshReason: reason,
    timeZone, reportDate: localDate(Date.now(), timeZone),
    fetchedAt: output.stats.feedGeneratedAt,
    newPosts: reason ? output.blogs.filter(b => b.discovery === 'new').length : 0,
    retainedPosts: reason ? output.blogs.filter(b => b.discovery === 'retained').length : 0,
    cachedPosts: reason ? 0 : output.blogs.length,
    failedSources: output.stats.failedBlogSources,
    excludedPosts: output.stats.excludedBlogPosts
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exitCode = 1;
});
