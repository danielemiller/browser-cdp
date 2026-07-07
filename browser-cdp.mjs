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
//      /tmp/browser-cdp/state.json (active session) mirrored per-port under
//      /tmp/browser-cdp/sessions/<port>.json for multi-session use.
//
// Subcommands:
//   launch [--port N] [--headless] [--user-data-dir DIR] [--persist NAME]
//          [--attach URL] [--download-dir DIR]
//   status [--all] [--port N]
//   new [--url URL] [--port N]
//   list-tabs [--port N]
//   navigate URL [--wait UNTIL] [--timeout MS] [--target ID] [--port N]
//   back | forward | reload [--timeout MS] [--target ID] [--port N]
//   wait [--selector CSS | --text S | --url S | --idle | --stable [MS] | --ms N] [--timeout MS]
//   snapshot [--target ID] [--json] [--port N]
//   text [--target ID] [--port N]
//   screenshot [PATH] [--full] [--ref e-N] [--target ID] [--port N]
//   click REF [--wait-nav] [--wait-selector CSS] [--wait-text S] [--timeout MS] [--target ID]
//   type REF TEXT [--clear] [--submit] [--target ID]
//   clear REF [--target ID]
//   fill REF TEXT [--target ID]
//   select REF VALUE [VALUE...] [--target ID]
//   hover REF [--target ID]
//   scroll [--ref e-N | --bottom | --top | --by N] [--target ID]
//   press KEY [--target ID]
//   eval "expr" [--target ID]           (CSP-safe: runs via raw CDP Runtime.evaluate)
//   logs [--for MS] [--console] [--network] [--errors] [--reload | --navigate URL] [--target ID]
//   cookies dump [PATH] | load PATH | clear [--target ID]
//   pdf [PATH] [--target ID]            (headless only)
//   close-tab [--target ID]
//   shutdown [--port N] [--all]
//
// Refs come from `snapshot` — each interactive element (including those inside
// iframes) gets an "e-N" ref that stays valid on that page until the next
// snapshot or navigation.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const STATE_DIR = path.join(os.tmpdir(), 'browser-cdp');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const SESSIONS_DIR = path.join(STATE_DIR, 'sessions');
const SCREENSHOT_DIR = path.join(STATE_DIR, 'screenshots');
const DEFAULT_PORT = 9222;

// Chrome binary candidates, checked in order after env overrides.
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  path.join(os.homedir(), 'Applications/Chromium.app/Contents/MacOS/Chromium'),
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const WAIT_UNTILS = new Set(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']);

function die(msg, code = 1) {
  process.stderr.write(`browser-cdp: ${msg}\n`);
  process.exit(code);
}

function ensureDirs() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truthy = (v) => v === true || v === 'true';

// ---------------- state (active + per-port mirror) ----------------

function sessionFile(port) {
  return path.join(SESSIONS_DIR, `${port}.json`);
}

// port omitted → active session (state.json). port given → that session's mirror.
function loadState(port) {
  try {
    const file = port ? sessionFile(port) : STATE_FILE;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Writes the per-port mirror (when the state has a port) AND the active pointer,
// so bare (portless) commands keep operating on the most recently touched session.
function saveState(state) {
  ensureDirs();
  const json = JSON.stringify(state, null, 2);
  if (state && state.port) fs.writeFileSync(sessionFile(state.port), json);
  fs.writeFileSync(STATE_FILE, json);
}

function clearState(port) {
  if (port) {
    try { fs.unlinkSync(sessionFile(port)); } catch {}
    // If the active pointer referenced this port, drop it too.
    const active = loadState();
    if (active && active.port === port) { try { fs.unlinkSync(STATE_FILE); } catch {} }
    return;
  }
  const active = loadState();
  if (active && active.port) { try { fs.unlinkSync(sessionFile(active.port)); } catch {} }
  try { fs.unlinkSync(STATE_FILE); } catch {}
}

function listSessions() {
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch {}
  const out = [];
  for (const f of files) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'))); } catch {}
  }
  return out;
}

// Resolve the state a command should act on: --port N targets a specific
// session (must exist); otherwise the active session.
function resolveState(args) {
  const port = args.flags.port ? Number(args.flags.port) : null;
  if (port) {
    const s = loadState(port);
    if (!s) die(`no session on port ${port} — launch with --port ${port} first`);
    return s;
  }
  return loadState();
}

// ---------------- net helpers ----------------

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
    await sleep(150);
  }
  return false;
}

