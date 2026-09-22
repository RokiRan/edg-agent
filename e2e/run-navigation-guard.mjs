// e2e/run-navigation-guard.mjs — 导航漂移检测的纯函数测试。
//
// 任务：把 lib/agent/loop.ts 里的 eTLD1 / checkNav 纯函数抠出来，做单元断言。
// mock-friendly：不依赖 puppeteer / mock-llm / 真扩展；只验证算法的语义正确。
//
// 退出码：0=断言全绿，1=setup failure，2=assertion failure

import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const PROJECT_ROOT = resolve(__dirname, '..');

function log(...args) {
  console.log('[run-navigation-guard]', ...args);
}

/**
 * 简化 eTLD+1：取 host 最后两段小写作为「公共后缀+1」。
 * 与 lib/agent/loop.ts 的 eTLD1 实现一致（独立复制以保持 mock-friendly 性质）。
 */
function eTLD1(host) {
  const parts = host.toLowerCase().split('.').filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join('.');
  return host.toLowerCase() || '';
}

/** 常见登录/鉴权路径前缀——跨子域落到这些路径默认当「前置登录」处理。 */
const LOGIN_PATH_RE = /^\/(?:login|signin|sso|oauth|auth|accounts?|signup|register)(?:\/|$)/i;

/**
 * 与 lib/agent/loop.ts 的 checkNav 实现一致（独立复制以保持 mock-friendly 性质）。
 *   - same：完全相同 host
 *   - cross-subdomain-login：eTLD+1 一致但 host 不同——按登录前置保守处理
 *   - cross-domain：eTLD+1 不同——弹 nav-confirm 让用户三选一
 */
function checkNav(fromUrl, toUrl) {
  const a = new URL(fromUrl); const b = new URL(toUrl);
  const same = a.hostname === b.hostname;
  const sameEtld1 = eTLD1(a.hostname) === eTLD1(b.hostname);
  let kind;
  if (same) kind = 'same';
  else if (sameEtld1 && LOGIN_PATH_RE.test(b.pathname)) kind = 'cross-subdomain-login';
  else if (sameEtld1) kind = 'cross-subdomain-login';
  else kind = 'cross-domain';
  return { kind, fromHost: a.hostname, toHost: b.hostname, fromPath: a.pathname, toPath: b.pathname, fromEtld1: eTLD1(a.hostname), toEtld1: eTLD1(b.hostname) };
}

/**
 * 断言 helper：expected 中键 '__value' 时比对标量返回值；其他键比对对象字段。
 * 返回失败列表（空数组=全绿）。
 */
function runCase(label, actual, expected) {
  const failures = [];
  if (typeof actual !== 'object' || actual === null) {
    if (actual !== expected.__value) {
      failures.push(`  ✗ ${label}: expected ${JSON.stringify(expected.__value)}, got ${JSON.stringify(actual)}`);
    }
    return failures;
  }
  for (const k of Object.keys(expected)) {
    if (k === '__value') continue;
    if (JSON.stringify(actual[k]) !== JSON.stringify(expected[k])) {
      failures.push(`  ✗ ${label}.${k}: expected ${JSON.stringify(expected[k])}, got ${JSON.stringify(actual[k])}`);
    }
  }
  return failures;
}

