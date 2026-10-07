[English](README.md) | **中文**

# 追踪建造者，而非网红 (Follow Engine Fork)

一个 AI 驱动的信息聚合工具，追踪 AI 领域最顶尖的建造者——研究员、创始人、产品经理和工程师——并将他们的最新动态整理成易于消化的摘要推送给你。

> **项目现状与 Fork 说明 (firstmaple-coding Fork)：**
> 本仓库是 [zarazhangrui/follow-builders](https://github.com/zarazhangrui/follow-builders) 的增强 Fork 版本。
>
> - **已验收且就绪的功能（零付费密钥）：** 我们实现并全流程验证了**本地手动、零付费 API 密钥的 AI 官方博客中文早报**。该流程直接抓取公开技术博客（Anthropic Engineering、Claude 官方博客），严格执行 72 小时时效校验、去重合并与原文抽取，将运行数据隔离至 `.runtime/` 目录（确保 Git 代码工作区 100% 保持干净），并通过 `.agents/skills/daily-blog-digest/SKILL.md` 原生支持 ChatGPT 桌面端及本地 Agent。
> - **各模块依赖边界说明（客观披露）：**
>   - **X / Twitter 抓取：** 依赖官方 Twitter API Developer 权限与 `X_BEARER_TOKEN`（付费 / 高级权限），未配置时自动跳过。
>   - **播客（YouTube 字幕）抓取：** 依赖 `POD2TXT_API_KEY`（或第三方转写服务）。*注：YouTube 官方 API `captions.download` 要求对视频拥有所有权或编辑权限，无法直接作为通用公共字幕拉取方案。*
>   - **GitHub Actions 自动化流水线：** 每日自动化工作流（`.github/workflows/daily.yml`）目前处于未启用状态，避免产生意外费用或非受控运行；当前均以本地手动受控运行为主。

---

## 你会得到什么

按需或每日在聊天应用中接收的精选摘要：

- **官方技术博客（已验收，零密钥）：** Anthropic Engineering 与 Claude 官方博客的最新技术文章与产品发布，包含原文核心句子引用与直达链接，严禁虚构。
- **X 上的 AI 建造者：** 26 位顶尖 AI 建造者的核心观点与讨论（需配置 `X_BEARER_TOKEN`）。
- **精选播客：** 6 档顶尖 AI 播客节目的关键洞察（需配置 `POD2TXT_API_KEY`）。
- **多语言支持：** 支持简体中文、英文或中英双语输出。

---

## 已验收能力：手动官方博客早报（零付费密钥）

你可以在本地或通过 ChatGPT 桌面端直接运行官方博客早报，无需任何付费 API 密钥。

### 1. 在 ChatGPT 桌面端使用
1. 克隆本仓库到本地：
   ```bash
   git clone https://github.com/firstmaple-coding/follow-engine.git
   ```
2. 打开 ChatGPT 桌面端（或本地 Agent）。
3. 仓库内已内置桌面 Skill：`.agents/skills/daily-blog-digest/SKILL.md`。
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

运行前后 Git tracked 文件完全不会被修改，代码工作区始终保持干净。

---

## 信息源与依赖说明

### 官方博客（已验收 2 个）
- [Anthropic Engineering](https://www.anthropic.com/engineering) — Anthropic 团队的技术深度文章
- [Claude Blog](https://claude.com/blog)（以及 `/resources/articles`）— Claude 的产品公告、研究与技术指南

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
