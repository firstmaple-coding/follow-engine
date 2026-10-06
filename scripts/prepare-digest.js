#!/usr/bin/env node

// ============================================================================
// Follow Builders / Follow Engine — Prepare Digest
// ============================================================================
// Gathers everything the LLM needs to produce a digest:
// - Fetches feeds (tweets, podcasts, blogs) from the configured Fork repository
//   (or reads local feed files if explicitly enabled via --local)
// - Fetches the latest prompts (user custom > remote Fork > local fallback)
// - Reads the user's config (language, delivery method)
// - Outputs a single JSON blob to stdout
//
// The LLM's ONLY job is to read this JSON, remix the content, and output
// the digest text. Everything else is handled here deterministically.
//
// Usage:
//   node prepare-digest.js          # default: fetches from firstmaple-coding/follow-engine
//   node prepare-digest.js --local  # explicit local mode: reads local feed files
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// -- Constants & Paths -------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');

const USER_DIR = process.env.FOLLOW_BUILDERS_USER_DIR || join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const DEFAULT_REPO = 'firstmaple-coding/follow-engine';
const DEFAULT_BRANCH = 'main';

const FEED_REPO = process.env.FEED_REPO || DEFAULT_REPO;
const FEED_BRANCH = process.env.FEED_BRANCH || DEFAULT_BRANCH;

const RAW_BASE = `https://raw.githubusercontent.com/${FEED_REPO}/${FEED_BRANCH}`;

const FEED_X_URL = `${RAW_BASE}/feed-x.json`;
const FEED_PODCASTS_URL = `${RAW_BASE}/feed-podcasts.json`;
const FEED_BLOGS_URL = `${RAW_BASE}/feed-blogs.json`;
const PROMPTS_BASE = `${RAW_BASE}/prompts`;

const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-blogs.md',
  'digest-intro.md',
  'translate.md'
];

// -- Helpers -----------------------------------------------------------------

async function fetchJSONWithDiagnostic(url, resourceName) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return {
        data: null,
        error: `HTTP ${res.status} (${res.statusText || 'Error'}) when fetching ${resourceName} from ${url}`
      };
    }
    const data = await res.json();
    return { data, error: null };
  } catch (err) {
    return {
      data: null,
      error: `Network error when fetching ${resourceName} from ${url}: ${err.message}`
    };
  }
}

async function fetchTextWithDiagnostic(url, resourceName) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return {
        text: null,
        error: `HTTP ${res.status} (${res.statusText || 'Error'}) when fetching ${resourceName} from ${url}`
      };
    }
    const text = await res.text();
    return { text, error: null };
  } catch (err) {
    return {
      text: null,
      error: `Network error when fetching ${resourceName} from ${url}: ${err.message}`
    };
  }
}

