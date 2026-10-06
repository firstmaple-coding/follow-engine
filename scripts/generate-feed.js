#!/usr/bin/env node

// ============================================================================
// Follow Builders — Central Feed Generator
// ============================================================================
// Runs on GitHub Actions (daily at 6am UTC) to fetch content and publish
// feed-x.json, feed-podcasts.json, and feed-blogs.json.
//
// Deduplication: tracks previously seen tweet IDs, episode GUIDs, and article
// URLs in state-feed.json so content is never repeated across runs.
//
// Usage: node generate-feed.js [--tweets-only | --podcasts-only | --blogs-only] [--dry-run]
// --dry-run: 不写文件，仍可能联网及产生 API 费用
// Env vars needed: X_BEARER_TOKEN, POD2TXT_API_KEY
// ============================================================================

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

// -- Constants ---------------------------------------------------------------

const POD2TXT_BASE = "https://pod2txt.vercel.app/api";
const X_API_BASE = "https://api.x.com/2";
// Some RSS hosts (notably Substack) block non-browser user agents from cloud IPs.
// Using a real Chrome UA avoids 403 errors in GitHub Actions.
const RSS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TWEET_LOOKBACK_HOURS = 24;
const PODCAST_LOOKBACK_HOURS = 336; // 14 days — podcasts publish weekly/biweekly, not daily
const BLOG_LOOKBACK_HOURS = 72;
const MAX_TWEETS_PER_USER = 3;
const MAX_ARTICLES_PER_BLOG = 3;
const X_USER_LOOKUP_BATCH_SIZE = 5;
const X_RETRY_STATUSES = new Set([500, 502, 503, 504]);
const X_RETRY_ATTEMPTS = 3;

// State file lives in the repo root so it gets committed by GitHub Actions
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(SCRIPT_DIR, "..", "state-feed.json");

// -- State Management --------------------------------------------------------

// Tracks which tweet IDs and video IDs we've already included in feeds
// so we never send the same content twice across runs.

async function loadState(statePath = STATE_PATH) {
  if (!existsSync(statePath)) {
    return { seenTweets: {}, seenVideos: {}, seenArticles: {} };
  }
  try {
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    // Ensure seenArticles exists for older state files
    if (!state.seenArticles) state.seenArticles = {};
    return state;
  } catch {
    return { seenTweets: {}, seenVideos: {}, seenArticles: {} };
  }
}

function mergeBlogPosts(
  newPosts = [],
  existingPosts = [],
  cutoffMs = Date.now() - BLOG_LOOKBACK_HOURS * 60 * 60 * 1000,
  nowMs = Date.now(),
) {
  const stillFreshExisting = (existingPosts || []).filter((item) => {
    if (!item || !item.url) return false;
    const pubDate = item.publishedAt ? new Date(item.publishedAt).getTime() : NaN;
    return !isNaN(pubDate) && pubDate >= cutoffMs && pubDate <= nowMs;
  });

  const seenUrls = new Set((newPosts || []).map((b) => b.url));
  const merged = [...(newPosts || [])];
  for (const item of stillFreshExisting) {
    if (!seenUrls.has(item.url)) {
      seenUrls.add(item.url);
      merged.push(item);
    }
  }
  return merged;
}

async function saveState(
  state,
  activeTypes = { tweets: true, podcasts: true, blogs: true },
  statePath = STATE_PATH,
) {
  // Prune entries older than 7 days only for active feed types
  // to avoid mutating other categories (e.g. --blogs-only touching tweets/podcasts).
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (activeTypes.tweets) {
    for (const [id, ts] of Object.entries(state.seenTweets || {})) {
      if (ts < cutoff) delete state.seenTweets[id];
    }
  }
  if (activeTypes.podcasts) {
    for (const [id, ts] of Object.entries(state.seenVideos || {})) {
      if (ts < cutoff) delete state.seenVideos[id];
    }
  }
  if (activeTypes.blogs) {
    for (const [id, ts] of Object.entries(state.seenArticles || {})) {
      if (ts < cutoff) delete state.seenArticles[id];
    }
  }
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

// -- Load Sources ------------------------------------------------------------

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, "..", "config", "default-sources.json");
  return JSON.parse(await readFile(sourcesPath, "utf-8"));
}

// -- Podcast Fetching (RSS + pod2txt) ----------------------------------------

// Parses an RSS feed XML string and returns episode objects with
// title, publishedAt, guid, and link. RSS feeds list newest first.
function parseRssFeed(xml) {
  const episodes = [];
  // Match each <item> block in the RSS feed
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];

    // Extract title (inside CDATA or plain text)
    const titleMatch =
      block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
      block.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].trim() : "Untitled";

    // Extract GUID (unique episode identifier), stripping CDATA wrapper if present
    const guidMatch =
      block.match(/<guid[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/guid>/) ||
      block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const guid = guidMatch ? guidMatch[1].trim() : null;

    // Extract publish date
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const publishedAt = pubDateMatch
      ? new Date(pubDateMatch[1].trim()).toISOString()
      : null;

    // Extract episode link (for the feed output URL)
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const link = linkMatch ? linkMatch[1].trim() : null;

    if (guid) {
      episodes.push({ title, guid, publishedAt, link });
    }
  }
  return episodes;
}

