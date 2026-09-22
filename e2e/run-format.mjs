// e2e/run-format.mjs — end-to-end tests for the format-error classifier
// (lib/agent/loop.ts classifyFailure) and the止血 (raw-history replay
// removal + neutral retry prompt + structured diag).
//
// Two scenarios, each running once:
//   1. FORMAT_THINK_ONLY — mock serves pure think twice; classifier should
//      mark think-only and the second occurrence should trigger early-fail
//      (任务请求数差值 == 2，不应被发到第 3 次；失败摘要含「连续输出思考内容」)。
//   2. FORMAT_REFUSAL — mock serves think + 抱歉...; classifier should mark
//      refusal and burn no retry (请求数差值 == 1；失败摘要含「模型拒绝执行」)。
//
// Assertions follow edg-agent-e2e-runner-deltas: terminal state via badge
// COUNT DELTA (not presence — stale badges from previous tasks would false-
// positive), and mock stats via前后差值 (mock is process-lifetime cumulative).
//
// Harness defenses mirrored from run-dialog.mjs: pre-launch pkill, tab order
// (search.html then sidepanel.html), retry-on-TargetClosed, random debug port.

import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const PROJECT_ROOT = resolve(__dirname, '..');

const MOCK_LLM_PORT = Number(process.env.MOCK_LLM_PORT ?? 4399);
const MOCK_BASE = `http://127.0.0.1:${MOCK_LLM_PORT}/v1`;

// 两个场景各一个任务；任务文本包含 mock-llm.mjs 中的 sentinel 关键词。
const TASK_THINK_ONLY = 'FORMAT_THINK_ONLY 请执行一些不可能完成的操作';
const TASK_REFUSAL = 'FORMAT_REFUSAL 请执行一些不可能完成的操作';
const TASK_RECOVER = '格式容错 请执行一些不可能完成的操作';