// ---------------- arg parsing ----------------

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      // A value follows unless the next token is another flag. `-100` (a bare
      // negative number) is treated as a value, not a flag.
      if (next !== undefined && !next.startsWith('--')) { args.flags[key] = next; i++; }
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

// Prepend https:// when a navigation target has no scheme (so `navigate
// example.com` works, not just `navigate https://example.com`).
function normalizeUrl(u) {
  if (!u) return u;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) return u; // has a scheme (http:, https:, about:, data:, file:, chrome:)
  return `https://${u}`;
}

function validWaitUntil(v) {
  if (typeof v === 'string' && WAIT_UNTILS.has(v)) return v;
  return null;
}

// Resolve the Chrome/Chromium binary: explicit env override → macOS defaults.
function resolveChrome() {
  const dedicated = process.env.BROWSER_CDP_CHROME;
  if (dedicated) {
    if (fs.existsSync(dedicated)) return dedicated;
    die(`$BROWSER_CDP_CHROME points to a missing file: ${dedicated}`);
  }
  for (const env of [process.env.CHROME_BIN, process.env.CHROME_PATH]) {
    if (env && fs.existsSync(env)) return env;
  }
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  die('no Chrome/Chromium binary found — set $BROWSER_CDP_CHROME to your browser executable');
}

// ---------------- CDP connection + targets ----------------

async function connect(state) {
  if (!state) die('no state — run `browser-cdp launch` first');
  const opts = normalizeEndpoint(state.endpoint);
  if (!opts) die(`bad endpoint in state: ${state.endpoint}`);
  return puppeteer.connect({ ...opts, defaultViewport: null });
}

function targetIdOf(page) {
  try { return page.target()._targetId || null; }
  catch { return null; }
}

async function pickTarget(browser, targetId, state) {
  const pages = await browser.pages();
  if (targetId) {
    for (const p of pages) if (targetIdOf(p) === targetId) return p;
    for (const p of pages) if (p.url() === targetId) return p; // fall back to URL match
    die(`target not found: ${targetId}`);
  }
  if (state?.activeTargetId) {
    for (const p of pages) if (targetIdOf(p) === state.activeTargetId) return p;
  }
  return pages[pages.length - 1] || (await browser.newPage());
}

// Find an element by its snapshot ref across ALL frames (top document +
// iframes). Returns the owning frame (needed for frame.select) and the handle.
async function resolveRef(page, ref) {
  const selector = `[data-browser-cdp-ref="${ref}"]`;
  for (const frame of page.frames()) {
    let handle = null;
    try { handle = await frame.$(selector); } catch { handle = null; }
    if (handle) return { frame, handle, selector };
  }
  die(`ref not found: ${ref} (run \`snapshot\` first to (re-)tag elements)`);
}

// Resolve when the DOM settles: fires once mutations stop for `settleMs`, with
// a hard cap so it always returns.
async function waitStable(page, settleMs, capMs) {
  await page.evaluate((settle, cap) => new Promise((resolve) => {
    let timer = setTimeout(finish, settle);
    const hard = setTimeout(finish, cap);
    const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, settle); });
    function finish() { try { obs.disconnect(); } catch {} clearTimeout(timer); clearTimeout(hard); resolve(); }
    try { obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true }); }
    catch { finish(); }
  }), settleMs, capMs);
}

// ---------------- subcommands ----------------