// -- YouTube Episode URL Lookup ----------------------------------------------
// Podcast RSS feeds don't know about YouTube, so to get the exact YouTube
// video URL for an episode we look up the channel's recent videos and match
// by title. Free, no API key required. Tries Atom RSS first (stable but
// returns 500 for some channels), falls back to scraping the /videos page.

// Derives a YouTube Atom feed URL from a channel or playlist URL.
// Handles three URL shapes: /@handle, /channel/UCxxx, /playlist?list=PLxxx.
async function getYouTubeFeedUrl(channelUrl) {
  if (!channelUrl || !channelUrl.includes("youtube.com")) return null;

  const playlistMatch = channelUrl.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (playlistMatch) {
    return `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistMatch[1]}`;
  }

  const channelIdMatch = channelUrl.match(/\/channel\/(UC[A-Za-z0-9_-]+)/);
  if (channelIdMatch) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelIdMatch[1]}`;
  }

  // /@handle URLs need a round-trip: fetch the channel page and pull the
  // channelId out of its HTML. YouTube embeds it in several places; the
  // "channelId":"UC..." pattern in the JSON blob is the most reliable.
  if (channelUrl.match(/\/@[A-Za-z0-9_.-]+/)) {
    try {
      const res = await fetch(channelUrl, {
        headers: {
          "User-Agent": RSS_USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const html = await res.text();
      const idMatch =
        html.match(/"channelId":"(UC[A-Za-z0-9_-]{20,})"/) ||
        html.match(
          /<meta\s+itemprop="(?:identifier|channelId)"\s+content="(UC[A-Za-z0-9_-]{20,})"/,
        );
      if (idMatch) {
        return `https://www.youtube.com/feeds/videos.xml?channel_id=${idMatch[1]}`;
      }
    } catch {
      return null;
    }
  }
  return null;
}

// Scrapes recent videos from a YouTube channel's /videos page by parsing
// the ytInitialData JSON embedded in the HTML. Used as a fallback when the
// Atom RSS endpoint is unavailable. YouTube's internal data shapes change
// occasionally, so we defensively navigate both the rich-grid (channel page)
// and playlist-video-list (playlist page) structures.
function parseYouTubePageData(html) {
  const videos = [];
  const m = html.match(/var\s+ytInitialData\s*=\s*({[\s\S]*?});\s*<\/script>/);
  if (!m) return videos;

  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return videos;
  }

  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  for (const tab of tabs) {
    const gridItems =
      tab?.tabRenderer?.content?.richGridRenderer?.contents || [];
    for (const it of gridItems) {
      const v = it?.richItemRenderer?.content?.videoRenderer;
      if (v?.videoId) {
        const title = v.title?.runs?.[0]?.text || v.title?.simpleText || "";
        if (title) {
          videos.push({
            title,
            url: `https://www.youtube.com/watch?v=${v.videoId}`,
          });
        }
      }
    }
    if (videos.length > 0) break;

    const playlistItems =
      tab?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
        ?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer
        ?.contents || [];
    for (const it of playlistItems) {
      const v = it?.playlistVideoRenderer;
      if (v?.videoId) {
        const title = v.title?.runs?.[0]?.text || v.title?.simpleText || "";
        if (title) {
          videos.push({
            title,
            url: `https://www.youtube.com/watch?v=${v.videoId}`,
          });
        }
      }
    }
    if (videos.length > 0) break;
  }
  return videos;
}

