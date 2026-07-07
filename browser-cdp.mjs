#!/usr/bin/env node
// browser-cdp — a small CLI that drives Chrome over the DevTools Protocol.
//
// Design goals:
//   1. Self-contained. One `npm install` in this directory and it works.
//   2. Safe by default. Launches its own Chrome with an isolated
//      --user-data-dir so the user's real Chrome (profiles, cookies, logins)
//      is never touched. Optionally attaches to an existing endpoint.
//   3. Stateless invocations. Each command connects to CDP, does its thing,
//      disconnects. State (endpoint, pid, active target) lives in
//      /tmp/browser-cdp/state.json.
//
// Subcommands:
//   launch [--port N] [--headless] [--user-data-dir DIR] [--persist NAME] [--attach URL]
//   status
//   new [--url URL]
//   list-tabs
//   navigate URL [--target ID]
//   snapshot [--target ID] [--json]
//   text [--target ID]
//   screenshot [PATH] [--full] [--target ID]
//   click REF [--target ID]
//   type REF TEXT [--submit] [--target ID]
//   press KEY [--target ID]
//   eval "expr" [--target ID]
//   close-tab [--target ID]
//   shutdown
//
// Refs come from `snapshot` — each interactive element gets an "e-N" ref
// that stays valid on that page until the next snapshot or navigation.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const STATE_DIR = path.join(os.tmpdir(), 'browser-cdp');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const SCREENSHOT_DIR = path.join(STATE_DIR, 'screenshots');
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_PORT = 9222;

function die(msg, code = 1) {
  process.stderr.write(`browser-cdp: ${msg}\n`);
  process.exit(code);
}

function ensureDirs() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function clearState() {
  try { fs.unlinkSync(STATE_FILE); } catch {}
}

function isPortListening(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    import('node:net').then(({ Socket }) => {
      const socket = new Socket();
      const done = (ok) => { socket.destroy(); resolve(ok); };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  });
}

async function waitForPort(port, host, totalMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    if (await isPortListening(port, host)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args.flags[key] = next; i++; }
      else args.flags[key] = true;
    } else args._.push(a);
  }
  return args;
}

function normalizeEndpoint(raw) {
  if (!raw) return null;
  if (raw.startsWith('ws://') || raw.startsWith('wss://')) return { wsEndpoint: raw };
  if (raw.startsWith('http://') || raw.startsWith('https://')) return { browserURL: raw };
  return { browserURL: `http://${raw}` };
}

async function connect(state) {
  if (!state) die('no state — run `browser-cdp launch` first');
  const opts = normalizeEndpoint(state.endpoint);
  if (!opts) die(`bad endpoint in state: ${state.endpoint}`);
  const browser = await puppeteer.connect({ ...opts, defaultViewport: null });
  return browser;
}

async function pickTarget(browser, targetId) {
  const pages = await browser.pages();
  if (targetId) {
    for (const p of pages) {
      const id = await p.target()._targetId ?? null;
      if (id === targetId) return p;
    }
    // fall through to try by URL matching
    for (const p of pages) {
      if (p.url() === targetId) return p;
    }
    die(`target not found: ${targetId}`);
  }
  const state = loadState();
  if (state?.activeTargetId) {
    for (const p of pages) {
      const id = p.target()._targetId;
      if (id === state.activeTargetId) return p;
    }
  }
  return pages[pages.length - 1] || (await browser.newPage());
}

function shortTargetId(page) {
  return page.target()._targetId || null;
}

// ---------------- subcommands ----------------

