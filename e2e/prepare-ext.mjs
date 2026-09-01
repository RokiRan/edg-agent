// Prepare the built Chrome MV3 extension for e2e testing.
// Pure Node (>=20) — no external dependencies.
//
// Steps:
//   1. Remove any previous copy at /tmp/edg-e2e-ext.
//   2. Recursively copy .output/chrome-mv3 (relative to project root) there.
//   3. Patch manifest.json to add host_permissions: ["<all_urls>"] so that
//      Puppeteer-driven tests don't have to click through Chrome's native
//      permission dialog.
//
// KNOWN GAP: because host_permissions is pre-granted here, e2e NEVER exercises
// the runtime chrome.permissions.request flow in lib/agent/loop.ts (runInPage
// catch → request → retry). That path requires manual verification: load the
// UNPATCHED .output/chrome-mv3, send a task, click 允许 in the native dialog.
//
// BROWSER: e2e must launch Chrome for Testing (~/.cache/puppeteer/chrome/…),
// NOT branded /Applications/Google Chrome — branded Chrome 137+ removed
// --load-extension support.
//   4. Print the absolute path to the prepared extension.
//
// Run from project root: `node e2e/prepare-ext.mjs`

import { rm, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(PROJECT_ROOT, '.output', 'chrome-mv3');
const TARGET_DIR = '/tmp/edg-e2e-ext';
const MANIFEST_NAME = 'manifest.json';

async function main() {
  // 1. Wipe previous copy.
  await rm(TARGET_DIR, { force: true, recursive: true });

  // 2. Recursive copy.
  await cp(SOURCE_DIR, TARGET_DIR, { recursive: true });

  // 3. Patch manifest.json with host_permissions: ["<all_urls>"].
  const manifestPath = path.join(TARGET_DIR, MANIFEST_NAME);
  const raw = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  manifest.host_permissions = ['<all_urls>'];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // 4. Report.
  // eslint-disable-next-line no-console
  console.log(TARGET_DIR);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('prepare-ext failed:', err);
  process.exit(1);
});