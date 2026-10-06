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
  const isBlogsOnly = args.includes('--blogs-only') || process.env.BLOGS_ONLY === '1';

  const feedDirArgIndex = args.indexOf('--feed-dir');
  const feedDir = feedDirArgIndex !== -1 ? args[feedDirArgIndex + 1] : (process.env.FEED_DIR || REPO_ROOT);

  const maxAgeArgIndex = args.indexOf('--max-feed-age-hours');
  let maxFeedAgeHours = null;
  if (maxAgeArgIndex !== -1) {
    if (maxAgeArgIndex === args.length - 1 || args[maxAgeArgIndex + 1].startsWith('--')) {
      throw new Error('Flag --max-feed-age-hours requires a positive numeric argument (e.g. --max-feed-age-hours 24).');
    }
    const rawVal = args[maxAgeArgIndex + 1];
    const val = Number(rawVal);
    if (!Number.isFinite(val) || val <= 0) {
      throw new Error(`Invalid --max-feed-age-hours value: "${rawVal}". Must be a positive number of hours.`);
    }
    maxFeedAgeHours = val;
  } else if (process.env.MAX_FEED_AGE_HOURS) {
    const rawVal = process.env.MAX_FEED_AGE_HOURS;
    const val = Number(rawVal);
    if (!Number.isFinite(val) || val <= 0) {
      throw new Error(`Invalid MAX_FEED_AGE_HOURS environment value: "${rawVal}". Must be a positive number of hours.`);
    }
    maxFeedAgeHours = val;
  }

  const ALLOWED_LANGUAGES = ['en', 'zh', 'bilingual'];
  const langArgIndex = args.indexOf('--language') !== -1 ? args.indexOf('--language') : args.indexOf('--lang');
  let cliLanguage = null;
  if (langArgIndex !== -1) {
    if (langArgIndex === args.length - 1 || args[langArgIndex + 1].startsWith('--')) {
      throw new Error(`Flag --language requires a language argument. Allowed values are: ${ALLOWED_LANGUAGES.join(', ')}.`);
    }
    cliLanguage = args[langArgIndex + 1];
    if (!ALLOWED_LANGUAGES.includes(cliLanguage)) {
      throw new Error(`Invalid --language value "${cliLanguage}". Allowed values are: ${ALLOWED_LANGUAGES.join(', ')}.`);
    }
  } else if (process.env.DIGEST_LANGUAGE) {
    cliLanguage = process.env.DIGEST_LANGUAGE;
    if (!ALLOWED_LANGUAGES.includes(cliLanguage)) {
      throw new Error(`Invalid DIGEST_LANGUAGE environment value "${cliLanguage}". Allowed values are: ${ALLOWED_LANGUAGES.join(', ')}.`);
    }
  }

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
  if (cliLanguage) {
    config.language = cliLanguage;
  }
  if (config.language && !ALLOWED_LANGUAGES.includes(config.language)) {
    errors.push(`Config language "${config.language}" is invalid; falling back to "en".`);
    config.language = 'en';
  }

  // 2. Load feeds (either via explicit local mode, or default remote Fork)
  let feedX = null;
  let feedPodcasts = null;
  let feedBlogs = null;

  if (isBlogsOnly) {
    if (isLocalMode) {
      const resBlogs = await readLocalJSON(join(feedDir, 'feed-blogs.json'), 'blog feed');
      feedBlogs = resBlogs.data;
      if (resBlogs.error) errors.push(resBlogs.error);
    } else {
      const resBlogs = await fetchJSONWithDiagnostic(FEED_BLOGS_URL, 'blog feed');
      feedBlogs = resBlogs.data;
      if (resBlogs.error) errors.push(resBlogs.error);
    }
  } else if (isLocalMode) {
    const [resX, resPodcasts, resBlogs] = await Promise.all([
      readLocalJSON(join(feedDir, 'feed-x.json'), 'tweet feed'),
      readLocalJSON(join(feedDir, 'feed-podcasts.json'), 'podcast feed'),
      readLocalJSON(join(feedDir, 'feed-blogs.json'), 'blog feed')
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

  // Filter out stale feeds if maxFeedAgeHours is set, preventing old feeds from masquerading as today's content
  if (maxFeedAgeHours !== null) {
    const now = Date.now();
    const filterStale = (feed, label, itemsProp) => {
      if (!feed) return feed;
      const items = feed[itemsProp];
      if (!Array.isArray(items) || items.length === 0) return feed;

      if (!feed.generatedAt) {
        errors.push(`${label} is missing generatedAt timestamp; excluded under freshness policy (--max-feed-age-hours).`);
        return { ...feed, [itemsProp]: [] };
      }

      const genTime = new Date(feed.generatedAt).getTime();
      if (Number.isNaN(genTime)) {
        errors.push(`${label} has invalid generatedAt timestamp ("${feed.generatedAt}"); excluded under freshness policy (--max-feed-age-hours).`);
        return { ...feed, [itemsProp]: [] };
      }

      const ageHours = (now - genTime) / (1000 * 60 * 60);
      if (ageHours < -1) {
        errors.push(`${label} timestamp is in the future ("${feed.generatedAt}"); excluded under freshness policy (--max-feed-age-hours).`);
        return { ...feed, [itemsProp]: [] };
      }

      if (ageHours > maxFeedAgeHours) {
        errors.push(`${label} is stale (${ageHours.toFixed(1)}h old, exceeds ${maxFeedAgeHours}h limit); excluded to prevent old content from masquerading as today's updates.`);
        return { ...feed, [itemsProp]: [] };
      }

      return feed;
    };
    feedX = filterStale(feedX, 'Tweet feed', 'x');
    feedPodcasts = filterStale(feedPodcasts, 'Podcast feed', 'podcasts');
    feedBlogs = filterStale(feedBlogs, 'Blog feed', 'blogs');
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

  // Filter blog posts to enforce mandatory original source link rule:
  // Must have a non-empty, valid HTTP(S) URL (rejects empty/whitespace, non-HTTP(S), and invalid URLs)
  const validBlogPosts = (feedBlogs?.blogs || []).filter(b => {
    const rawUrl = typeof b?.url === 'string' ? b.url.trim() : '';
    if (!rawUrl) {
      errors.push(`Blog post "${b?.title || 'Untitled'}" missing or empty url; excluded per mandatory link rule.`);
      return false;
    }
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push(`Blog post "${b?.title || 'Untitled'}" has non-HTTP(S) url ("${b.url}"); excluded per mandatory link rule.`);
        return false;
      }
    } catch (_) {
      errors.push(`Blog post "${b?.title || 'Untitled'}" has invalid url ("${b.url}"); excluded per mandatory link rule.`);
      return false;
    }
    b.url = rawUrl;
    return true;
  });

  // Check fatal condition
  const targetDesc = isLocalMode ? (feedDir !== REPO_ROOT ? `local directory (${feedDir})` : 'local files') : `remote Fork (${FEED_REPO} on ${FEED_BRANCH} branch)`;

  if (isBlogsOnly) {
    if (!feedBlogs) {
      const fatalMsg = `Blog feed failed to load from ${targetDesc}.\n` +
        errors.map(e => `  - ${e}`).join('\n') +
        (isLocalMode ? '' : '\nTip: If running offline or testing locally, pass --local to explicitly read local files.');
      throw new Error(fatalMsg);
    }
  } else {
    // 1. All three feed sources failed to load
    if (!feedX && !feedPodcasts && !feedBlogs) {
      const fatalMsg = `All feed sources failed to load from ${targetDesc}.\n` +
        errors.map(e => `  - ${e}`).join('\n') +
        (isLocalMode ? '' : '\nTip: If running offline or testing locally, pass --local to explicitly read local files.');
      throw new Error(fatalMsg);
    }

    // 2. Both tweet and podcast feeds failed to load, AND blog feed has no valid articles or failed.
    // If blog feed succeeded and has valid articles, proceed with available blogs (recording tweet/podcast errors).
    const hasValidBlogs = validBlogPosts.length > 0;
    if (!feedX && !feedPodcasts && !hasValidBlogs) {
      const prefix = (!feedBlogs)
        ? `All feed sources failed to load from ${targetDesc}.`
        : `All usable digest feed sources failed to load from ${targetDesc} (both tweets and podcasts failed, and blog feed has no valid articles).`;
      const fatalMsg = `${prefix}\n` +
        errors.map(e => `  - ${e}`).join('\n') +
        (isLocalMode ? '' : '\nTip: If running offline or testing locally, pass --local to explicitly read local files.');
      throw new Error(fatalMsg);
    }
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

  // Check if essential prompts are missing based on actual content present:
  // - digest_intro: required whenever updates exist to assemble the digest
  // - summarize_tweets: required if there are builders with tweets (x.length > 0)
  // - summarize_podcast: required if there are podcast episodes (podcasts.length > 0)
  // - summarize_blogs: required if there are blog posts (blogs.length > 0)
  // - translate: required if updates exist AND target language is Chinese or bilingual ('zh' or 'bilingual')
  // Note: if there are no updates, SKILL.md halts at Step 3 without remixing or translating.
  const hasXUpdates = (feedX?.x?.length || 0) > 0;
  const hasPodcastUpdates = (feedPodcasts?.podcasts?.length || 0) > 0;
  const hasBlogUpdates = validBlogPosts.length > 0;
  const hasUpdates = hasXUpdates || hasPodcastUpdates || hasBlogUpdates;

  const essentialPrompts = [];
  if (hasUpdates) {
    essentialPrompts.push('digest_intro');
    if (hasXUpdates) essentialPrompts.push('summarize_tweets');
    if (hasPodcastUpdates) essentialPrompts.push('summarize_podcast');
    if (hasBlogUpdates) {
      essentialPrompts.push('summarize_blogs');
    }
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
    blogs: validBlogPosts,

    // Stats for the LLM to reference
    stats: {
      podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
      xBuilders: feedX?.x?.length || 0,
      totalTweets: (feedX?.x || []).reduce((sum, a) => sum + a.tweets.length, 0),
      blogPosts: validBlogPosts.length,
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