// Fetches recent videos for a YouTube channel/playlist URL. Tries the Atom
// feed first, then scrapes the /videos page if the feed is unavailable.
async function fetchYouTubeVideos(channelUrl) {
  const feedUrl = await getYouTubeFeedUrl(channelUrl);
  if (feedUrl) {
    try {
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": RSS_USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const videos = parseYouTubeFeed(await res.text());
        if (videos.length > 0) return videos;
      }
    } catch {
      // fall through to scraping
    }
  }

  if (!channelUrl || !channelUrl.includes("youtube.com")) return [];
  // Playlist URLs should not be mutated; channel URLs need /videos appended
  // so we hit the uploads grid rather than the channel home/shorts page.
  const videosPageUrl = channelUrl.includes("/playlist?")
    ? channelUrl
    : channelUrl.replace(/\/$/, "") + "/videos";
  try {
    const res = await fetch(videosPageUrl, {
      headers: {
        "User-Agent": RSS_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    return parseYouTubePageData(await res.text());
  } catch {
    return [];
  }
}

// Parses a YouTube Atom feed and returns { title, url } for each entry.
function parseYouTubeFeed(xml) {
  const videos = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let entryMatch;
  while ((entryMatch = entryRegex.exec(xml)) !== null) {
    const block = entryMatch[1];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const videoIdMatch = block.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/);
    if (titleMatch && videoIdMatch) {
      videos.push({
        title: titleMatch[1].trim(),
        url: `https://www.youtube.com/watch?v=${videoIdMatch[1].trim()}`,
      });
    }
  }
  return videos;
}

// Lowercase, strip punctuation, collapse whitespace — so minor title
// differences between a podcast feed and its YouTube upload don't block a match.
function normalizeTitle(t) {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Finds the YouTube video whose title best matches the podcast episode title.
// Uses substring match first, then token overlap (>=50% of episode's content
// words must appear in the video title). Returns null if no confident match.
async function findYouTubeEpisodeUrl(channelUrl, episodeTitle) {
  const videos = await fetchYouTubeVideos(channelUrl);
  if (videos.length === 0) return null;

  const needle = normalizeTitle(episodeTitle);
  const needleTokens = new Set(needle.split(" ").filter((w) => w.length > 2));
  if (needleTokens.size === 0) return null;

  let bestUrl = null;
  let bestScore = 0;
  for (const v of videos) {
    const hay = normalizeTitle(v.title);
    if (hay && (hay.includes(needle) || needle.includes(hay))) {
      return v.url;
    }
    const hayTokens = new Set(hay.split(" ").filter((w) => w.length > 2));
    let overlap = 0;
    for (const tok of needleTokens) if (hayTokens.has(tok)) overlap++;
    const score = overlap / needleTokens.size;
    if (score > bestScore) {
      bestScore = score;
      bestUrl = v.url;
    }
  }
  return bestScore >= 0.5 ? bestUrl : null;
}

// Fetches a transcript from pod2txt. The API is async: first request may
// return "processing", so we poll until "ready" (up to 5 attempts, ~2.5 min).
async function fetchPod2txtTranscript(rssUrl, guid, apiKey) {
  const maxAttempts = 5;
  const pollInterval = 30000; // 30 seconds between polls

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${POD2TXT_BASE}/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedurl: rssUrl, guid, apikey: apiKey }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { error: `HTTP ${res.status}: ${text}` };
    }

    const data = await res.json();

    if (data.status === "ready" && data.url) {
      // Transcript is ready — fetch the text from the provided URL
      const txtRes = await fetch(data.url);
      if (!txtRes.ok)
        return {
          error: `Failed to fetch transcript text: HTTP ${txtRes.status}`,
        };
      const transcript = await txtRes.text();
      return { transcript };
    }

    if (data.status === "processing") {
      console.error(
        `      pod2txt: processing (attempt ${attempt}/${maxAttempts}), waiting ${pollInterval / 1000}s...`,
      );
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, pollInterval));
      }
      continue;
    }

    // Unexpected status or error from the API
    return { error: data.message || `Unexpected status: ${data.status}` };
  }

  return { error: "Timed out waiting for transcript processing" };
}

// Main podcast fetching function. For each podcast:
// 1. Fetches the RSS feed to discover episodes
// 2. Filters by lookback window and dedup
// 3. Fetches transcript via pod2txt for the newest unseen episode
async function fetchPodcastContent(podcasts, apiKey, state, errors) {
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);
  const allCandidates = [];

  // Step 1: Discover episodes from each podcast's RSS feed
  for (const podcast of podcasts) {
    if (!podcast.rssUrl) {
      errors.push(`Podcast: No rssUrl configured for ${podcast.name}`);
      continue;
    }

    try {
      console.error(`  Fetching RSS for ${podcast.name}...`);
      const rssRes = await fetch(podcast.rssUrl, {
        headers: {
          "User-Agent": RSS_USER_AGENT,
          Accept: "application/rss+xml, application/xml, text/xml, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        signal: AbortSignal.timeout(30000), // 30 second timeout for large feeds
      });

      if (!rssRes.ok) {
        console.error(
          `  ${podcast.name}: RSS fetch failed — HTTP ${rssRes.status}`,
        );
        errors.push(
          `Podcast: Failed to fetch RSS for ${podcast.name}: HTTP ${rssRes.status}`,
        );
        continue;
      }

      const rssXml = await rssRes.text();
      const episodes = parseRssFeed(rssXml);
      console.error(
        `  ${podcast.name}: found ${episodes.length} episodes in RSS feed`,
      );

      // Check the 3 most recent episodes, skip already-seen ones
      for (const episode of episodes.slice(0, 3)) {
        if (state.seenVideos[episode.guid]) {
          console.error(`    Skipping "${episode.title}" (already seen)`);
          continue;
        }

        console.error(
          `    Candidate: "${episode.title}" published=${episode.publishedAt || "unknown"}`,
        );
        allCandidates.push({ podcast, ...episode });
      }
    } catch (err) {
      errors.push(`Podcast: Error processing ${podcast.name}: ${err.message}`);
    }
  }

  console.error(
    `  Total candidates: ${allCandidates.length}, cutoff: ${cutoff.toISOString()}`,
  );

  // Step 2: Filter by lookback window, sort newest first
  const withinWindow = allCandidates
    .filter((v) => !v.publishedAt || new Date(v.publishedAt) >= cutoff)
    .sort((a, b) => {
      // Newest first; dateless ones go to the end
      if (a.publishedAt && b.publishedAt)
        return new Date(b.publishedAt) - new Date(a.publishedAt);
      if (a.publishedAt) return -1;
      if (b.publishedAt) return 1;
      return 0;
    });

  console.error(`  Within window: ${withinWindow.length} episode(s)`);
  for (const v of withinWindow) {
    console.error(`    - "${v.title}" published=${v.publishedAt || "unknown"}`);
  }

  // Step 3: Try each candidate until we get a transcript from pod2txt
  for (const selected of withinWindow) {
    console.error(`    Fetching transcript for "${selected.title}"...`);

    const result = await fetchPod2txtTranscript(
      selected.podcast.rssUrl,
      selected.guid,
      apiKey,
    );

    if (result.error) {
      console.error(
        `    Transcript error: ${result.error} — skipping to next candidate`,
      );
      errors.push(
        `Podcast: Transcript error for "${selected.title}": ${result.error}`,
      );
      continue;
    }

    if (!result.transcript) {
      console.error(
        `    Empty transcript for "${selected.title}" — skipping to next candidate`,
      );
      continue;
    }

    // Only mark as seen once transcript is successfully acquired.
    // If pod2txt fails or returns an error, keep it un-seen so subsequent runs can retry.
    state.seenVideos[selected.guid] = Date.now();

    console.error(
      `    Selected: "${selected.title}" (transcript: ${result.transcript.length} chars)`,
    );

    // Try to resolve the exact YouTube video URL for this episode. If the
    // lookup fails (no YouTube channel configured, no title match, network
    // error), fall back to the channel URL so the feed still works.
    const youtubeUrl = await findYouTubeEpisodeUrl(
      selected.podcast.url,
      selected.title,
    );
    if (youtubeUrl) {
      console.error(`    Matched YouTube episode URL: ${youtubeUrl}`);
    } else {
      console.error(
        `    No YouTube episode match found — falling back to channel URL`,
      );
    }

    return [
      {
        source: "podcast",
        name: selected.podcast.name,
        title: selected.title,
        guid: selected.guid,
        url: youtubeUrl || selected.podcast.url,
        publishedAt: selected.publishedAt,
        transcript: result.transcript,
      },
    ];
  }

  console.error(`    No candidates had transcripts available`);
  return [];
}