async function cmdLaunch(args) {
  const attach = args.flags.attach;
  if (attach) {
    const endpoint = typeof attach === 'string' ? attach : `http://127.0.0.1:${DEFAULT_PORT}`;
    const test = normalizeEndpoint(endpoint);
    let port = null;
    if (test.browserURL) {
      const url = new URL(test.browserURL);
      port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
      const ok = await isPortListening(port, url.hostname);
      if (!ok) die(`nothing listening at ${endpoint}`);
    }
    saveState({ endpoint, chromePid: null, userDataDir: null, activeTargetId: null, attached: true, port });
    console.log(`Attached to ${endpoint}`);
    return;
  }

  const port = Number(args.flags.port || DEFAULT_PORT);
  const headless = truthy(args.flags.headless);
  // Profile selection:
  //   --user-data-dir DIR  → explicit path (advanced)
  //   --persist NAME       → ~/.browser-cdp-profiles/NAME (survives across launches)
  //   default              → throwaway /tmp/browser-cdp/profile-<ts>
  const persistName = args.flags.persist && String(args.flags.persist);
  const userDataDir = args.flags['user-data-dir']
    || (persistName
      ? path.join(os.homedir(), '.browser-cdp-profiles', persistName.replace(/[^A-Za-z0-9._-]+/g, '-'))
      : path.join(STATE_DIR, `profile-${Date.now()}`));
  fs.mkdirSync(userDataDir, { recursive: true });

  const downloadDir = args.flags['download-dir'] ? String(args.flags['download-dir']) : null;
  if (downloadDir) fs.mkdirSync(downloadDir, { recursive: true });

  const existing = loadState(port);
  if (existing && existing.chromePid) {
    try { process.kill(existing.chromePid, 0); if (await isPortListening(port)) die(`chrome already running on port ${port} (pid ${existing.chromePid}). Use \`shutdown --port ${port}\` first, or a different --port.`); }
    catch { /* dead — ignore */ }
  }
  if (await isPortListening(port)) die(`port ${port} already in use — pick a different --port or attach with --attach`);

  const chromeBin = resolveChrome();

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    '--disable-background-networking',
  ];
  if (headless) chromeArgs.push('--headless=new');

  const child = spawn(chromeBin, chromeArgs, { detached: true, stdio: 'ignore' });
  child.unref();

  const ok = await waitForPort(port, '127.0.0.1', 10000);
  if (!ok) die(`chrome did not start listening on ${port} within 10s`);

  const endpoint = `http://127.0.0.1:${port}`;
  saveState({
    endpoint, chromePid: child.pid, userDataDir, activeTargetId: null,
    attached: false, headless, persistName: persistName || null, port, downloadDir,
  });

  // Best-effort: point downloads at downloadDir (persists for the browser).
  if (downloadDir) {
    try {
      const browser = await connect({ endpoint });
      const client = await browser.target().createCDPSession();
      await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir }).catch(() => {});
      await client.detach().catch(() => {});
      await browser.disconnect();
    } catch { /* non-fatal */ }
  }

  console.log(JSON.stringify({
    endpoint, pid: child.pid, userDataDir, headless, persist: persistName || null,
    port, chrome: chromeBin, downloadDir: downloadDir || null,
  }, null, 2));
}

async function cmdStatus(args) {
  if (args.flags.all) {
    const sessions = listSessions();
    const rows = await Promise.all(sessions.map(async (s) => {
      let alive = null;
      if (s.chromePid) { try { process.kill(s.chromePid, 0); alive = true; } catch { alive = false; } }
      return { port: s.port, endpoint: s.endpoint, headless: !!s.headless, persist: s.persistName || null, chromeAlive: alive };
    }));
    console.log(JSON.stringify({ sessions: rows }, null, 2));
    return;
  }
  const state = resolveState(args);
  if (!state) { console.log('not launched'); return; }
  let alive = null;
  if (state.chromePid) { try { process.kill(state.chromePid, 0); alive = true; } catch { alive = false; } }
  let tabs = [];
  try {
    const browser = await connect(state);
    const pages = await browser.pages();
    tabs = await Promise.all(pages.map(async (p) => ({
      id: targetIdOf(p), url: p.url(), title: await p.title().catch(() => ''),
      active: targetIdOf(p) === state.activeTargetId,
    })));
    await browser.disconnect();
  } catch (e) {
    tabs = [{ error: String(e.message || e) }];
  }
  console.log(JSON.stringify({ ...state, chromeAlive: alive, tabs }, null, 2));
}

