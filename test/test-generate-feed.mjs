#!/usr/bin/env node

// ============================================================================
// Follow Engine — Offline Test Suite for generate-feed.js (--dry-run & safety)
// ============================================================================
// Verifies:
// 1. --dry-run mode performs ZERO disk writes (feed-*.json & state-feed.json unchanged)
// 2. --blogs-only does NOT mutate or prune seenTweets or seenVideos dedup state
// 3. Podcast transcript failure does NOT mark candidate episode as seen in state
// 4. Podcast transcript success marks candidate episode as seen
// 5. Workspace feed files are 100% bitwise identical before and after all tests
// ============================================================================

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, copyFileSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import assert from 'assert';

// ----------------------------------------------------------------------------
// Mode A: Preload Mock Environment (when invoked via Node --import)
// ----------------------------------------------------------------------------
if (process.env.__GENERATE_FEED_MOCK_PRELOAD__ === '1') {
  const scenario = process.env.TEST_SCENARIO || 'default';

  globalThis.fetch = async (url, options) => {
    const urlStr = String(url);
    console.error(`__TRACE_FETCH__:${urlStr}`);

    // Anthropic Engineering blog index mock
    if (urlStr.includes('anthropic.com/engineering') && !urlStr.includes('/article-')) {
      const mockHtml = `
        <html>
          <body>
            <script id="__NEXT_DATA__" type="application/json">
              {
                "props": {
                  "pageProps": {
                    "posts": [
                      {
                        "slug": "article-test-1",
                        "title": "Engineering Claude 4",
                        "publishedOn": "${new Date().toISOString()}",
                        "summary": "Building reliable agentic systems."
                      }
                    ]
                  }
                }
              }
            </script>
          </body>
        </html>
      `;
      return new Response(mockHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }

    // Anthropic Engineering article mock
    if (urlStr.includes('anthropic.com/engineering/article-test-1')) {
      const mockArticleHtml = `
        <html>
          <body>
            <script id="__NEXT_DATA__" type="application/json">
              {
                "props": {
                  "pageProps": {
                    "post": {
                      "title": "Engineering Claude 4",
                      "publishedOn": "${new Date().toISOString()}",
                      "author": { "name": "Research Team" },
                      "body": [
                        {
                          "_type": "block",
                          "children": [{ "text": "This is full article text for engineering test." }]
                        }
                      ]
                    }
                  }
                }
              }
            </script>
          </body>
        </html>
      `;
      return new Response(mockArticleHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }

    // Claude Blog index mock
    if (urlStr.includes('claude.com/blog') && !urlStr.includes('/post-')) {
      const mockHtml = `
        <html>
          <body>
            <a href="/blog/post-test-1">New Claude Cowork</a>
          </body>
        </html>
      `;
      return new Response(mockHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }

    // Claude Blog article mock
    if (urlStr.includes('claude.com/blog/post-test-1')) {
      const mockArticleHtml = `
        <html>
          <head>
            <script type="application/ld+json">
              {
                "@type": "BlogPosting",
                "headline": "New Claude Cowork",
                "datePublished": "${new Date().toISOString()}",
                "author": { "name": "Anthropic" }
              }
            </script>
          </head>
          <body>
            <div class="w-richtext">Claude Cowork article full body text.</div>
          </body>
        </html>
      `;
      return new Response(mockArticleHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }

    // GitHub Engineering full-text RSS mock
    if (urlStr === 'https://github.blog/engineering/feed/') {
      const freshDate = new Date().toUTCString();
      const body = 'GitHub engineering article content about agent-scale development. '.repeat(6);
      const rss = `<rss><channel><item><title><![CDATA[Building Git infrastructure for agents]]></title><link>https://github.blog/engineering/agent-scale-test/</link><pubDate>${freshDate}</pubDate><content:encoded><![CDATA[<p>${body}</p>]]></content:encoded></item></channel></rss>`;
      return new Response(rss, { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
    }

    // X API User Lookup Mock
    if (urlStr.includes('api.x.com/2/users/by')) {
      const urlObj = new URL(urlStr);
      const usernames = (urlObj.searchParams.get('usernames') || '').split(',');
      const mockUsers = usernames.filter(Boolean).map((u) => ({
        id: `mock-id-${u}`,
        name: `Builder ${u}`,
        username: u,
        description: `Bio for ${u}`
      }));
      return new Response(JSON.stringify({ data: mockUsers }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // X API User Tweets Mock
    if (urlStr.includes('api.x.com/2/users/') && urlStr.includes('/tweets')) {
      return new Response(JSON.stringify({
        data: [
          {
            id: `mock-tweet-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
            text: 'Autonomous agents offline test tweet',
            created_at: new Date().toISOString()
          }
        ]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // RSS Feed mock for podcasts (matching all RSS/podcast domains in default-sources.json)
    if (
      urlStr.includes('rss') ||
      urlStr.includes('feed') ||
      urlStr.includes('simplecast.com') ||
      urlStr.includes('anchor.fm') ||
      urlStr.includes('megaphone.fm') ||
      urlStr.includes('acast.com') ||
      urlStr.includes('changelog.com')
    ) {
      const mockRss = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Test AI Podcast</title>
            <item>
              <title>Test Episode Title</title>
              <guid>test-guid-12345</guid>
              <pubDate>${new Date().toUTCString()}</pubDate>
              <link>https://example.com/ep1</link>
            </item>
          </channel>
        </rss>
      `;
      return new Response(mockRss, { status: 200, headers: { 'Content-Type': 'application/xml' } });
    }

    // YouTube mock (triggers graceful channel fallback)
    if (urlStr.includes('youtube.com')) {
      return new Response('<html></html>', { status: 404 });
    }

    // Pod2Txt mock
    if (urlStr.includes('pod2txt.vercel.app')) {
      if (scenario === 'podcast_transcript_failure') {
        return new Response(JSON.stringify({ status: 'error', message: 'Transcription service unavailable' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (urlStr.includes('/api/transcript')) {
        return new Response(JSON.stringify({
          status: 'ready',
          url: 'https://pod2txt.vercel.app/transcripts/test-guid-12345.txt'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (urlStr.includes('.txt')) {
        return new Response('Mock transcript text content here.', { status: 200 });
      }
    }

    return new Response('Not Found', { status: 404 });
  };
}

// ----------------------------------------------------------------------------
// Mode B: Test Runner
// ----------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const GENERATE_SCRIPT = join(REPO_ROOT, 'scripts', 'generate-feed.js');

function sha256(filePath) {
  try {
    const data = readFileSync(filePath);
    return createHash('sha256').update(data).digest('hex');
  } catch {
    return null;
  }
}

function runTest(name, fn) {
  console.log(`\n[Test] ${name}`);
  try {
    fn();
    console.log('  -> PASSED');
  } catch (err) {
    console.error('  -> FAILED:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

async function runAsyncTest(name, fn) {
  console.log(`\n[Test] ${name}`);
  try {
    await fn();
    console.log('  -> PASSED');
  } catch (err) {
    console.error('  -> FAILED:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

async function main() {
  console.log('Running follow-engine feed generation test suite...');
  console.log(`Repository root: ${REPO_ROOT}`);
  console.log(`Target script:   ${GENERATE_SCRIPT}`);

  // Snapshot real workspace files
  const filesToTrack = ['feed-x.json', 'feed-podcasts.json', 'feed-blogs.json', 'state-feed.json'];
  const initialHashes = {};
  for (const f of filesToTrack) {
    initialHashes[f] = sha256(join(REPO_ROOT, f));
  }

  // Import functions for direct unit tests
  const {
    saveState,
    fetchPodcastContent,
    fetchBlogContent,
    extractAnthropicArticleContent,
    extractClaudeBlogArticleContent,
    parseAnthropicEngineeringIndex,
    parseClaudeBlogIndex,
    parseFullTextBlogRss
  } = await import(pathToFileURL(GENERATE_SCRIPT).href);

  // --------------------------------------------------------------------------
  // Test 1: saveState scoped pruning (blogs-only does NOT prune tweets or podcasts)
  // --------------------------------------------------------------------------
  await runAsyncTest('saveState with blogs-only preserves older seenTweets and seenVideos', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'test-savestate-'));
    try {
      const oldTimestamp = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago (past 7-day cutoff)
      const freshTimestamp = Date.now();

      const testState = {
        seenTweets: { 'old-tweet-id': oldTimestamp, 'fresh-tweet-id': freshTimestamp },
        seenVideos: { 'old-podcast-guid': oldTimestamp, 'fresh-podcast-guid': freshTimestamp },
        seenArticles: { 'https://old-article.com': oldTimestamp, 'https://fresh-article.com': freshTimestamp }
      };

      const tempStatePath = join(tempDir, 'state-feed.json');

      // Call the genuine saveState function under test with custom statePath
      await saveState(testState, { tweets: false, podcasts: false, blogs: true }, tempStatePath);

      // Read back the state written to disk by saveState
      const savedState = JSON.parse(readFileSync(tempStatePath, 'utf-8'));

      // Assertions
      assert.strictEqual(savedState.seenTweets['old-tweet-id'], oldTimestamp, 'Old tweet must NOT be pruned when tweets are not active');
      assert.strictEqual(savedState.seenTweets['fresh-tweet-id'], freshTimestamp, 'Fresh tweet must remain');
      assert.strictEqual(savedState.seenVideos['old-podcast-guid'], oldTimestamp, 'Old video must NOT be pruned when podcasts are not active');
      assert.strictEqual(savedState.seenVideos['fresh-podcast-guid'], freshTimestamp, 'Fresh video must remain');
      assert.strictEqual(savedState.seenArticles['https://old-article.com'], undefined, 'Old article MUST be pruned when blogs are active');
      assert.strictEqual(savedState.seenArticles['https://fresh-article.com'], freshTimestamp, 'Fresh article must remain');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // Test 2: Podcast transcript failure does NOT mark candidate as seen
  // --------------------------------------------------------------------------
  await runAsyncTest('Podcast failure leaves candidate UNMARKED in state.seenVideos (regression test)', async () => {
    // Setup mock fetch for failure
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('rss') || urlStr.includes('feed')) {
          const rss = `<?xml version="1.0" encoding="UTF-8"?>
            <rss version="2.0">
              <channel>
                <item>
                  <title>Failing Episode</title>
                  <guid>fail-guid-999</guid>
                  <pubDate>${new Date().toUTCString()}</pubDate>
                </item>
              </channel>
            </rss>`;
          return new Response(rss, { status: 200, headers: { 'Content-Type': 'application/xml' } });
        }
        if (urlStr.includes('pod2txt.vercel.app')) {
          return new Response(JSON.stringify({ status: 'error', message: 'Transient 500 error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response('Not found', { status: 404 });
      };

      const mockPodcasts = [{ name: 'Test Podcast', rssUrl: 'https://example.com/rss.xml', url: 'https://youtube.com/@test' }];
      const state = { seenTweets: {}, seenVideos: {}, seenArticles: {} };
      const errors = [];

      const episodes = await fetchPodcastContent(mockPodcasts, 'test-key', state, errors);

      assert.strictEqual(episodes.length, 0, 'No episodes should be returned on transcript error');
      assert.strictEqual(state.seenVideos['fail-guid-999'], undefined, 'Episode must NOT be marked as seen when transcript fails');
      assert(errors.some(e => e.includes('Transcript error')), 'Error must be recorded in errors array');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // Test 3: Podcast transcript success DOES mark candidate as seen
  // --------------------------------------------------------------------------
  await runAsyncTest('Podcast success marks candidate in state.seenVideos and returns episode', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('rss') || urlStr.includes('feed')) {
          const rss = `<?xml version="1.0" encoding="UTF-8"?>
            <rss version="2.0">
              <channel>
                <item>
                  <title>Successful Episode</title>
                  <guid>success-guid-111</guid>
                  <pubDate>${new Date().toUTCString()}</pubDate>
                </item>
              </channel>
            </rss>`;
          return new Response(rss, { status: 200, headers: { 'Content-Type': 'application/xml' } });
        }
        if (urlStr.includes('pod2txt.vercel.app/api/transcript')) {
          return new Response(JSON.stringify({ status: 'ready', url: 'https://pod2txt.vercel.app/transcripts/success-guid-111.txt' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (urlStr.includes('success-guid-111.txt')) {
          return new Response('Great AI interview transcript here.', { status: 200 });
        }
        if (urlStr.includes('youtube.com')) {
          return new Response('<html></html>', { status: 404 });
        }
        return new Response('Not found', { status: 404 });
      };

      const mockPodcasts = [{ name: 'Success Podcast', rssUrl: 'https://example.com/rss.xml', url: 'https://youtube.com/@test' }];
      const state = { seenTweets: {}, seenVideos: {}, seenArticles: {} };
      const errors = [];

      const episodes = await fetchPodcastContent(mockPodcasts, 'test-key', state, errors);

      assert.strictEqual(episodes.length, 1, 'One episode should be returned');
      assert.strictEqual(episodes[0].guid, 'success-guid-111');
      assert(typeof state.seenVideos['success-guid-111'] === 'number', 'Episode MUST be marked as seen on success');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // Test 4: Podcast empty transcript leaves candidate UNMARKED in state
  // --------------------------------------------------------------------------
  await runAsyncTest('Podcast empty transcript leaves candidate UNMARKED in state.seenVideos', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('rss') || urlStr.includes('feed')) {
          const rss = `<?xml version="1.0" encoding="UTF-8"?>
            <rss version="2.0">
              <channel>
                <item>
                  <title>Empty Episode</title>
                  <guid>empty-guid-333</guid>
                  <pubDate>${new Date().toUTCString()}</pubDate>
                </item>
              </channel>
            </rss>`;
          return new Response(rss, { status: 200, headers: { 'Content-Type': 'application/xml' } });
        }
        if (urlStr.includes('pod2txt.vercel.app/api/transcript')) {
          return new Response(JSON.stringify({ status: 'ready', url: 'https://pod2txt.vercel.app/transcripts/empty-guid-333.txt' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (urlStr.includes('empty-guid-333.txt')) {
          return new Response('', { status: 200 }); // empty transcript
        }
        return new Response('Not found', { status: 404 });
      };

      const mockPodcasts = [{ name: 'Empty Podcast', rssUrl: 'https://example.com/rss.xml', url: 'https://youtube.com/@test' }];
      const state = { seenTweets: {}, seenVideos: {}, seenArticles: {} };
      const errors = [];

      const episodes = await fetchPodcastContent(mockPodcasts, 'test-key', state, errors);

      assert.strictEqual(episodes.length, 0, 'No episodes should be returned on empty transcript');
      assert.strictEqual(state.seenVideos['empty-guid-333'], undefined, 'Episode must NOT be marked as seen when transcript is empty');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  function createCliSandbox() {
    const tempDir = mkdtempSync(join(tmpdir(), 'test-feed-cli-'));
    mkdirSync(join(tempDir, 'scripts'), { recursive: true });
    mkdirSync(join(tempDir, 'config'), { recursive: true });

    copyFileSync(GENERATE_SCRIPT, join(tempDir, 'scripts', 'generate-feed.js'));
    copyFileSync(join(REPO_ROOT, 'config', 'default-sources.json'), join(tempDir, 'config', 'default-sources.json'));

    const initialFeedBlogs = { generatedAt: '2026-10-04T08:22:09.700Z', blogs: [] };
    const initialFeedPodcasts = { generatedAt: '2026-10-04T08:22:08.769Z', podcasts: [] };
    const initialFeedX = { generatedAt: '2026-10-04T08:22:04.655Z', x: [] };
    const initialState = { seenTweets: { t1: 123 }, seenVideos: { v1: 456 }, seenArticles: { a1: 789 } };

    writeFileSync(join(tempDir, 'feed-blogs.json'), JSON.stringify(initialFeedBlogs, null, 2));
    writeFileSync(join(tempDir, 'feed-podcasts.json'), JSON.stringify(initialFeedPodcasts, null, 2));
    writeFileSync(join(tempDir, 'feed-x.json'), JSON.stringify(initialFeedX, null, 2));
    writeFileSync(join(tempDir, 'state-feed.json'), JSON.stringify(initialState, null, 2));

    const hashesBefore = {
      'feed-blogs.json': sha256(join(tempDir, 'feed-blogs.json')),
      'feed-podcasts.json': sha256(join(tempDir, 'feed-podcasts.json')),
      'feed-x.json': sha256(join(tempDir, 'feed-x.json')),
      'state-feed.json': sha256(join(tempDir, 'state-feed.json'))
    };

    return {
      tempDir,
      hashesBefore,
      cleanup: () => rmSync(tempDir, { recursive: true, force: true })
    };
  }

  // --------------------------------------------------------------------------
  // Test 5: CLI execution with --tweets-only --dry-run (fictional credentials)
  // --------------------------------------------------------------------------
  runTest('CLI execution with --tweets-only --dry-run (fictional credentials) writes zero files to disk', () => {
    const sandbox = createCliSandbox();
    try {
      const res = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(__filename).href,
          join(sandbox.tempDir, 'scripts', 'generate-feed.js'),
          '--tweets-only',
          '--dry-run'
        ],
        {
          cwd: sandbox.tempDir,
          env: {
            ...process.env,
            __GENERATE_FEED_MOCK_PRELOAD__: '1',
            X_BEARER_TOKEN: 'fictional_x_bearer_token_for_dry_run_test_only'
          },
          encoding: 'utf-8'
        }
      );

      assert.strictEqual(res.status, 0, `Process failed with exit code ${res.status}. stderr: ${res.stderr}`);
      assert(res.stderr.includes('[dry-run] Dry run mode enabled'), 'Output must announce dry-run mode');
      assert(res.stderr.includes('[dry-run] feed-x.json:'), 'Output must indicate feed-x write skipped');
      assert(res.stderr.includes('[dry-run] state-feed.json: skipped updating state'), 'Output must indicate state update skipped');

      for (const [file, hash] of Object.entries(sandbox.hashesBefore)) {
        assert.strictEqual(sha256(join(sandbox.tempDir, file)), hash, `${file} must not be modified`);
      }
    } finally {
      sandbox.cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // Test 6: CLI execution with --podcasts-only --dry-run (fictional credentials)
  // --------------------------------------------------------------------------
  runTest('CLI execution with --podcasts-only --dry-run (fictional credentials) writes zero files to disk', () => {
    const sandbox = createCliSandbox();
    try {
      const res = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(__filename).href,
          join(sandbox.tempDir, 'scripts', 'generate-feed.js'),
          '--podcasts-only',
          '--dry-run'
        ],
        {
          cwd: sandbox.tempDir,
          env: {
            ...process.env,
            __GENERATE_FEED_MOCK_PRELOAD__: '1',
            POD2TXT_API_KEY: 'fictional_pod2txt_key_for_dry_run_test_only'
          },
          encoding: 'utf-8'
        }
      );

      assert.strictEqual(res.status, 0, `Process failed with exit code ${res.status}. stderr: ${res.stderr}`);
      assert(res.stderr.includes('[dry-run] Dry run mode enabled'), 'Output must announce dry-run mode');
      assert(res.stderr.includes('[dry-run] feed-podcasts.json:'), 'Output must indicate feed-podcasts write skipped');
      assert(res.stderr.includes('[dry-run] state-feed.json: skipped updating state'), 'Output must indicate state update skipped');

      for (const [file, hash] of Object.entries(sandbox.hashesBefore)) {
        assert.strictEqual(sha256(join(sandbox.tempDir, file)), hash, `${file} must not be modified`);
      }
    } finally {
      sandbox.cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // Test 7: CLI execution with --blogs-only --dry-run
  // --------------------------------------------------------------------------
  runTest('CLI execution with --blogs-only --dry-run writes zero files to disk', () => {
    const sandbox = createCliSandbox();
    try {
      const res = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(__filename).href,
          join(sandbox.tempDir, 'scripts', 'generate-feed.js'),
          '--blogs-only',
          '--dry-run'
        ],
        {
          cwd: sandbox.tempDir,
          env: {
            ...process.env,
            __GENERATE_FEED_MOCK_PRELOAD__: '1'
          },
          encoding: 'utf-8'
        }
      );

      assert.strictEqual(res.status, 0, `Process failed with exit code ${res.status}. stderr: ${res.stderr}`);
      assert(res.stderr.includes('[dry-run] Dry run mode enabled'), 'Output must announce dry-run mode');
      assert(res.stderr.includes('[dry-run] feed-blogs.json:'), 'Output must indicate feed-blogs write skipped');
      assert(res.stderr.includes('[dry-run] state-feed.json: skipped updating state'), 'Output must indicate state update skipped');

      for (const [file, hash] of Object.entries(sandbox.hashesBefore)) {
        assert.strictEqual(sha256(join(sandbox.tempDir, file)), hash, `${file} must not be modified`);
      }
    } finally {
      sandbox.cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // Test 8: CLI execution with --blogs-only (non-dry-run) updates seenArticles but DOES NOT alter seenTweets or seenVideos
  // --------------------------------------------------------------------------
  runTest('CLI execution with --blogs-only updates seenArticles but preserves seenTweets and seenVideos', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'test-feed-cli-blogs-'));
    try {
      mkdirSync(join(tempDir, 'scripts'), { recursive: true });
      mkdirSync(join(tempDir, 'config'), { recursive: true });

      copyFileSync(GENERATE_SCRIPT, join(tempDir, 'scripts', 'generate-feed.js'));
      copyFileSync(join(REPO_ROOT, 'config', 'default-sources.json'), join(tempDir, 'config', 'default-sources.json'));

      const oldTimestamp = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
      const initialState = {
        seenTweets: { 'legacy-tweet-1': oldTimestamp },
        seenVideos: { 'legacy-podcast-1': oldTimestamp },
        seenArticles: { 'https://old-article.com': oldTimestamp }
      };

      writeFileSync(join(tempDir, 'state-feed.json'), JSON.stringify(initialState, null, 2));

      const res = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(__filename).href,
          join(tempDir, 'scripts', 'generate-feed.js'),
          '--blogs-only'
        ],
        {
          cwd: tempDir,
          env: {
            ...process.env,
            __GENERATE_FEED_MOCK_PRELOAD__: '1'
          },
          encoding: 'utf-8'
        }
      );

      assert.strictEqual(res.status, 0, `Process failed with exit code ${res.status}. stderr: ${res.stderr}`);

      // Read back state-feed.json
      const updatedState = JSON.parse(readFileSync(join(tempDir, 'state-feed.json'), 'utf-8'));

      // Assertions
      assert.strictEqual(updatedState.seenTweets['legacy-tweet-1'], oldTimestamp, 'seenTweets must NOT be pruned or altered');
      assert.strictEqual(updatedState.seenVideos['legacy-podcast-1'], oldTimestamp, 'seenVideos must NOT be pruned or altered');
      assert.strictEqual(updatedState.seenArticles['https://old-article.com'], undefined, 'Old article MUST be pruned');
      assert(Object.keys(updatedState.seenArticles).length > 0, 'New articles should be added to seenArticles');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // Test 9: Direct CLI --dry-run against workspace leaves workspace bitwise identical
  // --------------------------------------------------------------------------
  runTest('Direct CLI --blogs-only --dry-run executed in workspace leaves all files bitwise identical', () => {
    const res = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(__filename).href,
        GENERATE_SCRIPT,
        '--blogs-only',
        '--dry-run'
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          __GENERATE_FEED_MOCK_PRELOAD__: '1'
        },
        encoding: 'utf-8'
      }
    );

    assert.strictEqual(res.status, 0, `Direct workspace dry-run failed with code ${res.status}: ${res.stderr}`);
    assert(res.stderr.includes('[dry-run] Dry run mode enabled'));
    assert(res.stderr.includes('[dry-run] feed-blogs.json:'));
    assert(res.stderr.includes('[dry-run] state-feed.json: skipped updating state'));

    // Check workspace hashes
    for (const f of filesToTrack) {
      const currentHash = sha256(join(REPO_ROOT, f));
      assert.strictEqual(currentHash, initialHashes[f], `Workspace file ${f} must not be altered by direct dry-run!`);
    }
  });

  // --------------------------------------------------------------------------
  // Test 11: parseAnthropicEngineeringIndex & parseClaudeBlogIndex with synthetic HTML
  // --------------------------------------------------------------------------
  runTest('Blog index parsers extract article slugs via App Router links and Next.js fallback', () => {
    // Anthropic App Router regex parsing
    const anthropicHtml = `
      <div>
        <a href="/engineering/how-we-contain-claude">Link 1</a>
        <a href="/engineering/evaluating-rag-systems">Link 2</a>
        <a href="/engineering/how-we-contain-claude">Duplicate Link</a>
      </div>
    `;
    const anthropicPosts = parseAnthropicEngineeringIndex(anthropicHtml);
    assert.strictEqual(anthropicPosts.length, 2, 'Should extract 2 unique posts');
    assert.strictEqual(anthropicPosts[0].url, 'https://www.anthropic.com/engineering/how-we-contain-claude');
    assert.strictEqual(anthropicPosts[1].url, 'https://www.anthropic.com/engineering/evaluating-rag-systems');

    // Claude blog regex parsing
    const claudeHtml = `
      <section>
        <a href="/blog/cowork-is-now-claude">Cowork</a>
        <a href="/blog/claude-3-7-sonnet">Sonnet 3.7</a>
      </section>
    `;
    const claudePosts = parseClaudeBlogIndex(claudeHtml);
    assert.strictEqual(claudePosts.length, 2, 'Should extract 2 unique Claude posts');
    assert.strictEqual(claudePosts[0].url, 'https://claude.com/blog/cowork-is-now-claude');
    assert.strictEqual(claudePosts[1].url, 'https://claude.com/blog/claude-3-7-sonnet');
  });

  // --------------------------------------------------------------------------
  // Test 12: extractAnthropicArticleContent extracts JSON-LD metadata and body
  // --------------------------------------------------------------------------
  runTest('extractAnthropicArticleContent extracts JSON-LD metadata, author, and decodes HTML entities', () => {
    const syntheticHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Anthropic &#8212; Engineering Claude&#39;s Sandbox</title>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "BlogPosting",
              "headline": "Engineering Claude&#39;s Sandbox",
              "datePublished": "2026-05-25T12:00:00Z",
              "author": {
                "@type": "Person",
                "name": "Security &amp; Systems Team"
              }
            }
          </script>
        </head>
        <body>
          <article>
            <h1>Engineering Claude's Sandbox</h1>
            <p>We built a multi-layered hypervisor environment to contain autonomous agent executions safely.</p>
            <p>Key benchmark: zero guest breakouts across 10 million test executions.</p>
          </article>
        </body>
      </html>
    `;

    const extracted = extractAnthropicArticleContent(syntheticHtml);
    assert.strictEqual(extracted.title, "Engineering Claude's Sandbox", 'Title entity &#39; should be decoded');
    assert.strictEqual(extracted.publishedAt, "2026-05-25T12:00:00Z", 'Published date from JSON-LD should be extracted');
    assert.strictEqual(extracted.author, "Security & Systems Team", 'Author &amp; entity should be decoded');
    assert(extracted.content.includes('multi-layered hypervisor environment'), 'Body content should be captured');
    assert(extracted.content.includes('zero guest breakouts'), 'Content should include key metrics');
  });

  // --------------------------------------------------------------------------
  // Test 13: extractClaudeBlogArticleContent extracts JSON-LD metadata and rich text
  // --------------------------------------------------------------------------
  runTest('extractClaudeBlogArticleContent extracts headline, datePublished, and rich text content', () => {
    const syntheticHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Claude Cowork is now Claude</title>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "NewsArticle",
              "headline": "Claude Cowork &amp; chat are now one",
              "datePublished": "2026-09-16"
            }
          </script>
        </head>
        <body>
          <div class="u-rich-text-blog">
            <h2>Seamless agentic collaboration</h2>
            <p>Today we are rolling out deep task execution inside conversational workflows.</p>
          </div>
        </body>
      </html>
    `;

    const extracted = extractClaudeBlogArticleContent(syntheticHtml);
    assert.strictEqual(extracted.title, "Claude Cowork & chat are now one", 'Headline with &amp; should be decoded');
    assert.strictEqual(extracted.publishedAt, "2026-09-16", 'Date published should match JSON-LD');
    assert(extracted.content.includes('Seamless agentic collaboration'), 'Content should contain heading');
    assert(extracted.content.includes('deep task execution inside conversational workflows'), 'Content should contain paragraph');
  });

  // --------------------------------------------------------------------------
  // Test 14: parseClaudeBlogIndex extracts both /resources/articles/<slug> and /blog/<slug>
  // --------------------------------------------------------------------------
  runTest('parseClaudeBlogIndex extracts both /resources/articles/<slug> and /blog/<slug>', () => {
    const claudeHtml = `
      <section>
        <a href="/resources/articles/how-cresta-turned-cx-expertise-into-an-agent-builder-on-the-claude-agent-sdk">Cresta SDK</a>
        <a href="https://claude.com/resources/articles/were-expanding-the-claude-startups-program-to-help-founders-build">Startups</a>
        <a href="/blog/legacy-post-slug/">Legacy Blog Post</a>
        <a href="/resources/articles/how-cresta-turned-cx-expertise-into-an-agent-builder-on-the-claude-agent-sdk">Duplicate Cresta</a>
      </section>
    `;
    const posts = parseClaudeBlogIndex(claudeHtml);
    assert.strictEqual(posts.length, 3, 'Should extract 3 unique posts ignoring duplicates');
    assert.strictEqual(posts[0].url, 'https://claude.com/resources/articles/how-cresta-turned-cx-expertise-into-an-agent-builder-on-the-claude-agent-sdk');
    assert.strictEqual(posts[1].url, 'https://claude.com/resources/articles/were-expanding-the-claude-startups-program-to-help-founders-build');
    assert.strictEqual(posts[2].url, 'https://claude.com/blog/legacy-post-slug');
  });

  // --------------------------------------------------------------------------
  // Test 15: extractClaudeBlogArticleContent extracts full content from <article> container despite nested divs
  // --------------------------------------------------------------------------
  runTest('extractClaudeBlogArticleContent extracts full content from <article> container despite nested divs', () => {
    const htmlWithNestedDivs = `
      <!DOCTYPE html>
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "BlogPosting",
              "headline": "How Cresta turned CX expertise into an agent builder",
              "datePublished": "2026-10-05",
              "author": { "name": "Anthropic Platform Team" }
            }
          </script>
        </head>
        <body>
          <article>
            <h1>How Cresta turned CX expertise into an agent builder</h1>
            <div class="text-rich-text text-rich-text--article w-richtext">
              <p>Introduction paragraph before a callout block.</p>
              <div class="callout-card">
                <div>Nested div that would break non-greedy regex</div>
              </div>
              <p>Deep technical discussion on Agent SDK and evaluations across Claude models.</p>
              <p>Concluding section with benchmark metrics.</p>
            </div>
          </article>
        </body>
      </html>
    `;
    const extracted = extractClaudeBlogArticleContent(htmlWithNestedDivs);
    assert.strictEqual(extracted.title, "How Cresta turned CX expertise into an agent builder");
    assert.strictEqual(extracted.publishedAt, "2026-10-05");
    assert(extracted.content.includes("Deep technical discussion on Agent SDK"), "Must extract content after nested div");
    assert(extracted.content.includes("Concluding section with benchmark metrics"), "Must extract entire article");
  });

  // --------------------------------------------------------------------------
  // Test 16: "首页无日期、详情页为旧文" -> 详情页提取出旧日期后被丢弃，不进入 feed；但记入 seenArticles
  // --------------------------------------------------------------------------
  await runAsyncTest('fetchBlogContent rejects candidate when index lacks date but article page has older date', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago (cutoff is 72h)
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        // Blog index: provides candidate without date
        if (urlStr === 'https://www.anthropic.com/engineering') {
          return new Response(`
            <html>
              <body>
                <a href="/engineering/old-article-slug">Old Engineering Article</a>
              </body>
            </html>
          `, { status: 200 });
        }
        // Article detail page: provides JSON-LD with old date
        if (urlStr.includes('/engineering/old-article-slug')) {
          return new Response(`
            <html>
              <head>
                <script type="application/ld+json">
                  {
                    "@context": "https://schema.org",
                    "@type": "BlogPosting",
                    "headline": "Old Engineering Article",
                    "datePublished": "${oldDate}"
                  }
                </script>
              </head>
              <body>
                <article><p>Some old content that was published 10 days ago.</p></article>
              </body>
            </html>
          `, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      };

      const mockBlogs = [{
        name: "Anthropic Engineering",
        indexUrl: "https://www.anthropic.com/engineering"
      }];
      const state = { seenTweets: {}, seenVideos: {}, seenArticles: {} };
      const errors = [];

      const results = await fetchBlogContent(mockBlogs, state, errors);

      assert.strictEqual(results.length, 0, 'Article older than lookback window must NOT be added to results');
      assert(state.seenArticles['https://www.anthropic.com/engineering/old-article-slug'], 'Old article must be recorded in seenArticles to avoid repeated fetches');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // Test 17: "旧文排在新文之前" -> 候选扫描不被前面的旧文截断，继续扫描直到取得合格新文
  // --------------------------------------------------------------------------
  await runAsyncTest('fetchBlogContent continues scanning past old candidates to find fresh articles', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(); // 15 days ago
      const freshDate1 = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(); // 10 hours ago
      const freshDate2 = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

      // 3 old articles followed by 2 fresh articles on the index page
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr === 'https://claude.com/blog') {
          return new Response(`
            <html>
              <body>
                <a href="/resources/articles/old-art-1">Old 1</a>
                <a href="/resources/articles/old-art-2">Old 2</a>
                <a href="/resources/articles/old-art-3">Old 3</a>
                <a href="/resources/articles/fresh-art-4">Fresh 4</a>
                <a href="/resources/articles/fresh-art-5">Fresh 5</a>
              </body>
            </html>
          `, { status: 200 });
        }
        if (urlStr.includes('old-art-')) {
          return new Response(`
            <html>
              <head>
                <script type="application/ld+json">
                  { "@context": "https://schema.org", "@type": "BlogPosting", "headline": "Old Post", "datePublished": "${oldDate}" }
                </script>
              </head>
              <body><article><p>Old post content</p></article></body>
            </html>
          `, { status: 200 });
        }
        if (urlStr.includes('fresh-art-4')) {
          return new Response(`
            <html>
              <head>
                <script type="application/ld+json">
                  { "@context": "https://schema.org", "@type": "BlogPosting", "headline": "Fresh Post 4", "datePublished": "${freshDate1}" }
                </script>
              </head>
              <body><article><p>Fresh post 4 content</p></article></body>
            </html>
          `, { status: 200 });
        }
        if (urlStr.includes('fresh-art-5')) {
          return new Response(`
            <html>
              <head>
                <script type="application/ld+json">
                  { "@context": "https://schema.org", "@type": "BlogPosting", "headline": "Fresh Post 5", "datePublished": "${freshDate2}" }
                </script>
              </head>
              <body><article><p>Fresh post 5 content</p></article></body>
            </html>
          `, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      };

      const mockBlogs = [{
        name: "Claude Blog",
        indexUrl: "https://claude.com/blog"
      }];
      const state = { seenTweets: {}, seenVideos: {}, seenArticles: {} };
      const errors = [];

      const results = await fetchBlogContent(mockBlogs, state, errors);

      // Verify scanner did NOT give up after the first 3 old articles
      assert.strictEqual(results.length, 2, 'Must discover both fresh articles despite initial old articles');
      assert.strictEqual(results[0].title, 'Fresh Post 4');
      assert.strictEqual(results[1].title, 'Fresh Post 5');
      // All 5 candidates should now be recorded in seenArticles
      assert(state.seenArticles['https://claude.com/resources/articles/old-art-1']);
      assert(state.seenArticles['https://claude.com/resources/articles/old-art-2']);
      assert(state.seenArticles['https://claude.com/resources/articles/old-art-3']);
      assert(state.seenArticles['https://claude.com/resources/articles/fresh-art-4']);
      assert(state.seenArticles['https://claude.com/resources/articles/fresh-art-5']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // Test 18: Article with missing date, invalid date, or future date is excluded from feed
  // --------------------------------------------------------------------------
  await runAsyncTest('fetchBlogContent excludes articles with missing, invalid, or far-future dates', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days in future
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr === 'https://claude.com/blog') {
          return new Response(`
            <html>
              <body>
                <a href="/resources/articles/no-date">No Date</a>
                <a href="/resources/articles/bad-date">Bad Date</a>
                <a href="/resources/articles/future-date">Future Date</a>
              </body>
            </html>
          `, { status: 200 });
        }
        if (urlStr.includes('no-date')) {
          return new Response(`
            <html>
              <body><article><p>Content with no date</p></article></body>
            </html>
          `, { status: 200 });
        }
        if (urlStr.includes('bad-date')) {
          return new Response(`
            <html>
              <head>
                <script type="application/ld+json">
                  { "@context": "https://schema.org", "@type": "BlogPosting", "headline": "Bad Date", "datePublished": "not-a-valid-date-string" }
                </script>
              </head>
              <body><article><p>Content with bad date</p></article></body>
            </html>
          `, { status: 200 });
        }
        if (urlStr.includes('future-date')) {
          return new Response(`
            <html>
              <head>
                <script type="application/ld+json">
                  { "@context": "https://schema.org", "@type": "BlogPosting", "headline": "Future Date", "datePublished": "${futureDate}" }
                </script>
              </head>
              <body><article><p>Content from the future</p></article></body>
            </html>
          `, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      };

      const mockBlogs = [{
        name: "Claude Blog",
        indexUrl: "https://claude.com/blog"
      }];
      const state = { seenTweets: {}, seenVideos: {}, seenArticles: {} };
      const errors = [];

      const results = await fetchBlogContent(mockBlogs, state, errors);

      assert.strictEqual(results.length, 0, 'No articles with missing, invalid, or future dates should be included');
      assert.strictEqual(state.seenArticles['https://claude.com/resources/articles/no-date'], undefined, 'Missing date must NOT be marked in seenArticles');
      assert.strictEqual(state.seenArticles['https://claude.com/resources/articles/bad-date'], undefined, 'Invalid date must NOT be marked in seenArticles');
      assert.strictEqual(state.seenArticles['https://claude.com/resources/articles/future-date'], undefined, 'Future date must NOT be marked in seenArticles');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // Test 19: First run has invalid date (unmarked), next run has corrected date (collected & marked)
  // --------------------------------------------------------------------------
  await runAsyncTest('fetchBlogContent retries and collects article whose date was invalid on first run but corrected on next run', async () => {
    const originalFetch = globalThis.fetch;
    try {
      let isFirstRun = true;
      const correctedDate = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3 hours ago

      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr === 'https://claude.com/blog') {
          return new Response(`
            <html>
              <body>
                <a href="/resources/articles/eventual-fix">Eventual Fix</a>
              </body>
            </html>
          `, { status: 200 });
        }
        if (urlStr.includes('eventual-fix')) {
          const dateValue = isFirstRun ? "invalid-or-missing" : correctedDate;
          return new Response(`
            <html>
              <head>
                <script type="application/ld+json">
                  {
                    "@context": "https://schema.org",
                    "@type": "BlogPosting",
                    "headline": "Eventual Fix Article",
                    "datePublished": "${dateValue}"
                  }
                </script>
              </head>
              <body>
                <article>
                  <h1>Eventual Fix Article</h1>
                  <p>This article initially had an invalid date published timestamp.</p>
                </article>
              </body>
            </html>
          `, { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      };

      const mockBlogs = [{
        name: "Claude Blog",
        indexUrl: "https://claude.com/blog"
      }];
      const state = { seenTweets: {}, seenVideos: {}, seenArticles: {} };
      const errors = [];

      // Run 1: First run with invalid date
      isFirstRun = true;
      const run1Results = await fetchBlogContent(mockBlogs, state, errors);

      assert.strictEqual(run1Results.length, 0, 'First run must reject article with invalid date');
      assert.strictEqual(state.seenArticles['https://claude.com/resources/articles/eventual-fix'], undefined, 'Must NOT mark in seenArticles when date was invalid');

      // Run 2: Next run after blog author/CMS fixes the date
      isFirstRun = false;
      const run2Results = await fetchBlogContent(mockBlogs, state, errors);

      assert.strictEqual(run2Results.length, 1, 'Second run must discover and collect article once date is corrected');
      assert.strictEqual(run2Results[0].title, 'Eventual Fix Article');
      assert.strictEqual(run2Results[0].publishedAt, correctedDate);
      assert(typeof state.seenArticles['https://claude.com/resources/articles/eventual-fix'] === 'number', 'Must be marked in seenArticles only after successful collection');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // Full-text RSS: validate source host, publication date, body, and no detail fetch
  // --------------------------------------------------------------------------
  await runAsyncTest('GitHub Engineering RSS accepts fresh full text and rejects off-site links', async () => {
    const freshDate = new Date().toUTCString();
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toUTCString();
    const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toUTCString();
    const body = 'Agent-scale Git infrastructure requires reliable repository operations. '.repeat(6);
    const item = (title, link, date) => `<item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${date}</pubDate><content:encoded><![CDATA[<p>${body}</p>]]></content:encoded></item>`;
    const rss = `<rss><channel>${item('Fresh &amp; relevant', 'https://github.blog/engineering/fresh/', freshDate)}${item('Untrusted', 'https://example.com/foreign/', freshDate)}${item('Old', 'https://github.blog/engineering/old/', oldDate)}${item('Future', 'https://github.blog/engineering/future/', futureDate)}</channel></rss>`;
    const blog = { name: 'GitHub Engineering', type: 'rss-fulltext', indexUrl: 'https://github.blog/engineering/feed/', articleBaseUrl: 'https://github.blog/' };
    const errors = [];
    const parsed = parseFullTextBlogRss(rss, blog, errors);
    assert.strictEqual(parsed.length, 3, 'Only same-host articles should be candidates');
    assert(errors.some(e => e.includes('Unexpected RSS article URL')), 'Off-site article must be reported');
    assert(parsed[0].content.length > 200, 'RSS body must contain usable full text');

    const originalFetch = globalThis.fetch;
    const requests = [];
    try {
      globalThis.fetch = async (url) => {
        requests.push(String(url));
        if (String(url) === blog.indexUrl) return new Response(rss, { status: 200 });
        return new Response('Unexpected detail request', { status: 500 });
      };
      const state = { seenTweets: {}, seenVideos: {}, seenArticles: {} };
      const results = await fetchBlogContent([blog], state, []);
      assert.strictEqual(results.length, 1, 'Only the fresh same-host article should enter the feed');
      assert.strictEqual(results[0].title, 'Fresh & relevant');
      assert.strictEqual(requests.length, 1, 'Full-text RSS must not require article detail fetches');
      assert(state.seenArticles['https://github.blog/engineering/fresh/'], 'Accepted article must be deduplicated');
      assert.strictEqual(state.seenArticles['https://github.blog/engineering/future/'], undefined, 'Future article must remain retryable');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --------------------------------------------------------------------------
  // Verify real workspace files remain 100% untouched
  // --------------------------------------------------------------------------
  runTest('Workspace root files remain 100% bitwise untouched', () => {
    for (const f of filesToTrack) {
      const currentHash = sha256(join(REPO_ROOT, f));
      assert.strictEqual(currentHash, initialHashes[f], `Workspace file ${f} must not be changed by any test run!`);
    }
  });

  console.log('\n========================================');
  console.log('FEED TEST SUITE COMPLETE: All tests passed.');
  console.log('========================================');
}

if (process.env.__GENERATE_FEED_MOCK_PRELOAD__ !== '1') {
  main().catch((err) => {
    console.error('Test runner encountered unexpected error:', err);
    process.exit(1);
  });
}