// -- X/Twitter Fetching (Official API v2) ------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchXWithRetry(url, options) {
  let lastResponse;
  for (let attempt = 1; attempt <= X_RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, options);
      lastResponse = res;
      if (!X_RETRY_STATUSES.has(res.status) || attempt === X_RETRY_ATTEMPTS) {
        return res;
      }
    } catch (err) {
      if (attempt === X_RETRY_ATTEMPTS) throw err;
    }
    await sleep(1000 * attempt);
  }
  return lastResponse;
}

async function fetchXContent(xAccounts, bearerToken, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  // Batch lookup user IDs. Smaller batches make one flaky X response less likely
  // to wipe out the whole feed.
  const handles = xAccounts.map((a) => a.handle);
  let userMap = {};

  for (let i = 0; i < handles.length; i += X_USER_LOOKUP_BATCH_SIZE) {
    const batch = handles.slice(i, i + X_USER_LOOKUP_BATCH_SIZE);
    try {
      const res = await fetchXWithRetry(
        `${X_API_BASE}/users/by?usernames=${batch.join(",")}&user.fields=name,description`,
        { headers: { Authorization: `Bearer ${bearerToken}` } },
      );

      if (!res.ok) {
        errors.push(
          `X API: User lookup failed for ${batch.join(",")}: HTTP ${res.status}`,
        );
        continue;
      }

      const data = await res.json();
      for (const user of data.data || []) {
        userMap[user.username.toLowerCase()] = {
          id: user.id,
          name: user.name,
          description: user.description || "",
        };
      }
      if (data.errors) {
        for (const err of data.errors) {
          errors.push(`X API: User not found: ${err.value || err.detail}`);
        }
      }
    } catch (err) {
      errors.push(`X API: User lookup error: ${err.message}`);
    }
  }

  // Fetch recent tweets per user (max 3, exclude retweets/replies)
  for (const account of xAccounts) {
    const userData = userMap[account.handle.toLowerCase()];
    if (!userData) continue;

    try {
      const res = await fetchXWithRetry(
        `${X_API_BASE}/users/${userData.id}/tweets?` +
          `max_results=5` + // fetch 5, then filter to 3 new ones
          `&tweet.fields=created_at,public_metrics,referenced_tweets,note_tweet` +
          `&exclude=retweets,replies` +
          `&start_time=${cutoff.toISOString()}`,
        { headers: { Authorization: `Bearer ${bearerToken}` } },
      );

      if (!res.ok) {
        if (res.status === 429) {
          errors.push(`X API: Rate limited, skipping remaining accounts`);
          break;
        }
        errors.push(
          `X API: Failed to fetch tweets for @${account.handle}: HTTP ${res.status}`,
        );
        continue;
      }

      const data = await res.json();
      const allTweets = data.data || [];

      // Filter out already-seen tweets, cap at 3
      const newTweets = [];
      for (const t of allTweets) {
        if (state.seenTweets[t.id]) continue; // dedup
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;

        newTweets.push({
          id: t.id,
          // note_tweet.text has the full untruncated text for long tweets (>280 chars)
          text: t.note_tweet?.text || t.text,
          createdAt: t.created_at,
          url: `https://x.com/${account.handle}/status/${t.id}`,
          likes: t.public_metrics?.like_count || 0,
          retweets: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          isQuote:
            t.referenced_tweets?.some((r) => r.type === "quoted") || false,
          quotedTweetId:
            t.referenced_tweets?.find((r) => r.type === "quoted")?.id || null,
        });

        // Mark as seen
        state.seenTweets[t.id] = Date.now();
      }

      if (newTweets.length === 0) continue;

      results.push({
        source: "x",
        name: account.name,
        handle: account.handle,
        bio: userData.description,
        tweets: newTweets,
      });

      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      errors.push(`X API: Error fetching @${account.handle}: ${err.message}`);
    }
  }

  return results;
}