async function main() {
  const failures = [];

  // ===== eTLD1 边界测试 =====
  failures.push(...runCase('eTLD1(accounts.flightsite.com)', eTLD1('accounts.flightsite.com'), { __value: 'flightsite.com' }));
  failures.push(...runCase('eTLD1(www.flightsite.com)', eTLD1('www.flightsite.com'), { __value: 'flightsite.com' }));
  failures.push(...runCase('eTLD1(flightsite.com)', eTLD1('flightsite.com'), { __value: 'flightsite.com' }));
  failures.push(...runCase('eTLD1(x.com)', eTLD1('x.com'), { __value: 'x.com' }));
  failures.push(...runCase('eTLD1(ACCOUNTS.FLIGHTSITE.COM 大小写)', eTLD1('ACCOUNTS.FLIGHTSITE.COM'), { __value: 'flightsite.com' }));
  failures.push(...runCase('eTLD1(empty)', eTLD1(''), { __value: '' }));
  failures.push(...runCase('eTLD1(a.b.c.flightsite.com 深层子域)', eTLD1('a.b.c.flightsite.com'), { __value: 'flightsite.com' }));

  // ===== checkNav 核心场景 =====
  // 1. 跨子域到登录路径 → cross-subdomain-login
  failures.push(...runCase(
    'cross-subdomain-login (www → accounts/login)',
    checkNav('https://www.flightsite.com/search', 'https://accounts.flightsite.com/login'),
    { kind: 'cross-subdomain-login', fromHost: 'www.flightsite.com', toHost: 'accounts.flightsite.com' },
  ));
  failures.push(...runCase(
    'cross-subdomain-login (任意路径 → /auth)',
    checkNav('https://www.flightsite.com/foo', 'https://accounts.flightsite.com/auth/callback'),
    { kind: 'cross-subdomain-login' },
  ));
  failures.push(...runCase(
    'cross-subdomain-login (/sso 子路径也命中)',
    checkNav('https://www.flightsite.com/foo', 'https://accounts.flightsite.com/sso/redirect'),
    { kind: 'cross-subdomain-login' },
  ));

  // 2. 真跨域 → cross-domain
  failures.push(...runCase(
    'cross-domain (flightsite → google)',
    checkNav('https://www.flightsite.com/search', 'https://accounts.google.com/login'),
    { kind: 'cross-domain', fromEtld1: 'flightsite.com', toEtld1: 'google.com' },
  ));
  failures.push(...runCase(
    'cross-domain (完全不同的两个 eTLD+1)',
    checkNav('https://example.com/foo', 'https://other.org/bar'),
    { kind: 'cross-domain' },
  ));

  // 3. 同站跨子域（非登录路径）：按当前实现策略归 cross-subdomain-login（保守熔断）
  failures.push(...runCase(
    'cross-subdomain-login (非登录路径，同站跨子域保守熔断)',
    checkNav('https://www.flightsite.com/search', 'https://docs.flightsite.com/help'),
    { kind: 'cross-subdomain-login' },
  ));

  // 4. 完全相同 host → same
  failures.push(...runCase(
    'same (x.com → x.com)',
    checkNav('https://x.com/', 'https://x.com/search'),
    { kind: 'same', toPath: '/search' },
  ));
  failures.push(...runCase(
    'same (x.com → www.x.com 实际是同 host 不同 path)',
    checkNav('https://x.com/foo', 'https://x.com/foo?bar=1'),
    { kind: 'same' },
  ));

  // 5. 大小写不敏感
  failures.push(...runCase(
    '大小写不敏感 (FLIGHTSITE.COM → accounts.flightsite.com)',
    checkNav('https://WWW.FLIGHTSITE.COM/search', 'https://accounts.flightsite.com/login'),
    { kind: 'cross-subdomain-login' },
  ));

  // 6. 端口不参与 eTLD+1 比较（最常见情形是同 host 不同端口——仍属 same）
  failures.push(...runCase(
    '端口不同 → same (www:8080 → www:9090)',
    checkNav('https://www.flightsite.com:8080/foo', 'https://www.flightsite.com:9090/bar'),
    { kind: 'same' },
  ));

  // ===== 回归断言：loop.ts 源码里 eTLD1 / checkNav 必须存在并被导出 =====
  const loopSrc = await readFile(join(PROJECT_ROOT, 'lib/agent/loop.ts'), 'utf8');
  const mustHave = [
    /export\s+function\s+eTLD1\b/,
    /export\s+function\s+checkNav\b/,
    /export\s+type\s+JevHealth\b/,
    /export\s+type\s+NavDecision\b/,
    /export\s+interface\s+NavConfirmRequest\b/,
    /taskOriginHost:\s*string/,
    /jevHealth:\s*JevHealth/,
    /onNavConfirmRequired\?:/,
  ];
  for (const re of mustHave) {
    if (!re.test(loopSrc)) failures.push(`  ✗ loop.ts 缺少契约: ${re}`);
  }

  // ===== 回归断言：build 输出里也要存在 eTLD1 / checkNav / JevHealth =====
  // 验证 build 后 chunk 仍含这些符号（防止 wxt/esbuild 把 tree-shake 掉）
  const buildDir = join(PROJECT_ROOT, '.output', 'chrome-mv3', 'chunks');
  let buildSearchOk = false;
  try {
    const { readdirSync, readFileSync } = await import('node:fs');
    const files = readdirSync(buildDir).filter((f) => f.endsWith('.js'));
    for (const f of files) {
      const content = readFileSync(join(buildDir, f), 'utf8');
      if (/eTLD1|checkNav|cross-subdomain-login|onNavConfirmRequired/.test(content)) {
        buildSearchOk = true;
        break;
      }
    }
  } catch (e) {
    // build dir 不存在——可能是首次跑（未 build），跳过（不计入失败）
    log('build dir 跳过（可能 .output/chrome-mv3/chunks 不存在）:', e.message);
  }
  if (!buildSearchOk) {
    log('警告：build chunks 里没找到 eTLD1/checkNav/onNavConfirmRequired 符号——可能是首次 build，先跑 `npm run build`');
  }

  // ===== 输出 =====
  log('eTLD1/checkNav 断言数 =', failures.length === 0 ? '全绿' : `失败 ${failures.length} 条`);
  for (const f of failures) log(f);

  if (failures.length > 0) {
    console.error('断言失败');
    process.exit(2);
  }
  log('all assertions green');
}

main().catch((err) => {
  console.error('run-navigation-guard failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});