# 🚀 JustSearch: 智能 AI 深度搜索助手

<p align="center">
  <a href="./README.md">中文</a> | <a href="./README.en.md">English</a>
</p>

**JustSearch** 是一款基于大语言模型（LLM）和浏览器桥接技术的深度搜索工具。它不仅仅是一个搜索界面，更是一个能够像人类一样"思考、搜索、阅读、总结"的智能代理。它能自动拆解复杂问题，深入网页正文提取关键信息，并生成带有精确引用的详尽答案。

> v2.0 起,JustSearch 不再内置无头浏览器,而是通过 **自建 Chrome 扩展 + 本地 WebSocket 桥接** 驱动你**真实**的 Chrome——直接复用你的登录态/Cookie,反爬与验证码大幅减少。详见 [浏览器桥接](#-浏览器桥接自建扩展) 与 [`extension/README.md`](./extension/README.md)。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/)
[![Browser Bridge](https://img.shields.io/badge/browser-Chrome%20Bridge-green.svg)](./extension/)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](https://www.docker.com/)

---

## 💡 为什么选择 JustSearch？

传统的搜索引擎往往只给你一系列链接，而 JustSearch 会：
1. **深度理解**：利用 LLM 拆解您的意图，不只是关键词匹配。
2. **真机阅读**：通过桥接驱动你真实的 Chrome 打开网页，直接复用登录态，绕过简单的反爬，获取正文。
3. **事实核查**：在生成答案时强制要求标注引用，拒绝 AI 幻觉。
4. **自主迭代**：如果初次搜索结果不足以回答，它会自己决定"再搜一次"。

---

## ✨ 核心特性

- **🎯 任务多级拆解**：自动分析用户意图，将复杂问题拆解为多个搜索查询或直接访问特定 URL。
- **🕵️ 深度爬取与分析**：通过桥接驱动真实 Chrome 进入网页抓取正文。主引擎为 [Defuddle](https://github.com/kepano/defuddle)（与 ToMarkdown / Obsidian Web Clipper 同款），输出 AI 友好 Markdown；失败或正文过薄时回退到站点选择器与密度打分。支持**交互模式**，能自动识别并点击"阅读更多"、"展开全文"等按钮（含中文按钮识别），并带虚拟光标可视化。
- **🔄 迭代式搜索逻辑**：AI 会评估当前获取的信息是否足以回答问题。如果不足，会自动发起补充搜索，直到获取足够证据。
- **📝 自动标注引用**：生成答案时会严格标注来源编号 `[1]`, `[2]`，并在文末提供对应的原始链接，确保信息真实可靠、可追溯。
- **🛡️ 真机反爬**：直接使用你已登录的真实 Chrome，登录态/Cookie 与插件天然复用，触发验证码的概率远低于无头浏览器。
- **🎨 现代 Web UI**：支持流式输出（Streaming）、实时搜索过程可视化、对话历史管理（支持重命名）、深色/浅色模式切换。
- **⚡ 多对话同时进行**：切换会话或新建对话不会中断正在进行的搜索——后台会话继续跑完并保存，返回时直接看到结果；后端按会话隔离工作流，并可用环境变量放宽全局并发上限（见下）。
- **🔐 安全认证**：自动生成 Bearer Token 保护 API；本机访问会由服务端自动注入，无需额外配置。桥接 WebSocket 仅接受 loopback 连接。
- **🛡️ SSRF 防护**：阻止对内网地址（含 IPv4-mapped IPv6 和代理/VPN 虚拟 IP 段）的访问，防止服务端请求伪造。
- **🐙 GitHub 深度优化**：针对 GitHub 用户和仓库页面进行了专门的爬取逻辑优化，更准确地获取星数、活跃度等信息。
- **🔀 多模型切换**：支持配置多个模型 ID（逗号分隔），在对话界面顶部实时切换。
- **🤖 验证码就地解决**：搜索过程中遇到验证码时,JustSearch 在你真实的 Chrome 里检测到并提示,你在浏览器里直接完成即可,搜索会自动继续。
- **📥 对话导出**：支持将对话记录导出为 Markdown 文件，方便保存和分享。
- **🌓 跟随系统主题**：支持浅色、深色、跟随系统三种主题模式。
- **🌐 多语言界面**：支持中文 / English / 跟随系统三种语言模式，覆盖侧栏、设置、聊天、快捷键等全部界面元素；可在「设置 → 常规」中随时切换，无需刷新页面。
- **🔍 多搜索引擎**：支持 Google、Bing、DuckDuckGo、Brave Search、搜狗、百度、Yandex。

---

## 🛠️ 技术栈

- **后端**: Python 3.10+, FastAPI, WebSocket (浏览器桥接服务端)
- **浏览器桥接**: 自建 Chrome 扩展 (MV3) + `chrome.debugger` CDP，见 [`extension/`](./extension/)
- **AI 模型**: 兼容 OpenAI API 协议（支持 DeepSeek, GPT-4, Claude, NVIDIA NIM, GLM 等）
- **前端**: 原生 JS (ES6 Modules), CSS3, Markdown-it, DOMPurify
- **部署**: Docker / Docker Compose / 本地 Python 环境

---

## 🚀 快速启动

我们提供了一键部署脚本，支持 Docker 和本地环境。**推荐使用 Docker 以获得最佳体验。**

### 1. 克隆项目
```bash
git clone https://github.com/yeahhe365/JustSearch.git
cd JustSearch
```

### 2. 一键部署
#### Mac / Linux 用户
```bash
chmod +x deploy.sh
./deploy.sh
```
#### Windows 用户
双击运行 `deploy.bat`。

> **脚本逻辑说明**：
> 1. 优先检查 Docker 环境，若存在则自动构建镜像并启动容器。
> 2. 若无 Docker，则自动回退至本地 Python 环境，创建虚拟环境、安装依赖并启动服务。

### 3. 访问与配置
1. 打开浏览器访问服务地址：
    - **Docker 部署**（`deploy.sh` / `docker-compose` 默认）：`http://localhost:8001`
    - **本地 Python 启动**（`run.sh` / uvicorn）：`http://localhost:8000`
    - 首次访问时，本机页面会自动注入认证 Token，**无需手动输入**。
    - 仅在服务重启后 Token 变更时，本机页面会刷新到新 Token。
    - 如果需要从其他设备访问，请在目标 URL 后带上 `?token=<data/.auth_token 中的值>`。
2. 点击页面左下角的 **设置** ⚙️ 按钮。
3. 输入您的 `API Key` 和 `Base URL`。
    - 默认配置为 DeepSeek API（`https://api.deepseek.com/v1`，模型 `deepseek-v4-pro`）。
    - 也支持 OpenAI、NVIDIA NIM、Claude、任何兼容 OpenAI 协议的 API 服务。
    - **💡 提示**：`API Key` 支持输入多个（用英文逗号分隔），程序会自动轮询使用，适合多 Key 负载均衡。
4. 在 `模型 ID` 中填入模型名称，支持多个模型（逗号分隔），保存后可在对话界面顶部下拉切换。
4. 开始提问！

---

## 📦 手动安装指南 (针对开发者)

如果您希望手动控制开发环境：

### 1. 环境准备
```bash
python3 -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r backend/requirements.txt
```

### 2. 加载浏览器桥接扩展
1. 打开 Chrome,访问 `chrome://extensions`,开启右上角「开发者模式」。
2. 点「加载已解压的扩展程序」,选择本仓库的 [`extension/`](./extension/) 目录。
3. 扩展弹出页会显示连接状态(默认连 `ws://127.0.0.1:8000/justsearch`)。后端启动后会自动变绿。

> 扩展只需加载一次;后端重启无需重载扩展(它会自动重连)。

### 3. 构建前端产物(可选)

前端 JS/CSS 采用**分片源文件 + esbuild 打包**：业务 JS 与各 CSS 分片位于
`backend/static/js/modules/` 与 `backend/static/css/sections/`,运行时直接加载源文件即可正常开发。

如需生产级优化(JS 合并压缩、CSS 拼接压缩、自动缓存指纹),执行:

```bash
npm install          # 首次;安装 esbuild
npm run build        # 生成 backend/static/dist/ 产物
```

构建后 `backend/app/main.py` 会优先伺服 `dist/index.html`(自动缓存指纹 `?v=<hash>`,
改代码后无需手动递增版本号);未构建时回退到源 `index.html`,开发体验不受影响。
本地开发可运行 `npm run dev` 生成未压缩产物。

### 4. 运行服务
```bash
# 使用脚本运行
./run.sh

# 或手动启动
python3 -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --reload
```

### 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `JUSTSEARCH_BRIDGE_WS_HOST` | `127.0.0.1` | 桥接 WebSocket 监听地址(Docker 内用 `0.0.0.0`) |
| `JUSTSEARCH_BRIDGE_WS_PATH` | `/justsearch` | 桥接 WebSocket 路径 |
| `BRIDGE_REQUEST_TIMEOUT_MS` | `30000` | 单次桥接 RPC 请求超时(毫秒) |
| `JUSTSEARCH_LLM_CONCURRENCY` | `5` | 进程级 LLM 请求并发上限；同时进行多个对话时可调大（如 `8`），注意过大会触发上游限流 |
| `JUSTSEARCH_INTERACTIVE_CONCURRENCY` | `2` | 全局「交互模式」爬取并发上限（CDP 点击）；放宽后允许多个对话并行交互爬取 |
| `CORS_ORIGINS` | `http://localhost:8000,http://127.0.0.1:8000,http://localhost,http://127.0.0.1` | 允许的 CORS 来源（逗号分隔） |
| `OPENAI_API_KEY` | - | API Key 环境变量回退（优先使用设置面板中的配置） |

### Docker 部署

```bash
docker-compose up -d
```

访问 `http://localhost:8001`（compose 将容器 `8000` 映射到宿主机 `127.0.0.1:8001`）。认证 Token 会自动注入到本机页面中，无需手动配置；远程访问请显式提供 token。

浏览器桥接扩展请连 `ws://127.0.0.1:8001/justsearch`（与页面端口一致）。若扩展连的不是本机 loopback，可在 URL 后加 `?token=<token>`。

> **升级提示**：镜像以非 root 用户 `justsearch` 运行。若旧数据卷由 root 创建导致无法写入，可在宿主机执行：  
> `docker compose run --rm --user root justsearch chown -R justsearch:justsearch /app/data`

---

## 🔄 更新指南

如果您需要更新到最新版本，请执行以下步骤：

### 1. 获取最新代码
```bash
git pull
```

### 2. 重新部署
#### Docker 用户 (推荐)
直接运行：
```bash
./deploy.sh
```
或者手动运行：
```bash
docker-compose up -d --build
```
> **注意**：使用 `--build` 参数确保 Docker 重新构建镜像以应用最新的代码和依赖变更。运行数据保存在 `data/` 中，会通过 Docker volume 保留。Docker 部署下,桥接 WebSocket 与 HTTP 共用端口，扩展连接地址与页面访问地址端口一致。

#### 本地 Python 用户
```bash
./deploy.sh
```
或者手动更新：
```bash
source venv/bin/activate
pip install -r backend/requirements.txt
```

---

## 🤖 工作流程详解

JustSearch 采用多阶段迭代流程，确保回答的深度和准确性：

1. **Phase I: 分析 (Analysis)** - LLM 接收问题，决定是进行关键词搜索还是直接访问特定链接。
2. **Phase II: 搜索 (Search)** - 在 DuckDuckGo / Google / Bing 等引擎执行并发搜索。
3. **Phase III: 评估 (Assess)** - AI 筛选出最相关的多个结果进行深度阅读。评估时会优先选择官方权威来源。
4. **Phase IV: 爬取与交互 (Crawl & Interact)** - 浏览器进入页面抓取全文。如果开启"交互模式"，AI 会自动点击潜在的内容展开按钮。
5. **Phase V: 生成 (Generate)** - 融合所有来源，生成带引用的结构化答案。如果信息不足，则返回 Phase I 重新迭代。

---

## 🌐 浏览器桥接（自建扩展）

JustSearch 用一个自建 Chrome 扩展 + 后端 WebSocket 服务驱动你**真实**的 Chrome。好处:

- 直接复用你的登录态/Cookie/插件,搜索与爬取在已登录的真实浏览器里发生,验证码显著减少。
- 后端镜像无需打包 Chromium,体积小、部署轻。
- 遇到验证码时,JustSearch 在你的 Chrome 里检测到并提示,你直接在浏览器里完成即可,搜索自动继续——不再需要弹窗远程操作。

### 工作原理
```
你的 Chrome(装了 JustSearch Bridge 扩展)
   │ WebSocket 出站连接(JSON-RPC 2.0,自动重连)
   ▼
JustSearch 后端 FastAPI
   └── extension_bridge.py  ← WS 服务端(ws://127.0.0.1:8000/justsearch)
         持有唯一扩展连接、JSON-RPC 路由、tab 池
```

扩展借鉴了 [browser-control-bridge](https://github.com/...) 的设计(`chrome.debugger` CDP 路径 + 虚拟光标 + tab 生命周期),但**完全自建、只服务 JustSearch**,无 MCP 层、无 CDP allowlist(自用)。

### 安装扩展
1. `chrome://extensions` → 开启「开发者模式」。
2. 「加载已解压的扩展程序」→ 选择仓库根目录的 `extension/` 文件夹。
3. 启动 JustSearch 后端,扩展弹出页状态变绿即连接成功。

详见 [`extension/README.md`](./extension/README.md)。

---

## 🤖 验证码处理

搜索过程中如果遇到验证码,JustSearch 会在你的真实 Chrome 里检测到,并在对话流里提示「请在 Chrome 中手动完成」。你只需切到那个标签页完成验证,JustSearch 会自动检测通过并继续搜索,无需中断流程。

> 旧版的「弹窗远程操作验证码」与「预登录脚本」在 v2.0 已移除——真实浏览器下这两者都不再需要。

---

## 📂 项目结构

```text
JustSearch/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI 入口，路由定义
│   │   ├── workflow.py          # 搜索工作流引擎（迭代式搜索核心）
│   │   ├── llm_client.py        # LLM 客户端（任务分析/评估/生成/交互决策）
│   │   ├── openai_client.py     # OpenAI 兼容客户端构造
│   │   ├── browser_manager.py   # 搜索引擎抓取(经桥接驱动真实 Chrome)
│   │   ├── extension_bridge.py  # 浏览器桥接:WS 服务端 + JSON-RPC 客户端 + tab 池
│   │   ├── page_crawler.py      # 页面正文爬取与 GitHub 等站点专用提取器
│   │   ├── crawler/             # URL 安全校验与搜索引擎重定向解析
│   │   ├── search_result_cleanup.py # 搜索结果标题/内部页过滤
│   │   ├── database.py          # SQLite 模型、对话历史、设置持久化
│   │   ├── legacy_migration.py  # 旧 JSON 数据一次性迁移
│   │   ├── auth.py              # Token 认证与 HTML 启动参数注入
│   │   ├── routers/             # API 路由（chat/history/settings/stats）
│   │   ├── prompts.py           # LLM Prompt 模板
│   │   └── search_engine.py     # 搜索引擎 CSS 选择器配置加载
│   ├── static/
│   │   ├── css/style.css        # 样式入口，按顺序导入 sections/
│   │   ├── css/sections/        # base/sidebar/chat/modal/markdown/responsive 等样式分层
│   │   ├── js/
│   │   │   ├── main.js          # 前端启动编排
│   │   │   └── modules/         # api/auth/chat/history/sidebar/settings/source-renderer.js/ui 等模块
│   │   └── index.html
│   ├── settings.json.example    # 配置模板
│   └── requirements.txt
├── extension/                   # 自建 Chrome 扩展(MV3):WS 桥接 + CDP + 虚拟光标
├── data/                        # SQLite 数据库运行目录（自动创建）
├── Dockerfile                   # Docker 构建文件(无 Chromium)
├── docker-compose.yml
├── deploy.sh / deploy.bat       # 一键部署脚本 (推荐)
└── run.sh                       # 本地启动脚本
```

## 🤝 贡献

欢迎贡献代码！请遵循以下步骤：

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -m "feat: your feature"`
4. 推送分支：`git push origin feature/your-feature`
5. 创建 Pull Request

---

## ⚙️ 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `JUSTSEARCH_BRIDGE_WS_HOST` | `127.0.0.1` | 桥接 WS 监听地址 |
| `JUSTSEARCH_BRIDGE_WS_PATH` | `/justsearch` | 桥接 WS 路径 |
| `BRIDGE_REQUEST_TIMEOUT_MS` | `30000` | 桥接 RPC 请求超时(毫秒) |
| `JUSTSEARCH_LLM_CONCURRENCY` | `5` | 进程级 LLM 请求并发上限；同时进行多个对话时可调大（如 `8`） |
| `JUSTSEARCH_INTERACTIVE_CONCURRENCY` | `2` | 全局「交互模式」爬取并发上限（CDP 点击） |
| `CORS_ORIGINS` | `http://localhost:8000,http://127.0.0.1:8000,http://localhost,http://127.0.0.1` | CORS 允许的源（逗号分隔） |
| `OPENAI_API_KEY` | — | 备用 API Key |

---

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 协议。
---

## 友链

- [Linux.do](https://linux.do/)：也称 L 站，是一个活跃的中文技术社区，围绕 AI、软件开发、资源分享与前沿资讯展开讨论；社区愿景是“新的理想型社区”，社区文化是“真诚、友善、团结、专业，共建你我引以为荣之社区”。