// -- Blog Fetching (HTML scraping) -------------------------------------------

// Scrapes the Anthropic Engineering blog index page.
// The page is a Next.js app that embeds article data as JSON in <script> tags.
// We parse that JSON to extract article metadata (title, slug, date, summary).
// Falls back to regex-based HTML parsing if the JSON approach fails.
function parseAnthropicEngineeringIndex(html) {
  const articles = [];

  // Strategy 1: Look for article data in Next.js __NEXT_DATA__ script tag
  const nextDataMatch = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      // Navigate the Next.js page props to find article entries
      const pageProps = data?.props?.pageProps;
      const posts =
        pageProps?.posts || pageProps?.articles || pageProps?.entries || [];
      for (const post of posts) {
        const slug = post.slug?.current || post.slug || "";
        articles.push({
          title: post.title || "Untitled",
          url: `https://www.anthropic.com/engineering/${slug}`,
          publishedAt:
            post.publishedOn || post.publishedAt || post.date || null,
          description: post.summary || post.description || "",
        });
      }
      if (articles.length > 0) return articles;
    } catch {
      // JSON parsing failed, fall through to regex approach
    }
  }

  // Strategy 2: Regex-based extraction from the rendered HTML.
  // Anthropic engineering articles follow the pattern /engineering/<slug>
  const linkRegex = /href="\/engineering\/([a-z0-9-]+)"/gi;
  const seenSlugs = new Set();
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const slug = linkMatch[1];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    articles.push({
      title: "", // Will be filled when we fetch the article page
      url: `https://www.anthropic.com/engineering/${slug}`,
      publishedAt: null,
      description: "",
    });
  }
  return articles;
}

// Scrapes the Claude Blog index page (claude.com/blog and /resources/articles).
// Matches article links under both /resources/articles/<slug> and legacy /blog/<slug>.
function parseClaudeBlogIndex(html) {
  const articles = [];
  const seenUrls = new Set();

  // Match blog/article post links — supports both /blog/<slug> and /resources/articles/<slug>
  const linkRegex =
    /href="((?:https?:\/\/claude\.com)?\/(?:resources\/articles|blog)\/([a-z0-9-]+))\/?["']/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const rawPath = linkMatch[1];
    const fullUrl = rawPath.startsWith("http")
      ? rawPath.replace(/\/$/, "")
      : `https://claude.com${rawPath.startsWith("/") ? "" : "/"}${rawPath}`.replace(/\/$/, "");

    if (seenUrls.has(fullUrl)) continue;
    seenUrls.add(fullUrl);

    articles.push({
      title: "", // Will be filled when we fetch the article page
      url: fullUrl,
      publishedAt: null,
      description: "",
    });
  }
  return articles;
}

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return str || '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

// Extracts the main text content from an Anthropic Engineering article page.
// Tries JSON-LD schema data first (used in modern Next.js App Router), then
// Next.js embedded SSR data, then falls back to stripping HTML tags.
function extractAnthropicArticleContent(html) {
  let title = "";
  let author = "";
  let publishedAt = null;
  let content = "";

  // Strategy 1: JSON-LD structured data (standard in modern Next.js)
  const jsonLdRegex =
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (
        ld["@type"] === "BlogPosting" ||
        ld["@type"] === "Article" ||
        ld["@type"] === "NewsArticle"
      ) {
        title = ld.headline || ld.name || "";
        author =
          typeof ld.author === "string"
            ? ld.author
            : ld.author?.name ||
              (Array.isArray(ld.author)
                ? ld.author.map((a) => a.name || a).join(", ")
                : "");
        publishedAt = ld.datePublished || ld.dateCreated || null;
        break;
      }
    } catch {
      // Not valid JSON-LD, skip
    }
  }

  // Strategy 2: Try Next.js __NEXT_DATA__ if present
  if (!content) {
    const nextDataMatch = html.match(
      /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
    );
    if (nextDataMatch) {
      try {
        const data = JSON.parse(nextDataMatch[1]);
        const pageProps = data?.props?.pageProps;
        const post =
          pageProps?.post || pageProps?.article || pageProps?.entry || pageProps;
        if (!title) title = post?.title || "";
        if (!author)
          author = post?.author?.name || post?.authors?.[0]?.name || "";
        if (!publishedAt)
          publishedAt =
            post?.publishedOn || post?.publishedAt || post?.date || null;

        const body = post?.body || post?.content || [];
        if (Array.isArray(body)) {
          const textParts = [];
          for (const block of body) {
            if (block._type === "block" && block.children) {
              const text = block.children.map((c) => c.text || "").join("");
              if (text.trim()) textParts.push(text.trim());
            }
          }
          content = textParts.join("\n\n");
        }
      } catch {
        // Fall through
      }
    }
  }

  // Strategy 3: HTML tag fallback for title, author, date
  if (!title) {
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, "").trim();
  }
  if (!publishedAt) {
    const timeMatch = html.match(/<time[^>]*datetime="([^"]+)"[^>]*>/i);
    if (timeMatch) publishedAt = timeMatch[1];
  }

  // Extract body from <article> or main content if not already extracted from structured blocks
  if (!content) {
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const bodyHtml = articleMatch ? articleMatch[1] : html;

    content = bodyHtml
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return {
    title: decodeHtmlEntities(title),
    author: decodeHtmlEntities(author),
    publishedAt,
    content,
  };
}

