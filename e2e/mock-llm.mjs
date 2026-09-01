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

  // Scenario priority (mutually exclusive):
  //   D) 滚动测试 — 触发一次向下滚动。
  //   1) Canvas page ("画布测试页") — supports DOM-id clicks AND multimodal coordinate actions.
  //   2) Order page ("确认订单").
  //   3) Search page ("测试搜索站").
  const hasScrollTest = allUserText.includes('滚动测试');
  if (hasScrollTest) {
    if (results === 0) return { tool: 'scroll', direction: 'down' };
    return { tool: 'done', summary: '滚动完成' };
  }
  const hasCanvas = allUserText.includes('画布测试页');
  const hasOrder = allUserText.includes('确认订单');
  const hasSearch = allUserText.includes('测试搜索站');

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
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...CORS_HEADERS,
  });
  res.end(body);
}

function writeSse(res, contentString) {
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
    req.on('end', () => {
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

      const contentString = JSON.stringify(action);

      if (stream) {
        writeSse(res, contentString);
      } else {
        writeJson(res, 200, {
          choices: [
            {
              message: { role: 'assistant', content: contentString },
            },
          ],
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
    writeJson(res, 200, { reqCount, sawImage });
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