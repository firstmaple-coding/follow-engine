import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { filterCurrentBlogs, refreshReason } from '../scripts/daily-freshness.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const now = Date.parse('2026-10-10T14:30:00Z');
const article = { title: 'Test', url: 'https://example.com/a', content: 'Example body', publishedAt: new Date(now - 3600000).toISOString() };
const feed = generatedAt => ({ generatedAt, blogs: [article] });

test('Previous local day refreshes even below 24 hours; same day reuses; force overrides', () => {
  assert.equal(refreshReason(feed('2026-10-09T15:20:00Z'), { now }), 'previous-day');
  assert.equal(refreshReason(feed('2026-10-10T05:00:00Z'), { now }), null);
  assert.equal(refreshReason(feed('2026-10-10T05:00:00Z'), { now, force: true }), 'forced');
});

test('Local midnight differs from UTC and system timezone; DST fallback still caps at 24 hours', () => {
  const utcMidnight = Date.parse('2026-10-10T01:00:00Z');
  const f = { generatedAt: '2026-10-09T23:30:00Z', blogs: [{ ...article, publishedAt: '2026-10-09T20:00:00Z' }] };
  assert.equal(refreshReason(f, { now: utcMidnight }), null);
  assert.equal(refreshReason(f, { now: utcMidnight, timeZone: 'UTC' }), 'previous-day');
  const dst = { generatedAt: '2026-11-01T04:01:00Z', blogs: [{ ...article, publishedAt: '2026-11-01T04:00:00Z' }] };
  assert.equal(refreshReason(dst, { now: Date.parse('2026-11-02T04:30:00Z') }), 'older-than-24-hours');
  assert.throws(() => refreshReason(null, { now, timeZone: 'Not/A_Zone' }), RangeError);
});

test('Missing, invalid, future, empty snapshots refresh; articles expire on each reuse', () => {
  assert.equal(refreshReason(null, { now }), 'missing-feed');
  for (const timestamp of ['invalid', '2026-10-11T00:00:00Z']) assert.equal(refreshReason(feed(timestamp), { now }), 'invalid-timestamp');
  const expired = { ...article, publishedAt: new Date(now - 73 * 3600000).toISOString() };
  const boundary = { ...article, publishedAt: new Date(now - 72 * 3600000).toISOString() };
  const future = { ...article, publishedAt: new Date(now + 1000).toISOString() };
  assert.deepEqual(filterCurrentBlogs([article, expired, boundary, future, { ...article, publishedAt: null }, { ...article, content: '' }], now), [article, boundary]);
  assert.equal(refreshReason({ generatedAt: '2026-10-10T05:00:00Z', blogs: [expired] }, { now }), 'empty-feed');
});

test('Runner refreshes, reuses, forces, filters and fails closed through real preparation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe-daily-'));
  try {
    const scripts = join(dir, 'scripts');
    const data = join(dir, 'data');
    mkdirSync(scripts); mkdirSync(data); mkdirSync(join(dir, 'prompts'));
    copyFileSync(join(root, 'prompts', 'personal-daily-digest.md'), join(dir, 'prompts', 'personal-daily-digest.md'));
    writeFileSync(join(scripts, 'package.json'), '{"type":"module"}');
    for (const name of ['daily-freshness.js', 'run-daily-digest.js', 'prepare-digest.js']) copyFileSync(join(root, 'scripts', name), join(scripts, name));
    // Deterministic public-source stand-in, with real runner subprocess and prepare-digest.
    writeFileSync(join(scripts, 'generate-feed.js'), `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      if(process.env.FAIL_FETCH === '1') process.exit(1);
      const dir=process.argv[process.argv.indexOf('--feed-dir')+1];
      const post={ title:'New',url:'https://example.com/new',content:'Real fixture content',publishedAt:new Date().toISOString(),discovery:'new' };
      writeFileSync(join(dir,'feed-blogs.json'),JSON.stringify({generatedAt:new Date().toISOString(), blogs:process.env.EMPTY_FETCH==='1'?[]:[post,{...post,url:'https://example.com/old',discovery:'retained'}],stats:{failedSources:1},errors:['Blog: example source failed']}));
    `);
    const runner = (...args) => spawnSync(process.execPath, [join(scripts, 'run-daily-digest.js'), '--feed-dir', data, ...args], {
      encoding: 'utf8', env: { ...process.env, FEED_SOURCE: 'local', DIGEST_TIMEZONE: 'America/New_York',
        MAX_FEED_AGE_HOURS: '', LOCAL_PROMPTS_DIR: join(root, 'prompts'), FOLLOW_BUILDERS_USER_DIR: join(dir, 'user') }
    });
    const path = join(data, 'feed-blogs.json');
    writeFileSync(path, JSON.stringify({ generatedAt: new Date(Date.now()-48*3600000).toISOString(), blogs:[article] }));
    let result = runner();
    assert.equal(result.status, 0, result.stderr);
    let out = JSON.parse(result.stdout);
    const personalPrompt = readFileSync(join(root, 'prompts', 'personal-daily-digest.md'), 'utf8');
    assert.equal(out.prompts.summarize_blogs, personalPrompt);
    assert.equal(out.prompts.digest_intro, personalPrompt);
    assert.deepEqual(out.editorial, { profile: 'personal-use', maxItems: 3, maxExperiments: 1 });
    assert.equal(out.run.mode, 'refreshed');
    assert.equal(out.run.newPosts, 1); assert.equal(out.run.retainedPosts, 1);
    assert.equal(out.run.failedSources, 1); assert.ok(out.errors.some(e=>e.includes('example source failed')));
    const saved = JSON.parse(readFileSync(path));
    saved.blogs.push({ ...saved.blogs[0], url:'https://example.com/expired', publishedAt:new Date(Date.now()-73*3600000).toISOString() });
    writeFileSync(path,JSON.stringify(saved));
    result=runner(); out=JSON.parse(result.stdout);
    assert.equal(out.run.mode,'cache'); assert.equal(out.run.newPosts,0);
    assert.equal(out.run.cachedPosts,2); assert.equal(out.run.excludedPosts,1);
    result=runner('--force-refresh'); out=JSON.parse(result.stdout);
    assert.equal(out.run.mode,'refreshed'); assert.equal(out.run.refreshReason,'forced');
    // A valid cache must never leak as successful output after a forced fetch failure.
    process.env.FAIL_FETCH='1';
    result=runner('--force-refresh');
    assert.equal(result.status,1); assert.equal(result.stdout,''); assert.match(result.stderr,/no cached digest/);
    delete process.env.FAIL_FETCH;
    process.env.EMPTY_FETCH='1';
    result=runner('--force-refresh'); out=JSON.parse(result.stdout);
    assert.equal(result.status,0,result.stderr); assert.equal(out.stats.blogPosts,0);
    delete process.env.EMPTY_FETCH;
    result=runner('--timezone','Not/A_Zone'); assert.equal(result.status,1);
  } finally {
    delete process.env.FAIL_FETCH; delete process.env.EMPTY_FETCH;
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '\\') || resolve(dir).startsWith(resolve(tmpdir()) + '/'));
    rmSync(dir, { recursive:true, force:true });
  }
});