// Extracts the main text content from a Claude Blog article page.
// Uses JSON-LD schema data if present, then falls back to the rich text body.
function extractClaudeBlogArticleContent(html) {
  let title = "";
  let author = "";
  let publishedAt = null;
  let content = "";

  // Try JSON-LD structured data first (most reliable for metadata)
  const jsonLdRegex =
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (
        ld["@type"] === "BlogPosting" ||
        ld["@type"] === "Article" ||
        ld["@type"] === "NewsArticle"
      ) {
        title = ld.headline || ld.name || "";
        author =
          typeof ld.author === "string"
            ? ld.author
            : ld.author?.name ||
              (Array.isArray(ld.author)
                ? ld.author.map((a) => a.name || a).join(", ")
                : "");
        publishedAt = ld.datePublished || ld.dateCreated || null;
        break;
      }
    } catch {
      // Not valid JSON-LD, skip
    }
  }

  // Extract body text from <article> tag or Webflow rich text container.
  // Modern pages wrap full article in <article>, while nested <div>s can prematurely terminate w-richtext regex
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const richTextMatch =
    html.match(
      /<div[^>]*class="[^"]*u-rich-text-blog[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
    ) ||
    html.match(/<div[^>]*class="[^"]*w-richtext[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  const bodyHtml =
    articleMatch && articleMatch[1].length > (richTextMatch ? richTextMatch[1].length : 0)
      ? articleMatch[1]
      : richTextMatch
        ? richTextMatch[1]
        : articleMatch
          ? articleMatch[1]
          : html;

  content = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // If rich text extraction failed, get title from <h1> if not already found
  if (!title) {
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, "").trim();
  }
  if (!publishedAt) {
    const timeMatch = html.match(/<time[^>]*datetime="([^"]+)"[^>]*>/i);
    if (timeMatch) publishedAt = timeMatch[1];
  }

  return {
    title: decodeHtmlEntities(title),
    author: decodeHtmlEntities(author),
    publishedAt,
    content,
  };
}