const CHROME_BIN_CANDIDATES = [
  join(process.env.HOME ?? '', '.cache/puppeteer/chrome/mac_arm-131.0.6778.204/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  join(process.env.HOME ?? '', '.cache/puppeteer/chrome/mac_arm-130.0.6723.69/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  process.env.PUPPETEER_CHROME_BIN ?? '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const EXT_DIR = '/tmp/edg-e2e-ext';

function log(...args) {
  console.log('[run-format]', ...args);
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
  const userDataDir = mkdtempSync(join(tmpdir(), 'edg-format-'));
  log('userDataDir =', userDataDir);

  // 等待 mock 就绪
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
    execSync(`pkill -f 'edg-format-' 2>/dev/null || true; pkill -f 'load-extension=${EXT_DIR}' 2>/dev/null || true; sleep 1`, { stdio: 'ignore' });
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

  const results = [];

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

    // 防御点：先被测页再 sidepanel
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

    // 读取失败消息文本（用于断言摘要内容）。
    // 失败摘要显示在 AgentBubble 内、status==='failed' 分支的 <div class="text-[#f87171]">。
    // Tailwind 在 puppeteer DOM 里的 class 选择器写法：div.text-\[\#f87171\]。
    const readFailureSummary = () =>
      withSidepanel((p) =>
        p.evaluate(() => {
          const failDivs = Array.from(document.querySelectorAll('div.text-\\[\\#f87171\\]'));
          if (failDivs.length > 0) {
            return (failDivs[failDivs.length - 1].textContent || '').replace(/\s+/g, ' ').trim();
          }
          // 兜底：抓所有 li.edg-step 文本（mock 路径调试用）
          const allText = Array.from(document.querySelectorAll('li.edg-step'))
            .map((li) => (li.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
          return allText.length > 0 ? allText[allText.length - 1] : '';
        }),
      );

    // Seed settings（与 run-dialog 同构）
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

    // 终态徽标按计数判定（不按存在判定，否则上一任务的徽标残留会假阳性）
    const countTerminalBadges = () =>
      withSidepanel((p) =>
        p.evaluate(() => {
          const labels = Array.from(document.querySelectorAll('span')).map((s) =>
            (s.textContent || '').trim(),
          );
          return labels.filter((t) => t === '完成' || t === '失败' || t === '步数上限').length;
        }),
      );
    // 终态徽标文案（区分 完成/失败/步数上限；取最后一个，残留徽标按序排列最后一个是本任务的）
    const lastTerminalBadge = () =>
      withSidepanel((p) =>
        p.evaluate(() => {
          const labels = Array.from(document.querySelectorAll('span')).map((s) =>
            (s.textContent || '').trim(),
          );
          const terms = labels.filter((t) => t === '完成' || t === '失败' || t === '步数上限');
          return terms.length > 0 ? terms[terms.length - 1] : '';
        }),
      );




    const sendTask = async (task, opts = {}) => {
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
      }, { timeoutMs: 90000, label: `task terminal: ${task.slice(0, 16)}` });
      await delay(500);
    };

    // mock 统计是进程级累计值，断言一律前后差值
    const stats0 = await getStats(`http://127.0.0.1:${MOCK_LLM_PORT}`);
    log('stats0 =', JSON.stringify({
      reqCount: stats0.reqCount,
      thinkOnlyServed: stats0.thinkOnlyServed,
      refusalServed: stats0.refusalServed,
      formatRecoveryServed: stats0.formatRecoveryServed,
    }));

    // ───────── 场景 1：FORMAT_THINK_ONLY ─────────
    log('--- scenario 1: FORMAT_THINK_ONLY ---');
    await sendTask(TASK_THINK_ONLY);
    const stats1 = await getStats(`http://127.0.0.1:${MOCK_LLM_PORT}`);
    const summary1 = await readFailureSummary();
    log('stats1.thinkOnlyServed =', stats1.thinkOnlyServed);
    log('stats1.reqCount delta =', stats1.reqCount - stats0.reqCount);
    log('summary1 =', summary1.slice(0, 200));

    // 分类器判 think-only 后走专用 prompt 一次，再第二次仍 think-only → 早退。
    // 因此该任务的请求数 = 2（首轮 + 重试），且只应有 2 次 thinkOnly mock 响应。
    // 注意：mock 计数 thinkOnlyServed 是 process-lifetime 的，断言前后差值 == 2。
    // 「不应有第 3 次请求」用 reqCount 差值 == 2 验证（首轮 + 一次重试 = 2）。
    const thinkOnlyReqDelta = stats1.reqCount - stats0.reqCount;
    const thinkOnlyServedDelta = stats1.thinkOnlyServed - stats0.thinkOnlyServed;
    const thinkOnlySummaryHasPhrase = summary1.includes('连续输出思考内容');
    const thinkOnlyOk =
      thinkOnlyReqDelta === 2 &&
      thinkOnlyServedDelta === 2 &&
      thinkOnlySummaryHasPhrase;
    log('assert THINK_ONLY reqCount delta == 2 =', thinkOnlyReqDelta === 2);
    log('assert THINK_ONLY thinkOnlyServed delta == 2 =', thinkOnlyServedDelta === 2);
    log('assert THINK_ONLY summary contains 连续输出思考内容 =', thinkOnlySummaryHasPhrase);
    results.push({ scenario: 'FORMAT_THINK_ONLY', ok: thinkOnlyOk, thinkOnlyReqDelta, thinkOnlyServedDelta, summary: summary1 });

    // ───────── 场景 2：FORMAT_REFUSAL ─────────
    log('--- scenario 2: FORMAT_REFUSAL ---');
    await sendTask(TASK_REFUSAL);
    const stats2 = await getStats(`http://127.0.0.1:${MOCK_LLM_PORT}`);
    const summary2 = await readFailureSummary();
    log('stats2.refusalServed =', stats2.refusalServed);
    log('stats2.reqCount delta (from stats1) =', stats2.reqCount - stats1.reqCount);
    log('summary2 =', summary2.slice(0, 200));

    // 分类器判 refusal → 一次即终态，不烧重试。该任务的请求数 = 1。
    const refusalReqDelta = stats2.reqCount - stats1.reqCount;
    const refusalServedDelta = stats2.refusalServed - stats1.refusalServed;
    const refusalSummaryHasPhrase = summary2.includes('模型拒绝执行');
    const refusalOk =
      refusalReqDelta === 1 &&
      refusalServedDelta === 1 &&
      refusalSummaryHasPhrase;
    log('assert REFUSAL reqCount delta == 1 =', refusalReqDelta === 1);
    log('assert REFUSAL refusalServed delta == 1 =', refusalServedDelta === 1);
    log('assert REFUSAL summary contains 模型拒绝执行 =', refusalSummaryHasPhrase);
    results.push({ scenario: 'FORMAT_REFUSAL', ok: refusalOk, refusalReqDelta, refusalServedDelta, summary: summary2 });
    // ───────── 场景 3：FORMAT_RECOVER（think-only 一次 → 专用 prompt → 恢复 done）─────────
    // 回归锁：刚修的「consecutiveThinkOnly 成功复位」依赖此路径——think-only 后恢复 done
    // 不能污染后续任务，也不能误触连击闸。
    log('--- scenario 3: FORMAT_RECOVER ---');
    await sendTask(TASK_RECOVER);
    const stats3 = await getStats(`http://127.0.0.1:${MOCK_LLM_PORT}`);
    const badge3 = await lastTerminalBadge();
    log('stats3.formatRecoveryServed =', stats3.formatRecoveryServed);
    log('stats3.reqCount delta (from stats2) =', stats3.reqCount - stats2.reqCount);
    log('badge3 =', badge3);

    // 首轮 think-only → 分类器走专用 prompt → mock 见「请跳过思考过程」返回 done。
    // 请求数 == 2（首轮 + 一次重试）；徽标必须是「完成」而非「失败」。
    const recoverReqDelta = stats3.reqCount - stats2.reqCount;
    const recoverServedDelta = stats3.formatRecoveryServed - stats2.formatRecoveryServed;
    const recoverOk =
      recoverReqDelta === 2 &&
      recoverServedDelta === 1 &&
      badge3 === '完成';
    log('assert RECOVER reqCount delta == 2 =', recoverReqDelta === 2);
    log('assert RECOVER formatRecoveryServed delta == 1 =', recoverServedDelta === 1);
    log('assert RECOVER badge == 完成 =', badge3 === '完成');
    results.push({ scenario: 'FORMAT_RECOVER', ok: recoverOk, recoverReqDelta, recoverServedDelta, badge: badge3 });

    log('--- summary ---');
    for (const r of results) {
      log(`  ${r.scenario}: ${r.ok ? 'OK' : 'FAIL'}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await pageServer.close();
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error('断言失败:', JSON.stringify(failed, null, 2));
    process.exit(2);
  }
  log('all assertions green');
}

main().catch((err) => {
  console.error('run-format failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
