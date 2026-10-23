import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startDemo } from '../demo/server.mjs';

const demo = await startDemo();
const browser = await chromium.launch({ headless: true }).catch(async error => { await demo.close(); throw error; });
const context = await browser.newContext();
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const report = { browser: browser.version(), scenarios: [] };
try {
  await page.goto(demo.url);
  await page.getByRole('button', { name: 'Start / reconnect', exact: true }).click();
  await page.waitForFunction(() => window.demo?.metrics().state === 'live');
  await page.getByRole('button', { name: 'Publish one', exact: true }).click();
  await page.waitForFunction(() => window.demo.metrics().value === 1 && window.demo.metrics().cursor !== null);
  report.scenarios.push('authenticated cross-origin stream and first checkpoint');

  await page.getByRole('button', { name: 'Disconnect + publish three', exact: true }).click();
  await page.waitForFunction(() => window.demo.metrics().value === 4 && window.demo.metrics().connections.includes('b') && window.demo.metrics().state === 'live');
  assert.equal(await page.evaluate(() => window.demo.metrics().duplicates), 0);
  report.scenarios.push('disconnect, three retained events, ordered replay through relay B');

  await page.getByRole('button', { name: 'Fail next checkpoint + publish', exact: true }).click();
  await page.waitForFunction(() => window.demo.metrics().value === 5 && window.demo.metrics().duplicates === 1 && window.demo.metrics().state === 'live');
  assert.equal(await page.evaluate(() => window.demo.metrics().handled), 6);
  report.scenarios.push('checkpoint failure repeats handler effect exactly as documented');

  await page.getByRole('button', { name: 'Offline + expire history', exact: true }).click();
  await page.waitForFunction(() => window.demo.metrics().lastResult?.state === 'resync');
  assert.equal(await page.evaluate(() => window.demo.metrics().value), 5);
  report.scenarios.push('expired cursor yields terminal resync without silently skipping state');

  await page.getByRole('button', { name: 'Apply snapshot + resume', exact: true }).click();
  await page.waitForFunction(() => window.demo.metrics().state === 'live' && window.demo.metrics().value === 25);
  await page.getByRole('button', { name: 'Publish one', exact: true }).click();
  await page.waitForFunction(() => window.demo.metrics().value === 26);
  report.scenarios.push('install matching snapshot and cursor, then resume live processing');

  await page.getByRole('button', { name: 'Logout / clear cursor', exact: true }).click();
  await page.waitForFunction(() => window.demo.metrics().state === 'closed' && window.demo.metrics().cursor === null);
  const before = await page.evaluate(() => window.demo.metrics().connections.length);
  await page.getByRole('button', { name: 'Publish one', exact: true }).click();
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.demo.metrics());
  assert.equal(after.value, 0); assert.equal(after.handled, 0); assert.equal(after.connections.length, before);
  const keys = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('browser-sse-relay:failure-demo:')));
  assert.deepEqual(keys, []);
  report.scenarios.push('logout clears account cursor and blocks stale callbacks/reconnect');
  assert.deepEqual(pageErrors, []);
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/browser-smoke.png', fullPage: true });
  await writeFile('output/playwright/browser-smoke.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close(); await browser.close(); await demo.close();
}
