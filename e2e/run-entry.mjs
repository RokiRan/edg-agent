// e2e/run-entry.mjs — end-to-end test for repetitive data entry:
// local Excel (.xlsx) rows -> web form, one row at a time, submit each.
//
// Flow: generate a real .xlsx fixture on disk (python3 zipfile, no deps) ->
// parse it back (proving data originates from the xlsx) -> embed rows into
// the task text (edg-agent has no local-file-read tool; this is the
// paste/conversion boundary) -> mock-llm cycles type x3 + click submit per
// row -> assert the page table ends with exactly the xlsx rows.
//
// Defenses inherited from run-upload.mjs:
//   #1 pre-launch pkill leftover chrome
//   #2 tab order: dataentry.html, then sidepanel.html
//   #3 retry-on-TargetClosed wrapper for every sidepanel CDP call
//   #4 sidepanel stays foreground (background-tab rAF starvation workaround)

import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const PROJECT_ROOT = resolve(__dirname, '..');

const MOCK_LLM_PORT = Number(process.env.MOCK_LLM_PORT ?? 4399);
const MOCK_BASE = `http://127.0.0.1:${MOCK_LLM_PORT}/v1`;
const XLSX_PATH = '/private/tmp/edg-entry-fixture.xlsx';

// 测试数据：3 行（姓名, 部门, 电话）。先写成真 xlsx，再解析回来构造任务，
// 保证任务里的数据确实源自本地 Excel 文件。
const ROWS = [
  ['张伟', '技术部', '13800000001'],
  ['李娜', '财务部', '13800000002'],
  ['王强', '市场部', '13800000003'],
];