async function cmdNew(args) {
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const page = await browser.newPage();
    if (args.flags.url) await page.goto(normalizeUrl(String(args.flags.url)), { waitUntil: 'domcontentloaded', timeout: 30000 });
    const id = targetIdOf(page);
    saveState({ ...state, activeTargetId: id });
    console.log(JSON.stringify({ id, url: page.url(), title: await page.title() }, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdListTabs(args) {
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const pages = await browser.pages();
    const rows = await Promise.all(pages.map(async (p) => ({
      id: targetIdOf(p), url: p.url(), title: await p.title().catch(() => ''),
      active: targetIdOf(p) === state?.activeTargetId,
    })));
    console.log(JSON.stringify(rows, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdNavigate(args) {
  const url = args._[1];
  if (!url) die('usage: navigate URL [--wait UNTIL] [--timeout MS]');
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target, state);
    const waitUntil = validWaitUntil(args.flags.wait) || 'domcontentloaded';
    const timeout = Number(args.flags.timeout) || 45000;
    await page.goto(normalizeUrl(url), { waitUntil, timeout });
    saveState({ ...state, activeTargetId: targetIdOf(page) });
    console.log(JSON.stringify({ url: page.url(), title: await page.title() }, null, 2));
  } finally { await browser.disconnect(); }
}

function makeHistoryCmd(kind) {
  return async function (args) {
    const state = resolveState(args);
    const browser = await connect(state);
    try {
      const page = await pickTarget(browser, args.flags.target, state);
      const opts = { waitUntil: 'domcontentloaded', timeout: Number(args.flags.timeout) || 30000 };
      if (kind === 'reload') await page.reload(opts);
      else if (kind === 'back') await page.goBack(opts);
      else await page.goForward(opts);
      saveState({ ...state, activeTargetId: targetIdOf(page) });
      console.log(JSON.stringify({ [kind]: true, url: page.url(), title: await page.title().catch(() => '') }, null, 2));
    } finally { await browser.disconnect(); }
  };
}

async function cmdWait(args) {
  const state = resolveState(args);
  const timeout = Number(args.flags.timeout) || 15000;
  const f = args.flags;
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, f.target, state);
    if (f.ms !== undefined) {
      const ms = Number(f.ms) || 0;
      await sleep(ms);
      console.log(JSON.stringify({ waited_ms: ms }));
    } else if (typeof f.selector === 'string') {
      await page.waitForSelector(f.selector, { timeout });
      console.log(JSON.stringify({ selector: f.selector, found: true }));
    } else if (typeof f.text === 'string') {
      await page.waitForFunction((t) => document.body && document.body.innerText.includes(t), { timeout }, f.text);
      console.log(JSON.stringify({ text: f.text, found: true }));
    } else if (typeof f.url === 'string') {
      await page.waitForFunction((u) => location.href.includes(u), { timeout }, f.url);
      console.log(JSON.stringify({ url: page.url() }));
    } else if (f.idle) {
      await page.waitForNetworkIdle({ idleTime: 500, timeout });
      console.log(JSON.stringify({ idle: true }));
    } else if (f.stable) {
      const settle = typeof f.stable === 'string' ? Number(f.stable) : 400;
      await waitStable(page, settle > 0 ? settle : 400, timeout);
      console.log(JSON.stringify({ stable: true }));
    } else {
      die('usage: wait [--selector CSS | --text S | --url S | --idle | --stable [MS] | --ms N] [--timeout MS]');
    }
  } finally { await browser.disconnect(); }
}

// Injected per-frame: number every interactive element (continuing from
// `startAt` so refs are unique across frames), return summary + next counter.
function collectInFrame(startAt) {
  const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="menuitem"], [contenteditable="true"]';
  const els = Array.from(document.querySelectorAll(sel));
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0
      && style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || '1') > 0;
  };
  let counter = startAt;
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
  return { controls, nextAt: counter, frameUrl: location.href, frameTitle: document.title };
}

async function indexAndCollect(page) {
  const controls = [];
  let running = 0;
  let mainUrl = page.url();
  let mainTitle = '';
  for (const frame of page.frames()) {
    let res;
    try { res = await frame.evaluate(collectInFrame, running); }
    catch { continue; } // detached / inaccessible frame — skip
    running = res.nextAt;
    const isMain = frame === page.mainFrame();
    if (isMain) { mainUrl = res.frameUrl; mainTitle = res.frameTitle; }
    for (const c of res.controls) controls.push({ ...c, frameUrl: res.frameUrl, isMain });
  }
  return { url: mainUrl, title: mainTitle, controls };
}

