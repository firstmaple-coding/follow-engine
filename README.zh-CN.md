[English](README.md) | **中文**

# 追踪建造者，而非网红 (Follow Engine Fork)

一个 AI 驱动的信息聚合工具，追踪 AI 领域最顶尖的建造者——研究员、创始人、产品经理和工程师——并将他们的最新动态整理成易于消化的摘要推送给你。

> **项目现状与 Fork 说明 (firstmaple-coding Fork)：**
> 本仓库是 [zarazhangrui/follow-builders](https://github.com/zarazhangrui/follow-builders) 的增强 Fork 版本。
>
> - **已验收的手动流程（无需付费信源 API 密钥）：** 已在 Work 模式本地项目中完成中文博客早报的全流程验收。流程执行 72 小时时效校验，将运行数据写入 `.runtime/`，并使用 `.agents/skills/daily-blog-digest/SKILL.md`。Claude Blog 和 GitHub Engineering 已用近期文章验收。Google AI Blog 的官方 RSS 与正文提取已通过在线 dry-run，尚待在 Work 模式验收早报；Anthropic Engineering 的详情页提取仍待有新文章时实测。
> - **各模块依赖边界说明（客观披露）：**
>   - **X / Twitter 抓取：** X 生成器需要 `X_BEARER_TOKEN`；默认全量生成器缺少该值时会退出，`--blogs-only` 模式不会运行 X。
>   - **播客抓取：** 转录依赖 `POD2TXT_API_KEY`；默认全量生成器缺少该值时会退出，`--blogs-only` 模式不会运行播客。YouTube 官方 API `captions.download` 要求对视频有编辑权限，不能直接作为通用第三方视频字幕抓取方案。
>   - **GitHub Actions 自动化流水线：** Feed 工作流（`.github/workflows/generate-feed.yml`）目前在本 Fork 未启用；已验收的博客流程仅在本地手动运行。

---

## 你会得到什么

已验收流程在本地聊天中按需生成中文博客摘要。仓库还保留了 X、播客与交付组件，但它们有各自的依赖：

- **官方技术博客：** Claude Blog 和 GitHub Engineering 已在本地早报中验收；Google AI Blog 的正文提取通过在线 dry-run。Anthropic Engineering 仍待有符合时效的文章时验证详情提取。
- **X 上的 AI 建造者：** 26 位顶尖 AI 建造者的核心观点与讨论（需配置 `X_BEARER_TOKEN`）。
- **精选播客：** 6 档顶尖 AI 播客节目的关键洞察（需配置 `POD2TXT_API_KEY`）。
- **语言：** 手动博客 Skill 已以简体中文验收；底层预处理脚本也接受英文和中英双语配置。

---

## 已验收能力：手动官方博客早报（零付费密钥）

你可以在 Work 模式本地项目中运行官方博客早报，无需付费信源 API 密钥；本地 Agent 本身可能有账号或用量要求。

### 1. 在 ChatGPT 桌面端使用
1. 克隆本仓库到本地：
   ```bash
   git clone https://github.com/firstmaple-coding/follow-engine.git
   ```
2. 在 Work 模式中将本仓库作为本地项目打开（或使用能读取本地文件的 Agent）。
3. 调用仓库中的 Skill：`.agents/skills/daily-blog-digest/SKILL.md`。
4. 在会话中输入 **“生成今日早报”** 或 **“获取今日博客早报”**。
5. Agent 会优先探测 `.runtime/feed-blogs.json`（24 小时内直接复用缓存，防止频繁请求被目标站点限流），并在需要时重新抓取，生成带直达链接与原文引述的中文早报。

### 2. 通过 CLI 命令行手动运行
所有命令在仓库根目录执行，运行数据统一输出至被 Git 忽略的 `.runtime/` 目录：

```bash
# 第一步：抓取最新官方博客文章（写入 .runtime/feed-blogs.json）
node scripts/generate-feed.js --blogs-only --feed-dir .runtime

# 第二步：预处理并读取摘要物料（校验 24 小时时效并注入中文提示词）
node scripts/prepare-digest.js --local --blogs-only --feed-dir .runtime --max-feed-age-hours 24 --language zh
```

上述命令把生成的 feed 与状态文件写入被 Git 忽略的 `.runtime/`，不会修改仓库中受跟踪的 feed 文件。

---

## 信息源与依赖说明

### 博客与实践者来源（已配置 6 个）
- **官方博客**：
  - [Anthropic Engineering](https://www.anthropic.com/engineering) — Anthropic 团队的技术深度文章
  - [Claude Blog](https://claude.com/blog)（以及 `/resources/articles`）— Claude 的产品公告、研究与技术指南
  - [GitHub Engineering](https://github.blog/engineering/) — 通过官方全文 RSS 发现的工程技术文章
  - [Google AI Blog](https://blog.google/innovation-and-ai/technology/ai/) — 通过官方 RSS 发现 AI 动态，再从原文页面提取正文
  - [OpenAI News](https://openai.com/news/) — 通过官方 RSS 发现产品与研究公告，使用摘要模式接入
- **独立实践者博客**：
  - [Simon Willison Weblog](https://simonwillison.net/tags/ai/) — 通过官方 Atom 订阅获取 AI 标签动态与正文，覆盖独立实测、架构思考与证据链接

### X 上的 AI 建造者（26 位）
*需要配置 `X_BEARER_TOKEN`*
[Andrej Karpathy](https://x.com/karpathy), [Swyx](https://x.com/swyx), [Josh Woodward](https://x.com/joshwoodward), [Boris Cherny](https://x.com/bcherny), [Thibault Sottiaux](https://x.com/thsottiaux), [Peter Yang](https://x.com/petergyang), [Nan Yu](https://x.com/thenanyu), [Madhu Guru](https://x.com/realmadhuguru), [Amanda Askell](https://x.com/AmandaAskell), [Cat Wu](https://x.com/_catwu), [Thariq](https://x.com/trq212), [Google Labs](https://x.com/GoogleLabs), [Amjad Masad](https://x.com/amasad), [Guillermo Rauch](https://x.com/rauchg), [Alex Albert](https://x.com/alexalbert__), [Aaron Levie](https://x.com/levie), [Ryo Lu](https://x.com/ryolu_), [Garry Tan](https://x.com/garrytan), [Matt Turck](https://x.com/mattturck), [Zara Zhang](https://x.com/zarazhangrui), [Nikunj Kothari](https://x.com/nikunj), [Peter Steinberger](https://x.com/steipete), [Dan Shipper](https://x.com/danshipper), [Aditya Agarwal](https://x.com/adityaag), [Sam Altman](https://x.com/sama), [Claude](https://x.com/claudeai)

### 播客（6 个）
*需要配置 `POD2TXT_API_KEY`（或第三方转写服务）*
- [Latent Space](https://www.youtube.com/@LatentSpacePod)
- [Training Data](https://www.youtube.com/playlist?list=PLOhHNjZItNnMm5tdW61JpnyxeYH5NDDx8)
- [No Priors](https://www.youtube.com/@NoPriorsPodcast)
- [Unsupervised Learning](https://www.youtube.com/@RedpointAI)
- [The MAD Podcast with Matt Turck](https://www.youtube.com/@DataDrivenNYC)
- [AI & I by Every](https://www.youtube.com/playlist?list=PLuMcoKK9mKgHtW_o9h5sGO2vXrffKHwJL)

---

## 自定义摘要提示词

`prompts/` 文件夹中的文件用于控制摘要格式与语气：
- `summarize-blogs.md` — 博客文章的摘要方式（核心发布、关键数据、强制原文直接引述、原文链接）
- `summarize-tweets.md` — X/Twitter 帖子的摘要方式
- `summarize-podcast.md` — 播客节目的摘要方式
- `digest-intro.md` — 早报整体结构、排版与署名规范
- `translate.md` — 英文专业内容翻译为地道简体中文的规范

---

## 上游同步策略

本 Fork 与上游原项目（`zarazhangrui/follow-builders`）通过按次审查的方式同步，严格避免覆盖 Fork 已有的功能改动与测试体系。

---

## License

MIT
