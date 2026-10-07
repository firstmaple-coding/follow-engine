import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import assert from 'assert';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

function sha256(filePath) {
  try {
    const data = readFileSync(filePath);
    return createHash('sha256').update(data).digest('hex');
  } catch {
    return null;
  }
}

console.log('Running ChatGPT desktop skill test suite...');

let passed = 0;
let total = 0;

async function testCase(name, fn) {
  total++;
  try {
    console.log(`\n[Test ${total}] ${name}`);
    await fn();
    console.log('  -> PASSED');
    passed++;
  } catch (err) {
    console.error(`  -> FAILED: ${err.message}`);
    if (err.actual !== undefined && err.expected !== undefined) {
      console.error('     Actual:', err.actual);
      console.error('     Expected:', err.expected);
    }
    if (err.stack) {
      console.error(err.stack);
    }
  }
}

async function runAllTests() {
  // 1. Skill file existence and path
  await testCase('.agents/skills/daily-blog-digest/SKILL.md exists in repository', () => {
    const skillPath = join(REPO_ROOT, '.agents', 'skills', 'daily-blog-digest', 'SKILL.md');
    assert(existsSync(skillPath), `Expected skill file to exist at ${skillPath}`);
  });

  // 2. Frontmatter metadata validation
  await testCase('SKILL.md has valid YAML frontmatter with name and description', () => {
    const skillPath = join(REPO_ROOT, '.agents', 'skills', 'daily-blog-digest', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf-8');
    assert(content.startsWith('---'), 'SKILL.md must start with YAML frontmatter delimiters (---)');

    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert(match, 'SKILL.md must contain closing YAML delimiter (---)');
    const frontmatter = match[1];

    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    assert(nameMatch, 'Frontmatter must specify a name');
    assert.strictEqual(nameMatch[1].trim(), 'daily-blog-digest');

    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
    assert(descMatch, 'Frontmatter must specify a description');
    assert(descMatch[1].includes('生成今日早报'), 'Description must include trigger keyword "生成今日早报"');
  });

  // 3. Script references exist and decision workflow documented
  await testCase('Referenced scripts exist and decision logic (reuse vs refetch, failure reporting) is documented in SKILL.md', () => {
    const genScript = join(REPO_ROOT, 'scripts', 'generate-feed.js');
    const prepScript = join(REPO_ROOT, 'scripts', 'prepare-digest.js');
    assert(existsSync(genScript), 'scripts/generate-feed.js must exist');
    assert(existsSync(prepScript), 'scripts/prepare-digest.js must exist');

    const skillPath = join(REPO_ROOT, '.agents', 'skills', 'daily-blog-digest', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf-8');
    assert(content.includes('何时复用当天结果'), 'Must document when to reuse today results');
    assert(content.includes('何时重新抓取'), 'Must document when to refetch');
    assert(content.includes('抓取失败处理'), 'Must document failure handling');
    assert(content.includes('严防误报最新'), 'Must forbid falsely claiming stale cache is freshly verified');
    assert(content.includes('不完整'), 'Must document that scraping errors lead to disclosure of incomplete results');
    assert(content.includes('透明披露') || content.includes('抓取异常主动披露'), 'Must instruct transparent disclosure of partial crawl issues');
    assert(content.includes('--feed-dir .runtime'), 'Must document using --feed-dir .runtime');
    assert(content.includes('.runtime'), 'Must document .runtime directory usage');
  });

  // 4. Preservation of root SKILL.md
  await testCase('Root SKILL.md preserves its original identity and platform detection', () => {
    const rootSkill = join(REPO_ROOT, 'SKILL.md');
    const content = readFileSync(rootSkill, 'utf-8');
    assert(content.includes('name: follow-builders'), 'Root SKILL.md must retain follow-builders name');
    assert(content.includes('PLATFORM=openclaw'), 'Root SKILL.md must retain platform detection');
  });

  // 5. Execution of preparation pipeline with --language zh
  await testCase('prepare-digest with --language zh supplies all essential prompts for daily-blog-digest', () => {
    const prepScript = join(REPO_ROOT, 'scripts', 'prepare-digest.js');
    const res = spawnSync(process.execPath, [
      prepScript,
      '--local',
      '--blogs-only',
      '--language',
      'zh'
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf-8'
    });

    assert.strictEqual(res.status, 0, `Expected exit 0, got ${res.status}: ${res.stderr}`);
    const data = JSON.parse(res.stdout);
    assert.strictEqual(data.status, 'ok');
    assert.strictEqual(data.config.language, 'zh');
    assert(data.prompts.digest_intro, 'Must load digest_intro prompt');
    assert(data.prompts.summarize_blogs, 'Must load summarize_blogs prompt');
    assert(data.prompts.translate, 'Must load translate prompt');
    assert(data.prompts.digest_intro.includes('firstmaple-coding/follow-engine'), 'Must include Fork attribution URL');
  });

  // 6. Unit tests for mergeBlogPosts helper (properly awaited)
  await testCase('mergeBlogPosts retains still-fresh existing articles when new fetch finds 0 posts', async () => {
    const genScript = join(REPO_ROOT, 'scripts', 'generate-feed.js');
    const { mergeBlogPosts } = await import(pathToFileURL(genScript).href);

    const now = Date.now();
    const cutoff = now - 72 * 60 * 60 * 1000;

    const freshArticle1 = {
      title: 'Fresh Article 1',
      url: 'https://example.com/art-1',
      publishedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString() // 2 hours ago
    };
    const freshArticle2 = {
      title: 'Fresh Article 2',
      url: 'https://example.com/art-2',
      publishedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString() // 24 hours ago
    };
    const staleArticle = {
      title: 'Stale Article',
      url: 'https://example.com/art-old',
      publishedAt: new Date(now - 80 * 60 * 60 * 1000).toISOString() // 80 hours ago (>72h cutoff)
    };

    // Run 1: initial scrape with new posts
    const run1Merged = mergeBlogPosts([freshArticle1, freshArticle2], [], cutoff, now);
    assert.strictEqual(run1Merged.length, 2, 'Run 1 must include both fresh articles');

    // Run 2: repeated invocation later on same day (0 newly fetched posts because seenArticles deduplicated them)
    const run2Merged = mergeBlogPosts([], [freshArticle1, freshArticle2, staleArticle], cutoff, now);
    assert.strictEqual(run2Merged.length, 2, 'Run 2 must retain the 2 fresh existing articles and prune stale one');
    assert.strictEqual(run2Merged[0].url, 'https://example.com/art-1');
    assert.strictEqual(run2Merged[1].url, 'https://example.com/art-2');

    // Run 3: deduplication when newly fetched post matches existing URL
    const updatedArticle1 = { ...freshArticle1, title: 'Updated Title 1' };
    const run3Merged = mergeBlogPosts([updatedArticle1], [freshArticle1, freshArticle2], cutoff, now);
    assert.strictEqual(run3Merged.length, 2, 'Deduplication must keep unique URLs');
    assert.strictEqual(run3Merged[0].title, 'Updated Title 1', 'New post version takes precedence');
  });

  // 7. End-to-end two-run verification with isolated temporary sandbox
  await testCase('Isolated two-run execution: second invocation preserves blog feed without zeroing or misreporting', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'fe-test-chatgpt-isolated-'));
    const prepScript = join(REPO_ROOT, 'scripts', 'prepare-digest.js');
    const genScript = join(REPO_ROOT, 'scripts', 'generate-feed.js');

    // Snapshot workspace root hashes before test
    const hashBlogsBefore = sha256(join(REPO_ROOT, 'feed-blogs.json'));
    const hashStateBefore = sha256(join(REPO_ROOT, 'state-feed.json'));

    try {
      // Create mock HTTP preload module in tempDir
      const mockModulePath = join(tempDir, 'mock-fetch.mjs');
      const mockModuleContent = [
        'const nowIso = new Date().toISOString();',
        'const articleHtml = `<html><body>' +
          '<script id="__NEXT_DATA__" type="application/json">' +
          JSON.stringify({
            props: {
              pageProps: {
                post: {
                  title: 'Mock Article One',
                  publishedOn: '__DATE_PLACEHOLDER__',
                  author: { name: 'AI Engineer' },
                  body: [
                    {
                      _type: 'block',
                      children: [{ text: 'This is full body text with breakthrough technology.' }]
                    }
                  ]
                }
              }
            }
          }) +
          '</script>' +
          '<article>This is full body text with breakthrough technology.</article>' +
          '</body></html>`.replace("__DATE_PLACEHOLDER__", nowIso);',
        'const indexHtml = `<html><body>' +
          '<script id="__NEXT_DATA__" type="application/json">' +
          JSON.stringify({
            props: {
              pageProps: {
                posts: [
                  {
                    slug: 'mock-art-1',
                    title: 'Mock Article One',
                    publishedOn: '__DATE_PLACEHOLDER__',
                    summary: 'Summary of mock article'
                  }
                ]
              }
            }
          }) +
          '</script></body></html>`.replace("__DATE_PLACEHOLDER__", nowIso);',
        'globalThis.fetch = async (url) => {',
        '  const s = String(url);',
        '  if (s.includes("anthropic.com/engineering") && !s.includes("mock-art-")) {',
        '    return new Response(indexHtml, { status: 200, headers: { "Content-Type": "text/html" } });',
        '  }',
        '  if (s.includes("mock-art-1")) {',
        '    return new Response(articleHtml, { status: 200, headers: { "Content-Type": "text/html" } });',
        '  }',
        '  if (s.includes("claude.com")) {',
        '    return new Response("<html><body>No articles</body></html>", { status: 200, headers: { "Content-Type": "text/html" } });',
        '  }',
        '  return new Response("Not Found", { status: 404 });',
        '};'
      ].join('\n');
      writeFileSync(mockModulePath, mockModuleContent, 'utf-8');

      // === RUN 1: First invocation of the day ===
      const run1 = spawnSync(process.execPath, [
        '--import',
        pathToFileURL(mockModulePath).href,
        genScript,
        '--blogs-only',
        '--feed-dir',
        tempDir
      ], {
        cwd: REPO_ROOT,
        encoding: 'utf-8'
      });

      assert.strictEqual(run1.status, 0, `Run 1 generate-feed failed: ${run1.stderr}`);
      assert(existsSync(join(tempDir, 'feed-blogs.json')), 'Run 1 must generate feed-blogs.json in tempDir');
      assert(existsSync(join(tempDir, 'state-feed.json')), 'Run 1 must save state-feed.json in tempDir');

      // Verify prepare-digest on Run 1
      const prep1 = spawnSync(process.execPath, [
        prepScript,
        '--local',
        '--feed-dir',
        tempDir,
        '--blogs-only',
        '--max-feed-age-hours',
        '24',
        '--language',
        'zh'
      ], {
        cwd: REPO_ROOT,
        encoding: 'utf-8'
      });

      assert.strictEqual(prep1.status, 0, `Run 1 prepare-digest failed: ${prep1.stderr}`);
      const prep1Data = JSON.parse(prep1.stdout);
      assert.strictEqual(prep1Data.status, 'ok');
      assert.strictEqual(prep1Data.stats.blogPosts, 1, 'Run 1 must have 1 blog post');

      // === RUN 2: Repeated invocation on same day (same tempDir, seenArticles already has mock-art-1) ===
      const run2 = spawnSync(process.execPath, [
        '--import',
        pathToFileURL(mockModulePath).href,
        genScript,
        '--blogs-only',
        '--feed-dir',
        tempDir
      ], {
        cwd: REPO_ROOT,
        encoding: 'utf-8'
      });

      assert.strictEqual(run2.status, 0, `Run 2 generate-feed failed: ${run2.stderr}`);
      assert(run2.stderr.includes('Found 0 new blog post(s)'), 'Run 2 must see 0 new posts due to dedup');
      assert(run2.stderr.includes('1 retained'), 'Run 2 must retain the 1 existing fresh post');

      // Verify feed-blogs.json in tempDir was NOT wiped out
      const feedBlogsAfterRun2 = JSON.parse(readFileSync(join(tempDir, 'feed-blogs.json'), 'utf-8'));
      assert.strictEqual(feedBlogsAfterRun2.stats.blogPosts, 1, 'feed-blogs.json must NOT be wiped to 0');
      assert.strictEqual(feedBlogsAfterRun2.blogs.length, 1, 'feed-blogs.json blogs array must not be empty');

      // Verify prepare-digest on Run 2 does NOT report 0 articles
      const prep2 = spawnSync(process.execPath, [
        prepScript,
        '--local',
        '--feed-dir',
        tempDir,
        '--blogs-only',
        '--max-feed-age-hours',
        '24',
        '--language',
        'zh'
      ], {
        cwd: REPO_ROOT,
        encoding: 'utf-8'
      });

      assert.strictEqual(prep2.status, 0, `Run 2 prepare-digest failed: ${prep2.stderr}`);
      const prep2Data = JSON.parse(prep2.stdout);
      assert.strictEqual(prep2Data.status, 'ok');
      assert.strictEqual(prep2Data.stats.blogPosts, 1, 'Run 2 must still report 1 blog post, NOT 0');

      // === PATH 3: Direct reuse path without refetching ===
      const prepReuse = spawnSync(process.execPath, [
        prepScript,
        '--local',
        '--feed-dir',
        tempDir,
        '--blogs-only',
        '--max-feed-age-hours',
        '24',
        '--language',
        'zh'
      ], {
        cwd: REPO_ROOT,
        encoding: 'utf-8'
      });
      assert.strictEqual(prepReuse.status, 0);
      const reuseData = JSON.parse(prepReuse.stdout);
      assert.strictEqual(reuseData.status, 'ok');
      assert.strictEqual(reuseData.stats.blogPosts, 1);

      // Verify workspace files were NOT touched
      const hashBlogsAfter = sha256(join(REPO_ROOT, 'feed-blogs.json'));
      const hashStateAfter = sha256(join(REPO_ROOT, 'state-feed.json'));
      assert.strictEqual(hashBlogsAfter, hashBlogsBefore, 'Workspace feed-blogs.json must not be touched by isolated test');
      assert.strictEqual(hashStateAfter, hashStateBefore, 'Workspace state-feed.json must not be touched by isolated test');

    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 8. Total blog source failure handling
  await testCase('Total crawl failure: all blog sources failing throws error without falsely bumping generatedAt or corrupting feed', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'fe-test-chatgpt-fail-'));
    const genScript = join(REPO_ROOT, 'scripts', 'generate-feed.js');

    // Create an existing feed-blogs.json with older timestamp and 1 article
    const originalGeneratedAt = '2026-10-06T10:00:00.000Z';
    const initialFeed = {
      generatedAt: originalGeneratedAt,
      lookbackHours: 72,
      blogs: [
        {
          source: 'blog',
          name: 'Anthropic Engineering',
          title: 'Existing Earlier Article',
          url: 'https://www.anthropic.com/engineering/earlier-art',
          publishedAt: '2026-10-06T09:00:00.000Z',
          content: 'Earlier content'
        }
      ],
      stats: { blogPosts: 1 }
    };
    const feedBlogsPath = join(tempDir, 'feed-blogs.json');
    writeFileSync(feedBlogsPath, JSON.stringify(initialFeed, null, 2), 'utf-8');
    const hashBeforeFail = sha256(feedBlogsPath);

    try {
      // Mock network module where ALL blog endpoints return 500 error
      const mockFailPath = join(tempDir, 'mock-fail.mjs');
      const mockFailContent = `
        globalThis.fetch = async (url) => {
          return new Response('Internal Server Error', { status: 500 });
        };
      `;
      writeFileSync(mockFailPath, mockFailContent, 'utf-8');

      const runFail = spawnSync(process.execPath, [
        '--import',
        pathToFileURL(mockFailPath).href,
        genScript,
        '--blogs-only',
        '--feed-dir',
        tempDir
      ], {
        cwd: REPO_ROOT,
        encoding: 'utf-8'
      });

      // Must exit with error status (non-zero)
      assert.notStrictEqual(runFail.status, 0, 'Must exit with non-zero code on total blog failure');
      assert(
        runFail.stderr.includes('Blog feed failed: all') || runFail.stderr.includes('failed to fetch'),
        `Expected failure message in stderr, got: ${runFail.stderr}`
      );

      // feed-blogs.json must NOT have been updated or overwritten with a false new generatedAt
      const hashAfterFail = sha256(feedBlogsPath);
      assert.strictEqual(hashAfterFail, hashBeforeFail, 'feed-blogs.json must NOT be touched when all sources fail');

      const feedContentAfterFail = JSON.parse(readFileSync(feedBlogsPath, 'utf-8'));
      assert.strictEqual(
        feedContentAfterFail.generatedAt,
        originalGeneratedAt,
        'generatedAt must NOT be bumped to now when sources fail'
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 9. Boundary: 200 OK index with 0 candidates or 100% failing article details does not count as success
  await testCase('Boundary test: sources returning 0 candidates or failing all article details are treated as failed sources', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'fe-test-chatgpt-boundary-'));
    const genScript = join(REPO_ROOT, 'scripts', 'generate-feed.js');

    const originalGeneratedAt = '2026-10-06T10:00:00.000Z';
    const initialFeed = {
      generatedAt: originalGeneratedAt,
      lookbackHours: 72,
      blogs: [
        {
          source: 'blog',
          name: 'Anthropic Engineering',
          title: 'Existing Earlier Article',
          url: 'https://www.anthropic.com/engineering/earlier-art',
          publishedAt: '2026-10-06T09:00:00.000Z',
          content: 'Earlier content'
        }
      ],
      stats: { blogPosts: 1 }
    };
    const feedBlogsPath = join(tempDir, 'feed-blogs.json');
    writeFileSync(feedBlogsPath, JSON.stringify(initialFeed, null, 2), 'utf-8');
    const hashBefore = sha256(feedBlogsPath);

    try {
      // Mock network module where:
      // - Anthropic Engineering index returns 200 OK but HTML contains 0 candidates
      // - Claude Blog index returns 200 OK with candidates, but all article detail fetches fail (HTTP 500)
      const mockBoundaryPath = join(tempDir, 'mock-boundary.mjs');
      const mockBoundaryContent = [
        'const claudeIndex = `<html><body>',
        '  <a href="/resources/articles/fail-art-1">Fail Art 1</a>',
        '  <a href="/resources/articles/fail-art-2">Fail Art 2</a>',
        '</body></html>`;',
        'globalThis.fetch = async (url) => {',
        '  const s = String(url);',
        '  if (s.includes("anthropic.com/engineering")) {',
        '    // Returns 200 OK, but parser finds 0 candidates',
        '    return new Response("<html><body>No posts here</body></html>", { status: 200, headers: { "Content-Type": "text/html" } });',
        '  }',
        '  if (s.includes("claude.com/blog") || s.includes("claude.com/resources/articles")) {',
        '    if (s.includes("fail-art-")) {',
        '      // Article details fail with HTTP 500',
        '      return new Response("Internal Server Error", { status: 500 });',
        '    }',
        '    return new Response(claudeIndex, { status: 200, headers: { "Content-Type": "text/html" } });',
        '  }',
        '  return new Response("Not Found", { status: 404 });',
        '};'
      ].join('\n');
      writeFileSync(mockBoundaryPath, mockBoundaryContent, 'utf-8');

      const runBoundary = spawnSync(process.execPath, [
        '--import',
        pathToFileURL(mockBoundaryPath).href,
        genScript,
        '--blogs-only',
        '--feed-dir',
        tempDir
      ], {
        cwd: REPO_ROOT,
        encoding: 'utf-8'
      });

      // Must exit with error status (non-zero) because all sources failed
      assert.notStrictEqual(runBoundary.status, 0, 'Must exit with non-zero code when all sources fail candidate discovery or detail fetches');
      assert(
        runBoundary.stderr.includes('Blog feed failed: all') || runBoundary.stderr.includes('failed to fetch'),
        `Expected failure message in stderr, got: ${runBoundary.stderr}`
      );
      assert(
        runBoundary.stderr.includes('No article candidates discovered for Anthropic Engineering'),
        'Must log 0 candidates discovered error for Anthropic'
      );
      assert(
        runBoundary.stderr.includes('candidate article(s) failed to fetch for Claude Blog') ||
        runBoundary.stderr.includes('Failed to fetch article'),
        'Must log article detail fetch failures for Claude Blog'
      );

      // feed-blogs.json must NOT have been updated or overwritten with a false new generatedAt
      const hashAfter = sha256(feedBlogsPath);
      assert.strictEqual(hashAfter, hashBefore, 'feed-blogs.json must NOT be touched when all sources fail');

      const feedContentAfter = JSON.parse(readFileSync(feedBlogsPath, 'utf-8'));
      assert.strictEqual(
        feedContentAfter.generatedAt,
        originalGeneratedAt,
        'generatedAt must NOT be bumped to now when sources fail'
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 10. Partial crawl failure: 1 blog source succeeds while 1 blog fails -> feed succeeds, prepare-digest exposes diagnostic errors
  await testCase('Partial crawl failure: feed succeeds with available articles and records errors for downstream warning', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'fe-test-chatgpt-partial-'));
    const genScript = join(REPO_ROOT, 'scripts', 'generate-feed.js');
    const prepScript = join(REPO_ROOT, 'scripts', 'prepare-digest.js');

    try {
      const nowIso = new Date().toISOString();
      const articleHtml = `<html><head><script type="application/ld+json">{"@type":"BlogPosting","headline":"Partial Test Article","datePublished":"${nowIso}","author":{"name":"Team"}}</script></head><body><div class="w-richtext">Content for partial test.</div></body></html>`;
      const claudeIndex = `<html><body><a href="/resources/articles/partial-art-1">Partial Art 1</a></body></html>`;

      const mockPartialPath = join(tempDir, 'mock-partial.mjs');
      const mockPartialContent = [
        'globalThis.fetch = async (url) => {',
        '  const s = String(url);',
        '  if (s.includes("anthropic.com/engineering")) {',
        '    // Anthropic returns empty candidates (failed source)',
        '    return new Response("<html><body>Empty</body></html>", { status: 200, headers: { "Content-Type": "text/html" } });',
        '  }',
        '  if (s.includes("claude.com/resources/articles/partial-art-1")) {',
        '    // Claude article detail succeeds',
        `    return new Response(${JSON.stringify(articleHtml)}, { status: 200, headers: { "Content-Type": "text/html" } });`,
        '  }',
        '  if (s.includes("claude.com")) {',
        '    // Claude index succeeds',
        `    return new Response(${JSON.stringify(claudeIndex)}, { status: 200, headers: { "Content-Type": "text/html" } });`,
        '  }',
        '  return new Response("Not Found", { status: 404 });',
        '};'
      ].join('\n');
      writeFileSync(mockPartialPath, mockPartialContent, 'utf-8');

      const runGen = spawnSync(process.execPath, [
        '--import',
        pathToFileURL(mockPartialPath).href,
        genScript,
        '--blogs-only',
        '--feed-dir',
        tempDir
      ], {
        cwd: REPO_ROOT,
        encoding: 'utf-8'
      });

      assert.strictEqual(runGen.status, 0, `Partial run should succeed with code 0: ${runGen.stderr}`);
      const feedData = JSON.parse(readFileSync(join(tempDir, 'feed-blogs.json'), 'utf-8'));
      assert.strictEqual(feedData.stats.blogPosts, 1, 'Should include the 1 article from successful Claude Blog');
      assert(
        feedData.errors && feedData.errors.some(e => e.includes('Anthropic Engineering')),
        'feed-blogs.json must record error for failed Anthropic Engineering source'
      );

      // Now run prepare-digest and verify errors are passed to output JSON for Skill to detect
      const prepRes = spawnSync(process.execPath, [
        prepScript,
        '--local',
        '--feed-dir',
        tempDir,
        '--blogs-only',
        '--max-feed-age-hours',
        '24',
        '--language',
        'zh'
      ], {
        cwd: REPO_ROOT,
        encoding: 'utf-8'
      });

      assert.strictEqual(prepRes.status, 0, `prepare-digest must succeed: ${prepRes.stderr}`);
      const prepData = JSON.parse(prepRes.stdout);
      assert.strictEqual(prepData.status, 'ok');
      assert.strictEqual(prepData.stats.blogPosts, 1);
      assert(
        prepData.errors && prepData.errors.some(e => e.includes('Anthropic Engineering')),
        'prepare-digest must expose the blog source error so Skill can notify user of incomplete result'
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 11. Runtime isolation works in a fresh checkout without an existing local feed
  await testCase('Runtime isolation: generated files stay under ignored .runtime/ without changing tracked feeds', () => {
    const gitignorePath = join(REPO_ROOT, '.gitignore');
    assert(existsSync(gitignorePath), '.gitignore must exist');
    const gitignoreContent = readFileSync(gitignorePath, 'utf-8');
    assert(gitignoreContent.split(/\r?\n/).includes('.runtime/'), '.gitignore must ignore .runtime/');

    const trackedFiles = ['feed-blogs.json', 'state-feed.json', 'feed-x.json', 'feed-podcasts.json'];
    const hashesBefore = {};
    for (const file of trackedFiles) {
      hashesBefore[file] = sha256(join(REPO_ROOT, file));
    }
    const runtimeRoot = join(REPO_ROOT, '.runtime');
    mkdirSync(runtimeRoot, { recursive: true });
    const tempDir = mkdtempSync(join(runtimeRoot, 'test-isolation-'));
    const feedDir = join(tempDir, 'fresh-feed-dir');
    const relativeFeedDir = relative(REPO_ROOT, feedDir);

    try {
      const nowIso = new Date().toISOString();
      const articleHtml = `<html><head><script type="application/ld+json">{"@type":"BlogPosting","headline":"Isolation Test Article","datePublished":"${nowIso}"}</script></head><body><div class="w-richtext">Isolation test body.</div></body></html>`;
      const claudeIndex = '<html><body><a href="/resources/articles/isolation-test">Isolation Test</a></body></html>';
      const mockPath = join(tempDir, 'mock-fetch.mjs');
      writeFileSync(mockPath, [
        'globalThis.fetch = async (url) => {',
        '  const value = String(url);',
        '  if (value.includes("anthropic.com/engineering")) return new Response("<html><body>Empty</body></html>", { status: 200 });',
        `  if (value.includes("claude.com/resources/articles/isolation-test")) return new Response(${JSON.stringify(articleHtml)}, { status: 200 });`,
        `  if (value.includes("claude.com")) return new Response(${JSON.stringify(claudeIndex)}, { status: 200 });`,
        '  return new Response("Not Found", { status: 404 });',
        '};'
      ].join('\n'), 'utf-8');

      const genRes = spawnSync(process.execPath, [
        '--import', pathToFileURL(mockPath).href,
        join(REPO_ROOT, 'scripts', 'generate-feed.js'),
        '--blogs-only', '--feed-dir', relativeFeedDir
      ], { cwd: REPO_ROOT, encoding: 'utf-8' });
      assert.strictEqual(genRes.status, 0, `Expected isolated generation to succeed: ${genRes.stderr}`);
      assert(existsSync(join(feedDir, 'feed-blogs.json')), 'Generator must create the isolated feed directory');
      assert(existsSync(join(feedDir, 'state-feed.json')), 'Generator must write isolated dedupe state');

      const prepRes = spawnSync(process.execPath, [
        join(REPO_ROOT, 'scripts', 'prepare-digest.js'),
        '--local', '--blogs-only', '--feed-dir', relativeFeedDir,
        '--max-feed-age-hours', '24', '--language', 'zh'
      ], { cwd: REPO_ROOT, encoding: 'utf-8' });
      assert.strictEqual(prepRes.status, 0, `Expected isolated preparation to succeed: ${prepRes.stderr}`);
      assert.strictEqual(JSON.parse(prepRes.stdout).stats.blogPosts, 1);

      for (const file of trackedFiles) {
        assert.strictEqual(sha256(join(REPO_ROOT, file)), hashesBefore[file], `${file} must remain byte-identical`);
      }
      assert(relative(runtimeRoot, feedDir).startsWith('test-isolation-'), 'Generated feed must stay under .runtime/');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  console.log(`\n========================================`);
  console.log(`CHATGPT SKILL TEST SUMMARY: ${passed}/${total} passed.`);
  console.log(`========================================`);

  if (passed !== total) {
    process.exit(1);
  }
}

await runAllTests();