function renderControlGroup(lines, controls) {
  const buckets = new Map();
  for (const c of controls) {
    if (!buckets.has(c.role)) buckets.set(c.role, []);
    buckets.get(c.role).push(c);
  }
  const order = ['textbox', 'combobox', 'checkbox', 'button', 'link', 'menuitem', 'generic'];
  const roles = [...order.filter((r) => buckets.has(r)), ...[...buckets.keys()].filter((r) => !order.includes(r))];
  for (const role of roles) {
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
}

function renderSnapshot(snap) {
  const lines = [];
  lines.push(`# ${snap.title}`);
  lines.push(`${snap.url}`);
  lines.push('');
  const visible = snap.controls.filter((c) => c.visible && !c.disabled);
  const main = visible.filter((c) => c.isMain);
  renderControlGroup(lines, main);
  // Group iframe controls by their frame URL.
  const frames = new Map();
  for (const c of visible) {
    if (c.isMain) continue;
    if (!frames.has(c.frameUrl)) frames.set(c.frameUrl, []);
    frames.get(c.frameUrl).push(c);
  }
  for (const [url, arr] of frames) {
    lines.push('', `# iframe: ${url} (${arr.length})`);
    renderControlGroup(lines, arr);
  }
  const hiddenCount = snap.controls.length - visible.length;
  if (hiddenCount) lines.push('', `(${hiddenCount} hidden/disabled controls omitted)`);
  return lines.join('\n');
}

async function cmdSnapshot(args) {
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target, state);
    saveState({ ...state, activeTargetId: targetIdOf(page) });
    const snap = await indexAndCollect(page);
    if (args.flags.json) console.log(JSON.stringify(snap, null, 2));
    else console.log(renderSnapshot(snap));
  } finally { await browser.disconnect(); }
}

async function cmdText(args) {
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target, state);
    const parts = [];
    for (const frame of page.frames()) {
      let t = '';
      try {
        t = await frame.evaluate(() => {
          if (!document.body) return '';
          const clone = document.body.cloneNode(true);
          for (const s of clone.querySelectorAll('script, style, noscript')) s.remove();
          return clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
        });
      } catch { continue; }
      if (!t) continue;
      if (frame === page.mainFrame()) parts.unshift(t);
      else parts.push(`\n--- iframe: ${frame.url()} ---\n${t}`);
    }
    console.log(parts.join('\n'));
  } finally { await browser.disconnect(); }
}

