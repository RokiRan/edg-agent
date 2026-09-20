// e2e/run-memory.mjs — end-to-end test for long-term memory (lib/memory.ts).
//
// Covers:
//   - 提炼触发闸：任务有 ≥2 次页面动作 → done 后追加一轮提炼请求（sawDistill=1）
//   - 提炼结果落库：chrome.storage.local 的 memory_v1 含 facts + sites[domain]
//   - 去重：第二次任务提炼出相同内容 → 不重复入库（条目数不变）
//   - 注入：第二次任务的 system prompt 带记忆段（sawMemoryInjection=true）
// Harness 防御点沿用 run-dialog.mjs：pre-launch pkill、页面先于 sidepanel 打开、
// retry-on-TargetClosed、随机 debug port。

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
const TASK_1 = '记忆测试：搜索 hello';
const TASK_2 = '记忆测试：再搜索一次 hello';
const EXPECT_FACT = '用户公司的发票抬头是「示例科技有限公司」';
const EXPECT_TIP = '搜索框要先点击放大镜图标再输入';

const CHROME_BIN_CANDIDATES = [
  join(process.env.HOME ?? '', '.cache/puppeteer/chrome/mac_arm-131.0.6778.204/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  join(process.env.HOME ?? '', '.cache/puppeteer/chrome/mac_arm-130.0.6723.69/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  process.env.PUPPETEER_CHROME_BIN ?? '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const EXT_DIR = '/tmp/edg-e2e-ext';

function log(...args) {
  console.log('[run-memory]', ...args);
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

async function main() {
  if (!existsSync(join(EXT_DIR, 'manifest.json'))) {
    console.error('找不到扩展产物（', EXT_DIR, '）。先跑 `node e2e/prepare-ext.mjs`。');
    process.exit(1);
  }
  const userDataDir = mkdtempSync(join(tmpdir(), 'edg-memory-'));
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

  const pageServer = await startPageServer();
  const testUrl = `http://127.0.0.1:${pageServer.port}/search.html`;
  log('page server =', testUrl);

  const chromeBin = findChrome();
  log('chrome =', chromeBin);

  try {
    execSync(`pkill -f 'edg-memory-' 2>/dev/null || true; pkill -f 'load-extension=${EXT_DIR}' 2>/dev/null || true; sleep 1`, { stdio: 'ignore' });
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

    const pages = await browser.pages();
    const page = pages[0];
    page.on('pageerror', (err) => log('[page:exception]', err.message));
    await page.goto(testUrl, { waitUntil: 'domcontentloaded' });
    log('search.html loaded');

    const sidepanel = await browser.newPage();
    sidepanel.setDefaultTimeout(8000);
    sidepanel.on('pageerror', (err) => log('[sidepanel:exception]', err.message));
    await sidepanel.goto(sidepanelUrl, { waitUntil: 'domcontentloaded' });
    await sidepanel.waitForSelector('button[aria-label="设置"]', { timeout: 10000 });
    await delay(500);
    log('sidepanel loaded');

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

    // 终态徽标按计数判定：上一任务的「完成」徽标留在 DOM 里，
    // 用 some() 会被旧徽标假阳性秒过，必须等计数增加。
    const countTerminalBadges = () =>
      withSidepanel((p) =>
        p.evaluate(() => {
          const labels = Array.from(document.querySelectorAll('span')).map((s) =>
            (s.textContent || '').trim(),
          );
          return labels.filter((t) => t === '完成' || t === '失败' || t === '步数上限').length;
        }),
      );

    const sendTask = async (task) => {
      const badgesBefore = await countTerminalBadges();
      await withSidepanel((p) => p.click('textarea'));
      await withSidepanel((p) => p.type('textarea', task, { delay: 5 }));
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
      await pollUntil(async () => {
        const now = await countTerminalBadges();
        return now > badgesBefore;
      }, { timeoutMs: 90000, label: `task terminal: ${task.slice(0, 12)}` });
      await delay(500);
    };

    const readMemoryStore = () =>
      withSidepanel((p) =>
        p.evaluate(
          () =>
            new Promise((resolveP) => {
              chrome.storage.local.get('memory_v1', (items) => resolveP(items.memory_v1 ?? null));
            }),
        ),
      );

    // mock 统计是进程生命周期累计的（其它 runner 也会触发提炼），断言一律用差值
    const stats0 = await getStats(`http://127.0.0.1:${MOCK_LLM_PORT}`);

    // --- 任务 1：触发提炼，记忆落库 ---
    try {
      await sendTask(TASK_1);
    } catch (e) {
      const steps = await withSidepanel((p) =>
        p.evaluate(() =>
          Array.from(document.querySelectorAll('li.edg-step')).map((li) =>
            (li.textContent || '').replace(/\s+/g, ' ').trim(),
          ),
        ),
      ).catch(() => ['<dump failed>']);
      log('task 1 stall; steps so far:', steps);
      throw e;
    }
    log('task 1 terminal');

    const store1 = await readMemoryStore();
    const stats1 = await getStats(`http://127.0.0.1:${MOCK_LLM_PORT}`);
    log('store after task 1 =', JSON.stringify(store1));
    log('stats after task 1: sawDistill =', stats1.sawDistill, 'sawMemoryInjection =', stats1.sawMemoryInjection);

    const assertDistill1 = stats1.sawDistill - stats0.sawDistill === 1;
    const facts1 = store1?.facts ?? [];
    const tips1 = store1?.sites?.['127.0.0.1'] ?? [];
    const assertFactStored = facts1.some((e) => e.text === EXPECT_FACT);
    const assertTipStored = tips1.some((e) => e.text === EXPECT_TIP);
    // 首次任务无记忆可注入
    const assertNoInjectionYet = stats1.sawMemoryInjection - stats0.sawMemoryInjection === 0;

    // --- 任务 2：同内容提炼应去重，且本次 prompt 应已注入记忆段 ---
    await sendTask(TASK_2);
    log('task 2 terminal');

    const store2 = await readMemoryStore();
    const stats2 = await getStats(`http://127.0.0.1:${MOCK_LLM_PORT}`);
    log('stats after task 2: sawDistill =', stats2.sawDistill, 'sawMemoryInjection =', stats2.sawMemoryInjection);

    const assertDistill2 = stats2.sawDistill - stats0.sawDistill === 2;
    const assertInjected = stats2.sawMemoryInjection - stats1.sawMemoryInjection >= 1;
    const facts2 = store2?.facts ?? [];
    const tips2 = store2?.sites?.['127.0.0.1'] ?? [];
    const assertDedup = facts2.length === 1 && tips2.length === 1;

    // --- 记忆面板 UI：设置里应渲染出已记条目（查看/编辑/删除入口存在） ---
    await withSidepanel((p) => p.click('button[aria-label="设置"]'));
    await delay(600);
    const panelState = await withSidepanel((p) =>
      p.evaluate(() => {
        const text = document.body.innerText;
        return {
          hasSection: text.includes('记忆'),
          hasFact: text.includes('用户公司的发票抬头是「示例科技有限公司」'),
          hasTip: text.includes('搜索框要先点击放大镜图标再输入'),
          editBtns: Array.from(document.querySelectorAll('button')).filter(
            (b) => (b.textContent || '').trim() === '编辑',
          ).length,
        };
      }),
    );
    const assertPanel =
      panelState.hasSection && panelState.hasFact && panelState.hasTip && panelState.editBtns >= 2;
    await withSidepanel((p) => p.click('button[aria-label="设置"]'));
    await delay(300);

    log('assert 提炼触发(任务1) =', assertDistill1);
    log('assert fact 落库 =', assertFactStored);
    log('assert siteTip 落库(按域名) =', assertTipStored);
    log('assert 任务1无记忆注入 =', assertNoInjectionYet);
    log('assert 提炼触发(任务2) =', assertDistill2);
    log('assert 任务2注入记忆段 =', assertInjected);
    log('assert 重复提炼去重 =', assertDedup);
    log('assert 记忆面板渲染 =', assertPanel);

    if (
      !(
        assertDistill1 &&
        assertFactStored &&
        assertTipStored &&
        assertNoInjectionYet &&
        assertDistill2 &&
        assertInjected &&
        assertDedup &&
        assertPanel
      )
    ) {
      failed = { store1, store2, stats1, stats2, panelState };
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

main().catch((err) => {
  console.error('run-memory failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
