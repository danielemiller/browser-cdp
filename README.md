# browser-cdp

A small Node.js CLI that drives Chrome over the [DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/), designed so [Claude Code](https://claude.com/claude-code) (or any script) can navigate pages, take screenshots, snapshot interactive elements (including those inside iframes), fill forms, wait for the DOM to settle, capture console/network activity, and run arbitrary JS from the shell.

Safe defaults: launches its own isolated Chrome instance with a throwaway `--user-data-dir`, so your real Chrome profile (cookies, logins, tabs) is never touched.

## Install

```bash
npm install -g browser-cdp
```

Or clone and link locally:

```bash
git clone https://github.com/danielemiller/browser-cdp.git
cd browser-cdp
npm install
npm link
```

Requires:
- Node >= 18
- Chrome / Chromium. The binary is autodetected across Chrome, Chromium, Brave, and Edge under `/Applications` and `~/Applications` (macOS). Point `$BROWSER_CDP_CHROME` at any executable to override.

## Quick tour

```bash
browser-cdp launch --headless
browser-cdp navigate example.com          # bare hosts get https://
browser-cdp wait --stable                 # let the DOM settle
browser-cdp snapshot                       # tags interactive elements e-1..e-N (incl. iframes)
browser-cdp type e-2 "hello" --clear       # clear the field, then type
browser-cdp click e-5 --wait-nav           # click and wait for the navigation
browser-cdp screenshot /tmp/example.png --full
browser-cdp eval "document.title"          # CSP-safe (runs via CDP Runtime.evaluate)
browser-cdp shutdown
```

## Command reference

Most commands also accept `[--target TAB_ID]` (act on a specific tab) and `[--port N]` (act on a specific session — see [Multiple sessions](#multiple-sessions)).

### Launch / session

| Command | Purpose |
|---|---|
| `launch [--port 9222] [--headless] [--persist NAME] [--user-data-dir DIR] [--attach URL] [--download-dir DIR]` | Start Chrome with an isolated profile. Default: windowed + throwaway. `--headless` hides the window. `--persist NAME` uses `~/.browser-cdp-profiles/NAME` so cookies/logins survive across launches. `--attach URL` connects to an already-running Chrome (must be launched with `--remote-debugging-port=N`). `--download-dir` routes downloads there. |
| `status [--all]` | Print current session state + open tabs. `--all` lists every session. |
| `shutdown [--port N] [--all]` | Kill Chrome (or detach if attached). `--all` stops every session. Clears state. |

### Tabs / navigation

| Command | Purpose |
|---|---|
| `new [--url URL]` | Open a new tab. |
| `list-tabs` | JSON list of all open tabs. |
| `navigate URL [--wait UNTIL] [--timeout MS]` | Go to URL (bare hosts get `https://`). `--wait` ∈ `load\|domcontentloaded\|networkidle0\|networkidle2` (default `domcontentloaded`). |
| `back` / `forward` / `reload [--timeout MS]` | History navigation; waits for `domcontentloaded`, prints `{url,title}`. |
| `wait [--selector CSS \| --text S \| --url S \| --idle \| --stable [MS] \| --ms N] [--timeout MS]` | Block until a condition holds. `--stable` = DOM settles (MutationObserver); `--idle` = network idle. Default timeout 15s. |

### Reading

| Command | Purpose |
|---|---|
| `snapshot [--json] [--include-hidden]` | Tag interactive elements (main frame + iframes + popup/portal roles like `option`/`tab`/`treeitem`) with `e-1..e-N`, print a grouped text list. `--include-hidden` surfaces controls with zero-size rects (popups mid-animation). Use before `click`/`type`. |
| `text` | Visible page text (all frames) with `<script>/<style>/<noscript>` stripped. |
| `screenshot [PATH] [--full] [--ref e-N]` | Capture PNG. Default path: `/tmp/browser-cdp/screenshots/shot-<ts>.png`. `--full` for full-page; `--ref` for a single element. |
| `logs [--for MS] [--console] [--network] [--errors] [--reload \| --navigate URL]` | Bounded capture of console/network/page-errors for `--for` ms (default 3000), optionally triggering a reload/navigate. Prints JSON. |
| `intercept [--url-pattern REGEX] [--method M] [--for MS] [--include-response] [--reload \| --navigate URL]` | Capture request bodies (and response bodies with `--include-response`, truncated at 200KB) for requests matching the pattern. First-class replacement for hand-hooking `XMLHttpRequest.prototype.send`. |
| `eval "expr"` | Run JS via CDP `Runtime.evaluate` — **CSP-safe**. Single expression; the CLI wraps in `async () => (…)`. For multi-statement code, prefer `exec`. |
| `exec "SCRIPT" \| --file PATH \| -` | Run multi-statement JS as an async function body — top-level `const`/`let`/`var` + explicit `return` work, no IIFE needed. Also CSP-safe (same CDP path as `eval`). Read from stdin with `-` or a file with `--file PATH`. |

### Interaction (REF comes from the latest `snapshot`)

| Command | Purpose |
|---|---|
| `click REF [--wait-nav] [--wait-selector CSS] [--wait-text S]` | Click the ref. `--wait-nav` waits for the resulting navigation; `--wait-*` settle on a post-click condition. |
| `type REF TEXT [--clear] [--submit]` | Focus + type (appends). `--clear` empties the field first; `--submit` presses Enter after. |
| `clear REF` | Empty a text field / contenteditable (fires `input`+`change`). |
| `fill REF TEXT` | Overwrite a field's value wholesale (vs. append-y `type`). |
| `select REF VALUE [VALUE...]` | Choose option(s) in a `<select>`. |
| `hover REF` | Hover the element (for hover-triggered menus). |
| `scroll [--ref e-N \| --bottom \| --top \| --by N]` | Scroll to an element, to page top/bottom, or by N px. |
| `press KEY` | Send a raw key (`Enter`, `Tab`, `Escape`, `ArrowDown`, …). |
| `close-tab` | Close a single tab. |

### Session portability

| Command | Purpose |
|---|---|
| `cookies dump [PATH]` / `load PATH` / `clear` | Export/import/clear cookies as JSON. Reuse a session without a windowed login. |
| `pdf [PATH]` | Render the page to PDF. **Headless only** (Chrome limitation). |

### Anti-idle

| Command | Purpose |
|---|---|
| `keepalive [--interval MS] [--target ID]` | Spawn a detached background process that dispatches a synthetic mousemove via CDP every `--interval` ms (default 20000). Prevents idle-timeout auto-save on web apps that drop out of edit mode after ~60–90s of inactivity (Celonis Studio, some Salesforce record pages, etc.). Re-running while one is active kills the old one first. |
| `keepalive --stop` | Terminate the background keepalive for this session. Idempotent. `shutdown` also stops it automatically. |

## Snapshot + ref pattern

`snapshot` tags every interactive element with `data-browser-cdp-ref="e-N"` and returns a grouped text list you can pass to `click`/`type`:

```
# Example Domain
https://example.com/

## links (1)
  e-1 "Learn more" href=https://iana.org/domains/example
```

Refs are numbered continuously across the main document **and all iframes** (each iframe's controls get their own `# iframe: <url>` section), so widgets inside embedded login/payment frames are addressable too. Refs are valid on the current page until a navigation or reload. **Re-snapshot after any action that could change the DOM.**

## Waiting: act → wait → snapshot

Page text and refs are only trustworthy once the DOM has settled — never trust a snapshot taken mid-transition:

```bash
browser-cdp click e-7 --wait-nav     # or: click e-7 ; wait --stable
browser-cdp wait --stable            # DOM settles (or --selector / --idle / --text)
browser-cdp snapshot                 # now the refs match what's on screen
```

Use `wait --selector "#results"` when you know what should appear, `wait --idle` for network-driven pages, and `wait --stable` as a general "let the DOM settle" fallback.

## Persistent profiles

For sites behind SSO or logins, use `--persist NAME`:

```bash
browser-cdp launch --persist my-project     # windowed, so you can log in
browser-cdp navigate https://app.example.com/login
# ... log in yourself in the Chrome window that appears ...
browser-cdp snapshot                          # now authenticated context
# ... continue with click/type/screenshot ...
# don't call `shutdown` — leaving Chrome running keeps the session
```

Cookies live under `~/.browser-cdp-profiles/NAME` and survive future `launch --persist NAME` runs (as long as the cookies haven't expired). To move a session between machines or profiles without logging in again, use `cookies dump`/`load`.

## Capturing console & network

`logs` is a bounded, single-shot capture — it attaches listeners, optionally triggers activity, waits, then dumps `{console, errors, requests}`:

```bash
browser-cdp logs --network --reload --for 4000   # reload + capture requests for 4s
browser-cdp logs --console --errors --for 2000    # just console output + page errors
```

Requests include method, url, status, and failure text. Pass any of `--console`/`--network`/`--errors` to filter (all three if none given).

## Reverse-engineering an API: `intercept`

`intercept` is the sibling of `logs` for capturing **request and response bodies** (not just metadata). Useful for figuring out what a web app's UI actually sends to its backend when you click a button — the pattern you'd otherwise implement by hand-hooking `XMLHttpRequest.prototype.send` via `eval`.

```bash
# What does the "Save" button on this dashboard actually POST?
browser-cdp intercept --url-pattern "api/v2/boards" --include-response --for 4000 &
sleep 1 && browser-cdp click e-12          # click Save in another shell
```

- `--url-pattern` is a JavaScript regex (bare `.*` by default).
- `--method GET/POST/PUT/…` filters by verb.
- `--include-response` also fetches response bodies (200 KB cap; `responseBodyBytes` reports the pre-truncation size).
- `--reload` / `--navigate URL` triggers activity from the intercept command itself.
- Caps at 200 matched requests; `matched > requests.length` tells you the cap was hit.

## Multi-statement scripts: `exec`

`eval` treats input as a single expression — good for reads, awkward for multi-statement code. `exec` treats input as an async function body: top-level `const`/`let`/`var` and explicit `return` all work directly.

```bash
browser-cdp exec 'const rows = document.querySelectorAll("tr"); return {count: rows.length, first: rows[0]?.innerText}'

# Read from a file
browser-cdp exec --file scripts/extract-table.js

# Read from stdin (heredoc)
browser-cdp exec - <<'JS'
const editor = monaco.editor.getModels()[0];
const yaml = editor.getValue();
const parsed = yaml.split('\n').filter(l => l.startsWith('key:'));
return parsed;
JS
```

Both `eval` and `exec` run via raw CDP `Runtime.evaluate` — CSP-safe on sites that block `unsafe-eval`.

## Preventing idle-timeout auto-save: `keepalive`

Some web apps (Celonis Studio's edit mode is the canonical example, but Salesforce record edits and various admin consoles do the same thing) auto-save and drop you out of edit mode after ~60–90s of inactivity. When you're driving that app from a script with multi-second gaps between commands, the app's idle timer fires and undoes your session.

```bash
browser-cdp keepalive                       # default: mousemove every 20s
browser-cdp keepalive --interval 10000      # every 10s
# ... do your driving work ...
browser-cdp keepalive --stop                # explicit stop (shutdown also stops it)
```

`keepalive` spawns a detached background node process that dispatches a synthetic `mousemove` via CDP `Input.dispatchMouseEvent` on the interval. It survives tab-close (falls back to the most recent tab) and disconnects cleanly if Chrome exits. Only one keepalive per session — re-invoking replaces it. The PID is stored under `state.keepalive.pid` and cleaned up by `shutdown` (both single-session and `--all`).

## Multiple sessions

Run more than one browser at once by giving each a distinct `--port`. The default session is whichever you last launched or touched; target a specific one with `--port N` on any command.

```bash
browser-cdp launch --port 9222              # session A
browser-cdp launch --port 9333 --headless   # session B, independent
browser-cdp status --all                    # list both
browser-cdp navigate example.com --port 9333
browser-cdp shutdown --all                  # stop everything
```

State is kept per-port under `/tmp/browser-cdp/sessions/<port>.json`; `state.json` tracks the active session.

## Using with Claude Code

This CLI was originally built to give Claude Code sessions the ability to drive a real browser via [Skills](https://docs.claude.com/en/docs/claude-code/skills). A drop-in skill file [`SKILL.md`](./SKILL.md) is included; copy it into `~/.claude/skills/browser-cdp/SKILL.md` and Claude Code will pick it up.

The skill instructs future sessions to:
- Ask the user before the first launch about mode (windowed vs headless) and profile (throwaway vs persistent)
- Never type user passwords — hand off to the user in the windowed Chrome for authenticated flows
- Re-snapshot after actions that change the DOM, using the `wait` primitives

## Interoperability

- Screenshots and PDFs are files → read screenshots back with Claude Code's `Read` tool.
- `snapshot --json` gives structured output → pipe to `jq`.
- Pairs well with `eval` for surgical DOM reads:
  ```bash
  browser-cdp eval "monaco.editor.getModels()[0].getValue()" > page-content.txt
  ```

## Safety notes

- **Isolated profile by default.** `launch` (without `--persist`) creates a throwaway `--user-data-dir` under `/tmp/browser-cdp/`. Your real Chrome is not touched.
- **Debug port binds to 127.0.0.1** only — no external network exposure.
- **Attaching to your existing Chrome** (`launch --attach http://127.0.0.1:N`, only if you launched it yourself with `--remote-debugging-port=N`) exposes cookies and sessions to the driver. Only use for browsers you don't mind exposing.
- **Never type passwords via `type`.** For any login: launch windowed with a persistent profile, `navigate` to the login page, then hand off to the user. Passwords in tool calls end up in logs, transcripts, and prompt caches.

## Known limitations

- Anti-bot systems (Cloudflare, Google, DDG captcha) often flag headless Chrome. Retry windowed.
- Ref numbering resets on every `snapshot` — don't cache refs across DOM changes.
- `logs` and `intercept` are bounded snapshots, not live tails — they only capture during their own `--for` window.
- `keepalive`'s synthetic mousemove event may not reset every app's idle timer. Some apps listen only for keyboard events or scroll; for those, use `exec` with a page.evaluate that dispatches the specific event the app expects.
- `intercept --include-response` may miss bodies for requests whose response was already consumed by the page before the buffer is read (redirects, aborted requests).
- The CLI's `eval` wraps input in `(async () => (${expr}))()`, so top-level `const`/`let`/`var` statements don't parse. Use an IIFE.
- On some Angular / Vue / React apps, framework event handlers may not fire on a synthetic click; re-`snapshot` and retry, or drive the element via `eval`.

## Troubleshooting

- **"nothing listening at endpoint"** — prior `launch` state is stale. Run `browser-cdp shutdown` then relaunch.
- **"ref not found"** — snapshot again; the DOM changed.
- **Chrome not found** — autodetection checks Chrome/Chromium/Brave/Edge under `/Applications` and `~/Applications`. If your browser is elsewhere, `export BROWSER_CDP_CHROME=/path/to/binary`.
- **Port already in use** — another Chrome or leftover process on 9222. Use `--port 9223` (a separate session) or `pkill -f "remote-debugging-port"`.

## License

MIT — see [LICENSE](./LICENSE).
