**English** | [中文](README.zh-CN.md)

# Follow Builders (Follow Engine Fork)

An AI-powered digest that tracks top builders in AI — researchers, founders, PMs, and engineers who are actually building things — and delivers curated summaries of what they are publishing and discussing.

> **Project Status (firstmaple-coding Fork):**
> This repository is an active Fork of [zarazhangrui/follow-builders](https://github.com/zarazhangrui/follow-builders).
>
> - **Verified & Production-Ready (Zero Paid Keys):** We have implemented and end-to-end verified a **manual, 100% free / zero-paid-API-key AI Official Blog Digest** workflow. It extracts public posts from AI engineering blogs (Anthropic Engineering, Claude Blog), strictly enforces article freshness (72-hour window), isolates runtime data to `.runtime/` (keeping Git tracked files completely clean), and provides a desktop Skill (`.agents/skills/daily-blog-digest/SKILL.md`) for ChatGPT Desktop and local agents.
> - **Dependency Boundaries (Honest Disclosure):**
>   - **X / Twitter:** Requires an official Twitter API Developer account and `X_BEARER_TOKEN` (paid / elevated tier). If not provided, Twitter generation is skipped.
>   - **Podcasts / YouTube Transcripts:** Requires `POD2TXT_API_KEY` (or a third-party transcription provider). Note: The official YouTube Data API v3 `captions.download` method requires video edit/ownership permissions and cannot serve as an open third-party subtitle downloader for arbitrary public videos.
>   - **GitHub Actions Automation:** The automated daily workflow (`.github/workflows/daily.yml`) is currently inactive / disabled in this Fork to prevent unexpected billing or uninspected executions. All verified workflows run manually and locally.

---

## What You Get

A daily or on-demand digest delivered in-chat or to your preferred messaging apps:

- **Official AI Blogs (Verified, Zero Keys):** Fresh technical deep dives and announcements from top AI labs (Anthropic Engineering, Claude Blog) with direct links, original quotes, and strict anti-fabrication rules.
- **AI Builders on X:** Key posts and insights from 26 curated AI builders (requires `X_BEARER_TOKEN`).
- **Podcasts:** Episode summaries from 6 top AI podcasts (requires `POD2TXT_API_KEY`).
- **Languages:** Available in English, Chinese (Mandarin), or bilingual format.

---

## Verified Feature: Manual Daily Blog Digest (Zero Paid Keys)

You can run the official blog digest locally or via ChatGPT Desktop without any API keys or paid accounts.

### 1. Using ChatGPT Desktop
1. Clone this repository to your local machine:
   ```bash
   git clone https://github.com/firstmaple-coding/follow-engine.git
   ```
2. Open ChatGPT Desktop (or your local Agent).
3. The desktop skill is located at `.agents/skills/daily-blog-digest/SKILL.md`.
4. Say **"生成今日早报"** or **"获取今日博客早报"**.
5. The agent checks `.runtime/feed-blogs.json` for same-day freshness (reusing cached results within 24 hours to prevent rate limits), fetches fresh articles if needed, and outputs a verified Chinese digest with direct links and quotes.

### 2. Running via CLI
All commands run in the repository root and output to the Git-ignored `.runtime/` directory:

```bash
# Step 1: Fetch fresh official blogs (writes to .runtime/feed-blogs.json)
node scripts/generate-feed.js --blogs-only --feed-dir .runtime

# Step 2: Prepare digest JSON (checks 24h freshness, loads Chinese prompts)
node scripts/prepare-digest.js --local --blogs-only --feed-dir .runtime --max-feed-age-hours 24 --language zh
```

The Git working tree remains completely clean because all runtime files are placed in `.runtime/` (configured in `.gitignore`).

---

## Sources & Boundaries

### Official Blogs (2 verified)
- [Anthropic Engineering](https://www.anthropic.com/engineering) — technical deep dives from the Anthropic team
- [Claude Blog](https://claude.com/blog) (and `/resources/articles`) — product announcements, research, and technical guides

### AI Builders on X (26)
*Requires `X_BEARER_TOKEN`*
[Andrej Karpathy](https://x.com/karpathy), [Swyx](https://x.com/swyx), [Josh Woodward](https://x.com/joshwoodward), [Boris Cherny](https://x.com/bcherny), [Thibault Sottiaux](https://x.com/thsottiaux), [Peter Yang](https://x.com/petergyang), [Nan Yu](https://x.com/thenanyu), [Madhu Guru](https://x.com/realmadhuguru), [Amanda Askell](https://x.com/AmandaAskell), [Cat Wu](https://x.com/_catwu), [Thariq](https://x.com/trq212), [Google Labs](https://x.com/GoogleLabs), [Amjad Masad](https://x.com/amasad), [Guillermo Rauch](https://x.com/rauchg), [Alex Albert](https://x.com/alexalbert__), [Aaron Levie](https://x.com/levie), [Ryo Lu](https://x.com/ryolu_), [Garry Tan](https://x.com/garrytan), [Matt Turck](https://x.com/mattturck), [Zara Zhang](https://x.com/zarazhangrui), [Nikunj Kothari](https://x.com/nikunj), [Peter Steinberger](https://x.com/steipete), [Dan Shipper](https://x.com/danshipper), [Aditya Agarwal](https://x.com/adityaag), [Sam Altman](https://x.com/sama), [Claude](https://x.com/claudeai)

### Podcasts (6)
*Requires `POD2TXT_API_KEY` (or external transcript provider)*
- [Latent Space](https://www.youtube.com/@LatentSpacePod)
- [Training Data](https://www.youtube.com/playlist?list=PLOhHNjZItNnMm5tdW61JpnyxeYH5NDDx8)
- [No Priors](https://www.youtube.com/@NoPriorsPodcast)
- [Unsupervised Learning](https://www.youtube.com/@RedpointAI)
- [The MAD Podcast with Matt Turck](https://www.youtube.com/@DataDrivenNYC)
- [AI & I by Every](https://www.youtube.com/playlist?list=PLuMcoKK9mKgHtW_o9h5sGO2vXrffKHwJL)

---

## Customizing Summaries

Prompts in the `prompts/` directory govern output formatting and style:
- `summarize-blogs.md` — guidelines for blog summaries (core announcements, metrics, mandatory direct quotes, direct links)
- `summarize-tweets.md` — rules for X/Twitter builder posts
- `summarize-podcast.md` — instructions for podcast episode transcripts
- `digest-intro.md` — overall digest structuring, formatting, and header/footer rules
- `translate.md` — instructions for natural simplified Chinese translation

---

## Upstream Synchronization

This Fork syncs with the upstream repository (`zarazhangrui/follow-builders`) through selective, PR-by-PR reviews to prevent unintended overrides of Fork enhancements.

---

## License

MIT