async function cmdLaunch(args) {
  const attach = args.flags.attach;
  if (attach) {
    const endpoint = typeof attach === 'string' ? attach : `http://127.0.0.1:${DEFAULT_PORT}`;
    // Verify we can talk to it
    const test = normalizeEndpoint(endpoint);
    if (test.browserURL) {
      const url = new URL(test.browserURL);
      const ok = await isPortListening(Number(url.port) || 80, url.hostname);
      if (!ok) die(`nothing listening at ${endpoint}`);
    }
    saveState({ endpoint, chromePid: null, userDataDir: null, activeTargetId: null, attached: true });
    console.log(`Attached to ${endpoint}`);
    return;
  }

  const port = Number(args.flags.port || DEFAULT_PORT);
  const headless = args.flags.headless === true || args.flags.headless === 'true';
  // Profile selection:
  //   --user-data-dir DIR  → explicit path (advanced)
  //   --persist NAME       → ~/.browser-cdp-profiles/NAME (survives across launches — good for
  //                          "log in once, reuse the session later")
  //   default              → throwaway /tmp/browser-cdp/profile-<ts> (fresh state every launch)
  const persistName = args.flags.persist && String(args.flags.persist);
  const userDataDir = args.flags['user-data-dir']
    || (persistName
      ? path.join(os.homedir(), '.browser-cdp-profiles', persistName.replace(/[^A-Za-z0-9._-]+/g, '-'))
      : path.join(STATE_DIR, `profile-${Date.now()}`));
  fs.mkdirSync(userDataDir, { recursive: true });

  const existing = loadState();
  if (existing && existing.chromePid) {
    try { process.kill(existing.chromePid, 0); }
    catch { /* dead — ignore */ }
    try { if (await isPortListening(port)) die(`chrome already running (pid ${existing.chromePid}, endpoint ${existing.endpoint}). Use \`shutdown\` first or \`--port\` for a different port.`); } catch {}
  }
  if (await isPortListening(port)) die(`port ${port} already in use — pick a different --port or attach with --attach`);

  if (!fs.existsSync(CHROME_BIN)) die(`Chrome binary not found at ${CHROME_BIN}`);

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    '--disable-background-networking',
  ];
  if (headless) chromeArgs.push('--headless=new');

  const child = spawn(CHROME_BIN, chromeArgs, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const ok = await waitForPort(port, '127.0.0.1', 10000);
  if (!ok) die(`chrome did not start listening on ${port} within 10s`);

  const endpoint = `http://127.0.0.1:${port}`;
  saveState({
    endpoint,
    chromePid: child.pid,
    userDataDir,
    activeTargetId: null,
    attached: false,
    headless: !!headless,
    persistName: persistName || null,
  });
  console.log(JSON.stringify({
    endpoint, pid: child.pid, userDataDir,
    headless: !!headless, persist: persistName || null,
  }, null, 2));
}

async function cmdStatus() {
  const state = loadState();
  if (!state) { console.log('not launched'); return; }
  let alive = null;
  if (state.chromePid) {
    try { process.kill(state.chromePid, 0); alive = true; }
    catch { alive = false; }
  }
  let tabs = [];
  try {
    const browser = await connect(state);
    const pages = await browser.pages();
    tabs = await Promise.all(pages.map(async (p) => ({
      id: shortTargetId(p),
      url: p.url(),
      title: await p.title().catch(() => ''),
      active: shortTargetId(p) === state.activeTargetId,
    })));
    await browser.disconnect();
  } catch (e) {
    tabs = [{ error: String(e.message || e) }];
  }
  console.log(JSON.stringify({ ...state, chromeAlive: alive, tabs }, null, 2));
}

