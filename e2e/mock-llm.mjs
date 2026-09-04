// Mock LLM server for edg-agent e2e tests.
// Pure Node (>=20) — no external dependencies.
// Listens on 127.0.0.1:4399 (override via MOCK_LLM_PORT).
//
// Implements a deterministic state machine based on the user messages in the
// request body, returning OpenAI-compatible responses for the agent loop.

import http from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT ?? 4399);
const HOST = '127.0.0.1';
// --- Process-wide counters (exposed via /__stats) ---
let sawImage = false;
let reqCount = 0;
let sawSteer = false;
let sawHistory = false;
// 上传测试：mock 每发一次 upload 工具动作 +1（驱动 3 次 = 3：file input + 按钮 + 拖拽区）
let sawUpload = 0;
// 对话框测试：mock 每发一次 dialog 工具动作 +1（期望 2：confirm + prompt）
let sawDialog = 0;
// 见到 alert 自动应答回执（autoNote 拼进执行结果）
let sawAutoAlert = false;
// 见到「页面有未应答的原生对话框」拦截闸（故意发错动作触发）
let sawDialogGuard = false;

// --- Helpers ---

function msgText(m) {
  if (!m || m.content == null) return '';
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

function hasImagePart(m) {
  return !!m && Array.isArray(m.content) && m.content.some(
    (p) => p && p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string'
  );
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
};

function buildSearchReply(lastUserContent, results) {
  if (typeof lastUserContent === 'string' && lastUserContent.includes('结果1: hello')) {
    return { tool: 'done', summary: '已完成搜索 hello，页面显示 3 条结果' };
  }
  if (results === 0) {
    const m = lastUserContent.match(/^\[(\d+)\] input[^\n]*placeholder="请输入关键词"/m);
    if (!m) return { tool: 'done', summary: '无法识别的场景' };
    return { tool: 'type', id: Number(m[1]), text: 'hello' };
  }
  if (results === 1) {
    const m = lastUserContent.match(/^\[(\d+)\] button[^\n]*"搜索"/m);
    if (!m) return { tool: 'done', summary: '无法识别的场景' };
    return { tool: 'click', id: Number(m[1]) };
  }
  return { tool: 'done', summary: '已完成搜索 hello，页面显示 3 条结果' };
}

function buildOrderReply(lastUserContent, results) {
  if (results === 0) {
    const m = lastUserContent.match(/^\[(\d+)\] input[^\n]*placeholder="姓名"/m);
    if (!m) return { tool: 'done', summary: '无法识别的场景' };
    return { tool: 'type', id: Number(m[1]), text: '张三' };
  }
  if (results === 1) {
    const m = lastUserContent.match(/^\[(\d+)\] input[^\n]*placeholder="密码"/m);
    if (!m) return { tool: 'done', summary: '无法识别的场景' };
    return { tool: 'type', id: Number(m[1]), text: '123456' };
  }
  if (results === 2) {
    const m = lastUserContent.match(/^\[(\d+)\] button[^\n]*"提交订单"/m);
    if (!m) return { tool: 'done', summary: '无法识别的场景' };
    return { tool: 'click', id: Number(m[1]) };
  }
  if (results === 3) {
    const m = lastUserContent.match(/^\[(\d+)\] button[^\n]*"删除订单"/m);
    if (!m) return { tool: 'done', summary: '无法识别的场景' };
    return { tool: 'click', id: Number(m[1]) };
  }
  return { tool: 'done', summary: '订单已完成' };
}

// --- Core state machine ---

function decideAction(messages) {
  const userMessages = Array.isArray(messages) ? messages.filter((m) => m && m.role === 'user') : [];
  const results = userMessages.filter((m) => msgText(m).startsWith('执行结果:')).length;
  const lastUser = userMessages[userMessages.length - 1];
  const last = lastUser ? msgText(lastUser) : '';
  const allUserText = userMessages.map((m) => msgText(m)).join('\n');
  const firstUserText = userMessages.length > 0 ? msgText(userMessages[0]) : '';
  const taskLine = (firstUserText.match(/^任务: ([^\n]+)/m) || [])[1] || '';

  if (taskLine.includes('插话测试')) {
    const steerMsg = userMessages.map((m) => msgText(m)).find((t) => t.includes('用户插话:'));
    if (steerMsg) {
      sawSteer = true;
      const m = steerMsg.match(/用户插话: ([^\n]+)/);
      return { tool: 'done', summary: `已收到插话: ${m ? m[1] : ''}` };
    }
    return { tool: 'scroll', direction: 'down' };
  }
  if (taskLine.includes('历史回顾')) {
    if (firstUserText.includes('此前本会话已完成的任务')) {
      sawHistory = true;
      return { tool: 'done', summary: '已看到历史' };
    }
    return { tool: 'done', summary: '没有看到历史' };
  }
  if (taskLine.includes('慢响应')) {
    return { tool: 'done', summary: '慢响应完成', __delay: 20000 };
  }
  // 对话框场景：任务含「对话框测试」— 状态机按 last 内容推进（short-circuit 消息
  // 不含快照，results 计数不可靠，不能按步数分流）：
  // click 弹出提示 → 见 alert 自动关闭回执 → click 弹出确认 → 见确认框上抛 →
  // 故意发 scroll（验证拦截闸）→ 见「页面有未应答」→ dialog accept →
  // click 弹出输入 → 见输入框上抛 → dialog accept+text → done。
  if (taskLine.includes('对话框测试')) {
    if (last.includes('已确认输入对话框')) {
      if (!last.includes('输入: "VIP999"')) return { tool: 'done', summary: 'prompt 的 text 没有透传' };
      return { tool: 'done', summary: '对话框测试完成' };
    }
    if (last.includes('页面弹出输入对话框')) {
      if (!last.includes('"请输入优惠码"')) return { tool: 'done', summary: 'prompt 消息内容不对' };
      sawDialog += 1;
      return { tool: 'dialog', action: 'accept', text: 'VIP999' };
    }
    if (last.includes('已确认确认对话框')) {
      const m = last.match(/^\[(\d+)\] button[^\n]*"弹出输入"/m);
      if (!m) return { tool: 'done', summary: '找不到弹出输入按钮' };
      return { tool: 'click', id: Number(m[1]) };
    }
    if (last.includes('页面有未应答的原生对话框')) {
      sawDialogGuard = true;
      return { tool: 'dialog', action: 'accept' };
    }
    if (last.includes('页面弹出确认对话框')) {
      if (!last.includes('"确定要删除该订单吗？"')) return { tool: 'done', summary: 'confirm 消息内容不对' };
      sawDialog += 1;
      // 故意发非 dialog 动作：验证 loop 的冻结拦截闸
      return { tool: 'scroll', direction: 'down' };
    }
    if (last.includes('页面弹出 alert')) {
      if (!last.includes('库存不足')) return { tool: 'done', summary: 'alert 消息内容不对' };
      sawAutoAlert = true;
      const m = last.match(/^\[(\d+)\] button[^\n]*"弹出确认"/m);
      if (!m) return { tool: 'done', summary: '找不到弹出确认按钮' };
      return { tool: 'click', id: Number(m[1]) };
    }
    if (results === 0) {
      const m = last.match(/^\[(\d+)\] button[^\n]*"弹出提示"/m);
      if (!m) return { tool: 'done', summary: '找不到弹出提示按钮' };
      return { tool: 'click', id: Number(m[1]) };
    }
    return { tool: 'done', summary: `对话框测试：状态机未覆盖: ${last.slice(0, 120)}` };
  }
  if (taskLine.includes('多步测试')) {
    if (results < 6) return { tool: 'scroll', direction: 'down' };
    return { tool: 'done', summary: '多步完成' };
  }
  if (taskLine.includes('markdown测试')) {
    return {
      tool: 'done',
      summary: [
        '# 更新一览',
        '',
        '根据 [OpenClaw 博客](https://openclaw.ai/blog)，近期更新如下：',
        '',
        '## 最新更新',
        '',
        '### 1. macOS 新安装器',
        '- 原生安装器 UI，无需接触终端',
        '- 自动检测 `Claude` / `Codex` 配置',
        '- Windows 端 **NVIDIA RTX** 一键部署',
        '',
        '| 日期 | 内容 |',
        '| --- | --- |',
        '| Sep 3 | 安装器 |',
        '| Aug 30 | 2.0 大更新 |',
      ].join('\n'),
    };
  }

  // Upload scenario: 任务含「上传测试」— 从任务文本里 regex 抽出 txt 绝对路径。
  // results===0 → upload 可见 file input（type=file accept=".txt"）；
  // results===1 → upload 「选择文件」按钮（触发器路径）；
  // results===2 → upload 拖拽区（div 行文带「拖」字）— 由影子 input + 合成 drop 事件完成；
  // results>=3 → done。每次发 upload +1（sawUpload 期望 3）。
  const hasUploadTest = taskLine.includes('上传测试');
  if (process.env.MOCK_DEBUG === '1' && hasUploadTest) {
    console.error(`[mock-debug upload] results=${results}`);
  }
  if (hasUploadTest) {
    const pathMatch = taskLine.match(/(\/[\w./-]+\.txt)/);
    const uploadPath = pathMatch ? pathMatch[1] : '/private/tmp/edg-upload-fixture.txt';
    if (results === 0) {
      const m = last.match(/^\[(\d+)\] input[^\n]*type=file[^\n]*accept="\.[\w]+"/m);
      if (!m) return { tool: 'done', summary: '上传测试：快照里找不到可见 file input' };
      sawUpload += 1;
      return { tool: 'upload', id: Number(m[1]), paths: [uploadPath] };
    }
    if (results === 1) {
      const m = last.match(/^\[(\d+)\] button[^\n]*"选择文件"/m);
      if (!m) return { tool: 'done', summary: '上传测试：快照里找不到「选择文件」按钮' };
      sawUpload += 1;
      return { tool: 'upload', id: Number(m[1]), paths: [uploadPath] };
    }
    if (results === 2) {
      // 拖拽区：buildSnapshotMessage 只输出 role/type/accept/text，不输出 class。
      // 匹配 [N] div 行文含「拖」字（占位文案）。
      const m = last.match(/^\[(\d+)\] div[^\n]*"[^"\n]*拖[^"\n]*"/m);
      if (!m) return { tool: 'done', summary: '上传测试：快照里找不到拖拽区' };
      sawUpload += 1;
      return { tool: 'upload', id: Number(m[1]), paths: [uploadPath] };
    }
    return { tool: 'done', summary: '上传完成' };
  }

  const hasScrollTest = allUserText.includes('滚动测试');
  if (hasScrollTest) {
    if (results === 0) return { tool: 'scroll', direction: 'down' };
    return { tool: 'done', summary: '滚动完成' };
  }
  const hasBigform = allUserText.includes('长文档表单测试页');
  if (hasBigform) {
    if (results === 0) {
      const m = last.match(/^\[(\d+)\] input[^\n]*placeholder="用户名"/m);
      if (!m) return { tool: 'done', summary: '快照中找不到用户名输入框' };
      return { tool: 'type', id: Number(m[1]), text: 'demo' };
    }
    if (results === 1) {
      const m = last.match(/^\[(\d+)\] input[^\n]*placeholder="密码"/m);
      if (!m) return { tool: 'done', summary: '快照中找不到密码输入框' };
      return { tool: 'type', id: Number(m[1]), text: 'secret123' };
    }
    if (results === 2) {
      const m = last.match(/^\[(\d+)\] button[^\n]*"登录"/m);
      if (!m) return { tool: 'done', summary: '快照中找不到登录按钮' };
      return { tool: 'click', id: Number(m[1]) };
    }
    return { tool: 'done', summary: '已完成登录表单录入' };
  }
  const hasCascaderReact = allUserText.includes('级联React测试页');
  const hasCascaderVue = !hasCascaderReact && allUserText.includes('级联Vue测试页');
  if (hasCascaderReact || hasCascaderVue) {
    if (process.env.MOCK_DEBUG === '1') {
      console.error(`[mock-debug] results=${results} last user message:\n${last.slice(0, 3000)}\n---`);
    }
    const steps = hasCascaderReact
      ? ['请选择::input', 'Zhejiang', 'Hangzhou', 'Xihu']
      : ['请选择::input', '浙江', '杭州', '西湖'];
    if (results < steps.length) {
      const target = steps[results];
      if (target.endsWith('::input')) {
        const ph = target.slice(0, -'::input'.length);
        const m = last.match(new RegExp(`^\\[(\\d+)\\] input[^\\n]*placeholder="${ph}"`, 'm'));
        if (!m) return { tool: 'done', summary: '快照中找不到级联触发框' };
        return { tool: 'click', id: Number(m[1]) };
      }
      const m = last.match(new RegExp(`^\\[(\\d+)\\] li role=menuitemcheckbox[^\\n]*"${target}`, 'm'));
      if (!m) return { tool: 'done', summary: `快照中找不到级联项 ${target}` };
      return { tool: 'click', id: Number(m[1]) };
    }
    return {
      tool: 'done',
      summary: hasCascaderReact ? '已完成级联选择: Zhejiang / Hangzhou / Xihu' : '已完成级联选择: 浙江 / 杭州 / 西湖',
    };
  }
  const hasCanvas = allUserText.includes('画布测试页');
  const hasAskOptions = allUserText.includes('询问选项');
  if (hasAskOptions) {
    const m = last.match(/用户回答: ([^\n]+)/);
    if (m) return { tool: 'done', summary: `已收到选择: ${m[1]}` };
    return { tool: 'ask_user', question: '请选择处理方式', options: ['选项甲', '选项乙', '选项丙'] };
  }
  const hasFormatRecovery = allUserText.includes('格式容错');
  if (hasFormatRecovery) {
    if (last.includes('格式错误：请只回复')) {
      return { tool: 'done', summary: '格式重试后完成' };
    }
    return {
      __raw: '<think>The user wants me to output only a single JSON action object. I need to redo my response properly. I was outputti',
    };
  }
  const hasTrailingContent = allUserText.includes('尾随正文');
  if (hasTrailingContent) {
    return {
      __raw: '{"tool":"done","summary":"完整交付: 第一题 {答案A} 第二题 {答案B}"}\n\n以下是试卷正文（这段在 JSON 之后，应被丢弃）: 题目 {示例} 略',
    };
  }
  const hasOrder = allUserText.includes('确认订单');
  const hasResumeTest = allUserText.includes('步数续跑');
  if (hasResumeTest) {
    if (last.includes('用户要求继续')) {
      return { tool: 'done', summary: '续跑后完成' };
    }
    return { tool: 'scroll', direction: 'down' };
  }
  const hasSalvageTest = allUserText.includes('截断交付');
  if (hasSalvageTest) {
    return {
      __raw: '<think>Let me provide the final done action with the full quiz</think>\n{"tool":"done","summary":"第一题: 什么是 Agent 循环?\\n答案: 感知-决策-执行的迭代。\\n第二题: 为什么需要快照剪枝?\\n答案: 控制上下文长度,防止 （此处输出被长度截断',
    };
  }
  const hasSalvageGuard = allUserText.includes('截断他键');
  if (hasSalvageGuard) {
    return {
      __raw: '{"tool":"done","summary":"这是一个已经完整闭合的摘要内容,不应该被抢救","extra":"值写到一半被截断',
    };
  }
  const hasSearch = allUserText.includes('测试搜索站');
  const hasDropdown = allUserText.includes('下拉测试页');

  if (hasCanvas) {
    if (last.includes('已点击')) {
      return { tool: 'done', summary: '已通过坐标点击画布按钮' };
    }
    if (lastUser && hasImagePart(lastUser)) {
      return { tool: 'click_at', x: 0.5, y: 0.4 };
    }
    if (results === 0) return { tool: 'click', id: 99 };
    if (results === 1) return { tool: 'click', id: 98 };
    return { tool: 'done', summary: '已通过坐标点击画布按钮' };
  }

  if (hasDropdown) {
    if (results === 0) {
      const m = last.match(/^\[(\d+)\] input[^\n]*placeholder="请选择人员"/m);
      if (!m) return { tool: 'done', summary: '无法识别的场景' };
      return { tool: 'click', id: Number(m[1]) };
    }
    if (results === 1) {
      const m = last.match(/^\[(\d+)\] div role=option[^\n]*"李强"/m);
      if (!m) return { tool: 'done', summary: '无法识别的场景' };
      return { tool: 'click', id: Number(m[1]) };
    }
    return { tool: 'done', summary: '已选择李强' };
  }

  if (hasOrder && !hasSearch) {
    return buildOrderReply(last, results);
  }
  if (hasSearch) {
    return buildSearchReply(last, results);
  }

  return { tool: 'done', summary: '无法识别的场景' };
}

// --- Response writers ---

function writeJson(res, status, payload) {
  if (res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...CORS_HEADERS,
  });
  res.end(body);
}