// Main blog fetching orchestrator.
// For each blog source in the config, discovers new articles, deduplicates
// against previously seen URLs, fetches full article content, and returns
// the results for feed-blogs.json.
async function fetchBlogContent(blogs, state, errors) {
  const results = [];
  const now = Date.now();
  const cutoff = new Date(now - BLOG_LOOKBACK_HOURS * 60 * 60 * 1000);
  const futureCutoff = new Date(now + 24 * 60 * 60 * 1000); // Guard against bogus future dates

  for (const blog of blogs) {
    console.error(`  Processing blog: ${blog.name}...`);
    let candidates = [];

    try {
      // Step 1: Discover articles from the blog index page
      const indexRes = await fetch(blog.indexUrl, {
        headers: { "User-Agent": "FollowBuilders/1.0 (feed aggregator)" },
      });
      if (!indexRes.ok) {
        errors.push(
          `Blog: Failed to fetch index for ${blog.name}: HTTP ${indexRes.status}`,
        );
        continue;
      }
      const indexHtml = await indexRes.text();

      // Use the right parser based on which blog this is
      if (blog.indexUrl.includes("anthropic.com")) {
        candidates = parseAnthropicEngineeringIndex(indexHtml);
      } else if (blog.indexUrl.includes("claude.com")) {
        candidates = parseClaudeBlogIndex(indexHtml);
      }

      // Step 2: Scan candidates to find up to MAX_ARTICLES_PER_BLOG qualified articles.
      // Blog index pages list articles newest-first. We scan recent entries (MAX_INDEX_SCAN)
      // to find up to MAX_ARTICLES_PER_BLOG articles that have valid dates falling within
      // the lookback window. If initial candidates turn out to be older than the cutoff or
      // already seen, scanning continues until up to 3 qualified fresh articles are found
      // or candidates are exhausted.
      const MAX_INDEX_SCAN = 15;
      let qualifiedForBlog = 0;

      for (const candidate of candidates.slice(0, MAX_INDEX_SCAN)) {
        if (qualifiedForBlog >= MAX_ARTICLES_PER_BLOG) {
          break;
        }

        if (state.seenArticles[candidate.url]) {
          continue; // already seen
        }

        // If candidate already has an authoritative date from index, check if older than cutoff
        if (candidate.publishedAt) {
          const indexDate = new Date(candidate.publishedAt);
          if (!isNaN(indexDate.getTime()) && indexDate < cutoff) {
            // Already known to be older than cutoff; mark as seen to avoid re-examining
            state.seenArticles[candidate.url] = Date.now();
            continue;
          }
        }

        // Fetch full article page
        try {
          const articleRes = await fetch(candidate.url, {
            headers: { "User-Agent": "FollowBuilders/1.0 (feed aggregator)" },
          });
          if (!articleRes.ok) {
            errors.push(
              `Blog: Failed to fetch article ${candidate.url}: HTTP ${articleRes.status}`,
            );
            continue;
          }
          const articleHtml = await articleRes.text();

          // Use the right content extractor based on the blog or article URL
          let extracted;
          if (
            candidate.url.includes("anthropic.com/engineering") ||
            blog.name.toLowerCase().includes("anthropic")
          ) {
            extracted = extractAnthropicArticleContent(articleHtml);
          } else if (
            candidate.url.includes("claude.com") ||
            blog.name.toLowerCase().includes("claude")
          ) {
            extracted = extractClaudeBlogArticleContent(articleHtml);
          }

          if (!extracted || !extracted.content) {
            errors.push(`Blog: No content extracted from ${candidate.url}`);
            continue;
          }

          // Validate publication date:
          // Must be present, valid, within the lookback window, and not in the future.
          // Articles with missing, invalid, or far-future dates are NOT marked in seenArticles,
          // allowing subsequent runs to discover them once corrected.
          const finalPublishedAt = extracted.publishedAt || candidate.publishedAt;
          if (!finalPublishedAt) {
            console.error(
              `    Skipping ${candidate.url}: missing publication date (will retry on next run)`,
            );
            continue;
          }

          const pubDate = new Date(finalPublishedAt);
          if (isNaN(pubDate.getTime())) {
            console.error(
              `    Skipping ${candidate.url}: invalid publication date "${finalPublishedAt}" (will retry on next run)`,
            );
            continue;
          }

          if (pubDate > futureCutoff) {
            console.error(
              `    Skipping ${candidate.url}: published at ${pubDate.toISOString()} is in the future (will retry on next run)`,
            );
            continue;
          }

          if (pubDate < cutoff) {
            console.error(
              `    Skipping ${candidate.url}: published at ${pubDate.toISOString()} is older than cutoff ${cutoff.toISOString()}`,
            );
            // Valid historical article: mark as seen so we do not re-fetch on future runs
            state.seenArticles[candidate.url] = Date.now();
            continue;
          }

          // Fresh, qualified article: include in feed and mark as seen
          results.push({
            source: "blog",
            name: blog.name,
            title: extracted.title || candidate.title || "Untitled",
            url: candidate.url,
            publishedAt: extracted.publishedAt || candidate.publishedAt,
            author: extracted.author || "",
            description: candidate.description || "",
            content: extracted.content,
          });

          // Mark candidate as seen only after confirming qualification and inclusion
          state.seenArticles[candidate.url] = Date.now();
          qualifiedForBlog++;

          // Small delay between article fetches to be polite
          await new Promise((r) => setTimeout(r, 500));
        } catch (err) {
          errors.push(
            `Blog: Error fetching article ${candidate.url}: ${err.message}`,
          );
        }
      }

      if (qualifiedForBlog === 0) {
        console.error(`    No new articles found`);
      } else {
        console.error(
          `    Found ${qualifiedForBlog} qualified new article(s)`,
        );
      }
    } catch (err) {
      errors.push(`Blog: Error processing ${blog.name}: ${err.message}`);
    }
  }

  return results;
}

