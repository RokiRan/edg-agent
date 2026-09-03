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

// --- Helpers ---

// Normalize an OpenAI-compatible message's content into a plain string.
// Strings are returned as-is; array form (multimodal) is flattened by joining
// the `text` fields of each text part. Non-text parts (e.g. image_url) are
// skipped, but their presence still triggers sawImage.
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

// True when the message content array carries an image_url part.
function hasImagePart(m) {
  return !!m && Array.isArray(m.content) && m.content.some(
    (p) => p && p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string'
  );
}


// --- CORS headers applied to every response ---
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
};

// --- Action builders ---

function buildSearchReply(lastUserContent, results) {
  // Prefer to short-circuit if the latest snapshot already shows results.
  if (typeof lastUserContent === 'string' && lastUserContent.includes('结果1: hello')) {
    return { tool: 'done', summary: '已完成搜索 hello，页面显示 3 条结果' };
  }

  if (results === 0) {
    // Extract input element id with placeholder "请输入关键词"
    const m = lastUserContent.match(/^\[(\d+)\] input[^\n]*placeholder="请输入关键词"/m);
    if (!m) return { tool: 'done', summary: '无法识别的场景' };
    return { tool: 'type', id: Number(m[1]), text: 'hello' };
  }

  if (results === 1) {
    // Extract button element id with text "搜索"
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

  // 第二个高危动作：验证「本次会话始终允许」跳过后续确认
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

  // Count "已完成步数" by counting user messages whose text content starts with "执行结果:".
  // msgText flattens array content (multimodal) into a plain string for matching.
  const results = userMessages.filter(
    (m) => msgText(m).startsWith('执行结果:')
  ).length;

  const lastUser = userMessages[userMessages.length - 1];
  const last = lastUser ? msgText(lastUser) : '';

  const allUserText = userMessages.map((m) => msgText(m)).join('\n');

  // 新场景按「任务行」分流（首条 user 消息里的 任务: 行），不用 allUserText——
  // 跨任务历史注入（此前本会话已完成的任务）会把旧任务关键词带进新请求，
  // 用 allUserText 会串场景。
  const firstUserText = userMessages.length > 0 ? msgText(userMessages[0]) : '';
  const taskLine = (firstUserText.match(/^任务: ([^\n]+)/m) || [])[1] || '';

  // Steering scenario: 任务含「插话测试」— 先回 scroll 让 loop 保持运行；
  // 看到「用户插话」消息（loop 步首注入）置 sawSteer 并 done。
  // 断言：补充指令确实进了对话历史，且任务未被打断（最终正常 done）。
  if (taskLine.includes('插话测试')) {
    const steerMsg = userMessages.map((m) => msgText(m)).find((t) => t.includes('用户插话:'));
    if (steerMsg) {
      sawSteer = true;
      const m = steerMsg.match(/用户插话: ([^\n]+)/);
      return { tool: 'done', summary: `已收到插话: ${m ? m[1] : ''}` };
    }
    return { tool: 'scroll', direction: 'down' };
  }
  // History scenario: 任务含「历史回顾」— 首条 user 消息应携带
  // 「此前本会话已完成的任务」历史块（priorTurns 注入）。看到置 sawHistory。
  if (taskLine.includes('历史回顾')) {
    if (firstUserText.includes('此前本会话已完成的任务')) {
      sawHistory = true;
      return { tool: 'done', summary: '已看到历史' };
    }
    return { tool: 'done', summary: '没有看到历史' };
  }
  // Slow scenario: 任务含「慢响应」— 延迟 20s 才响应，
  // 验证停止按钮能立即 abort 进行中的 LLM fetch（不等响应返回）。
  if (taskLine.includes('慢响应')) {
    return { tool: 'done', summary: '慢响应完成', __delay: 20000 };
  }

  // Scenario priority (mutually exclusive):
  //   D) 滚动测试 — 触发一次向下滚动。
  //   1) Canvas page ("画布测试页") — supports DOM-id clicks AND multimodal coordinate actions.
  //   2) Dropdown page ("下拉测试页") — ant-design style custom select: click trigger → click option.
  //   3) Order page ("确认订单").
  //   4) Search page ("测试搜索站").
  const hasScrollTest = allUserText.includes('滚动测试');
  if (hasScrollTest) {
    if (results === 0) return { tool: 'scroll', direction: 'down' };
    return { tool: 'done', summary: '滚动完成' };
  }
  // Bigform scenario: 长文档表单测试页 — 220 个链接排在登录表单之前，
  // 验证快照的表单控件优先收集（cap 150 不会把表单挤出快照）。
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
  // Cascader scenarios: 级联React测试页 / 级联Vue测试页 — antd/antdv 的
  // li[role=menuitemcheckbox] 多列菜单结构：点触发框 → 逐级点列项 → 叶子生效。
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
  // AskOptions scenario: 任务文本含「询问选项」— ask_user 带 options，
  // 验证选项按钮组 + 确认按钮的交互回路。放在 search 分支之前（用 search.html 做底页）。
  const hasAskOptions = allUserText.includes('询问选项');
  if (hasAskOptions) {
    const m = last.match(/用户回答: ([^\n]+)/);
    if (m) return { tool: 'done', summary: `已收到选择: ${m[1]}` };
    return { tool: 'ask_user', question: '请选择处理方式', options: ['选项甲', '选项乙', '选项丙'] };
  }
  // FormatRecovery scenario: 任务文本含「格式容错」— 首次返回未闭合 think 垃圾
  // （模拟推理模型被 max_tokens 截断的生产故障形状），触发 loop 的格式错误重试；
  // 看到重试提示后才返回合法 JSON。断言 agent 不失败、一步恢复。
  const hasFormatRecovery = allUserText.includes('格式容错');
  if (hasFormatRecovery) {
    if (last.includes('格式错误：请只回复')) {
      return { tool: 'done', summary: '格式重试后完成' };
    }
    return {
      __raw: '<think>The user wants me to output only a single JSON action object. I need to redo my response properly. I was outputti',
    };
  }
  // TrailingContent scenario: 任务文本含「尾随正文」— done JSON 之后追加含 } 的正文
  // （模型把交付内容接着写在 JSON 后面的生产故障形状）。
  // 旧 extractJson 用 lastIndexOf('}') 会把尾随垃圾切进来导致 parse 失败；
  // 配平扫描只取首个完整对象，summary 完整保留。
  const hasTrailingContent = allUserText.includes('尾随正文');
  if (hasTrailingContent) {
    return {
      __raw: '{"tool":"done","summary":"完整交付: 第一题 {答案A} 第二题 {答案B}"}\n\n以下是试卷正文（这段在 JSON 之后，应被丢弃）: 题目 {示例} 略',
    };
  }
  const hasOrder = allUserText.includes('确认订单');
  // Resume scenario: 任务文本含「步数续跑」— 永远 scroll 耗尽步数预算触发 max-steps；
  // 看到续跑消息（用户要求继续）才回 done。验证 max-steps 续跑链路。
  const hasResumeTest = allUserText.includes('步数续跑');
  if (hasResumeTest) {
    if (last.includes('用户要求继续')) {
      return { tool: 'done', summary: '续跑后完成' };
    }
    return { tool: 'scroll', direction: 'down' };
  }
  // Salvage scenario: 任务文本含「截断交付」— 永远返回写了一半的 done JSON
  // （summary 字符串未闭合，模拟长交付被 max_tokens 截断）。两次格式错误后
  // loop 的截断抢救应把已写出的 summary 救回来并标记可能不完整。
  const hasSalvageTest = allUserText.includes('截断交付');
  if (hasSalvageTest) {
    return {
      __raw: '<think>Let me provide the final done action with the full quiz</think>\n{"tool":"done","summary":"第一题: 什么是 Agent 循环?\\n答案: 感知-决策-执行的迭代。\\n第二题: 为什么需要快照剪枝?\\n答案: 控制上下文长度,防止 （此处输出被长度截断',
    };
  }
  // SalvageGuard scenario: 任务文本含「截断他键」— summary 已闭合、截断点在后面的键。
  // 形状守卫（捕获段含未转义引号）必须拒绝抢救，走重试后确定性失败+诊断。
  const hasSalvageGuard = allUserText.includes('截断他键');
  if (hasSalvageGuard) {
    return {
      __raw: '{"tool":"done","summary":"这是一个已经完整闭合的摘要内容,不应该被抢救","extra":"值写到一半被截断',
    };
  }
  const hasSearch = allUserText.includes('测试搜索站');
  const hasDropdown = allUserText.includes('下拉测试页');

  if (hasCanvas) {
    // Short-circuit: if the canvas was already clicked (snapshot shows #clicked).
    if (last.includes('已点击')) {
      return { tool: 'done', summary: '已通过坐标点击画布按钮' };
    }
    // Multimodal step: the latest user message carries an image_url part — use the
    // coordinate click action to drive the canvas button at (0.5, 0.4).
    if (lastUser && hasImagePart(lastUser)) {
      return { tool: 'click_at', x: 0.5, y: 0.4 };
    }
    if (results === 0) {
      // No DOM elements visible on the canvas page — pretend we have a stub id.
      return { tool: 'click', id: 99 };
    }
    if (results === 1) {
      return { tool: 'click', id: 98 };
    }
    return { tool: 'done', summary: '已通过坐标点击画布按钮' };
  }

  // Dropdown scenario: custom (ant-design style) select on 下拉测试页.
  // Step 0: click the input/ trigger to expand the floating listbox.
  // Step 1: click the option whose snapshot line carries role=option + text "李强".
  // Step 2+: done.
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

  // Order scenario: page contains "确认订单" but not "测试搜索站".
  // (search.html / danger.html are mutually exclusive per the spec.)
  if (hasOrder && !hasSearch) {
    return buildOrderReply(last, results);
  }

  // Search scenario: any user message mentions "测试搜索站".
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

  // Emit the entire action JSON as a single delta chunk, then [DONE].
  const chunk = {
    choices: [
      {
        delta: { content: contentString },
      },
    ],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// --- HTTP handler ---

const server = http.createServer((req, res) => {
  // CORS preflight.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  // GET /v1/models — discovery endpoint used by some clients.
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    writeJson(res, 200, { object: 'list', data: [] });
    return;
  }

  // POST /v1/chat/completions — the only LLM endpoint we serve.
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        writeJson(res, 400, { error: { message: 'invalid JSON body' } });
        return;
      }

      // Count every chat completion request, and remember whether we've ever seen
      // an image_url part (the multimodal fallback path).
      reqCount += 1;
      const msgs = body && Array.isArray(body.messages) ? body.messages : [];
      if (!sawImage && msgs.some(hasImagePart)) {
        sawImage = true;
      }

      const stream = body && body.stream === true;
      const action = decideAction(msgs);

      // __delay 场景（慢响应）：先挂起再响应；客户端 abort 后 socket 销毁，
      // writeJson/writeSse 的 res.destroyed 守卫会让响应静默丢弃。
      if (action && typeof action.__delay === 'number') {
        await new Promise((r) => setTimeout(r, action.__delay));
        if (res.destroyed) return;
      }

      // __raw 场景（如格式容错）直接返回原始文本，不包 JSON
      const contentString = action && typeof action.__raw === 'string' ? action.__raw : JSON.stringify(action);

      if (stream) {
        writeSse(res, contentString);
      } else {
        writeJson(res, 200, {
          choices: [
            {
              message: { role: 'assistant', content: contentString },
            },
          ],
          // 估算 token 用量（约 4 字符/token）——供 e2e 验证遥测链路与剪枝收益
          usage: {
            prompt_tokens: Math.ceil(raw.length / 4),
            completion_tokens: Math.ceil(contentString.length / 4),
          },
        });
      }
    });
    req.on('error', () => {
      // Client closed before body finished — ignore.
    });
    return;
  }

  // GET /__stats — process-wide counters (used by e2e harnesses).
  if (req.method === 'GET' && url.pathname === '/__stats') {
    writeJson(res, 200, { reqCount, sawImage, sawSteer, sawHistory });
    return;
  }

  // Everything else: 404.
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS });

  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`mock-llm listening on ${PORT}`);
});