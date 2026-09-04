// e2e/run-upload.mjs — end-to-end test for the upload tool.
//
// Defenses (from Main's diagnosis):
//   #1 pre-launch pkill leftover chrome (same userDataDir / debug port)
//   #2 tab order: upload.html, then sidepanel.html
//   #3 retry-on-TargetClosed wrapper for every sidepanel CDP call
//   #4 sidepanel stays foreground; upload tab stays background (Main's
//      rAF setTimeout fallback in lib/agent/actions.ts makes upload_prep
//      complete even with background tab's rAF paused).
// Plus: random debug port, sidepanel defaultTimeout 8s so background-tab
// stalls surface fast and withSidepanel can re-acquire.

import { mkdtempSync, writeFileSync, statSync, existsSync } from 'node:fs';
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
const FIXTURE_PATH = '/private/tmp/edg-upload-fixture.txt';
const FIXTURE_BASENAME = 'edg-upload-fixture.txt';
const TASK = `上传测试：把 ${FIXTURE_PATH} 上传到两个附件位`;

const CHROME_BIN_CANDIDATES = [
  join(process.env.HOME ?? '', '.cache/puppeteer/chrome/mac_arm-131.0.6778.204/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  join(process.env.HOME ?? '', '.cache/puppeteer/chrome/mac_arm-130.0.6723.69/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  process.env.PUPPETEER_CHROME_BIN ?? '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const EXT_DIR = '/tmp/edg-e2e-ext';

function log(...args) {
  console.log('[run-upload]', ...args);
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
      const safe = urlPath.replace(/^\/+/, '') || 'upload.html';
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

async function getStats(base) {
  const r = await fetch(`${base}/__stats`);
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
  const userDataDir = mkdtempSync(join(tmpdir(), 'edg-upload-'));
  log('userDataDir =', userDataDir);

  writeFileSync(FIXTURE_PATH, 'hello from upload e2e fixture\n');
  log('fixture written:', FIXTURE_PATH, '(', statSync(FIXTURE_PATH).size, 'bytes )');

  await pollUntil(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${MOCK_LLM_PORT}/v1/models`);
      return r.ok;
    } catch {
      return false;
    }
  }, { timeoutMs: 15000, label: 'mock-llm ready' });
  log('mock-llm ready');

  const pageServer = await startPageServer();
  const uploadUrl = `http://127.0.0.1:${pageServer.port}/upload.html`;
  log('page server =', uploadUrl);

  const chromeBin = findChrome();
  log('chrome =', chromeBin);

  // ★ 防御点 #1：杀掉残留 Chrome
  try {
    execSync(`pkill -f 'edg-upload-' 2>/dev/null || true; pkill -f 'load-extension=${EXT_DIR}' 2>/dev/null || true; sleep 1`, { stdio: 'ignore' });
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

    // ★ 防御点 #2：先 upload.html，再 sidepanel.html
    const pages = await browser.pages();
    let page = pages[0];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        log(`[page:${msg.type()}]`, msg.text());
      }
    });
    page.on('pageerror', (err) => log('[page:exception]', err.message));
    await page.goto(uploadUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#log1', { timeout: 5000 });
    log('upload.html loaded');

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

    // Seed settings
    await sidepanel.bringToFront();
    await withSidepanel((p) => p.click('button[aria-label="设置"]'));
    await sidepanel.waitForSelector('select', { timeout: 5000 });
    await withSidepanel((p) => p.select('select', 'custom'));
    await delay(200);
    await withSidepanel((p) => setReactField(p, 'Base URL', MOCK_BASE));
    await withSidepanel((p) => setReactField(p, 'API Key', 'mock-key-not-real'));
    await withSidepanel((p) => setReactField(p, 'Model', 'mock-model'));
    await delay(200);
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
    log('settings saved');

    // ★ 防御点 #4：sidepanel 保持前台；upload tab 留后台（依赖 Main rAF 兜底）
    log('sidepanel foreground; upload tab stays background.');

    // 发任务
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

    // 等第一次确认卡片
    await pollUntil(async () => {
      return withSidepanel((p) =>
        p.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          return btns.some((b) => (b.textContent || '').trim() === '本次会话始终允许');
        }),
      );
    }, { timeoutMs: 30000, label: 'confirm card' });
    await withSidepanel((p) =>
      p.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const b = btns.find((x) => (x.textContent || '').trim() === '本次会话始终允许');
        if (b) b.click();
      }),
    );
    log('confirm-always clicked');

    // 等任务结束
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

    const logs = await page.evaluate(() => ({
      log1: document.getElementById('log1')?.textContent ?? '',
      log2: document.getElementById('log2')?.textContent ?? '',
      log3: document.getElementById('log3')?.textContent ?? '',
    }));
    const pageState = await page.evaluate(() => {
      const f1 = document.getElementById('file1');
      const f2 = document.getElementById('file2');
      return {
        file1HasDataId: f1?.getAttribute('data-edg-id') ?? null,
        file1HasUpload: f1?.getAttribute('data-edg-upload') ?? null,
        file2HasDataId: f2?.getAttribute('data-edg-id') ?? null,
        file2HasUpload: f2?.getAttribute('data-edg-upload') ?? null,
        file1Files: f1?.files ? Array.from(f1.files).map((x) => x.name) : null,
        file2Files: f2?.files ? Array.from(f2.files).map((x) => x.name) : null,
      };
    });
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
    const stats = await getStats(`http://127.0.0.1:${MOCK_LLM_PORT}`);
    log('page state =', pageState);
    log('agent steps:');
    for (const s of agentSteps) log('  ·', s);
    log('logs =', logs);
    log('finalStatus =', finalStatus);
    log('stats =', stats);

    const assertLog1 = logs.log1.includes(FIXTURE_BASENAME);
    const assertLog2 = logs.log2.includes(FIXTURE_BASENAME);
    const assertLog3 = logs.log3.includes(FIXTURE_BASENAME);
    const assertSawUpload = stats.sawUpload === 3;
    const assertDone = finalStatus === 'done';

    log('assert log1 =', assertLog1);
    log('assert log2 =', assertLog2);
    log('assert log3 =', assertLog3);
    log('assert sawUpload=3 =', assertSawUpload);
    log('assert done =', assertDone);

    if (!(assertLog1 && assertLog2 && assertLog3 && assertSawUpload && assertDone)) {
      failed = {
        log1: logs.log1,
        log2: logs.log2,
        log3: logs.log3,
        pageState,
        finalStatus,
        reqCount: stats.reqCount,
        agentSteps,
      };
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
  console.error('run-upload failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});