function writeSse(res, contentString) {
  if (res.destroyed) return;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...CORS_HEADERS,
  });
  const chunk = { choices: [{ delta: { content: contentString } }] };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// --- HTTP handler ---

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    writeJson(res, 200, { object: 'list', data: [] });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        writeJson(res, 400, { error: { message: 'invalid JSON body' } });
        return;
      }
      reqCount += 1;
      const msgs = body && Array.isArray(body.messages) ? body.messages : [];
      if (!sawImage && msgs.some(hasImagePart)) sawImage = true;
      const stream = body && body.stream === true;
      const action = decideAction(msgs);
      if (action && typeof action.__delay === 'number') {
        await new Promise((r) => setTimeout(r, action.__delay));
        if (res.destroyed) return;
      }
      const contentString = action && typeof action.__raw === 'string'
 ? action.__raw
 : JSON.stringify(action);
      if (stream) {
        writeSse(res, contentString);
      } else {
        writeJson(res, 200, {
          choices: [{ message: { role: 'assistant', content: contentString } }],
          usage: {
            prompt_tokens: Math.ceil(raw.length / 4),
            completion_tokens: Math.ceil(contentString.length / 4),
          },
        });
      }
    });
    req.on('error', () => {});
    return;
  }

  if (req.method === 'GET' && url.pathname === '/__stats') {
    writeJson(res, 200, { reqCount, sawImage, sawSteer, sawHistory, sawUpload, sawDialog, sawAutoAlert, sawDialogGuard });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS });
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`mock-llm listening on ${PORT}`);
});