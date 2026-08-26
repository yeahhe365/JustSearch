# JustSearch Bridge 扩展

JustSearch 自带的 Chrome 扩展(MV3)。它把你**真实** Chrome 的标签页控制权交给本地 JustSearch 后端,用于搜索与爬取。

> v2.0 起,JustSearch 不再内置无头浏览器,而是通过这个扩展驱动你已登录的真实 Chrome——直接复用登录态/Cookie,反爬与验证码大幅减少。

## 工作原理

```
你的 Chrome(装了本扩展)
   │ 出站 WebSocket(JSON-RPC 2.0,自动重连)
   ▼
JustSearch 后端 ws://127.0.0.1:8000/justsearch（与 HTTP 共用端口）
```

后端需要时,通过 JSON-RPC 调用扩展:

- `createTab` / `navigate` / `closeTab` / `finalizeTabs` — 后台开标签、导航、用完即关
- `evaluate` — 在标签页里跑任意 JS(`chrome.debugger` + `Runtime.evaluate`),站点特判与启发式回退走这里
- `extractContent` — 注入 [Defuddle](https://github.com/kepano/defuddle)(与 ToMarkdown / Obsidian Web Clipper 同款)抽取主正文 Markdown
- `clickAt` / `scrollBy` — 真实输入事件
- `moveMouse` — 驱动虚拟光标动画到目标(可视化自动交互)

扩展借鉴了 [browser-control-bridge](https://github.com/...) 的设计(出站 WS 重连、`chrome.debugger` CDP 串行队列、虚拟光标),但**完全自建、只服务 JustSearch**。

## 安装

1. 先启动 JustSearch 后端(`./run.sh` 或 `docker-compose up -d`)。
2. 打开 Chrome,访问 `chrome://extensions`。
3. 右上角开启「开发者模式」。
4. 点「加载已解压的扩展程序」,选择本目录(`extension/`)。
5. 点扩展图标打开弹出页,确认状态为绿色「已连接」。

> 默认连 `ws://127.0.0.1:8000/justsearch`（与后端 HTTP 端口一致）。如果后端端口或路径改了,在弹出页的地址框里改保存即可,扩展会自动重连。

## Docker 部署

Docker 下后端跑在容器里,扩展连接地址与页面访问地址端口一致（默认宿主机 8001），路径 /justsearch。例如若访问 http://127.0.0.1:8001，则扩展应连 ws://127.0.0.1:8001/justsearch。

WebSocket 连接会做鉴权：本机 loopback / Docker 发布端口网关免 token；其它来源需在 URL 带 `?token=<data/.auth_token>`（与 HTTP API 相同）。

## 注意事项

- 扩展会用 `chrome.debugger` 附加到它创建的后台标签上,标签顶部会短暂出现「正被调试」黄条。任务结束扩展会自动 detach,黄条消失。
- 后端同一时刻只接受一个扩展连接;后连的会顶掉先连的。
- Service worker 30s 空闲会被 Chrome 回收,但 WS 连接活跃时不会被杀;断线扩展会自动重连(2s 退避 + 1min 兜底)。
- 扩展不读取/上传你的 Cookie 或历史,只执行后端发来的标签操作命令。WebSocket 仅限 loopback。
