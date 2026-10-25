---
name: daily-blog-digest
description: "从最新公开官方与实践者 AI 博客筛选适合个人使用的动态（Anthropic、Claude、Google、OpenAI、Simon Willison 等），提取正文并生成最多 3 条、说明具体用途与使用门槛的中文早报。在用户提出‘生成今日早报’、‘今日博客早报’、‘获取今日 AI 动态’等要求或其明确授权的定时试运行中触发。无需任何付费信源 API 密钥，严格基于抓取到的真实文章生成，不臆测、不胡编。"
---

# Daily Blog Digest (每日博客中文早报)

这是一个面向 ChatGPT 桌面端及本地 Agent 的轻量级 Skill，用于在用户明确要求时手动抓取公开 AI 官方与实践者博客（Anthropic、Claude、Google、OpenAI、Simon Willison 等），并在本地生成高质量、可核验的中文摘要早报。

## 适用场景与触发条件

- **触发时机**：在用户授权的定时试运行中，或用户明确指示生成今日早报（例如：“生成今日早报”、“获取今日 AI 动态”、“抓取博客早报”、“汇总今日博客更新”）时触发。
- **免责与边界**：无需任何付费 API 密钥；不抓取 Twitter/X 或播客；仅在用户发起请求或明确授权的定时试运行中执行公开博客抓取；严禁使用历史旧文章冒充今日更新。

## 执行流程与决策机制

日常请求统一使用程序入口，让日期判断和刷新由代码执行。所有命令在 Follow Engine 仓库根目录运行，数据写入 Git 忽略的 .runtime/。

```bash
node scripts/run-daily-digest.js --feed-dir .runtime --timezone America/New_York --language zh
```

### 何时复用当天结果

仅当快照属于 America/New_York 的同一天、距现在不超过 24 小时、且仍有有效文章时复用。24 小时是上限，不是跨日复用许可。每次运行都重新过滤超过 72 小时、未来日期、无效日期或缺少正文/链接的文章。

### 何时重新抓取

跨日首次请求、缓存缺失/损坏/过期、有效文章为空时，入口自动调用 scripts/generate-feed.js，随后调用 scripts/prepare-digest.js --daily 预处理。不要再用旧的 prepare-digest 探测命令决定今日缓存可用性。

用户说“最新”“刷新”“重新抓取”“重新跑一遍”或要求完整重跑时，加 --force-refresh，无论是否同一天：

```bash
node scripts/run-daily-digest.js --feed-dir .runtime --timezone America/New_York --language zh --force-refresh
```

### 抓取失败处理（严防误报最新）

入口在抓取失败时返回非零退出码，并停止摘要生成，绝不回退旧缓存冒充今日更新。网络限制时可按执行环境权限流程重试同一命令；仍失败则明确报告。旧报告只能作为明确标注原抓取时间的参考。部分来源失败时按 errors 透明披露不完整之处。

### 报告状态

报告开头必须展示 run.fetchedAt（按 run.timeZone 转换）、run.mode 和篇数：
- refreshed：本轮新增 run.newPosts，窗口内保留 run.retainedPosts，失败来源 run.failedSources。
- cache：明确“复用今日快照，本次未重新抓取”，展示 run.cachedPosts；不要把上轮新增计数称为本轮新增。
- failedSources 为 null 时显示“未知”，不可编造为 0；来源内部告警仍须阅读 errors。
- 新增是相对去重状态首次发现，不代表今天发表；保留文章必须标注原发布日期。

示例：抓取时间：10 月 10 日 10:30（美东）｜本轮新增 3 篇｜窗口内保留 5 篇｜失败来源 0 个。

### 步骤 2：时效与内容检查

1. **时效检查**：
   检查预处理返回 JSON 中的 `stats.blogPosts`：
   - 若 `stats.blogPosts === 0`，如实向用户报告：
     > "今天关注的官方与实践者博客没有符合时效（72小时内）的新文章。请明天再来看看！"
     然后停止执行，**绝对不要**拿历史旧文章伪造今日早报。
   - 若 `stats.blogPosts > 0`，进入早报生成。

2. **数据完整性与抓取告警检查（透明披露）**：
   检查预处理返回 JSON 中的 `errors` 数组（或抓取命令 stderr 中的告警信息）：
    - 若存在包含 `Blog` 或 `Blog feed internal issue` 的抓取异常（例如某个博客源结构变动导致候选为空、部分文章详情页拉取失败或超时）：
      生成早报时**必须在文首或引言处向用户明确说明：部分博客源抓取存在错误或不完整，本次早报仅包含成功获取的篇目，结果可能不完整**，并简要指出受影响的来源（如 Anthropic Engineering、Claude Blog、Google AI Blog、OpenAI News 或 Simon Willison Weblog），确保事实透明，严禁隐瞒抓取缺陷。

### 步骤 3：生成面向个人用途的早报

使用入口返回的 prompts.summarize_blogs 与 prompts.digest_intro；它们均来自 [个人日报规则](../../../prompts/personal-daily-digest.md)。从仓库根目录读取 prompts/personal-daily-digest.md。该规则取代旧的逐篇技术摘要、100–300 字下限、强制英文引述和全量覆盖要求。

- 每日最多 3 条，允许 0 条；先按个人用途筛选，再用普通语言解释。不要把“14 篇抓取结果”写成“14 条推荐”。
- 每条回答“有什么变化 / 你能拿它做什么 / 现在能用吗 / 值得现在试吗”；注明来源性质、发布日期和原文链接。
- 每日最多一个 5–10 分钟小尝试，未经用户进一步指示不代为执行。
- 账号、费用、可用入口不明时写待确认；不能把厂商案例或推测当作已验证能力。
- 三天试运行读取 .runtime/personal-digest-trial/ 中此前报告与反馈，避免重复推荐；只记录实际完成的日期。第三天复盘后结束试运行，不自行延长。
- 未收到反馈记为 pending，不能声称用户满意或已有成效。
- 对于无候选的日子，说明今天没有值得额外花时间的新内容，不补旧闻。
- 最后保留署名：Generated through the Follow Builders skill: https://github.com/firstmaple-coding/follow-engine
