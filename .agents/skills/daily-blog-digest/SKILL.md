---
name: daily-blog-digest
description: "手动抓取最新公开官方 AI 博客（Anthropic、Claude 等），提取正文并生成带直达链接的中文早报。仅在用户明确提出‘生成今日早报’、‘今日博客早报’、‘获取今日 AI 动态’等要求时触发。无需任何付费密钥，严格基于抓取到的真实文章生成，不臆测、不胡编。"
---

# Daily Blog Digest (每日博客中文早报)

这是一个面向 ChatGPT 桌面端及本地 Agent 的轻量级 Skill，用于在用户明确要求时手动抓取公开 AI 官方博客，并在本地生成高质量、可核验的中文摘要早报。

## 适用场景与触发条件

- **触发时机**：仅当用户明确指示生成今日早报（例如：“生成今日早报”、“获取今日 AI 动态”、“抓取博客早报”、“汇总今日博客更新”）时触发。
- **免责与边界**：无需任何付费 API 密钥；不抓取 Twitter/X 或播客；仅在用户发起请求时执行公开博客抓取；严禁使用历史旧文章冒充今日更新。

## 执行流水线

所有命令均需在 **仓库根目录 (`follow-engine`)** 下执行。

### 步骤 1：抓取最新公开官方博客

运行博客生成端，抓取已配置的公开官方博客（如 Claude Blog、Anthropic Engineering 等）：

```bash
node scripts/generate-feed.js --blogs-only
```

- 该命令会自动穿透扫描候选文章，校验文章详情页的真实发布日期；
- 仅保留严格在 72 小时回看窗口内的新鲜文章；
- 更新本地 `feed-blogs.json`，并更新 `state-feed.json` 中的博客去重记录；
- 保持 `feed-x.json` 与 `feed-podcasts.json` 完全未被修改。

*(可选：若仅需离线或无写盘探测，可添加 `--dry-run` 参数)*

### 步骤 2：预处理摘要数据与加载提示词

运行消费端预处理脚本，将数据校验为结构化 JSON：

```bash
node scripts/prepare-digest.js --local --blogs-only --max-feed-age-hours 24 --language zh
```

- 该命令会校验 `feed-blogs.json` 的生成时间戳（24小时内时效），剔除无效或缺失 URL 的条目；
- 载入官方提示词模版（`prompts/digest-intro.md`、`prompts/summarize-blogs.md`、`prompts/translate.md`）；
- 输出带有 `status: "ok"`、`blogs` 数组、`prompts` 字典的 JSON。

### 步骤 3：时效与内容检查

检查返回 JSON 中的 `stats.blogPosts`：
- 若 `stats.blogPosts === 0`，如实向用户报告：
  > "今天关注的官方博客没有符合时效（72小时内）的新文章。请明天再来看看！"
  然后停止执行，**绝对不要**拿历史旧文章伪造今日早报。
- 若 `stats.blogPosts > 0`，进入步骤 4 进行早报生成。

### 步骤 4：生成中文早报

严格依照 `prompts.summarize_blogs`、`prompts.digest_intro` 和 `prompts.translate` 规则组织 Markdown 输出：

1. **标题规范**：
   - 主标题：`# AI 建设者早报 — YYYY-MM-DD`（替换为当前实际日期）
   - 栏目标题：`## 官方博客`
   - 博客子标题：`### [博客名称]`（例如 `### Claude 官方博客`）
   - 文章小标题：`#### [文章标题]`

2. **摘要内容与格式**：
   - 每篇控制在 100~300 字，重点突出核心发布、新功能、研究发现或商业进展。
   - 必须包含关键数据、指标或性能表现（若原文有提供）。
   - **必须包含至少一处原文直接引述**（用英文双引号 `""` 引用原文核心句子）。
   - 明确指出对开发者或行业的实际意义（例如新 API、新工具、新接入方式）。
   - 紧随摘要附上可点击的**直达原文链接**：`原文链接: https://...`。

3. **合规与风控底线**：
   - **零臆测（No Fabrication）**：所有内容必须严格源自预处理 JSON 中的正文，严禁推测、虚构事实或言论。
   - **链接必选（Mandatory Links）**：每条摘要必须且只能链接至 JSON 中给出的原始 URL。
   - **语言规范**：简体中文，行文专业自然（像懂行的朋友在沟通）。AI、LLM、API、SDK、Agent、token、prompt 等通用技术术语以及人名、公司名、产品名保留英文。**严禁使用中文破折号（——）**。
   - **末尾署名**：在文末独占一行保留标准署名：
     `Generated through the Follow Builders skill: https://github.com/firstmaple-coding/follow-engine`
