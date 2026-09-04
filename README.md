# Edg Agent

> 在 Chrome 侧边栏里跑一个 LLM Agent，让它直接替你操作浏览器。

Edg Agent 是一个基于 WXT + React 19 + TypeScript 构建的 Chrome MV3 扩展。
你在侧边栏里给它一句自然语言任务（"去 Antd 文档里搜 cascader 的用法"，
"把这份表单填好"），它会自己分析页面、点击、输入、滚动，直到交付完整结果。

![status](https://img.shields.io/badge/status-MVP-orange)
![chrome](https://img.shields.io/badge/Chrome-MV3-4285F4)
![stack](https://img.shields.io/badge/WXT-React%2019-61dafb)

---

## 特性

- **侧边栏常驻** — 点击工具栏图标或 `Alt+E` 即开/关；不影响当前页面。
- **多 LLM 提供方** — OpenAI、DeepSeek，或任意 OpenAI 兼容 API（baseUrl + model 自填）。
- **结构化动作协议** — 每轮只输出一个 JSON 动作（`click` / `type` / `select` / `scroll` / `navigate` / `new_tab` / `ask_user` / `read_page` / `done` …），无解析歧义。
- **组件库下拉兼容** — Ant Design / Element Plus 类的"输入框 + 浮层 listbox"两步法内置提示，`select` 工具失败时自动引导改走 `click → click`。
- **思考态可视化** — 64px 浮动 orb（"composing"风格点带）显示 Agent 正在思考；支持中途插话。
- **多步无缝续跑** — 触达 `max-steps` 上限不直接失败，沿用完整对话历史在同卡片内继续。
- **Token 遥测** — 每步累积 prompt / completion 用量在 footer 显示，Snap 体积 O(n²)→O(n) 剪枝。
- **高危操作二次确认** — `tabs.executeScript`、`chrome.permissions.request` 等可勾选"本次会话始终允许"。

## 架构

```
┌────────────────┐   消息    ┌──────────────────┐
│  Side Panel UI │ ────────► │  Background SW   │
│   (React 19)   │ ◄──────── │  (目标标签路由)    │
└────────┬───────┘  snapshots└────────┬─────────┘
         │                            │
         │ user task / agent steps    │ edg:getTargetTab
         ▼                            ▼
┌────────────────┐   CDP    ┌──────────────────┐
│  lib/agent     │ ───────► │  Target Tab      │
│   loop.ts      │          │  (任何 http 标签) │
│   actions.ts   │          └──────────────────┘
│   prompt.ts    │
│   cdp.ts       │
└────────┬───────┘
         │ POST /chat/completions
         ▼
┌────────────────┐
│  OpenAI 兼容   │
│  LLM Provider  │
└────────────────┘
```

## 目录

```
edg-agent/
├─ entrypoints/
│  ├─ background.ts           # SW：侧边栏开关 / 快捷键 / 目标标签路由
│  └─ sidepanel/              # 侧边栏 UI（React 19 + Tailwind）
│     ├─ App.tsx              # 聊天主界面 + 步骤卡片
│     ├─ ThinkingOrb.tsx      # 64px 思考动画
│     ├─ Markdown.tsx         # 交付内容渲染
│     ├─ main.tsx
│     ├─ style.css
│     └─ index.html
├─ lib/
│  ├─ llm.ts                  # streamChat / chat + token 统计
│  ├─ storage.ts              # chrome.storage.local 封装
│  ├─ types.ts                # 共享类型
│  ├─ orb.ts                  # 思考 orb 的生命周期控制
│  └─ agent/
│     ├─ loop.ts              # 主循环：快照 → LLM → 动作 → CDP
│     ├─ actions.ts           # 动作执行 + 快照收集
│     ├─ prompt.ts            # system prompt + 快照消息构造
│     ├─ cdp.ts               # chrome.debugger 桥接（截图、坐标点击）
│     └─ targetTab.ts         # 目标标签解析
├─ e2e/
│  ├─ mock-llm.mjs            # 确定性状态机假 LLM（127.0.0.1:4399）
│  ├─ prepare-ext.mjs         # 把 build 产物拷到 /tmp/edg-e2e-ext + 注入 host_permissions
│  ├─ run-upload.mjs          # upload 工具的端到端驱动（puppeteer-core）
│  └─ pages/                  # 测试用 HTML 页面（bigform / cascader / dropdown / upload …）
├─ tailwind.config.js
├─ postcss.config.js
├─ tsconfig.json
└─ package.json
```

## 前置依赖

- **Node.js ≥ 20**（`e2e/mock-llm.mjs` 用了 `node:http` 原生模块）
- **Chrome for Testing**（**不是** 正式版 Chrome 137+，137 移除了 `--load-extension` 标志）
  - Puppeteer 自带缓存路径：`~/.cache/puppeteer/chrome/…`
- **npm**（或 pnpm / yarn，仓库不强制）

## 安装与开发

```bash
# 1. 装依赖
npm install

# 2. 准备 wxt 自动生成的类型（首次或 wxt.config.ts 变更后跑一次）
npm run prepare

# 3. 开发模式（热重载，自动打开 .output/chrome-mv3-dev）
npm run dev

# 4. 类型检查
npm run compile

# 5. 打包生产版本
npm run build          # 输出到 .output/chrome-mv3/edg-agent-0.1.0-chrome.zip
```

### 加载未打包扩展

1. `npm run build` 后打开 `chrome://extensions/`
2. 打开右上角"开发者模式"
3. 点"加载已解压的扩展程序"，选 `.output/chrome-mv3` 目录
4. 工具栏出现 Edg Agent 图标，点击或按 `Alt+E` 打开侧边栏

### LLM 配置

首次打开侧边栏 → 设置页填入：

| 提供方 | baseUrl | model |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 自定义 | 你自己的 OpenAI 兼容地址 | 任意 |

API Key 存在 `chrome.storage.local`，**不**上传到任何服务端。

## Agent 协议（开发向）

Agent 循环位于 [lib/agent/loop.ts](lib/agent/loop.ts)，核心契约：

- **System prompt**（[lib/agent/prompt.ts](lib/agent/prompt.ts)）：中文，明令"每轮只输出一个 JSON 动作对象、不要多余文字"。
- **快照消息**：每步作为 user 消息回灌 LLM，格式按契约逐字冻结（mock LLM 依赖它解析）。
  ```
  页面: <title> (<url>)
  可交互元素:
  [0] button "登录"
  [1] input type=text placeholder="搜索..."
  ...
  ```
- **支持的工具**：

  | 工具 | 用途 |
  |---|---|
  | `click` / `type` / `select` / `scroll` | 基于快照元素 id 的基本操作 |
  | `click_at` / `type_focused` | 视口归一化坐标点击 / 焦点输入（截图兜底用） |
| `upload` | 文件上传：`paths` 给本机绝对路径。三条路径：(a) 可见 file input 直接 `DOM.setFileInputFiles`；(b) 「选择文件」类按钮走 `Page.setInterceptFileChooserDialog` 拦截 + 喂隐藏 input；(c) 纯拖拽区走影子 `<input data-edg-shadow>` + 合成 drag/drop 事件。一律过高危确认闸。 |
  | `navigate` / `new_tab` | 标签页导航 |
  | `ask_user` | 缺信息时反问；可附 `options` 渲染为可点选按钮 |
  | `read_page` | 按需取页面正文（首轮快照默认附带；后续轮次需显式调用） |
  | `done` | 终止；`summary` 是用户唯一能看到的最终交付，**完整成果必须全文写入** |

- **温度与预算**：`chat()` 显式 `temperature=0` 消除动作漂移，`max_tokens=4096` 给足推理模型的 think + JSON 预算；格式错误重试时升级预算与温度。
- **Token 遥测**：每步从 usage 字段累加，footer 显示 `↑<prompt> ↓<completion>`。
- **历史剪枝**：快照消息只保留最近 2 份完整内容，更早的改写为占位符，prompt 体积 O(n²)→O(n)。
- **文件上传**：快照给 file input 标注 `accept=`；LLM 发 `{"tool":"upload","id":N,"paths":[...]}`，后台用已附加的 `chrome.debugger` 执行 `DOM.setFileInputFiles`（浏览器进程读盘，扩展不碰文件内容）。三条路径：(a) 可见 file input 直接注入；(b) 「选择文件」类按钮走 `Page.setInterceptFileChooserDialog` 拦截 + 喂隐藏 input；(c) 纯拖拽区（无 file input）走影子 `<input data-edg-shadow>` + 合成 `dragenter/dragover/drop` 事件。三条都过同一道高危确认闸。实现特殊的拖拽区（如 DataTransfer 自定义 items、自定义 `drop` 处理函数）才退化 `ask_user` 请用户手动拖入。

## E2E 测试

测试用纯 Node（≥20）写的 mock LLM，零外部依赖。`mock-llm.mjs` 是确定性状态机假 LLM（127.0.0.1:4399，按任务行关键词 + 步数分流）。

```bash
# 终端 1：构建产物 + 拷到 /tmp/edg-e2e-ext
node e2e/prepare-ext.mjs

# 终端 2：起 mock LLM（默认 127.0.0.1:4399；MOCK_DEBUG=1 调试日志）
node e2e/mock-llm.mjs

# 终端 3：跑具体场景的 puppeteer 驱动
# （旧场景外部仓库脚本；新增的 upload 工具自带 e2e/run-upload.mjs，见下节）
```



### Upload 工具（端到端）

`e2e/run-upload.mjs`

```bash
# 前置 1：构建 + 把产物拷到 /tmp/edg-e2e-ext
npm run build && node e2e/prepare-ext.mjs

# 前置 2：起 mock LLM（默认 127.0.0.1:4399；需先启；进程级计数，跨次跑累加）
node e2e/mock-llm.mjs &
# 主流程：一条命令（自动 pkill 残留 Chrome、随机 debug port、retry-on-TargetClosed）
node e2e/run-upload.mjs
# 退出码：0=五项断言全绿，1=setup failure，2=assertion failure
```

五项断言：`#log1` / `#log2` / `#log3` 含 `edg-upload-fixture.txt`、mock `/__stats sawUpload === 3`、任务终态 `done`。

`upload.html` 含可见 file input（id=file1）、按钮触发隐藏 file input（包在 `<form id="triggerForm">` 内，`findFileInput` 走 form 回退）、纯拖拽区 `<div class="dropzone">`（快照 candidates 含 `[class*="dropzone"]`，走影子 input + 合成 drop 事件）。Mock LLM 上传场景按任务行含「上传测试」+ 步数分流：results=0 → upload 可见 input；results=1 → upload「选择文件」按钮；results=2 → upload 拖拽区；results>=3 → done。

### 已知 gap


[lib/agent/loop.ts](lib/agent/loop.ts) 里的 `chrome.permissions.request` 运行时流程
（`runInPage` catch → request → retry）**e2e 不会覆盖**——因为 [e2e/prepare-ext.mjs](e2e/prepare-ext.mjs)
会在 manifest 里预注入 `host_permissions: ["<all_urls>"]`，绕过原生权限弹窗。
需要手动验证：加载**未打补丁**的 `.output/chrome-mv3`，发任务，在原生弹窗里点"允许"。

## 权限说明

[wxt.config.ts](wxt.config.ts) 里申请的权限：

| 权限 | 用途 |
|---|---|
| `sidePanel` | Chrome 侧边栏 API |
| `storage` | 存 LLM 设置、对话历史 |
| `activeTab` | 操作当前激活标签 |
| `scripting` | 注入内容脚本收集快照 |
| `tabs` | 跨标签查询 / 导航 |
| `debugger` | CDP 桥接（截图、坐标点击） |
| `<all_urls>` | 在任意 http(s) 页面工作 |

`tabs.executeScript` 与 `chrome.permissions.request` 被识别为高危操作，
UI 上提供"本次会话始终允许"按钮。

## 路线图

- [ ] Firefox MV2 兼容（`wxt.config.ts` 多 target）
- [ ] 任务模板 / 常用操作一键启动
- [ ] Agent 跑过的步骤可重放
- [ ] 多标签并行任务

## 许可

未指定。建议私下使用前先和作者确认。

---

<div align="center">

**提问、bug、想法 → Issues**

</div>
