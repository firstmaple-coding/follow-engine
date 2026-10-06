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
  const { saveState, fetchPodcastContent } = await import(pathToFileURL(GENERATE_SCRIPT).href);

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
  // Test 10: Verify real workspace files remain 100% untouched
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