const CHROME_BIN_CANDIDATES = [
  join(process.env.HOME ?? '', '.cache/puppeteer/chrome/mac_arm-131.0.6778.204/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  join(process.env.HOME ?? '', '.cache/puppeteer/chrome/mac_arm-130.0.6723.69/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  process.env.PUPPETEER_CHROME_BIN ?? '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const EXT_DIR = '/tmp/edg-e2e-ext';

function log(...args) {
  console.log('[run-entry]', ...args);
}

function findChrome() {
  for (const p of CHROME_BIN_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  throw new Error('找不到 Chrome 二进制，已尝试: ' + CHROME_BIN_CANDIDATES.join(', '));
}

// 用 python3 zipfile 写一个最小但合法的 xlsx（inlineStr，无 sharedStrings）。
function writeXlsx(path, rows) {
  const script = `
import zipfile, sys, json
rows = json.loads(sys.argv[1])
def esc(s):
    return s.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
body = ''
for i, r in enumerate(rows, start=1):
    cells = ''
    for j, v in enumerate(r):
        col = chr(ord('A') + j)
        cells += '<c r="%s%d" t="inlineStr"><is><t>%s</t></is></c>' % (col, i, esc(v))
    body += '<row r="%d">%s</row>' % (i, cells)
sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \\
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' \\
  '<sheetData>' + body + '</sheetData></worksheet>'
ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \\
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' \\
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' \\
  '<Default Extension="xml" ContentType="application/xml"/>' \\
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' \\
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' \\
  '</Types>'
rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \\
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' \\
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' \\
  '</Relationships>'
wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \\
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' \\
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' \\
  '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
wb_rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \\
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' \\
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' \\
  '</Relationships>'
z = zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED)
z.writestr('[Content_Types].xml', ct)
z.writestr('_rels/.rels', rels)
z.writestr('xl/workbook.xml', wb)
z.writestr('xl/_rels/workbook.xml.rels', wb_rels)
z.writestr('xl/worksheets/sheet1.xml', sheet)
z.close()
`;
  const scriptPath = join(mkdtempSync(join(tmpdir(), 'edg-xlsx-')), 'make_xlsx.py');
  writeFileSync(scriptPath, script);
  execFileSync('python3', [scriptPath, JSON.stringify(rows), path]);
}

// 解析回 xlsx 的行数据（证明任务数据确实从文件里来）。
function readXlsx(path) {
  const script = `
import zipfile, re, sys, json
z = zipfile.ZipFile(sys.argv[1])
xml = z.read('xl/worksheets/sheet1.xml').decode('utf-8')
rows = []
for m in re.finditer(r'<row[^>]*>(.*?)</row>', xml, re.S):
    rows.append(re.findall(r'<t>(.*?)</t>', m.group(1), re.S))
print(json.dumps(rows, ensure_ascii=False))
`;
  const scriptPath = join(mkdtempSync(join(tmpdir(), 'edg-xlsx-')), 'read_xlsx.py');
  writeFileSync(scriptPath, script);
  const out = execFileSync('python3', [scriptPath, path], { encoding: 'utf-8' });
  return JSON.parse(out);
}

async function startPageServer() {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const safe = urlPath.replace(/^\/+/, '') || 'dataentry.html';
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
  const userDataDir = mkdtempSync(join(tmpdir(), 'edg-entry-'));
  log('userDataDir =', userDataDir);

  writeXlsx(XLSX_PATH, ROWS);
  const parsed = readXlsx(XLSX_PATH);
  if (JSON.stringify(parsed) !== JSON.stringify(ROWS)) {
    console.error('xlsx 回读不一致:', parsed);
    process.exit(1);
  }
  log('xlsx fixture written & parsed back:', XLSX_PATH, `(${parsed.length} rows)`);

  // 数据不内嵌任务文本——通过 sidepanel 附件机制挂真 xlsx，验证完整解析链路
  const TASK = '批量录入测试：把附件 Excel 的数据逐条填入员工信息表单并提交，一次一条。';

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
  const entryUrl = `http://127.0.0.1:${pageServer.port}/dataentry.html`;
  log('page server =', entryUrl);

  const chromeBin = findChrome();
  log('chrome =', chromeBin);

  // ★ 防御点 #1：杀掉残留 Chrome
  try {
    execSync(`pkill -f 'edg-entry-' 2>/dev/null || true; pkill -f 'load-extension=${EXT_DIR}' 2>/dev/null || true; sleep 1`, { stdio: 'ignore' });
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

    // ★ 防御点 #2：先 dataentry.html，再 sidepanel.html
    const pages = await browser.pages();
    let page = pages[0];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        log(`[page:${msg.type()}]`, msg.text());
      }
    });
    page.on('pageerror', (err) => log('[page:exception]', err.message));
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#f-submit', { timeout: 5000 });
    log('dataentry.html loaded');

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
    // 挂真 xlsx 附件：sidepanel 内 SheetJS 解析 → chip 出现即解析成功
    await withSidepanel(async (p) => {
      const input = await p.$('input[data-edg-attach]');
      if (!input) throw new Error('附件 input 未找到');
      await input.uploadFile(XLSX_PATH);
    });
    await withSidepanel((p) => p.waitForSelector('[data-edg-attachment]', { timeout: 10000 }));
    const chipText = await withSidepanel((p) =>
      p.evaluate(() => document.querySelector('[data-edg-attachment]')?.textContent ?? ''),
    );
    log('attachment chip =', JSON.stringify(chipText));
    if (!chipText.includes('edg-entry-fixture.xlsx')) {
      throw new Error('附件 chip 未显示预期文件名: ' + chipText);
    }

    // ★ 防御点 #4：sidepanel 保持前台；录入页留后台
    log('sidepanel foreground; entry tab stays background.');

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

    // 「提交」命中高危闸（DANGEROUS_RE 含 提交）：等第一次确认卡片，点「本次会话始终允许」，
    // 之后每次提交自动放行。
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

    // 等任务结束（12 步动作 + 往返，给足时间）
    await pollUntil(async () => {
      return withSidepanel((p) =>
        p.evaluate(() => {
          const badges = Array.from(document.querySelectorAll('span'));
          const labels = badges.map((s) => (s.textContent || '').trim());
          return labels.some((t) => t === '完成' || t === '失败' || t === '步数上限');
        }),
      );
    }, { timeoutMs: 120000, label: 'task terminal' });
    log('task reached terminal state');
    await delay(500);

    const tableRows = await page.evaluate(() => {
      const trs = Array.from(document.querySelectorAll('#rows tr'));
      return trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent));
    });
    const pageLog = await page.evaluate(() => document.getElementById('log')?.textContent ?? '');
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
    log('table rows =', JSON.stringify(tableRows));
    log('agent steps:');
    for (const s of agentSteps) log('  ·', s);
    log('page log =', JSON.stringify(pageLog));
    log('finalStatus =', finalStatus);
    log('stats =', stats);

    const assertRows = JSON.stringify(tableRows) === JSON.stringify(ROWS);
    const assertSawEntry = stats.sawEntry === ROWS.length;
    const assertDone = finalStatus === 'done';

    log('assert table rows match xlsx =', assertRows);
    log(`assert sawEntry=${ROWS.length} =`, assertSawEntry);
    log('assert done =', assertDone);

    if (!(assertRows && assertSawEntry && assertDone)) {
      failed = {
        expected: ROWS,
        tableRows,
        pageLog,
        finalStatus,
        reqCount: stats.reqCount,
        sawEntry: stats.sawEntry,
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
  console.error('run-entry failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
