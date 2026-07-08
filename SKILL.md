---
name: browser-cdp
description: Drive a real Chrome browser from Claude Code sessions via the Chrome DevTools Protocol. INVOKE when the user asks Claude to open a page, click through a UI, screenshot a live site, fill out a form, scrape rendered content, or otherwise "use my browser." Launches its own Chrome with an isolated profile (user's real Chrome untouched). Before the first launch, ASK the user headless vs windowed and throwaway vs persistent profile — windowed+persistent is the right choice when they may need to log in or complete a captcha. Never type user passwords: hand off to the user in the windowed Chrome. Requires the `browser-cdp` CLI on PATH (see https://github.com/danielemiller/browser-cdp). Only available on Claude Code CLI (real machine); the Desktop Bash sandbox cannot reach localhost so this skill does NOT work there.
---

# browser-cdp — CDP-backed browser driver

A small Node CLI that lets Claude sessions drive Chrome over the DevTools Protocol.

CLI: `browser-cdp` (install from https://github.com/danielemiller/browser-cdp via `npm install -g browser-cdp` or `npm link` from a clone)
State file (session-local): `/tmp/browser-cdp/state.json`

## Environment gate

**Only works from Claude Code CLI.** The Desktop Bash sandbox cannot reach localhost, so `puppeteer.connect()` to `127.0.0.1:9222` will fail. If you're on Desktop, tell the user and stop.

## Before launching — ASK

Before the first `launch` of a task, ask the user three things unless the answer is obvious from context. Use `AskUserQuestion` for this. Keep it one question with 2–3 options.

1. **Mode:** `windowed` (they can watch and take over the keyboard) vs `headless` (invisible, faster, cheaper on RAM). Default recommendation: **windowed** when the task might need login, captcha, or human review; **headless** for pure scraping or batch screenshots.
2. **Profile:** `throwaway` (fresh state each launch — safest) vs `persistent NAME` (`--persist work` keeps cookies/logins under `~/.browser-cdp-profiles/work` for reuse). Recommend persistent only when the task involves signing in.
3. **Credentials:** never ask the user for passwords. If a site needs login: launch **windowed** with a **persistent** profile, `navigate` to the login page, then **hand off** — tell the user "I've opened the login page in the driver's Chrome window; log in there, then tell me when you're ready and I'll continue." Do NOT try to `type` a password into the field, even if the user offers to paste it — let them do it in the actual browser window.

Skip the question when the user has already told you (e.g. "just take a screenshot of X" → obviously headless + throwaway).

## Typical flow

Pure scrape (agreed to headless, throwaway):
```bash
browser-cdp launch --headless               # → starts isolated Chrome, prints endpoint + pid
browser-cdp navigate https://example.com    # → {url, title}
browser-cdp snapshot                        # → refs list, e-1..e-N
browser-cdp click e-1                       # → follows a link
browser-cdp screenshot /tmp/out.png --full  # → saves PNG, prints {path, bytes, url}
browser-cdp text                            # → visible page text (script/style stripped)
browser-cdp eval "document.title"           # → runs arbitrary JS, prints JSON result
browser-cdp shutdown                        # → kills Chrome, clears state
```

Windowed + persistent login handoff:
```bash
browser-cdp launch --persist work            # windowed by default, profile persists
browser-cdp navigate https://app.example.com/login
# → tell the user: "Login page is open. Log in manually, then let me know."
# … user logs in in the actual window, replies "done" …
browser-cdp snapshot                         # → now authenticated context
# … continue with click/type/screenshot …
# Do NOT call `shutdown` unless the user says so — leaving Chrome running keeps
# the session hot. On next launch with `--persist work`, cookies still there.
```

Read screenshots back with the `Read` tool — Claude Code renders PNGs inline.

## Command reference

Most commands also accept `[--target TAB_ID]` (act on a specific tab) and `[--port N]` (act on a specific session — see Multi-session below).

**Launch / session**
| Command | Purpose |
|---|---|
| `launch [--port 9222] [--headless] [--persist NAME] [--user-data-dir DIR] [--download-dir DIR]` | Start Chrome with an isolated profile. Default: windowed + throwaway. `--headless` hides the window. `--persist NAME` uses `~/.browser-cdp-profiles/NAME` so cookies/logins survive across launches. `--download-dir` routes downloads there. Chrome binary is autodetected (override with `$BROWSER_CDP_CHROME`). |
| `launch --attach URL` | Connect to an already-running Chrome (user must have started it with `--remote-debugging-port=N`). Chrome is left alone on `shutdown`. |
| `status [--all]` | Print current session state, Chrome PID liveness, and open tabs. `--all` lists every session. |
| `shutdown [--port N] [--all]` | Kill the Chrome we launched (or detach if attached). `--all` shuts down every session. Clears state. |

**Tabs / navigation**
| Command | Purpose |
|---|---|
| `new [--url URL]` | Open a new tab. Sets it as the active target. |
| `list-tabs` | JSON list of all open tabs with `id`, `url`, `title`, `active`. |
| `navigate URL [--wait UNTIL] [--timeout MS]` | Go to URL (bare hosts get `https://`). `--wait` ∈ `load\|domcontentloaded\|networkidle0\|networkidle2` (default `domcontentloaded`). |
| `back` / `forward` / `reload [--timeout MS]` | History navigation; waits for `domcontentloaded`, prints `{url,title}`. |
| `wait [--selector CSS \| --text S \| --url S \| --idle \| --stable [MS] \| --ms N] [--timeout MS]` | Block until a condition holds. `--stable` = DOM settles (MutationObserver); `--idle` = network idle. Default timeout 15s. |

**Reading**
| Command | Purpose |
|---|---|
| `snapshot [--json] [--include-hidden]` | Tag interactive elements (main frame + iframes + popup/portal roles: `option`, `tab`, `treeitem`, `menuitemcheckbox`, `menuitemradio`, `switch`, `radio`, `[aria-haspopup]`, `[aria-expanded]`) with `e-1..e-N`. `--include-hidden` surfaces controls with zero-size rects (popups mid-animation). Use before `click`/`type`. |
| `text` | Visible page text (all frames), `<script>/<style>/<noscript>` stripped. |
| `screenshot [PATH] [--full] [--ref e-N]` | Capture PNG. Default path: `/tmp/browser-cdp/screenshots/shot-<ts>.png`. `--full` = full-page; `--ref` = just that element (cheaper on tokens when reading back). |
| `logs [--for MS] [--console] [--network] [--errors] [--reload \| --navigate URL]` | Bounded capture of console/network/page-errors for `--for` ms (default 3000), optionally triggering a reload/navigate. Prints JSON. |
| `intercept [--url-pattern REGEX] [--method M] [--for MS] [--include-response] [--reload \| --navigate URL]` | Capture request bodies (and response bodies with `--include-response`, 200KB cap) for requests matching the pattern. First-class replacement for hand-hooking `XMLHttpRequest.prototype.send`. |
| `eval "expr"` | Run JS via CDP `Runtime.evaluate` — **CSP-safe**. Single expression. For multi-statement code, use `exec` instead. |
| `exec "SCRIPT" \| --file PATH \| -` | Run multi-statement JS as an async function body — top-level `const`/`let`/`var` + explicit `return` work directly, no IIFE needed. Also CSP-safe. Read from `--file PATH` or stdin `-`. |

**Interaction** (REF comes from the latest `snapshot`)
| Command | Purpose |
|---|---|
| `click REF [--wait-nav] [--wait-selector CSS] [--wait-text S]` | Click the ref. `--wait-nav` waits for the resulting navigation; `--wait-*` settle on a post-click condition. |
| `type REF TEXT [--clear] [--submit]` | Focus + type (appends). `--clear` empties the field first; `--submit` presses Enter after. |
| `clear REF` | Empty a text field / contenteditable (fires `input`+`change`). |
| `fill REF TEXT` | Overwrite a field's value wholesale (vs. append-y `type`). |
| `select REF VALUE [VALUE...]` | Choose option(s) in a `<select>`. |
| `hover REF` | Hover the element (for hover-triggered menus). |
| `scroll [--ref e-N \| --bottom \| --top \| --by N]` | Scroll to an element, to page top/bottom, or by N px. |
| `press KEY` | Send a raw key (e.g. `Enter`, `Tab`, `Escape`, `ArrowDown`). |
| `close-tab` | Close a single tab; Chrome keeps running. |

**Session portability**
| Command | Purpose |
|---|---|
| `cookies dump [PATH]` / `load PATH` / `clear` | Export/import/clear cookies as JSON. Reuse a session without a windowed login. |
| `pdf [PATH]` | Render the page to PDF. **Headless only** (Chrome limitation). |

**Anti-idle**
| Command | Purpose |
|---|---|
| `keepalive [--interval MS] [--target ID]` | Spawn a detached background process that dispatches a synthetic mousemove via CDP every `--interval` ms (default 20000). Prevents idle-timeout auto-save on web apps that drop out of edit mode after ~60–90s of inactivity (Celonis Studio, some Salesforce record edits, various admin consoles). Re-running while one is active replaces it. |
| `keepalive --stop` | Terminate the background keepalive for this session. Idempotent. `shutdown` also stops it automatically. |

**When to reach for keepalive:** the moment the user says "I want to edit X" in a webapp AND you plan to drive multi-step edits with pauses (screenshot → think → click), start a keepalive first. If in doubt, ask: *"This site sometimes auto-saves on idle — should I run `keepalive` in the background so we don't lose the edit session?"*

## Reverse-engineering an unknown API with `intercept`

If a UI action calls an internal API and you want to know the exact endpoint + payload (e.g., to eventually replay it via `fetch` for a batch operation), `intercept` captures request bodies without hand-hooking XHR:

```bash
# In background: capture 5s of API traffic while you click Save
browser-cdp intercept --url-pattern "api/v2" --include-response --for 5000
# In parallel shell:
browser-cdp click e-42                   # click the Save button
```

The pattern is a JS regex; results include method, URL, request headers, `postData` (request body string), status, and (with `--include-response`) response body up to 200KB. Match `matched > requests.length` — that means you hit the 200-request cap.

## Multi-statement scripting with `exec`

`eval` is single-expression only — good for reads, awkward for anything with intermediate state. `exec` treats input as an async function body: top-level `const`/`let`/`var` and `return` work directly.

```bash
browser-cdp exec 'const editor = monaco.editor.getModels()[0]; const yaml = editor.getValue(); return {length: yaml.length, first: yaml.split("\n")[0]};'

# From a file
browser-cdp exec --file scripts/extract-something.js

# From stdin (heredoc — no shell-escaping headaches)
browser-cdp exec - <<'JS'
const rows = document.querySelectorAll('table tr');
const out = [...rows].map(r => r.innerText.split('\t'));
return out.slice(0, 20);
JS
```

Both `eval` and `exec` go through raw CDP `Runtime.evaluate` — CSP-safe on strict-CSP sites (`unsafe-eval` blocked).

## The act → wait → snapshot loop

Refs and page text are only trustworthy *after* the DOM has settled. Never trust a snapshot taken mid-transition:

```bash
browser-cdp click e-7 --wait-nav     # or: click e-7 ; wait --stable
browser-cdp wait --stable            # DOM settles (or --selector / --idle / --text)
browser-cdp snapshot                 # NOW the refs match what's on screen
```

Use `wait --selector "#results"` when you know what should appear, `wait --idle` for network-driven pages, `wait --stable` as a general "let the DOM settle" fallback.

## Ref lifetime

Refs live on the current page under `data-browser-cdp-ref="e-N"`, numbered continuously across the main document **and all iframes** (each iframe's controls get their own `# iframe:` section in the snapshot). A navigation, reload, or SPA rerender invalidates them. **Always `snapshot` again after any action that could change the DOM.** All element commands (`click`, `type`, `clear`, `fill`, `select`, `hover`, `screenshot --ref`, `scroll --ref`) resolve a ref by searching every frame, so iframe'd login/payment/consent widgets work transparently.

## Capturing logs (debugging a broken page)

`logs` is a **bounded, single-shot** capture — it attaches listeners, optionally triggers activity, waits, and dumps `{console, errors, requests}`:

```bash
browser-cdp logs --network --reload --for 4000   # reload + capture requests for 4s
browser-cdp logs --console --errors --for 2000    # just console output + page errors
```

Pass any of `--console`/`--network`/`--errors` to filter (all three if none given).

## Multi-session

Run more than one browser at once by giving each a distinct `--port`. The default session is whichever you last launched/touched; target a specific one with `--port N` on any command.

```bash
browser-cdp launch --port 9222              # session A
browser-cdp launch --port 9333 --headless   # session B, independent
browser-cdp status --all                    # list both
browser-cdp shutdown --all                  # stop everything
```

State is per-port under `/tmp/browser-cdp/sessions/<port>.json`; `state.json` tracks the active session.

## Safety defaults

- Default `launch` uses a **throwaway `--user-data-dir`** under `/tmp/browser-cdp/`. User's real Chrome (their profile, cookies, logged-in sessions) is never touched.
- Debug port binds to `127.0.0.1` only.
- Never launch attached to the user's default Chrome without explicit consent — CDP gives full cookie/session access to anything the browser can do.

## Mode choice cheat sheet

| Situation | Mode | Profile |
|---|---|---|
| One-shot scrape, screenshot, or read | headless | throwaway |
| User wants to watch what's happening | windowed (default) | throwaway |
| Site behind a login | **windowed** (user logs in) | **`--persist NAME`** |
| Site fingerprints headless | windowed | throwaway |
| Long-running research task, many pages | headless | throwaway (or persist if they want caching) |
| RAM-tight machine | headless when possible | — |

**RAM cost:** windowed Chrome ≈ 200–400 MB idle, more per tab. Don't leave a windowed Chrome running for hours on a low-RAM machine if the user is compiling / running models.

## Credentials: hand off, don't type

If a task requires login:

1. `launch --persist <name>` (windowed).
2. `navigate` to the login page.
3. Tell the user: *"Login page is open in the driver's Chrome — please sign in there, then tell me when you're ready."*
4. **Stop.** Wait for their reply. Do NOT `type` into password fields even if offered — passwords in tool calls end up in transcripts, logs, and prompt caches.
5. When they say ready, `snapshot` to confirm you're logged in, then continue.
6. Do NOT `shutdown` unless the user is done — leaving Chrome running keeps the session.

On the next task in the same profile: `launch --persist <name>` again reuses the same cookies/logins (assuming they haven't expired).

## Interoperability

- Screenshot outputs are PNGs → read them back with the `Read` tool.
- `--json` on `snapshot` gives structured output → pipe to `jq`.
- Monaco editors on the target page are usually accessible via `browser-cdp eval "monaco.editor.getModels()[0].getValue()"` — very useful for extracting/injecting code, YAML, and rich text editor contents.

## Known limitations

- Anti-bot systems (Cloudflare, Google, DDG captcha) will often flag headless Chrome. Retry windowed.
- Ref numbering resets on every `snapshot`; don't cache ref values across steps if the DOM changed.
- `logs` is a bounded snapshot, not a live tail — it only captures during its own `--for` window.
- Node ≥ 18 required.
- On Angular / Vue / React apps with custom elements, standard `.click()` sometimes doesn't fire event handlers. Tag the element via `eval` (`el.setAttribute('data-browser-cdp-ref', 'foo')`) then use `browser-cdp click foo` — the CLI uses puppeteer's real mouse click.
- The CLI's `eval` wraps input in `(async () => (${expr}))()`, so top-level `const`/`let`/`var` statements don't parse. Use an IIFE: `(() => { const x = ...; return x; })()`.

**Now handled** (previously limitations): `eval` runs via CDP so strict-CSP pages no longer break it; `snapshot`/`text`/element commands traverse iframes; the Chrome binary is autodetected across Chrome/Chromium/Brave/Edge.

## Troubleshooting

- **"nothing listening at endpoint"** → prior `launch` state is stale. Run `browser-cdp shutdown` then relaunch.
- **"ref not found"** → snapshot again. The DOM changed under you.
- **Chrome not found** → autodetection checks Chrome/Chromium/Brave/Edge under `/Applications` and `~/Applications`. If your browser is elsewhere, `export BROWSER_CDP_CHROME=/path/to/binary`.
- **Port already in use** → another Chrome or leftover process on 9222. Use `--port 9223` (a separate session) or `pkill -f "remote-debugging-port"`.
