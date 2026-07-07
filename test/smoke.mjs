#!/usr/bin/env node
// Offline smoke test for browser-cdp. No real Chrome required: it unit-tests the
// pure helpers (imported directly — the driver's entry guard keeps `main()` from
// running on import) and exercises the CLI surface via subprocess for the paths
// that fail fast before ever spawning a browser.
//
// Run: node test/smoke.mjs   (or `npm test`)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(here, '..', 'browser-cdp.mjs');

const mod = await import('../browser-cdp.mjs');

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { process.stdout.write(`FAIL  ${name}\n      ${e.message}\n`); process.exitCode = 1; }
}

function run(args, env = {}) {
  return spawnSync('node', [DRIVER, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

// ---- pure helpers ----

check('parseArgs splits positionals, value flags, and boolean flags', () => {
  const a = mod.parseArgs(['click', 'e-3', '--wait-nav', '--timeout', '5000']);
  assert.deepEqual(a._, ['click', 'e-3']);
  assert.equal(a.flags['wait-nav'], true);
  assert.equal(a.flags.timeout, '5000');
});

check('parseArgs treats a bare negative number as a value', () => {
  const a = mod.parseArgs(['scroll', '--by', '-200']);
  assert.equal(a.flags.by, '-200');
});

check('normalizeUrl adds https:// only when scheme is missing', () => {
  assert.equal(mod.normalizeUrl('example.com'), 'https://example.com');
  assert.equal(mod.normalizeUrl('example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(mod.normalizeUrl('http://x.io'), 'http://x.io');
  assert.equal(mod.normalizeUrl('https://x.io'), 'https://x.io');
  assert.equal(mod.normalizeUrl('about:blank'), 'about:blank');
  assert.equal(mod.normalizeUrl('file:///tmp/x.html'), 'file:///tmp/x.html');
});

check('normalizeEndpoint distinguishes ws / http / bare host', () => {
  assert.deepEqual(mod.normalizeEndpoint('ws://127.0.0.1:9222/x'), { wsEndpoint: 'ws://127.0.0.1:9222/x' });
  assert.deepEqual(mod.normalizeEndpoint('http://127.0.0.1:9222'), { browserURL: 'http://127.0.0.1:9222' });
  assert.deepEqual(mod.normalizeEndpoint('127.0.0.1:9222'), { browserURL: 'http://127.0.0.1:9222' });
});

check('validWaitUntil accepts the four puppeteer values, rejects others', () => {
  for (const v of ['load', 'domcontentloaded', 'networkidle0', 'networkidle2']) assert.equal(mod.validWaitUntil(v), v);
  assert.equal(mod.validWaitUntil('bogus'), null);
  assert.equal(mod.validWaitUntil(true), null);
});

check('resolveChrome returns an existing $BROWSER_CDP_CHROME path', () => {
  const prev = process.env.BROWSER_CDP_CHROME;
  process.env.BROWSER_CDP_CHROME = DRIVER; // any file that exists
  try { assert.equal(mod.resolveChrome(), DRIVER); }
  finally { if (prev === undefined) delete process.env.BROWSER_CDP_CHROME; else process.env.BROWSER_CDP_CHROME = prev; }
});

check('all documented commands are wired into the dispatch table', () => {
  const expected = ['launch', 'status', 'shutdown', 'new', 'list-tabs', 'navigate',
    'back', 'forward', 'reload', 'wait', 'snapshot', 'text', 'screenshot', 'logs',
    'eval', 'click', 'type', 'clear', 'fill', 'select', 'hover', 'scroll', 'press',
    'cookies', 'pdf', 'close-tab'];
  for (const c of expected) assert.ok(typeof mod.HANDLERS[c] === 'function', `missing handler: ${c}`);
});

check('renderSnapshot groups main-frame and iframe controls', () => {
  const out = mod.renderSnapshot({
    url: 'https://x.io', title: 'X', controls: [
      { ref: 'e-1', role: 'button', name: 'Go', visible: true, disabled: false, isMain: true, frameUrl: 'https://x.io' },
      { ref: 'e-2', role: 'textbox', name: 'Email', visible: true, disabled: false, isMain: false, frameUrl: 'https://frame.io/login' },
    ],
  });
  assert.match(out, /# X/);
  assert.match(out, /buttons \(1\)/);
  assert.match(out, /# iframe: https:\/\/frame\.io\/login/);
});

// ---- CLI surface (fails fast, no Chrome spawned) ----

check('help exits 0 and prints usage', () => {
  const r = run(['help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /drive Chrome over the DevTools Protocol/);
});

check('unknown command exits non-zero with a browser-cdp: error', () => {
  const r = run(['frobnicate']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /browser-cdp: unknown command/);
});

check('commands needing state fail cleanly when nothing is launched', () => {
  // Point state at an empty temp dir so no real session is picked up.
  const r = run(['navigate', 'example.com', '--port', '65535']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no session on port 65535/);
});

check('launch with a bogus $BROWSER_CDP_CHROME errors before spawning', () => {
  const r = run(['launch', '--port', '65534'], { BROWSER_CDP_CHROME: '/no/such/chrome' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /BROWSER_CDP_CHROME points to a missing file/);
});

process.stdout.write(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}\n`);