async function cmdScreenshot(args) {
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target, state);
    const outPath = args._[1] || path.join(SCREENSHOT_DIR, `shot-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    if (typeof args.flags.ref === 'string') {
      const { handle } = await resolveRef(page, args.flags.ref);
      await handle.screenshot({ path: outPath });
    } else {
      await page.screenshot({ path: outPath, fullPage: truthy(args.flags.full) });
    }
    const stat = fs.statSync(outPath);
    console.log(JSON.stringify({ path: outPath, bytes: stat.size, url: page.url() }, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdClick(args) {
  const ref = args._[1];
  if (!ref) die('usage: click REF [--wait-nav] [--wait-selector CSS] [--wait-text S]');
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target, state);
    const { handle } = await resolveRef(page, ref);
    const timeout = Number(args.flags.timeout) || 15000;
    if (args.flags['wait-nav']) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }).catch(() => {}),
        handle.click(),
      ]);
    } else {
      await handle.click();
    }
    if (typeof args.flags['wait-selector'] === 'string') {
      await page.waitForSelector(args.flags['wait-selector'], { timeout }).catch(() => {});
    }
    if (typeof args.flags['wait-text'] === 'string') {
      await page.waitForFunction((t) => document.body && document.body.innerText.includes(t), { timeout }, args.flags['wait-text']).catch(() => {});
    }
    console.log(JSON.stringify({ clicked: ref, url: page.url() }, null, 2));
  } finally { await browser.disconnect(); }
}

// Empty a text field / contenteditable in the page and fire input+change.
function clearFieldInPage(el) {
  if ('value' in el) {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

async function cmdType(args) {
  const ref = args._[1];
  const text = args._[2];
  if (!ref || text === undefined) die('usage: type REF TEXT [--clear] [--submit]');
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target, state);
    const { handle } = await resolveRef(page, ref);
    await handle.focus();
    if (args.flags.clear) await handle.evaluate(clearFieldInPage);
    await handle.type(text, { delay: 5 });
    if (args.flags.submit) await page.keyboard.press('Enter');
    console.log(JSON.stringify({ typed: ref, cleared: !!args.flags.clear, submitted: !!args.flags.submit, url: page.url() }, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdClear(args) {
  const ref = args._[1];
  if (!ref) die('usage: clear REF');
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target, state);
    const { handle } = await resolveRef(page, ref);
    await handle.evaluate(clearFieldInPage);
    console.log(JSON.stringify({ cleared: ref, url: page.url() }, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdFill(args) {
  const ref = args._[1];
  const text = args._[2];
  if (!ref || text === undefined) die('usage: fill REF TEXT');
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target, state);
    const { handle } = await resolveRef(page, ref);
    await handle.evaluate((el, val) => {
      if ('value' in el) {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, text);
    console.log(JSON.stringify({ filled: ref, url: page.url() }, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdSelect(args) {
  const ref = args._[1];
  const values = args._.slice(2).map(String);
  if (!ref || !values.length) die('usage: select REF VALUE [VALUE...]');
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target, state);
    const { frame, selector } = await resolveRef(page, ref);
    const selected = await frame.select(selector, ...values);
    console.log(JSON.stringify({ selected }, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdHover(args) {
  const ref = args._[1];
  if (!ref) die('usage: hover REF');
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target, state);
    const { handle } = await resolveRef(page, ref);
    await handle.hover();
    console.log(JSON.stringify({ hovered: ref, url: page.url() }, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdScroll(args) {
  const state = resolveState(args);
  const f = args.flags;
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, f.target, state);
    if (typeof f.ref === 'string') {
      const { handle } = await resolveRef(page, f.ref);
      await handle.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
      console.log(JSON.stringify({ scrolledTo: f.ref }));
    } else if (f.bottom) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      console.log(JSON.stringify({ scrolled: 'bottom' }));
    } else if (f.top) {
      await page.evaluate(() => window.scrollTo(0, 0));
      console.log(JSON.stringify({ scrolled: 'top' }));
    } else if (f.by !== undefined) {
      const n = Number(f.by) || 0;
      await page.evaluate((y) => window.scrollBy(0, y), n);
      console.log(JSON.stringify({ scrolledBy: n }));
    } else {
      die('usage: scroll [--ref e-N | --bottom | --top | --by N]');
    }
  } finally { await browser.disconnect(); }
}

async function cmdPress(args) {
  const key = args._[1];
  if (!key) die('usage: press KEY');
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target, state);
    await page.keyboard.press(key);
    console.log(JSON.stringify({ pressed: key, url: page.url() }, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdEval(args) {
  const expr = args._[1];
  if (!expr) die('usage: eval "js expression"');
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target, state);
    // Raw CDP Runtime.evaluate runs in the inspector context, so it is NOT
    // subject to the page's `unsafe-eval` CSP (unlike page.evaluate(new Function)).
    const client = await page.createCDPSession();
    try {
      await client.send('Runtime.enable').catch(() => {});
      const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
        expression: `(async () => (${expr}))()`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
        includeCommandLineAPI: true,
      });
      if (exceptionDetails) {
        die(exceptionDetails.exception?.description || exceptionDetails.text || 'eval error');
      }
      if (result.type === 'undefined') { console.log('undefined'); return; }
      const v = 'value' in result ? result.value : undefined;
      if (v === undefined) { console.log(result.description || `(non-serializable ${result.subtype || result.type})`); return; }
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    } finally { await client.detach().catch(() => {}); }
  } finally { await browser.disconnect(); }
}

async function cmdLogs(args) {
  const state = resolveState(args);
  const f = args.flags;
  const forMs = Number(f.for) || 3000;
  const only = !!(f.console || f.network || f.errors);
  const inc = (k) => (only ? !!f[k] : true);
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, f.target, state);
    const consoleMsgs = [];
    const errors = [];
    const requests = [];
    const reqIds = new Map();
    let n = 0;
    const MAXC = 500; const MAXR = 1000; const MAXE = 200;
    const onConsole = (msg) => { consoleMsgs.push({ type: msg.type(), text: msg.text(), location: msg.location?.() }); if (consoleMsgs.length > MAXC) consoleMsgs.shift(); };
    const onErr = (e) => { errors.push({ message: String(e?.message || e), stack: e?.stack }); if (errors.length > MAXE) errors.shift(); };
    const onReq = (r) => { const id = `r${++n}`; reqIds.set(r, id); requests.push({ id, method: r.method(), url: r.url(), resourceType: r.resourceType() }); if (requests.length > MAXR) requests.shift(); };
    const onResp = (resp) => { const rec = requests.find((x) => x.id === reqIds.get(resp.request())); if (rec) { rec.status = resp.status(); rec.ok = resp.ok(); } };
    const onFail = (r) => { const rec = requests.find((x) => x.id === reqIds.get(r)); if (rec) { rec.failure = r.failure()?.errorText; rec.ok = false; } };
    page.on('console', onConsole);
    page.on('pageerror', onErr);
    page.on('request', onReq);
    page.on('response', onResp);
    page.on('requestfailed', onFail);
    if (typeof f.navigate === 'string') await page.goto(normalizeUrl(f.navigate), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    else if (f.reload) await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(forMs);
    page.off('console', onConsole);
    page.off('pageerror', onErr);
    page.off('request', onReq);
    page.off('response', onResp);
    page.off('requestfailed', onFail);
    const out = { url: page.url() };
    if (inc('console')) out.console = consoleMsgs;
    if (inc('errors')) out.errors = errors;
    if (inc('network')) out.requests = requests;
    console.log(JSON.stringify(out, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdCookies(args) {
  const sub = args._[1];
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target, state);
    const client = await page.createCDPSession();
    try {
      await client.send('Network.enable').catch(() => {});
      if (sub === 'dump') {
        const { cookies } = await client.send('Network.getAllCookies');
        const out = JSON.stringify(cookies, null, 2);
        const p = args._[2];
        if (p) { fs.writeFileSync(p, out); console.log(JSON.stringify({ path: p, count: cookies.length })); }
        else console.log(out);
      } else if (sub === 'load') {
        const p = args._[2];
        if (!p) die('usage: cookies load PATH');
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        const cookies = (Array.isArray(raw) ? raw : raw.cookies || []).map((c) => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
          expires: c.expires, url: c.url,
        }));
        await client.send('Network.setCookies', { cookies });
        console.log(JSON.stringify({ loaded: cookies.length }));
      } else if (sub === 'clear') {
        await client.send('Network.clearBrowserCookies');
        console.log(JSON.stringify({ cleared: true }));
      } else {
        die('usage: cookies dump [PATH] | load PATH | clear');
      }
    } finally { await client.detach().catch(() => {}); }
  } finally { await browser.disconnect(); }
}

async function cmdPdf(args) {
  const state = resolveState(args);
  if (!state.headless && !state.attached) die('pdf requires a headless browser — relaunch with --headless (Chrome only renders PDFs headless)');
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target, state);
    const outPath = args._[1] || path.join(SCREENSHOT_DIR, `page-${Date.now()}.pdf`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.pdf({ path: outPath, printBackground: true });
    const stat = fs.statSync(outPath);
    console.log(JSON.stringify({ path: outPath, bytes: stat.size, url: page.url() }, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdCloseTab(args) {
  const state = resolveState(args);
  const browser = await connect(state);
  try {
    const page = await pickTarget(browser, args.flags.target, state);
    const id = targetIdOf(page);
    await page.close();
    const next = state && state.activeTargetId === id ? { ...state, activeTargetId: null } : state;
    saveState(next);
    console.log(JSON.stringify({ closed: id }, null, 2));
  } finally { await browser.disconnect(); }
}

async function cmdShutdown(args) {
  if (args.flags.all) {
    const sessions = listSessions();
    const killed = [];
    for (const s of sessions) {
      if (s.chromePid && !s.attached) { try { process.kill(s.chromePid, 'SIGTERM'); } catch {} }
      if (s.port) { try { fs.unlinkSync(sessionFile(s.port)); } catch {} }
      killed.push(s.port || s.endpoint);
    }
    try { fs.unlinkSync(STATE_FILE); } catch {}
    console.log(JSON.stringify({ shutdown: killed }, null, 2));
    return;
  }
  const port = args.flags.port ? Number(args.flags.port) : null;
  const state = resolveState(args);
  if (!state) { console.log('not launched'); return; }
  if (state.attached) {
    clearState(port);
    console.log('detached from attached endpoint (Chrome left running)');
    return;
  }
  if (state.chromePid) { try { process.kill(state.chromePid, 'SIGTERM'); } catch {} }
  clearState(port || state.port);
  console.log('chrome shut down');
}

// ---------------- main ----------------

const HELP = `browser-cdp — drive Chrome over the DevTools Protocol

Launch / session:
  browser-cdp launch [--port 9222] [--headless] [--persist NAME] [--user-data-dir DIR]
                     [--attach URL] [--download-dir DIR]
      Default is WINDOWED with a throwaway profile. --headless hides the window;
      --persist NAME uses ~/.browser-cdp-profiles/NAME so cookies/logins survive.
      Chrome binary: $BROWSER_CDP_CHROME overrides autodetection.
  browser-cdp status [--all] [--port N]
  browser-cdp shutdown [--port N] [--all]

Tabs / navigation:
  browser-cdp new [--url URL]
  browser-cdp list-tabs
  browser-cdp navigate URL [--wait load|domcontentloaded|networkidle0|networkidle2] [--timeout MS]
  browser-cdp back | forward | reload [--timeout MS]
  browser-cdp wait [--selector CSS | --text S | --url S | --idle | --stable [MS] | --ms N] [--timeout MS]

Reading:
  browser-cdp snapshot [--json]          tag interactive elements e-1..e-N (incl. iframes)
  browser-cdp text                        visible page text (all frames)
  browser-cdp screenshot [PATH] [--full] [--ref e-N]
  browser-cdp logs [--for MS] [--console] [--network] [--errors] [--reload | --navigate URL]
  browser-cdp eval "expr"                 run JS via CDP (CSP-safe)

Interaction (REF comes from the latest snapshot):
  browser-cdp click REF [--wait-nav] [--wait-selector CSS] [--wait-text S]
  browser-cdp type REF TEXT [--clear] [--submit]
  browser-cdp clear REF
  browser-cdp fill REF TEXT
  browser-cdp select REF VALUE [VALUE...]
  browser-cdp hover REF
  browser-cdp scroll [--ref e-N | --bottom | --top | --by N]
  browser-cdp press KEY
  browser-cdp close-tab

Session portability:
  browser-cdp cookies dump [PATH] | load PATH | clear
  browser-cdp pdf [PATH]                  headless only

Global: most commands accept [--target TAB_ID] and [--port N].
`;

const HANDLERS = {
  launch: cmdLaunch, status: cmdStatus, shutdown: cmdShutdown,
  new: cmdNew, 'list-tabs': cmdListTabs, navigate: cmdNavigate,
  back: makeHistoryCmd('back'), forward: makeHistoryCmd('forward'), reload: makeHistoryCmd('reload'),
  wait: cmdWait, snapshot: cmdSnapshot, text: cmdText, screenshot: cmdScreenshot,
  logs: cmdLogs, eval: cmdEval, click: cmdClick, type: cmdType, clear: cmdClear,
  fill: cmdFill, select: cmdSelect, hover: cmdHover, scroll: cmdScroll, press: cmdPress,
  cookies: cmdCookies, pdf: cmdPdf, 'close-tab': cmdCloseTab,
};

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }
  const fn = HANDLERS[cmd];
  if (!fn) die(`unknown command: ${cmd}\n${HELP}`);
  try { await fn(args); }
  catch (e) { die(e && e.stack ? e.stack : String(e)); }
}

// Only run when invoked directly (so tests can import the pure helpers).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

export { parseArgs, normalizeUrl, normalizeEndpoint, validWaitUntil, resolveChrome, renderSnapshot, HELP, HANDLERS };
