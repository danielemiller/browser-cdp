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

| Command | Purpose |
|---|---|
| `launch [--port 9222] [--headless] [--persist NAME] [--user-data-dir DIR]` | Start Chrome with an isolated profile. Default: windowed + throwaway profile. `--headless` hides the window. `--persist NAME` uses `~/.browser-cdp-profiles/NAME` so cookies/logins survive across launches. |
| `launch --attach URL` | Connect to an already-running Chrome (user must have started it with `--remote-debugging-port=N`). Chrome is left alone on `shutdown`. |
| `status` | Print current state, Chrome PID liveness, and open tabs. |
| `new [--url URL]` | Open a new tab. Sets it as the active target. |
| `list-tabs` | JSON list of all open tabs with `id`, `url`, `title`, `active`. |
| `navigate URL [--target ID]` | Go to URL in the active tab (or `--target`). |
| `snapshot [--target ID] [--json]` | Tag all interactive elements with `e-1..e-N`, print a grouped text list (buttons, links, textboxes…). Use before `click`/`type`. |
| `text [--target ID]` | Visible page text with `<script>/<style>/<noscript>` stripped. |
| `screenshot [PATH] [--full] [--target ID]` | Capture PNG. Default path: `/tmp/browser-cdp/screenshots/shot-<ts>.png`. `--full` for full-page. |
| `click REF [--target ID]` | Click the element with the given ref. Refs come from the most recent `snapshot`. |
| `type REF TEXT [--submit] [--target ID]` | Focus + type. `--submit` presses Enter after. |
| `press KEY [--target ID]` | Send a raw key (e.g. `Enter`, `Tab`, `Escape`, `ArrowDown`). |
| `eval "expr"` [--target ID] | Run JS in the page. Bare expressions and async work — the CLI wraps in `async () => (…)`. |
| `close-tab [--target ID]` | Close a single tab; Chrome keeps running. |
| `shutdown` | Kill the Chrome we launched (or detach if attached). Clears state. |

## Ref lifetime

Refs live on the current page under `data-browser-cdp-ref="e-N"`. A navigation, reload, or SPA rerender invalidates them. **Always `snapshot` again after any action that could change the DOM.**

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
- Node ≥ 18 required.
- On Angular / Vue / React apps with custom elements, standard `.click()` sometimes doesn't fire event handlers. Tag the element via `eval` (`el.setAttribute('data-browser-cdp-ref', 'foo')`) then use `browser-cdp click foo` — the CLI uses puppeteer's real mouse click.
- The CLI's `eval` wraps input in `return (${expr})`, so top-level `const`/`let`/`var` statements don't parse. Use an IIFE: `(() => { const x = ...; return x; })()`.

## Troubleshooting

- **"nothing listening at endpoint"** → prior `launch` state is stale. Run `browser-cdp shutdown` then relaunch.
- **"ref not found"** → snapshot again. The DOM changed under you.
- **Chrome not found** → binary path is hardcoded to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Edit `CHROME_BIN` in the driver if different.
- **Port already in use** → another Chrome or leftover process on 9222. Use `--port 9223` or `pkill -f "remote-debugging-port"`.
