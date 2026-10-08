**English** | [中文](README.zh-CN.md)

# Follow Builders (Follow Engine Fork)

An AI-powered digest that tracks top builders in AI — researchers, founders, PMs, and engineers who are actually building things — and delivers curated summaries of what they are publishing and discussing.

> **Project Status (firstmaple-coding Fork):**
> This repository is an active Fork of [zarazhangrui/follow-builders](https://github.com/zarazhangrui/follow-builders).
>
> - **Verified manual workflow (no paid source API keys):** A local Chinese blog digest has been tested end to end in Work mode. It checks article freshness (72-hour window), keeps generated data in `.runtime/`, and uses `.agents/skills/daily-blog-digest/SKILL.md`. Claude Blog and GitHub Engineering have been verified with current posts. Google AI Blog's RSS and article extraction passed a live dry-run; its Work-mode digest has not yet been accepted. Anthropic Engineering is configured, but its detail extraction awaits a fresh article.
> - **Dependency Boundaries (Honest Disclosure):**
>   - **X / Twitter:** The X generator requires `X_BEARER_TOKEN`. The full generator exits if it is missing; `--blogs-only` does not run X.
>   - **Podcasts:** Transcript generation requires `POD2TXT_API_KEY`. The full generator exits if it is missing; `--blogs-only` does not run podcasts. YouTube Data API v3 `captions.download` requires permission to edit the video, so it is not a general way to download captions from third-party videos.
>   - **GitHub Actions Automation:** The feed workflow (`.github/workflows/generate-feed.yml`) is currently inactive in this Fork. The verified blog workflow runs manually and locally.

---

## What You Get

The verified workflow produces an on-demand Chinese blog digest in the local chat. The repository also contains earlier X, podcast, and delivery components with separate dependencies:

- **Official AI Blogs:** Claude Blog and GitHub Engineering were verified in the local digest; Google AI Blog article extraction passed a live dry-run. Anthropic Engineering detail extraction awaits a fresh qualifying article.
- **AI Builders on X:** Key posts and insights from 26 curated AI builders (requires `X_BEARER_TOKEN`).
- **Podcasts:** Episode summaries from 6 top AI podcasts (requires `POD2TXT_API_KEY`).
- **Languages:** The manual blog Skill was verified in Chinese; the underlying preparation script also accepts English and bilingual settings.

---

## Verified Feature: Manual Daily Blog Digest (Zero Paid Keys)

You can run the official blog digest in a local Work project without paid source API keys. Access to the local agent may have its own account or usage requirements.

### 1. Using ChatGPT Desktop
1. Clone this repository to your local machine:
   ```bash
   git clone https://github.com/firstmaple-coding/follow-engine.git
   ```
2. Open this repository as a local project in Work mode (or another local agent with filesystem access).
3. Invoke the repository Skill at `.agents/skills/daily-blog-digest/SKILL.md`.
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

These commands keep generated feed and state files in `.runtime/`, which is ignored by Git. They do not modify the repository's tracked feed files.

---

## Sources & Boundaries

### Blog & Practitioner Sources (6 configured)
- **Official Blogs**:
  - [Anthropic Engineering](https://www.anthropic.com/engineering) — technical deep dives from the Anthropic team
  - [Claude Blog](https://claude.com/blog) (and `/resources/articles`) — product announcements, research, and technical guides
  - [GitHub Engineering](https://github.blog/engineering/) — engineering articles discovered from its official full-text RSS feed
  - [Google AI Blog](https://blog.google/innovation-and-ai/technology/ai/) — AI updates from Google's official RSS feed, with article-page text extraction
  - [OpenAI News](https://openai.com/news/) — official product and research announcements parsed from its RSS feed in summary mode
- **Independent Practitioner Weblog**:
  - [Simon Willison Weblog](https://simonwillison.net/tags/ai/) — AI tagged entries and content parsed from the official Atom feed, covering hands-on experiments, architectural reflections, and evidence links

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
