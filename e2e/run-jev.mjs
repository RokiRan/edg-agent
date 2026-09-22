// e2e/run-jev.mjs — Jev 快路径的端到端测试。
//
// 场景：search.html 搜索流程（type 关键词 → click 搜索 → done），
// 设置里配置了 Jev key 指向 mock 的 /v1/systemone。
// 验证三件事：
//   1. 快路径被调用（sawJev ≥ 3：每步一次）
//   2. 第 2 步（点搜索）由快路径直接执行、绕过 LLM（sawJevClick = 1，
//      且侧边栏步骤行带 [jev conf= 标注）
//   3. 第 1 步（输入，需生成文本）与第 3 步（done，需写 summary）仍走 LLM
// 结构克隆 run-upload.mjs（防御点 #1-#4 全保留）。
//
// 前置：npm run build && node e2e/prepare-ext.mjs；mock-llm 已启动。
// 退出码：0=断言全绿，1=setup failure，2=assertion failure

import { mkdtempSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const PROJECT_ROOT = resolve(__dirname, '..');

const MOCK_LLM_PORT = Number(process.env.MOCK_LLM_PORT ?? 4399);
const MOCK_BASE = `http://127.0.0.1:${MOCK_LLM_PORT}/v1`;
const TASK = '快路径测试：在测试搜索站搜索 hello';

const CHROME_BIN_CANDIDATES = [
  join(process.env.HOME ?? '', '.cache/puppeteer/chrome/mac_arm-131.0.6778.204/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  join(process.env.HOME ?? '', '.cache/puppeteer/chrome/mac_arm-130.0.6723.69/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  process.env.PUPPETEER_CHROME_BIN ?? '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const EXT_DIR = '/tmp/edg-e2e-ext';

function log(...args) {
  console.log('[run-jev]', ...args);
}

function findChrome() {
  for (const p of CHROME_BIN_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  throw new Error('找不到 Chrome 二进制，已尝试: ' + CHROME_BIN_CANDIDATES.join(', '));
}

async function startPageServer() {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const safe = urlPath.replace(/^\/+/, '') || 'search.html';
      if (safe.includes('..')) {
        res.writeHead(400).end('bad path');
        return;
      }
      const filePath = join(PROJECT_ROOT, 'e2e', 'pages', safe);
      const data = await readFile(filePath);
      const ext = safe.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ext });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, close: () => new Promise((r) => { server.close(() => r()); }) };
}

async function discoverExtensionIdViaJson(baseUrl) {
  const res = await fetch(`${baseUrl}/json`);
  if (!res.ok) throw new Error(`/json ${res.status}`);
  const targets = await res.json();
  const found = targets.filter((t) => typeof t.url === 'string' && t.url.startsWith('chrome-extension://'));
  if (found.length === 0) throw new Error('no chrome-extension targets in /json');
  const m = found[0].url.match(/^chrome-extension:\/\/([^/]+)\//);
  if (!m) throw new Error('cannot parse extension id from: ' + found[0].url);
  return m[1];
}

async function getStats() {
  const r = await fetch(`http://127.0.0.1:${MOCK_LLM_PORT}/__stats`);
  if (!r.ok) throw new Error(`/__stats ${r.status}`);
  return await r.json();
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntil(fn, { timeoutMs = 30000, intervalMs = 200, label = 'poll' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await delay(intervalMs);
  }
  throw new Error(`poll timeout: ${label}${lastErr ? ' (last: ' + (lastErr.message ?? lastErr) + ')' : ''}`);
}

function livePageGetter(browser, urlPart) {
  let cached = null;
  return async () => {
    if (cached && !cached.isClosed()) {
      try {
        await cached.evaluate(() => 1);
        return cached;
      } catch {
        cached = null;
      }
    }
    const pages = await browser.pages();
    cached = pages.find((p) => p.url().includes(urlPart)) || null;
    return cached;
  };
}

async function main() {
  if (!existsSync(join(EXT_DIR, 'manifest.json'))) {
    console.error('找不到扩展产物（', EXT_DIR, '）。先跑 `node e2e/prepare-ext.mjs`。');
    process.exit(1);
  }
  const userDataDir = mkdtempSync(join(tmpdir(), 'edg-jev-'));
  log('userDataDir =', userDataDir);

  await pollUntil(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${MOCK_LLM_PORT}/v1/models`);
      return r.ok;
    } catch {
      return false;
    }
  }, { timeoutMs: 15000, label: 'mock-llm ready' });
  log('mock-llm ready');

  const statsBefore = await getStats();
  log('stats before =', { sawJev: statsBefore.sawJev, sawJevClick: statsBefore.sawJevClick, reqCount: statsBefore.reqCount });

  const pageServer = await startPageServer();
  const searchUrl = `http://127.0.0.1:${pageServer.port}/search.html`;
  log('page server =', searchUrl);

  const chromeBin = findChrome();
  log('chrome =', chromeBin);

  // ★ 防御点 #1：杀掉残留 Chrome
  try {
    execSync(`pkill -f 'edg-jev-' 2>/dev/null || true; pkill -f 'load-extension=${EXT_DIR}' 2>/dev/null || true; sleep 1`, { stdio: 'ignore' });
  } catch {
    // ignore
  }

  const debugPort = 10000 + Math.floor(Math.random() * 50000);
  log('chrome debug port =', debugPort);

  const browser = await puppeteer.launch({
    executablePath: chromeBin,
    headless: false,
    userDataDir,
    protocolTimeout: 60000,
    args: [
      `--remote-debugging-port=${debugPort}`,
      '--remote-debugging-address=127.0.0.1',
      `--load-extension=${EXT_DIR}`,
      `--disable-extensions-except=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-popup-blocking',
      '--disable-translate',
      '--no-sandbox',
    ],
    dumpio: false,
    defaultViewport: { width: 1280, height: 800 },
  });

  const debugBase = `http://127.0.0.1:${debugPort}`;

  let failed = null;
  try {
    const extId = await pollUntil(async () => {
      try {
        return await discoverExtensionIdViaJson(debugBase);
      } catch {
        return null;
      }
    }, { timeoutMs: 20000, intervalMs: 500, label: 'extension id' });
    log('extension id =', extId);
    const sidepanelUrl = `chrome-extension://${extId}/sidepanel.html`;

    // ★ 防御点 #2：先 search.html，再 sidepanel.html
    const pages = await browser.pages();
    const page = pages[0];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        log(`[page:${msg.type()}]`, msg.text());
      }
    });
    page.on('pageerror', (err) => log('[page:exception]', err.message));
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#searchForm', { timeout: 5000 });
    log('search.html loaded');

    const sidepanel = await browser.newPage();
    sidepanel.setDefaultTimeout(8000);
    sidepanel.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        log(`[sidepanel:${msg.type()}]`, msg.text());
      }
    });
    sidepanel.on('pageerror', (err) => log('[sidepanel:exception]', err.message));
    await sidepanel.goto(sidepanelUrl, { waitUntil: 'domcontentloaded' });
    await sidepanel.waitForSelector('button[aria-label="设置"]', { timeout: 10000 });
    await delay(500);
    log('sidepanel loaded');

    // ★ 防御点 #3：retry-on-TargetClosed
    const getSidepanel = livePageGetter(browser, 'sidepanel.html');
    const withSidepanel = async (fn) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const p = await getSidepanel();
        if (!p) {
          await delay(300);
          continue;
        }
        try {
          return await fn(p);
        } catch (e) {
          const msg = String(e?.message ?? e);
          if (/Target (closed|was destroyed)|Session closed|Execution context was destroyed|callFunctionOn timed out|ProtocolError/i.test(msg)) {
            log(`sidepanel CDP lost (attempt ${attempt + 1}): ${msg.slice(0, 140)}`);
            await delay(300);
            continue;
          }
          throw e;
        }
      }
      throw new Error('sidepanel CDP unusable after 3 retries');
    };

    // Seed settings：LLM 指向 mock /chat/completions，Jev 指向 mock /v1/systemone
    await sidepanel.bringToFront();
    await withSidepanel((p) => p.click('button[aria-label="设置"]'));
    await sidepanel.waitForSelector('select', { timeout: 5000 });
    await withSidepanel((p) => p.select('select', 'custom'));
    await delay(200);
    await withSidepanel((p) => setReactField(p, 'Base URL', MOCK_BASE));
    await withSidepanel((p) => setReactField(p, 'API Key', 'mock-key-not-real'));
    await withSidepanel((p) => setReactField(p, 'Model', 'mock-model'));
    await withSidepanel((p) => setReactField(p, 'Jev API Key', 'mock-jev-key'));
    await withSidepanel((p) => setReactField(p, 'Jev Base URL', MOCK_BASE));
    await delay(200);
    // 打开「启用 Jev 快路径」开关（默认关，不开则 loop 不会发 /v1/systemone）
    await withSidepanel((p) =>
      p.evaluate(() => {
        const span = Array.from(document.querySelectorAll('span')).find(
          (s) => (s.textContent || '').trim() === '启用 Jev 快路径',
        );
        const box = span?.parentElement?.querySelector('input[type="checkbox"]');
        if (!box) throw new Error('启用 Jev 快路径开关未找到');
        if (!box.checked) box.click();
      }),
    );
    await delay(150);
    await withSidepanel((p) =>
      p.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const save = btns.find((b) => b.textContent && b.textContent.trim() === '保存');
        if (save) save.click();
        else throw new Error('保存按钮未找到');
      }),
    );
    await delay(400);
    await withSidepanel((p) => p.waitForSelector('textarea', { timeout: 5000 }));
    log('settings saved (llm + jev)');

    // ★ 防御点 #4：sidepanel 保持前台
    await withSidepanel((p) => p.click('textarea'));
    await withSidepanel((p) => p.type('textarea', TASK, { delay: 5 }));
    await delay(150);
    await withSidepanel((p) =>
      p.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const send = btns.find((b) => {
          const t = (b.textContent || '').trim();
          return t === '发送' || t === '补充';
        });
        if (send) send.click();
        else throw new Error('发送按钮未找到');
      }),
    );
    log('task sent');

    // 等任务结束（搜索流程无高危确认闸，无需点确认卡片）
    await pollUntil(async () => {
      return withSidepanel((p) =>
        p.evaluate(() => {
          const badges = Array.from(document.querySelectorAll('span'));
          const labels = badges.map((s) => (s.textContent || '').trim());
          return labels.some((t) => t === '完成' || t === '失败' || t === '步数上限');
        }),
      );
    }, { timeoutMs: 90000, label: 'task terminal' });
    log('task reached terminal state');
    await delay(500);

    const resultCount = await page.evaluate(() => document.querySelectorAll('#results li').length);
    const firstResult = await page.evaluate(() => document.querySelector('#results li')?.textContent ?? '');
    const agentSteps = await withSidepanel((p) =>
      p.evaluate(() => {
        const lis = Array.from(document.querySelectorAll('li.edg-step'));
        return lis.map((li) => (li.textContent || '').replace(/\s+/g, ' ').trim());
      }),
    );
    const finalStatus = await withSidepanel((p) =>
      p.evaluate(() => {
        const badges = Array.from(document.querySelectorAll('span'));
        const labels = badges.map((s) => (s.textContent || '').trim());
        if (labels.includes('完成')) return 'done';
        if (labels.includes('失败')) return 'failed';
        if (labels.includes('步数上限')) return 'max-steps';
        return 'unknown';
      }),
    );
    const stats = await getStats();
    const dJev = stats.sawJev - statsBefore.sawJev;
    const dJevClick = stats.sawJevClick - statsBefore.sawJevClick;
    const dReq = stats.reqCount - statsBefore.reqCount;
    const jevStepRows = agentSteps.filter((s) => s.includes('[jev conf='));
    log('agent steps:');
    for (const s of agentSteps) log('  ·', s);
    log('results =', resultCount, JSON.stringify(firstResult));
    log('finalStatus =', finalStatus);
    log('stats delta =', { dJev, dJevClick, dReq });

    const assertResults = resultCount === 3 && firstResult.includes('hello');
    const assertDone = finalStatus === 'done';
    const assertJevCalled = dJev >= 3;
    const assertJevClick = dJevClick === 1;
    const assertJevMarker = jevStepRows.length >= 1;
    const assertFallbackMarker = agentSteps.some((s) => s.includes('[jev→llm'));

    log('assert results=3 =', assertResults);
    log('assert done =', assertDone);
    log('assert sawJev>=3 =', assertJevCalled, `(Δ=${dJev})`);
    log('assert sawJevClick=1 =', assertJevClick, `(Δ=${dJevClick})`);
    log('assert jev step marker =', assertJevMarker);
    log('assert jev→llm fallback marker =', assertFallbackMarker);

    if (!(assertResults && assertDone && assertJevCalled && assertJevClick && assertJevMarker && assertFallbackMarker)) {
      failed = { resultCount, firstResult, finalStatus, dJev, dJevClick, dReq, agentSteps };
    }
  } finally {
    await browser.close().catch(() => {});
    await pageServer.close();
  }

  if (failed) {
    console.error('断言失败:', JSON.stringify(failed, null, 2));
    process.exit(2);
  }
  log('all assertions green');
}

async function setReactField(page, labelText, value) {
  await page.evaluate(
    (label, v) => {
      const labels = Array.from(document.querySelectorAll('span'));
      const lab = labels.find((s) => (s.textContent || '').trim() === label);
      if (!lab) throw new Error(`未找到 label: ${label}`);
      const wrap = lab.parentElement;
      if (!wrap) throw new Error(`label 容器未找到: ${label}`);
      const input = wrap.querySelector('input, textarea');
      if (!input) throw new Error(`label 下未找到输入框: ${label}`);
      const proto = Object.getPrototypeOf(input);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(input, v);
      else input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    labelText,
    value,
  );
}

main().catch((err) => {
  console.error('run-jev failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
