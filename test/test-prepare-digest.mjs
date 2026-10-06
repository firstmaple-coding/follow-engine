#!/usr/bin/env node

// ============================================================================
// Follow Engine — Standalone Portable Test Suite for prepare-digest.js
// ============================================================================
// This test suite runs without machine-specific absolute paths.
// It verifies:
// 1. Default feed & prompt URLs strictly target firstmaple-coding/follow-engine
// 2. Explicit --local mode performs ZERO network requests
// 3. Partial feed failure (HTTP 404 & Network error diagnostics)
// 4. All feeds failure (fatal exit 1 with structured diagnostic JSON)
// 5. Remote prompt missing with graceful local template fallback & warning
// 6. Essential prompt missing (per SKILL.md usage conditions) triggers fatal exit 1
// 7. Non-essential prompt missing (e.g. summarize-blogs) does NOT block the digest
// ============================================================================

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, copyFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import assert from 'assert';

// ----------------------------------------------------------------------------
// Mode A: Preload Mock Environment (activated when imported via --import)
// ----------------------------------------------------------------------------
if (process.env.__PREPARE_DIGEST_MOCK_PRELOAD__ === '1') {
  const scenario = process.env.TEST_SCENARIO;

  const sampleFeedX = {
    generatedAt: new Date().toISOString(),
    x: [{ name: "Mock Builder", handle: "mockbuilder", bio: "AI Dev", tweets: [{ id: "1", text: "hello", url: "https://x.com/1" }] }]
  };
  const sampleFeedPodcasts = {
    generatedAt: new Date().toISOString(),
    podcasts: [{ name: "Mock Pod", title: "Ep 1", url: "https://youtube.com/watch?v=123", transcript: "Transcript 1" }]
  };
  const sampleFeedBlogs = {
    generatedAt: new Date().toISOString(),
    blogs: [{ title: "Blog 1", url: "https://example.com/1", content: "Content 1" }]
  };

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    // Emit trace to stderr for URL assertions
    console.error(`__TRACE_FETCH__:${urlStr}`);

    if (scenario === 'explicit_local') {
      throw new Error(`Unexpected network request in local mode to: ${urlStr}`);
    }

    if (scenario === 'remote_success') {
      if (urlStr.endsWith('feed-x.json')) {
        return new Response(JSON.stringify(sampleFeedX), { status: 200, statusText: 'OK' });
      }
      if (urlStr.endsWith('feed-podcasts.json')) {
        return new Response(JSON.stringify(sampleFeedPodcasts), { status: 200, statusText: 'OK' });
      }
      if (urlStr.endsWith('feed-blogs.json')) {
        return new Response(JSON.stringify(sampleFeedBlogs), { status: 200, statusText: 'OK' });
      }
      if (urlStr.includes('/prompts/')) {
        return new Response("# Remote Mock Prompt\nRules here.", { status: 200, statusText: 'OK' });
      }
      return new Response("Not Found", { status: 404, statusText: 'Not Found' });
    }

    if (scenario === 'partial_missing') {
      if (urlStr.endsWith('feed-x.json')) {
        return new Response("404 Not Found", { status: 404, statusText: 'Not Found' });
      }
      if (urlStr.endsWith('feed-blogs.json')) {
        throw new Error("connect ETIMEDOUT raw.githubusercontent.com:443");
      }
      if (urlStr.endsWith('feed-podcasts.json')) {
        return new Response(JSON.stringify(sampleFeedPodcasts), { status: 200, statusText: 'OK' });
      }
      if (urlStr.includes('/prompts/')) {
        return new Response("# Remote Mock Prompt\nRules here.", { status: 200, statusText: 'OK' });
      }
      return new Response("Not Found", { status: 404, statusText: 'Not Found' });
    }

    if (scenario === 'all_failed') {
      if (urlStr.endsWith('feed-x.json')) {
        return new Response("404 Not Found", { status: 404, statusText: 'Not Found' });
      }
      if (urlStr.endsWith('feed-podcasts.json')) {
        return new Response("404 Not Found", { status: 404, statusText: 'Not Found' });
      }
      if (urlStr.endsWith('feed-blogs.json')) {
        throw new Error("DNS resolution failed");
      }
      if (urlStr.includes('/prompts/')) {
        return new Response("# Remote Mock Prompt", { status: 200, statusText: 'OK' });
      }
      return new Response("Not Found", { status: 404, statusText: 'Not Found' });
    }

    if (scenario === 'digest_feeds_failed_blogs_ok') {
      if (urlStr.endsWith('feed-x.json')) {
        return new Response("404 Not Found", { status: 404, statusText: 'Not Found' });
      }
      if (urlStr.endsWith('feed-podcasts.json')) {
        return new Response("500 Internal Server Error", { status: 500, statusText: 'Internal Server Error' });
      }
      if (urlStr.endsWith('feed-blogs.json')) {
        return new Response(JSON.stringify(sampleFeedBlogs), { status: 200, statusText: 'OK' });
      }
      if (urlStr.includes('/prompts/')) {
        return new Response("# Remote Mock Prompt", { status: 200, statusText: 'OK' });
      }
      return new Response("Not Found", { status: 404, statusText: 'Not Found' });
    }

    if (scenario === 'prompt_fallback') {
      if (urlStr.endsWith('feed-x.json')) {
        return new Response(JSON.stringify(sampleFeedX), { status: 200, statusText: 'OK' });
      }
      if (urlStr.endsWith('feed-podcasts.json')) {
        return new Response(JSON.stringify(sampleFeedPodcasts), { status: 200, statusText: 'OK' });
      }
      if (urlStr.endsWith('feed-blogs.json')) {
        return new Response(JSON.stringify(sampleFeedBlogs), { status: 200, statusText: 'OK' });
      }
      // summarize-tweets.md returns 404, prompting fallback
      if (urlStr.endsWith('summarize-tweets.md')) {
        return new Response("Not Found", { status: 404, statusText: 'Not Found' });
      }
      if (urlStr.includes('/prompts/')) {
        return new Response("# Remote Prompt Content", { status: 200, statusText: 'OK' });
      }
      return new Response("Not Found", { status: 404, statusText: 'Not Found' });
    }

    if (scenario === 'essential_prompt_missing') {
      if (urlStr.endsWith('feed-x.json')) {
        return new Response(JSON.stringify(sampleFeedX), { status: 200, statusText: 'OK' });
      }
      if (urlStr.endsWith('feed-podcasts.json')) {
        return new Response(JSON.stringify(sampleFeedPodcasts), { status: 200, statusText: 'OK' });
      }
      if (urlStr.endsWith('feed-blogs.json')) {
        return new Response(JSON.stringify(sampleFeedBlogs), { status: 200, statusText: 'OK' });
      }
      // Essential prompts fail on remote
      if (urlStr.includes('/prompts/')) {
        return new Response("Not Found", { status: 404, statusText: 'Not Found' });
      }
      return new Response("Not Found", { status: 404, statusText: 'Not Found' });
    }

    if (scenario === 'non_essential_prompt_missing') {
      if (urlStr.endsWith('feed-x.json')) {
        return new Response(JSON.stringify(sampleFeedX), { status: 200, statusText: 'OK' });
      }
      if (urlStr.endsWith('feed-podcasts.json')) {
        return new Response(JSON.stringify(sampleFeedPodcasts), { status: 200, statusText: 'OK' });
      }
      if (urlStr.endsWith('feed-blogs.json')) {
        return new Response(JSON.stringify(sampleFeedBlogs), { status: 200, statusText: 'OK' });
      }
      // Non-essential prompt summarize-blogs.md fails on remote, others succeed
      if (urlStr.endsWith('summarize-blogs.md')) {
        return new Response("Not Found", { status: 404, statusText: 'Not Found' });
      }
      if (urlStr.includes('/prompts/')) {
        return new Response("# Remote Mock Prompt", { status: 200, statusText: 'OK' });
      }
      return new Response("Not Found", { status: 404, statusText: 'Not Found' });
    }

    if (scenario === 'no_updates_zh_no_translate') {
      if (urlStr.endsWith('feed-x.json')) {
        return new Response(JSON.stringify({ generatedAt: new Date().toISOString(), x: [] }), { status: 200, statusText: 'OK' });
      }
      if (urlStr.endsWith('feed-podcasts.json')) {
        return new Response(JSON.stringify({ generatedAt: new Date().toISOString(), podcasts: [] }), { status: 200, statusText: 'OK' });
      }
      if (urlStr.endsWith('feed-blogs.json')) {
        return new Response(JSON.stringify({ generatedAt: new Date().toISOString(), blogs: [] }), { status: 200, statusText: 'OK' });
      }
      // Prompts are unavailable / 404
      if (urlStr.includes('/prompts/')) {
        return new Response("Not Found", { status: 404, statusText: 'Not Found' });
      }
      return new Response("Not Found", { status: 404, statusText: 'Not Found' });
    }

    return new Response("Unhandled scenario url", { status: 500 });
  };
} else {
  // --------------------------------------------------------------------------
  // Mode B: Test Runner (invoked directly: node test/test-prepare-digest.mjs)
  // --------------------------------------------------------------------------
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = join(__dirname, '..');
  const TARGET_SCRIPT = join(REPO_ROOT, 'scripts', 'prepare-digest.js');
  const SELF_IMPORT_URL = pathToFileURL(fileURLToPath(import.meta.url)).href;

  console.log(`Running follow-engine test suite...`);
  console.log(`Repository root: ${REPO_ROOT}`);
  console.log(`Target script:   ${TARGET_SCRIPT}`);

  const ISOLATED_HOME_DIR = mkdtempSync(join(tmpdir(), 'fe-test-isolated-home-'));

  function runChild(scenario, extraArgs = [], extraEnv = {}) {
    const sanitizedEnv = { ...process.env };
    // Clear any machine-specific or user-specific environment overrides
    delete sanitizedEnv.FEED_REPO;
    delete sanitizedEnv.FEED_BRANCH;
    delete sanitizedEnv.FEED_SOURCE;
    delete sanitizedEnv.LOCAL_PROMPTS_DIR;
    delete sanitizedEnv.FOLLOW_BUILDERS_USER_DIR;

    const env = {
      ...sanitizedEnv,
      HOME: ISOLATED_HOME_DIR,
      USERPROFILE: ISOLATED_HOME_DIR,
      HOMEDRIVE: '',
      HOMEPATH: ISOLATED_HOME_DIR,
      FOLLOW_BUILDERS_USER_DIR: join(ISOLATED_HOME_DIR, '.follow-builders'),
      __PREPARE_DIGEST_MOCK_PRELOAD__: '1',
      TEST_SCENARIO: scenario,
      ...extraEnv
    };

    const args = [
      '--import',
      SELF_IMPORT_URL,
      TARGET_SCRIPT,
      ...extraArgs
    ];

    const result = spawnSync(process.execPath, args, {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf-8'
    });

    // Extract trace fetch calls
    const traceLines = (result.stderr || '')
      .split('\n')
      .filter(line => line.startsWith('__TRACE_FETCH__:'))
      .map(line => line.replace('__TRACE_FETCH__:', '').trim());

    // Filter out trace lines from stderr to inspect actual process errors
    const cleanedStderr = (result.stderr || '')
      .split('\n')
      .filter(line => !line.startsWith('__TRACE_FETCH__:'))
      .join('\n')
      .trim();

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: cleanedStderr,
      traces: traceLines
    };
  }

  let passed = 0;
  let total = 0;

  function testCase(name, fn) {
    total++;
    try {
      console.log(`\n[Test ${total}] ${name}`);
      fn();
      console.log(`  -> PASSED`);
      passed++;
    } catch (err) {
      console.error(`  -> FAILED: ${err.message}`);
      if (err.actual !== undefined && err.expected !== undefined) {
        console.error(`     Actual:`, err.actual);
        console.error(`     Expected:`, err.expected);
      }
    }
  }

  // --- 1. Default remote URLs assertion ---
  testCase('Default remote feed & prompt URLs target firstmaple-coding/follow-engine', () => {
    const res = runChild('remote_success');
    assert.strictEqual(res.status, 0, `Expected exit 0, got ${res.status}: ${res.stderr}`);

    const expectedRawBase = 'https://raw.githubusercontent.com/firstmaple-coding/follow-engine/main';
    const expectedUrls = [
      `${expectedRawBase}/feed-x.json`,
      `${expectedRawBase}/feed-podcasts.json`,
      `${expectedRawBase}/feed-blogs.json`,
      `${expectedRawBase}/prompts/summarize-podcast.md`,
      `${expectedRawBase}/prompts/summarize-tweets.md`,
      `${expectedRawBase}/prompts/summarize-blogs.md`,
      `${expectedRawBase}/prompts/digest-intro.md`,
      `${expectedRawBase}/prompts/translate.md`
    ];

    for (const expectedUrl of expectedUrls) {
      assert(
        res.traces.includes(expectedUrl),
        `Missing expected fetch URL: ${expectedUrl}\nActual requests:\n${res.traces.join('\n')}`
      );
    }

    // Verify NO requests to upstream author zarazhangrui
    for (const trace of res.traces) {
      assert(
        !trace.includes('zarazhangrui'),
        `Forbidden upstream URL detected in trace: ${trace}`
      );
    }

    const data = JSON.parse(res.stdout);
    assert.strictEqual(data.status, 'ok');
    assert.strictEqual(data.errors, undefined);
    assert.strictEqual(data.stats.podcastEpisodes, 1);
    assert.strictEqual(data.stats.xBuilders, 1);
  });

  // --- 2. Explicit local mode (--local) ---
  testCase('Explicit --local mode performs ZERO network requests', () => {
    const res = runChild('explicit_local', ['--local']);
    assert.strictEqual(res.status, 0, `Expected exit 0, got ${res.status}: ${res.stderr}`);

    assert.strictEqual(
      res.traces.length,
      0,
      `Expected 0 fetch calls in --local mode, but got ${res.traces.length}:\n${res.traces.join('\n')}`
    );

    const data = JSON.parse(res.stdout);
    assert.strictEqual(data.status, 'ok');
    assert(data.stats.totalTweets > 0, 'Should load tweets from local files');
    assert(data.stats.podcastEpisodes > 0, 'Should load podcast from local files');
  });

  // --- 3. Partial feed failure with diagnostics ---
  testCase('Partial feed failure preserves successful feeds and reports diagnostic errors', () => {
    const res = runChild('partial_missing');
    assert.strictEqual(res.status, 0, `Expected exit 0 for partial failure, got ${res.status}`);

    const data = JSON.parse(res.stdout);
    assert.strictEqual(data.status, 'ok');
    assert.strictEqual(data.podcasts.length, 1);
    assert.strictEqual(data.x.length, 0);

    assert(Array.isArray(data.errors), 'data.errors should be an array');
    const has404 = data.errors.some(e => e.includes('HTTP 404') && e.includes('tweet feed') && e.includes('feed-x.json'));
    const hasNetwork = data.errors.some(e => e.includes('Network error') && e.includes('blog feed') && e.includes('ETIMEDOUT'));

    assert(has404, `Missing HTTP 404 diagnostic in errors: ${JSON.stringify(data.errors)}`);
    assert(hasNetwork, `Missing network error diagnostic in errors: ${JSON.stringify(data.errors)}`);
  });

  // --- 4. All feeds failed fatal error ---
  testCase('All feeds failed exits with code 1 and structured error JSON on stderr', () => {
    const res = runChild('all_failed');
    assert.strictEqual(res.status, 1, `Expected exit 1 when all feeds fail, got ${res.status}`);

    let errObj = null;
    try {
      errObj = JSON.parse(res.stderr);
    } catch (e) {
      assert.fail(`Stderr is not valid JSON: ${res.stderr}`);
    }

    assert.strictEqual(errObj.status, 'error');
    assert(
      errObj.message.includes('All feed sources failed to load'),
      `Message should state all feeds failed: ${errObj.message}`
    );
    assert(
      errObj.message.includes('HTTP 404') && errObj.message.includes('DNS resolution failed'),
      `Message should list feed diagnostic reasons: ${errObj.message}`
    );
    assert(
      errObj.message.includes('--local'),
      `Message should recommend --local tip: ${errObj.message}`
    );
  });

  // --- 5. Remote prompt missing & local template fallback ---
  testCase('Remote prompt missing gracefully falls back to local template with warning', () => {
    const res = runChild('prompt_fallback');
    assert.strictEqual(res.status, 0, `Expected exit 0, got ${res.status}`);

    const data = JSON.parse(res.stdout);
    assert.strictEqual(data.status, 'ok');
    assert(typeof data.prompts.summarize_tweets === 'string' && data.prompts.summarize_tweets.length > 0);

    const hasWarning = data.errors?.some(e =>
      e.includes('summarize-tweets.md') &&
      e.includes('HTTP 404') &&
      e.includes('falling back to local template')
    );
    assert(hasWarning, `Expected prompt fallback warning in errors: ${JSON.stringify(data.errors)}`);
  });

  // --- 6. Essential prompt missing condition (SKILL.md alignment) ---
  testCase('Essential prompt missing under active updates triggers fatal exit 1', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'fe-test-empty-prompts-'));
    try {
      const res = runChild('essential_prompt_missing', [], {
        LOCAL_PROMPTS_DIR: emptyDir,
        FEED_BRANCH: 'nonexistent-branch'
      });

      assert.strictEqual(res.status, 1, `Expected exit 1 when essential prompt is missing, got ${res.status}`);
      const errObj = JSON.parse(res.stderr);
      assert.strictEqual(errObj.status, 'error');
      assert(
        errObj.message.includes('Essential prompt(s) missing for current content/configuration: digest_intro'),
        `Expected essential prompt missing error, got: ${errObj.message}`
      );
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // --- 7. Non-essential prompt missing (summarize_blogs) does not block digest ---
  testCase('Non-essential prompt missing (summarize-blogs) does NOT block digest', () => {
    const customDir = mkdtempSync(join(tmpdir(), 'fe-test-prompts-no-blogs-'));
    try {
      // Copy all prompts except summarize-blogs.md
      const promptFiles = ['summarize-podcast.md', 'summarize-tweets.md', 'digest-intro.md', 'translate.md'];
      for (const f of promptFiles) {
        copyFileSync(join(REPO_ROOT, 'prompts', f), join(customDir, f));
      }

      const res = runChild('non_essential_prompt_missing', [], {
        LOCAL_PROMPTS_DIR: customDir,
        FEED_BRANCH: 'nonexistent-branch'
      });

      assert.strictEqual(res.status, 0, `Expected exit 0 when non-essential prompt is missing, got ${res.status}: ${res.stderr}`);
      const data = JSON.parse(res.stdout);
      assert.strictEqual(data.status, 'ok');
      assert.strictEqual(data.prompts.summarize_blogs, undefined);
      assert(
        data.errors?.some(e => e.includes('summarize-blogs.md') && e.includes('missing')),
        `Expected warning about summarize-blogs.md in errors: ${JSON.stringify(data.errors)}`
      );
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  // --- 8. No updates + language: zh does NOT require translate prompt (SKILL.md Step 3 alignment) ---
  testCase('No updates with language: zh does NOT require translate prompt (SKILL.md Step 3 early exit)', () => {
    const emptyPromptsDir = mkdtempSync(join(tmpdir(), 'fe-test-empty-prompts-'));
    const testUserDir = mkdtempSync(join(tmpdir(), 'fe-test-user-zh-'));
    try {
      mkdirSync(testUserDir, { recursive: true });
      writeFileSync(join(testUserDir, 'config.json'), JSON.stringify({ language: 'zh' }), 'utf-8');

      const res = runChild('no_updates_zh_no_translate', [], {
        FOLLOW_BUILDERS_USER_DIR: testUserDir,
        LOCAL_PROMPTS_DIR: emptyPromptsDir,
        FEED_BRANCH: 'nonexistent-branch'
      });

      assert.strictEqual(res.status, 0, `Expected exit 0 when no updates even if translate is missing, got ${res.status}: ${res.stderr}`);
      const data = JSON.parse(res.stdout);
      assert.strictEqual(data.status, 'ok');
      assert.strictEqual(data.config.language, 'zh');
      assert.strictEqual(data.stats.totalTweets, 0);
      assert.strictEqual(data.stats.podcastEpisodes, 0);
      assert.strictEqual(data.prompts.translate, undefined);
    } finally {
      rmSync(emptyPromptsDir, { recursive: true, force: true });
      rmSync(testUserDir, { recursive: true, force: true });
    }
  });

  // --- 9. Both digest feed sources failed (tweets + podcasts) exits with code 1 even if blog feed succeeds ---
  testCase('Both digest feed sources failed exits with code 1 even if blog feed succeeds', () => {
    const res = runChild('digest_feeds_failed_blogs_ok');
    assert.strictEqual(
      res.status,
      1,
      `Expected exit code 1 when both tweet & podcast feeds fail, but got ${res.status}. Output was:\n${res.stdout}`
    );

    let errObj = null;
    try {
      errObj = JSON.parse(res.stderr);
    } catch (e) {
      assert.fail(`Stderr is not valid JSON: ${res.stderr}`);
    }

    assert.strictEqual(errObj.status, 'error');
    assert(
      errObj.message.includes('All digest feed sources failed to load'),
      `Message should state digest feed sources failed: ${errObj.message}`
    );
    assert(
      errObj.message.includes('both tweets and podcasts failed'),
      `Message should clarify both tweets and podcasts failed: ${errObj.message}`
    );
    assert(
      errObj.message.includes('HTTP 404') && errObj.message.includes('HTTP 500'),
      `Message should list diagnostic causes for both failures: ${errObj.message}`
    );
  });

  // Cleanup isolated home directory
  try {
    rmSync(ISOLATED_HOME_DIR, { recursive: true, force: true });
  } catch (_) {}

  console.log(`\n========================================`);
  console.log(`TEST SUMMARY: ${passed}/${total} passed.`);
  console.log(`========================================`);

  if (passed !== total) {
    process.exit(1);
  }
}
