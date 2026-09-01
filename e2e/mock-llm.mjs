// Mock LLM server for edg-agent e2e tests.
// Pure Node (>=20) — no external dependencies.
// Listens on 127.0.0.1:4399 (override via MOCK_LLM_PORT).
//
// Implements a deterministic state machine based on the user messages in the
// request body, returning OpenAI-compatible responses for the agent loop.

import http from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT ?? 4399);
const HOST = '127.0.0.1';

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

  // Count "已完成步数" by counting user messages whose content starts with "执行结果:".
  const results = userMessages.filter(
    (m) => typeof m.content === 'string' && m.content.startsWith('执行结果:')
  ).length;

  const lastUser = userMessages[userMessages.length - 1];
  const last = lastUser && typeof lastUser.content === 'string' ? lastUser.content : '';

  const allUserText = userMessages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n');

  // Order scenario: page contains "确认订单" but not "测试搜索站".
  // (search.html / danger.html are mutually exclusive per the spec.)
  const hasOrder = allUserText.includes('确认订单');
  const hasSearch = allUserText.includes('测试搜索站');

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

      const stream = body && body.stream === true;
      const action = decideAction(body && body.messages);
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

  // Everything else: 404.
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS });
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`mock-llm listening on ${PORT}`);
});