// -- Main --------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const tweetsOnly = args.includes("--tweets-only");
  const podcastsOnly = args.includes("--podcasts-only");
  const blogsOnly = args.includes("--blogs-only");

  const feedDirIndex = args.indexOf("--feed-dir");
  let feedDir = join(SCRIPT_DIR, "..");
  if (
    feedDirIndex !== -1 &&
    feedDirIndex + 1 < args.length &&
    !args[feedDirIndex + 1].startsWith("--")
  ) {
    feedDir = args[feedDirIndex + 1];
  } else if (process.env.FEED_DIR) {
    feedDir = process.env.FEED_DIR;
  }

  if (dryRun) {
    console.error(
      "[dry-run] Dry run mode enabled (不写文件，仍可能联网及产生 API 费用). No feed files or state will be written.",
    );
  }

  // If a specific --*-only flag is set, only that feed type runs.
  // If no flag is set, all three run.
  const runTweets = tweetsOnly || (!podcastsOnly && !blogsOnly);
  const runPodcasts = podcastsOnly || (!tweetsOnly && !blogsOnly);
  const runBlogs = blogsOnly || (!tweetsOnly && !podcastsOnly);

  const xBearerToken = process.env.X_BEARER_TOKEN;
  const pod2txtKey = process.env.POD2TXT_API_KEY;

  if (runPodcasts && !pod2txtKey) {
    console.error("POD2TXT_API_KEY not set");
    process.exit(1);
  }
  if (runTweets && !xBearerToken) {
    console.error("X_BEARER_TOKEN not set");
    process.exit(1);
  }

  const sources = await loadSources();
  const statePath = join(feedDir, "state-feed.json");
  const state = await loadState(statePath);
  const errors = [];

  // Fetch tweets
  if (runTweets) {
    console.error("Fetching X/Twitter content...");
    const xContent = await fetchXContent(
      sources.x_accounts,
      xBearerToken,
      state,
      errors,
    );
    console.error(`  Found ${xContent.length} builders with new tweets`);

    const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);
    const xErrors = errors.filter((e) => e.startsWith("X API"));

    if (xErrors.length > 0) {
      console.error("  X API errors:");
      for (const error of xErrors) {
        console.error(`    - ${error}`);
      }
    }

    if (xContent.length === 0 && xErrors.length > 0) {
      throw new Error(
        `X feed failed: 0 builders returned and ${xErrors.length} X API error(s) occurred`,
      );
    }

    const xFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: TWEET_LOOKBACK_HOURS,
      x: xContent,
      stats: { xBuilders: xContent.length, totalTweets },
      errors: xErrors.length > 0 ? xErrors : undefined,
    };
    if (dryRun) {
      console.error(
        `[dry-run] feed-x.json: ${xContent.length} builders, ${totalTweets} tweets (skipped write)`,
      );
    } else {
      await writeFile(
        join(feedDir, "feed-x.json"),
        JSON.stringify(xFeed, null, 2),
      );
      console.error(
        `  feed-x.json: ${xContent.length} builders, ${totalTweets} tweets`,
      );
    }
  }

  // Fetch podcasts
  if (runPodcasts) {
    console.error("Fetching podcast content (RSS + pod2txt)...");
    const podcasts = await fetchPodcastContent(
      sources.podcasts,
      pod2txtKey,
      state,
      errors,
    );
    console.error(`  Found ${podcasts.length} new episodes`);

    const podcastFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: PODCAST_LOOKBACK_HOURS,
      podcasts,
      stats: { podcastEpisodes: podcasts.length },
      errors:
        errors.filter((e) => e.startsWith("Podcast")).length > 0
          ? errors.filter((e) => e.startsWith("Podcast"))
          : undefined,
    };
    if (dryRun) {
      console.error(
        `[dry-run] feed-podcasts.json: ${podcasts.length} episodes (skipped write)`,
      );
    } else {
      await writeFile(
        join(feedDir, "feed-podcasts.json"),
        JSON.stringify(podcastFeed, null, 2),
      );
      console.error(`  feed-podcasts.json: ${podcasts.length} episodes`);
    }
  }

  // Fetch blog posts
  if (runBlogs && sources.blogs && sources.blogs.length > 0) {
    console.error("Fetching blog content...");
    const blogContent = await fetchBlogContent(sources.blogs, state, errors);
    console.error(`  Found ${blogContent.length} new blog post(s)`);

    // Retain existing fresh articles from feed-blogs.json so repeat runs on the same day
    // (when newly fetched articles are 0 due to dedup) do not wipe out valid feeds.
    const feedBlogsPath = join(feedDir, "feed-blogs.json");
    let existingBlogs = [];
    if (existsSync(feedBlogsPath)) {
      try {
        const existingData = JSON.parse(await readFile(feedBlogsPath, "utf-8"));
        if (Array.isArray(existingData.blogs)) {
          existingBlogs = existingData.blogs;
        }
      } catch {
        // Ignore unreadable/corrupted feed file
      }
    }

    const now = Date.now();
    const blogCutoff = now - BLOG_LOOKBACK_HOURS * 60 * 60 * 1000;
    const mergedBlogs = mergeBlogPosts(
      blogContent,
      existingBlogs,
      blogCutoff,
      now,
    );

    const blogFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: BLOG_LOOKBACK_HOURS,
      blogs: mergedBlogs,
      stats: { blogPosts: mergedBlogs.length },
      errors:
        errors.filter((e) => e.startsWith("Blog")).length > 0
          ? errors.filter((e) => e.startsWith("Blog"))
          : undefined,
    };
    if (dryRun) {
      console.error(
        `[dry-run] feed-blogs.json: ${mergedBlogs.length} posts (${blogContent.length} new, ${mergedBlogs.length - blogContent.length} retained) (skipped write)`,
      );
    } else {
      await writeFile(
        feedBlogsPath,
        JSON.stringify(blogFeed, null, 2),
      );
      console.error(
        `  feed-blogs.json: ${mergedBlogs.length} posts (${blogContent.length} new, ${mergedBlogs.length - blogContent.length} retained)`,
      );
    }
  }

  // Save dedup state
  if (dryRun) {
    console.error(
      "[dry-run] state-feed.json: skipped updating state in dry-run mode",
    );
  } else {
    await saveState(
      state,
      {
        tweets: runTweets,
        podcasts: runPodcasts,
        blogs: runBlogs,
      },
      statePath,
    );
  }

  if (errors.length > 0) {
    console.error(`  ${errors.length} non-fatal errors`);
  }
}

const isMainModule =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((err) => {
    console.error("Feed generation failed:", err.message);
    process.exit(1);
  });
}

export {
  main,
  saveState,
  loadState,
  mergeBlogPosts,
  fetchPodcastContent,
  fetchPod2txtTranscript,
  fetchXContent,
  fetchBlogContent,
  extractAnthropicArticleContent,
  extractClaudeBlogArticleContent,
  parseAnthropicEngineeringIndex,
  parseClaudeBlogIndex,
};