async function cmdNew(args) {
  const state = loadState();
  const browser = await connect(state);
  try {
    const page = await browser.newPage();
    if (args.flags.url) await page.goto(String(args.flags.url), { waitUntil: 'domcontentloaded', timeout: 30000 });
    const id = shortTargetId(page);
    saveState({ ...state, activeTargetId: id });
    console.log(JSON.stringify({ id, url: page.url(), title: await page.title() }, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdListTabs() {
  const state = loadState();
  const browser = await connect(state);
  try {
    const pages = await browser.pages();
    const rows = await Promise.all(pages.map(async (p) => ({
      id: shortTargetId(p),
      url: p.url(),
      title: await p.title().catch(() => ''),
      active: shortTargetId(p) === state?.activeTargetId,
    })));
    console.log(JSON.stringify(rows, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdNavigate(args) {
  const url = args._[1];
  if (!url) die('usage: navigate URL');
  const state = loadState();
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    saveState({ ...state, activeTargetId: shortTargetId(page) });
    console.log(JSON.stringify({ url: page.url(), title: await page.title() }, null, 2));
  } finally { await browser.disconnect(); }
}

// Injected in-page: number every interactive element, return summary.
async function indexAndCollect(page) {
  return page.evaluate(() => {
    const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="menuitem"], [contenteditable="true"]';
    const els = Array.from(document.querySelectorAll(sel));
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity || '1') > 0;
    };
    let counter = 0;
    const controls = [];
    for (const el of els) {
      counter += 1;
      const ref = `e-${counter}`;
      el.setAttribute('data-browser-cdp-ref', ref);
      const tag = el.tagName.toLowerCase();
      const explicitRole = el.getAttribute('role');
      const role = explicitRole
        || (tag === 'a' ? 'link'
        : tag === 'button' ? 'button'
        : tag === 'input' ? (el.getAttribute('type') === 'checkbox' ? 'checkbox' : 'textbox')
        : tag === 'textarea' ? 'textbox'
        : tag === 'select' ? 'combobox' : 'generic');
      const label = (el.getAttribute('aria-label')
        || el.getAttribute('placeholder')
        || el.getAttribute('name')
        || el.getAttribute('value')
        || el.textContent || '')
        .trim().replace(/\s+/g, ' ').slice(0, 180);
      const value = ('value' in el) ? String(el.value || '').slice(0, 180) : null;
      const href = el.href || null;
      const visible = isVisible(el);
      const disabled = Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');
      controls.push({ ref, role, tag, name: label, value, href, visible, disabled });
    }
    return {
      url: location.href,
      title: document.title,
      controls,
    };
  });
}

function renderSnapshot(snap) {
  const lines = [];
  lines.push(`# ${snap.title}`);
  lines.push(`${snap.url}`);
  lines.push('');
  const visible = snap.controls.filter((c) => c.visible && !c.disabled);
  const buckets = new Map();
  for (const c of visible) {
    const key = c.role;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }
  const order = ['textbox', 'combobox', 'checkbox', 'button', 'link', 'menuitem', 'generic'];
  for (const role of order) {
    const arr = buckets.get(role);
    if (!arr || !arr.length) continue;
    lines.push(`## ${role}s (${arr.length})`);
    for (const c of arr) {
      const bits = [c.ref, JSON.stringify(c.name || '(no label)')];
      if (c.value) bits.push(`value=${JSON.stringify(c.value)}`);
      if (c.href) bits.push(`href=${c.href}`);
      lines.push('  ' + bits.join(' '));
    }
  }
  const hiddenCount = snap.controls.length - visible.length;
  if (hiddenCount) lines.push('', `(${hiddenCount} hidden/disabled controls omitted)`);
  return lines.join('\n');
}

async function cmdSnapshot(args) {
  const state = loadState();
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target);
    saveState({ ...state, activeTargetId: shortTargetId(page) });
    const snap = await indexAndCollect(page);
    if (args.flags.json) console.log(JSON.stringify(snap, null, 2));
    else console.log(renderSnapshot(snap));
  } finally { await browser.disconnect(); }
}

async function cmdText(args) {
  const state = loadState();
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target);
    const text = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);
      for (const s of clone.querySelectorAll('script, style, noscript')) s.remove();
      return clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
    });
    console.log(text);
  } finally { await browser.disconnect(); }
}

async function cmdScreenshot(args) {
  const state = loadState();
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target);
    const outPath = args._[1]
      || path.join(SCREENSHOT_DIR, `shot-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, fullPage: args.flags.full === true || args.flags.full === 'true' });
    const stat = fs.statSync(outPath);
    console.log(JSON.stringify({ path: outPath, bytes: stat.size, url: page.url() }, null, 2));
  } finally { await browser.disconnect(); }
}

async function elementHandleByRef(page, ref) {
  const handle = await page.evaluateHandle((r) => document.querySelector(`[data-browser-cdp-ref="${r}"]`), ref);
  const el = handle.asElement();
  if (!el) die(`ref not found: ${ref} (run \`snapshot\` first to (re-)tag elements)`);
  return el;
}

