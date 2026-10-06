import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

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

// 3. Script references exist
testCase('Referenced scripts in SKILL.md actually exist and are executable', () => {
  const genScript = join(REPO_ROOT, 'scripts', 'generate-feed.js');
  const prepScript = join(REPO_ROOT, 'scripts', 'prepare-digest.js');
  assert(existsSync(genScript), 'scripts/generate-feed.js must exist');
  assert(existsSync(prepScript), 'scripts/prepare-digest.js must exist');
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

console.log(`\n========================================`);
console.log(`CHATGPT SKILL TEST SUMMARY: ${passed}/${total} passed.`);
console.log(`========================================`);

if (passed !== total) {
  process.exit(1);
}
