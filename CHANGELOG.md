# Changelog

## [2.5.0] - 2026-08-10

### Added
- **多轮上下文改写（Standalone Query）**：任务分析输出 `resolved_query` / `entities` / `is_followup` / `topic_changed`；短追问（如「具体时间？国内时间？」）会补齐历史实体后再搜索。相关性评估、深度爬取与答案生成统一使用改写后的独立问题，避免话题漂移。

### Changed
- **对话历史入模压缩**：assistant 长文 / Live Artifacts HTML 去标签并截断后再进入 LLM 上下文，降低噪声淹没主题的风险；模型失败时提供 history-aware fallback，禁止裸短句直接检索。
- **Live Artifacts 对齐 AMC 渲染路径**：接入 `normalizePreviewableMarkdownContent`；开启 Live Artifacts 时 Markdown/混排答案强制整段进 themed iframe（`coerceLiveModeArtifact`），并清理 `height:100vh` / `overflow:hidden` 等裁切样式，避免表格后出现“细灰条”半截内容。
- **Live Artifacts 流式渲染降载（Phase 1）**：增量门控（`shouldRenderStreamTick`）只在内容增量 ≥400 字符 / 跨块边界 / 超 800ms / 首推时才跑完整渲染管线；单 artifact 消息跳过气泡 markdown 双渲染；流式走轻量 sanitize 管线、终态才跑全量后处理；iframe 内 stream-render 按 rAF 合帧；高度探针按内容 hash 记忆化、流式中途不再探针、终态 sweep 由两次减为一次。
- **Live Artifacts 终态推送（Phase 2.1）**：流式 shell 终身不 remount，终态内容经 postMessage 全量链推送进原 iframe（无空白窗口），registry 的 `srcdoc` 作为重建种子。
- **Live Artifacts 离屏卸载与 wake 恢复（Phase 2.2/2.3）**：离屏 150% 视口持续 2s 卸载 iframe（消除 Chrome 丢弃离屏文档的根因），回视口按需从 registry 重建并同步恢复缓存高度；wake 时只 ping 视口内 frame、300ms 窗口。带 `LA_VIEWPORT_UNLOAD_ENABLED` 开关。
- **Live Artifacts 后台标签页策略（Phase 3）**：`document.hidden` 时流式不 postMessage，只标 dirty 存最新；回前台一次性推送最新内容。
- **代码清理**：合并重复 CSS 规则、删除死代码（tab-groups 未用方法、citation 兼容入口、未用 locale key 等），前端测试 helper 去重。

### Fixed
- **多轮搜索流式内容错乱**：`generate_answer._drain_stream` 缺 `nonlocal status`，`status = "insufficient"` 只改局部变量，门控永不触发——第 N 轮 insufficient 的 partial answer 会推给前端并与下一轮拼接。现已将 `status` 加入 nonlocal。
- **空会话被提前清理**：`_cleanup_old_sessions` 用本地 naive 时间与 UTC 存储的 `updated_at` 比较，UTC+8 下会把“刚更新过几小时”的空会话误删。改用 `_utc_now()` 计算 cutoff。
- **迁移失败永久丢数据**：`legacy_migration.py` 单个文件迁移失败仍 `rmtree` 整个 chats/ 目录。现任一文件失败则保留目录。
- **Provider 配置校验漏洞**：全禁用时 `ensure_default_provider_id` 静默 fallback 到 `providers[0]`（可能禁用项）；`api_key` 字段缺失被清空。现全禁用抛 400、缺失字段从现有配置保留。
- **截断编辑后台流切回会话短暂重复**：后台截断流 detached 时 DB 仍是截断前历史，切回 `loadChat` 渲染旧尾部 + 在途气泡并存。`rec` 记录 `truncateFromIndex`，re-attach 时先裁剪 DOM。
- **错误状态语义不一致**：`generate_answer` 外层兜底 / 超时 / 未收到响应返回 `status:"sufficient"` 把异常文本当正常答案。统一为 `status:"error"`，workflow 遇 error 直接抛错走错误+重试。
- **replace 失败回退复活已删除会话**：`replace_messages_from` 因会话被并发删除返回 False 时，回退 `save_chat_history` 会重建该会话。现先复查会话是否仍存在再回退。
- **Live Artifacts 气泡高度被二次压扁 / 过大空白**：对齐 AMC `ArtifactFrame` + `previewBridgeScript`。含 `<details>` 时强制 open；仅当 bridge 高度≈折叠态时用展开高度兜底（防裁切），可信量高可回缩去掉内容下方大空白。模块缓存 `main.js?v=74` / `live-artifacts.js?v=26`。
- **Live Artifacts 闪烁（三根因）**：① `syncPendingStreamToFrame` 的 `streaming` 标志写反——流式每 tick 跑全量重处理链（卡顿）、终态反而走轻量（details 折叠/暗色回退/底部空白）；② `FRAME_VIEW_RECOVERY_TIMEOUT_MS` 150ms 过短导致合法 pong 超时被误判重建空壳，且流式 frame 会被重建——放宽至 1000ms 并跳过流式 frame；③ 来源条每 tick 无条件销毁重建——`clearArtifactControls` 不再清 source strip，`renderLiveArtifactSources` 按签名幂等。
- **次要**：extension_bridge fire-and-forget 任务异常消费；evidence-panel LRU delete-then-set 刷新插入序；composer-extras 补 `?v=3` 版本号；删除死代码（`engine_name` / `sessionId` / 不可达 CJK 标点 split / 无消费者 `evidenceSnippet`）。
- **流式壳引擎名回归**：`ENGINE_NAMES` 提升到模块级，修复 `syncQuickSettingsFromState` 初始化抛 `ReferenceError` 导致的侧栏历史空白。