async function cmdClick(args) {
  const ref = args._[1];
  if (!ref) die('usage: click REF');
  const state = loadState();
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target);
    const el = await elementHandleByRef(page, ref);
    await el.click();
    console.log(JSON.stringify({ clicked: ref, url: page.url() }, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdType(args) {
  const ref = args._[1];
  const text = args._[2];
  if (!ref || text === undefined) die('usage: type REF TEXT');
  const state = loadState();
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target);
    const el = await elementHandleByRef(page, ref);
    await el.focus();
    await el.type(text, { delay: 5 });
    if (args.flags.submit) await page.keyboard.press('Enter');
    console.log(JSON.stringify({ typed: ref, submitted: !!args.flags.submit, url: page.url() }, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdPress(args) {
  const key = args._[1];
  if (!key) die('usage: press KEY');
  const state = loadState();
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target);
    await page.keyboard.press(key);
    console.log(JSON.stringify({ pressed: key, url: page.url() }, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdEval(args) {
  const expr = args._[1];
  if (!expr) die('usage: eval "js expression"');
  const state = loadState();
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target);
    const value = await page.evaluate((src) => {
      // Wrap in a function body so a bare expression works too.
      // eslint-disable-next-line no-new-func
      return Promise.resolve(new Function(`return (async () => { return (${src}); })();`)());
    }, expr);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdCloseTab(args) {
  const state = loadState();
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target);
    const id = shortTargetId(page);
    await page.close();
    const next = state && state.activeTargetId === id ? { ...state, activeTargetId: null } : state;
    saveState(next);
    console.log(JSON.stringify({ closed: id }, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdShutdown() {
  const state = loadState();
  if (!state) { console.log('not launched'); return; }
  if (state.attached) {
    // Just drop our reference; leave the user's Chrome alone.
    clearState();
    console.log('detached from attached endpoint (Chrome left running)');
    return;
  }
  if (state.chromePid) {
    try { process.kill(state.chromePid, 'SIGTERM'); }
    catch { /* already dead */ }
  }
  clearState();
  console.log('chrome shut down');
}

// ---------------- main ----------------

const HELP = `browser-cdp — drive Chrome over the DevTools Protocol

Usage:
  browser-cdp launch [--port 9222] [--headless] [--persist NAME] [--user-data-dir DIR] [--attach URL]
    Default is WINDOWED with a throwaway profile. --headless hides the window;
    --persist NAME uses ~/.browser-cdp-profiles/NAME so cookies/logins survive across
    launches.
  browser-cdp status
  browser-cdp new [--url URL]
  browser-cdp list-tabs
  browser-cdp navigate URL [--target ID]
  browser-cdp snapshot [--target ID] [--json]
  browser-cdp text [--target ID]
  browser-cdp screenshot [PATH] [--full] [--target ID]
  browser-cdp click REF [--target ID]
  browser-cdp type REF TEXT [--submit] [--target ID]
  browser-cdp press KEY [--target ID]
  browser-cdp eval "expr" [--target ID]
  browser-cdp close-tab [--target ID]
  browser-cdp shutdown
`;

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP); return;
  }
  const handlers = {
    launch: cmdLaunch, status: cmdStatus, new: cmdNew, 'list-tabs': cmdListTabs,
    navigate: cmdNavigate, snapshot: cmdSnapshot, text: cmdText,
    screenshot: cmdScreenshot, click: cmdClick, type: cmdType, press: cmdPress,
    eval: cmdEval, 'close-tab': cmdCloseTab, shutdown: cmdShutdown,
  };
  const fn = handlers[cmd];
  if (!fn) die(`unknown command: ${cmd}\n${HELP}`);
  try { await fn(args); }
  catch (e) { die(e && e.stack ? e.stack : String(e)); }
}

main();