async function readLocalJSON(filePath, resourceName) {
  if (!existsSync(filePath)) {
    return {
      data: null,
      error: `Local ${resourceName} file not found: ${filePath}`
    };
  }
  try {
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    return { data, error: null };
  } catch (err) {
    return {
      data: null,
      error: `Failed to read or parse local ${resourceName} file at ${filePath}: ${err.message}`
    };
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const isLocalMode = args.includes('--local') || process.env.FEED_SOURCE === 'local';

  const errors = [];

  // 1. Read user config
  let config = {
    language: 'en',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read user config (${CONFIG_PATH}): ${err.message}`);
    }
  }

  // 2. Load feeds (either via explicit local mode, or default remote Fork)
  let feedX = null;
  let feedPodcasts = null;
  let feedBlogs = null;

  if (isLocalMode) {
    const [resX, resPodcasts, resBlogs] = await Promise.all([
      readLocalJSON(join(REPO_ROOT, 'feed-x.json'), 'tweet feed'),
      readLocalJSON(join(REPO_ROOT, 'feed-podcasts.json'), 'podcast feed'),
      readLocalJSON(join(REPO_ROOT, 'feed-blogs.json'), 'blog feed')
    ]);

    feedX = resX.data;
    feedPodcasts = resPodcasts.data;
    feedBlogs = resBlogs.data;

    if (resX.error) errors.push(resX.error);
    if (resPodcasts.error) errors.push(resPodcasts.error);
    if (resBlogs.error) errors.push(resBlogs.error);
  } else {
    // Remote mode: fetch from Fork repository
    const [resX, resPodcasts, resBlogs] = await Promise.all([
      fetchJSONWithDiagnostic(FEED_X_URL, 'tweet feed'),
      fetchJSONWithDiagnostic(FEED_PODCASTS_URL, 'podcast feed'),
      fetchJSONWithDiagnostic(FEED_BLOGS_URL, 'blog feed')
    ]);

    feedX = resX.data;
    feedPodcasts = resPodcasts.data;
    feedBlogs = resBlogs.data;

    if (resX.error) errors.push(resX.error);
    if (resPodcasts.error) errors.push(resPodcasts.error);
    if (resBlogs.error) errors.push(resBlogs.error);
  }

  // Append upstream/feed internal errors if present in payload
  if (feedX?.errors?.length) {
    errors.push(...feedX.errors.map(err => `Tweet feed internal issue: ${err}`));
  }
  if (feedPodcasts?.errors?.length) {
    errors.push(...feedPodcasts.errors.map(err => `Podcast feed internal issue: ${err}`));
  }
  if (feedBlogs?.errors?.length) {
    errors.push(...feedBlogs.errors.map(err => `Blog feed internal issue: ${err}`));
  }

  // Check fatal condition: both digestible feed sources (tweets and podcasts) failed to load.
  // The current digest workflow (SKILL.md Steps 3 & 4) only processes tweets and podcasts.
  // If both failed to load, even if blogs succeeded, returning status "ok" with 0 updates
  // would falsely report "No new updates from your builders today."
  if (!feedX && !feedPodcasts) {
    const targetDesc = isLocalMode ? 'local files' : `remote Fork (${FEED_REPO} on ${FEED_BRANCH} branch)`;
    const prefix = (!feedBlogs)
      ? `All feed sources failed to load from ${targetDesc}.`
      : `All digest feed sources failed to load from ${targetDesc} (both tweets and podcasts failed; blog feed cannot be used for digest alone).`;
    const fatalMsg = `${prefix}\n` +
      errors.map(e => `  - ${e}`).join('\n') +
      (isLocalMode ? '' : '\nTip: If running offline or testing locally, pass --local to explicitly read local files.');
    throw new Error(fatalMsg);
  }

  // 3. Load prompts:
  // Priority 1: User's custom prompt at ~/.follow-builders/prompts/<file>
  // Priority 2: Remote Fork at PROMPTS_BASE/<file> (skipped in explicit --local mode)
  // Priority 3: Local repository template at REPO_ROOT/prompts/<file>
  const prompts = {};
  const localPromptsDir = process.env.LOCAL_PROMPTS_DIR || join(REPO_ROOT, 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    // Priority 1: User's custom prompt
    if (existsSync(userPath)) {
      try {
        prompts[key] = await readFile(userPath, 'utf-8');
        continue;
      } catch (err) {
        errors.push(`Could not read custom prompt ${userPath}: ${err.message}`);
      }
    }

    // Priority 2: Remote prompt from Fork (if not in explicit local mode)
    if (!isLocalMode) {
      const remoteRes = await fetchTextWithDiagnostic(`${PROMPTS_BASE}/${filename}`, `prompt ${filename}`);
      if (remoteRes.text) {
        prompts[key] = remoteRes.text;
        continue;
      } else {
        // Record degradation warning
        errors.push(`Remote prompt "${filename}" unavailable (${remoteRes.error}); falling back to local template.`);
      }
    }

    // Priority 3: Local repository template
    if (existsSync(localPath)) {
      try {
        prompts[key] = await readFile(localPath, 'utf-8');
      } catch (err) {
        errors.push(`Could not read local prompt template ${localPath}: ${err.message}`);
      }
    } else {
      errors.push(`Prompt template "${filename}" is missing (neither custom, remote, nor local found).`);
    }
  }

  // Check if essential prompts are missing based on SKILL.md actual usage conditions:
  // - digest_intro: required whenever updates exist to assemble the digest
  // - summarize_tweets: required if there are builders with tweets (x.length > 0)
  // - summarize_podcast: required if there are podcast episodes (podcasts.length > 0)
  // - translate: required if updates exist AND target language is Chinese or bilingual ('zh' or 'bilingual')
  // Note: if there are no updates, SKILL.md halts at Step 3 without remixing or translating.
  // Note: summarize_blogs is currently not used in SKILL.md remix workflow.
  const hasUpdates = (feedX?.x?.length || 0) > 0 || (feedPodcasts?.podcasts?.length || 0) > 0;
  const essentialPrompts = [];
  if (hasUpdates) {
    essentialPrompts.push('digest_intro');
    if ((feedX?.x?.length || 0) > 0) essentialPrompts.push('summarize_tweets');
    if ((feedPodcasts?.podcasts?.length || 0) > 0) essentialPrompts.push('summarize_podcast');
    if (config.language === 'zh' || config.language === 'bilingual') {
      essentialPrompts.push('translate');
    }
  }

  const missingEssentials = essentialPrompts.filter(p => !prompts[p]);
  if (missingEssentials.length > 0) {
    throw new Error(`Essential prompt(s) missing for current content/configuration: ${missingEssentials.join(', ')}.\n` + errors.map(e => `  - ${e}`).join('\n'));
  }

  // 4. Build the output — keep all original fields exactly intact
  const output = {
    status: 'ok',
    generatedAt: new Date().toISOString(),

    // User preferences
    config: {
      language: config.language || 'en',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },

    // Content to remix
    podcasts: feedPodcasts?.podcasts || [],
    x: feedX?.x || [],
    blogs: feedBlogs?.blogs || [],

    // Stats for the LLM to reference
    stats: {
      podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
      xBuilders: feedX?.x?.length || 0,
      totalTweets: (feedX?.x || []).reduce((sum, a) => sum + a.tweets.length, 0),
      blogPosts: feedBlogs?.blogs?.length || 0,
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || null
    },

    // Prompts — the LLM reads these and follows the instructions
    prompts,

    // Diagnostic errors/warnings (only included if any occurred)
    errors: errors.length > 0 ? errors : undefined
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    message: err.message
  }));
  process.exit(1);
});