## [2.4.0] - 2026-07-15

### Added
- **引用定位原文片段（研究可信）**：答案中的 `[n]` 点击后打开证据侧栏，展示论断、原文摘录、匹配状态（已定位/弱匹配/未定位）。后端在生成完成后对 claim→quote 做日期/数字锚定 + token 重叠对齐；SSE 与历史消息下发 `snippet`/`excerpt`/`citations`（不含全文）。Live Artifacts iframe 内引用通过 postMessage 同样打开侧栏。
- **消息编辑与重新发送**：用户气泡支持编辑后从该轮截断重发；助手气泡支持重新生成。后端 `truncate_from_index` + 数据库截断消息；前端编辑横幅、Esc 取消、ArrowUp 快捷编辑。

### Changed
- **正文提取主引擎改为 Defuddle**：扩展新增 `extractContent` RPC，注入 `defuddle.full.js`（与 ToMarkdown / Obsidian Web Clipper 同款）输出 AI 友好 Markdown；薄内容时仍回退站点选择器 + 密度打分 + JSON-LD/OG，并保留 SPA 等待/滚动重试。扩展版本升至 0.2.0（需重新加载扩展）。
- **正文提取强化（SPA/官方站）**：多策略抽取（站点选择器 → 密度+链接密度打分 → 清洗 body → JSON-LD/OG/轻量 Next 数据回退）；对 openai/anthropic/rust blog 等 SPA 主机自动等待滚动并在“过薄”时重试，缓解官方页只抓到几十字符的问题。
- 版本升至 2.4.0（`version.py` / `Dockerfile` LABEL）。

### Fixed
- **交互模式 `evaluate` 缺 `tab_id`**：`run_interactive_mode` 与 `extract_github_repo_stats` 调用 `BridgeClient.evaluate` 时未传 `tab_id`，触发 `missing 1 required positional argument: 'expression'`，导致深度搜索里的自动点击完全失效。现已按 `(tab_id, expression)` 签名修正，并对非 list 返回值做防护。
- **Live Artifacts 空白预览**：流式预览将 HTML 写入 `srcdoc` 并在 ready/load 时重同步，避免空壳 iframe 与 postMessage 竞态导致空白。

### Removed
- **SearXNG 搜索引擎与 compose 依赖**：浏览器桥接架构下宿主机 Chrome 无法访问 Docker 内网 `searxng:8080`，且与 Google/Bing/DDG 等直连引擎重叠。已移除 `searxng` 服务、`SEARXNG_*` 环境变量、选择器配置与 UI 选项。

## [2.3.0] - 2026-07-09

### Added
- **百度搜索**(baidu)与 **Yandex 搜索**(yandex)引擎支持:在 `search_selectors.json` 新增两套选择器配置,`browser_manager.py` 的导航链接过滤与 `search_result_cleanup.py` 的内部页面判定同步纳入这两个域名。百度结果链接的 `/link?url=` 跳转由 `crawler/redirects.py` 新增的 `_resolve_baidu_link_url` 解析。

