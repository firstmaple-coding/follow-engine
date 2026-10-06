import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
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

function testCase(name, fn) {
  total++;
  try {
    console.log(`\n[Test ${total}] ${name}`);
    fn();
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

// 1. Skill file existence and path
testCase('.agents/skills/daily-blog-digest/SKILL.md exists in repository', () => {
  const skillPath = join(REPO_ROOT, '.agents', 'skills', 'daily-blog-digest', 'SKILL.md');
  assert(existsSync(skillPath), `Expected skill file to exist at ${skillPath}`);
});

// 2. Frontmatter metadata validation
testCase('SKILL.md has valid YAML frontmatter with name and description', () => {
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
testCase('Referenced scripts exist and decision logic (reuse vs refetch) is documented in SKILL.md', () => {
  const genScript = join(REPO_ROOT, 'scripts', 'generate-feed.js');
  const prepScript = join(REPO_ROOT, 'scripts', 'prepare-digest.js');
  assert(existsSync(genScript), 'scripts/generate-feed.js must exist');
  assert(existsSync(prepScript), 'scripts/prepare-digest.js must exist');

  const skillPath = join(REPO_ROOT, '.agents', 'skills', 'daily-blog-digest', 'SKILL.md');
  const content = readFileSync(skillPath, 'utf-8');
  assert(content.includes('何时复用当天结果'), 'Must document when to reuse today results');
  assert(content.includes('何时重新抓取'), 'Must document when to refetch');
});

// 4. Preservation of root SKILL.md
testCase('Root SKILL.md preserves its original identity and platform detection', () => {
  const rootSkill = join(REPO_ROOT, 'SKILL.md');
  const content = readFileSync(rootSkill, 'utf-8');
  assert(content.includes('name: follow-builders'), 'Root SKILL.md must retain follow-builders name');
  assert(content.includes('PLATFORM=openclaw'), 'Root SKILL.md must retain platform detection');
});

// 5. Execution of preparation pipeline with --language zh
testCase('prepare-digest with --language zh supplies all essential prompts for daily-blog-digest', () => {
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

// 6. Unit tests for mergeBlogPosts helper
testCase('mergeBlogPosts retains still-fresh existing articles when new fetch finds 0 posts', async () => {
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
testCase('Isolated two-run execution: second invocation preserves blog feed without zeroing or misreporting', () => {
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

console.log(`\n========================================`);
console.log(`CHATGPT SKILL TEST SUMMARY: ${passed}/${total} passed.`);
console.log(`========================================`);

if (passed !== total) {
  process.exit(1);
}