### Changed
- **彻底移除验证码/反爬检测**:桥接真实 Chrome 几乎不触发验证码,原有的 captcha_check 标记在数百 KB 的渲染 DOM 里极易子串误伤(如 Google 正常结果页被 `sorry/index` 误判成验证码,导致卡 60 秒超时)。删除 `_detect_captcha` / `_handle_verification_pages` / `_wait_for_manual_verification` / `_read_page_state` / `_blocked_search_reason` 及相关常量,移除所有引擎的 `captcha_check` 配置与前端"易触发验证码"标签。
- **修复扩展标签分组**:并发创建标签时多个请求同时判定"无组"各自建组,导致一个搜索一个分组。改为串行化分组操作 + 先登记 tab 再查组,保证所有标签归入唯一的全局 "JustSearch" 分组。
- 版本升至 2.3.0(`version.py` / `Dockerfile` LABEL)。

## [2.2.0] - 2026-07-09

### Changed
- **浏览器桥接架构全面落地**:用自建 Chrome 扩展(MV3 + `chrome.debugger` CDP)+ 本地 WebSocket 桥接驱动你**真实**的 Chrome,取代旧版无头浏览器池。直接复用登录态/Cookie,验证码显著减少。新增 `extension/`(扩展源码)与 `backend/app/extension_bridge.py`(WS 服务端 + JSON-RPC 客户端 + tab 生命周期)。
- **彻底移除 Playwright**:删除 `browser_context.py`、`interaction.py`、`tools/manual_login.py`、`browser-modal.js`;`requirements.txt` 不再含 Playwright,Docker 镜像不再打包 Chromium。
- **Dockerfile** 移除 `COPY tools/`(已无该目录),镜像更小、构建更快。
- **JS/CSS 静态资源** 改为 `public, max-age=3600` 缓存(带 `?v=` 版本号失效),减少刷新请求。

### Removed(按需精简保护机制)
- **搜索冷却**(`rate_limit.py` / `search_rate_limit` ≥4s 串行排队):已删除,搜索不再强制间隔。
- **Chrome 标签并发上限**(`BRIDGE_MAX_CONCURRENT_PAGES` / `TabPool` semaphore / `max_concurrent_pages` 设置项):已删除,后台标签与爬取不再限并发。
- **搜索引擎健康度与自动降级**(`engine_health.py` / `get_fallback` / `batch_id`):已删除,不再因失败率自动切换引擎。
- **Chat 接口限流**(`rate_limiter.py` / `chat_limiter` 30 次/分钟):已删除,对话接口不再返回 429。

### Fixed
- 恢复 `search_web` 的搜索结果缓存读取(冷却移除时误删,已补回)。

### Notes
- `/api/health` 不再返回 `engines` 健康度字段。
- 环境变量 `BRIDGE_MAX_CONCURRENT_PAGES` 与设置项 `max_concurrent_pages` 已废弃,相关 UI 输入框同步移除。

## [2.1.0] - 2026-03-29

### Added
- **Brave Search** 和 **SearXNG** 搜索引擎支持
- **FTS5 全文搜索** API (`/api/history/search?q=`)
- **API 密钥验证** 端点 (`/api/settings/validate-key`)
- **搜索引擎列表** 端点 (`/api/engines`)
- **对话链接分享** 按钮
- **导出全部对话** 按钮
- **Ctrl+/** 快捷键切换侧栏
- **Ctrl+Shift+R** 快捷键重新生成回答
- **模型选择持久化** (localStorage)
- **自动对话标题生成** (基于首条消息)
- 内容提取器: 知乎、微信公众号、GitHub、B站、小红书
- Cloudflare 验证页面检测
- 搜索结果权威域名排序 (Wikipedia, GitHub, SO 等)
- 自适应搜索深度 (内容不足时自动增加轮次)
- LLM 任务分析结果缓存 (TTL 3分钟)
- generate_answer 流式请求并发控制和超时重试
- 请求计时中间件 (X-Response-Time header)
- 请求 ID 追踪 (X-Request-ID header)
- GZip 压缩中间件
- 健康检查添加 uptime 和内存使用量
- 前端建议模板更新 (emoji + 当前话题)

### Fixed
- browser_context.py `_GLOBAL_CONTEXT` 未定义引用
- 删除 stale `.patch.2` 文件

### Improved
- DuckDuckGo 选择器增加更多备选
- prompt 改进: 评测/教程查询建议、对比结构化输出
- 历史搜索支持分词匹配
- 搜索空状态添加图标和友好提示
- model 逗号分隔解析: 过滤空白项
