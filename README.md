# browser-cdp

A small Node.js CLI that drives Chrome over the [DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/), designed so [Claude Code](https://claude.com/claude-code) (or any script) can navigate pages, take screenshots, snapshot interactive elements, click, type, and run arbitrary JS from the shell.

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
- Chrome / Chromium installed at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (macOS default; edit `CHROME_BIN` in `browser-cdp.mjs` if elsewhere)

## Quick tour

```bash
browser-cdp launch --headless
browser-cdp navigate https://example.com
browser-cdp snapshot
browser-cdp screenshot /tmp/example.png --full
browser-cdp eval "document.title"
browser-cdp shutdown
```

## Command reference

| Command | Purpose |
|---|---|
| `launch [--port 9222] [--headless] [--persist NAME] [--user-data-dir DIR] [--attach URL]` | Start Chrome with an isolated profile. Default: windowed + throwaway. `--headless` hides the window. `--persist NAME` uses `~/.browser-cdp-profiles/NAME` so cookies/logins survive across launches. `--attach URL` connects to an already-running Chrome (must be launched with `--remote-debugging-port=N`). |
| `status` | Print current state + open tabs. |
| `new [--url URL]` | Open a new tab. |
| `list-tabs` | JSON list of all open tabs. |
| `navigate URL [--target ID]` | Go to URL in the active tab (or `--target`). |
| `snapshot [--target ID] [--json]` | Tag interactive elements with `e-1..e-N`, print a grouped text list (buttons, links, textboxes…). Use before `click`/`type`. |
| `text [--target ID]` | Visible page text with `<script>/<style>/<noscript>` stripped. |
| `screenshot [PATH] [--full] [--target ID]` | Capture PNG. Default path: `/tmp/browser-cdp/screenshots/shot-<ts>.png`. `--full` for full-page. |
| `click REF [--target ID]` | Click the element with the given ref. Refs come from the most recent `snapshot`. |
| `type REF TEXT [--submit] [--target ID]` | Focus + type. `--submit` presses Enter after. |
| `press KEY [--target ID]` | Send a raw key (`Enter`, `Tab`, `Escape`, `ArrowDown`, …). |
| `eval "expr" [--target ID]` | Run JS in the page. Bare expressions and async work — the CLI wraps in `async () => (…)`. Use IIFE `(() => { const x = …; return x })()` for multi-statement code. |
| `close-tab [--target ID]` | Close a single tab. |
| `shutdown` | Kill Chrome (or detach if attached). Clears state. |

## Snapshot + ref pattern

`snapshot` tags every interactive element with `data-browser-cdp-ref="e-N"` and returns a grouped text list you can pass to `click`/`type`:

```
# Example Domain
https://example.com/

## links (1)
  e-1 "Learn more" href=https://iana.org/domains/example
```

Refs are valid on the current page until a navigation or reload. **Re-snapshot after any action that could change the DOM.**

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

Cookies live under `~/.browser-cdp-profiles/NAME` and survive future `launch --persist NAME` runs (as long as the cookies haven't expired).

## Using with Claude Code

This CLI was originally built to give Claude Code sessions the ability to drive a real browser via [Skills](https://docs.claude.com/en/docs/claude-code/skills). A drop-in skill file [`SKILL.md`](./SKILL.md) is included; copy it into `~/.claude/skills/browser-cdp/SKILL.md` and Claude Code will pick it up.

The skill instructs future sessions to:
- Ask the user before the first launch about mode (windowed vs headless) and profile (throwaway vs persistent)
- Never type user passwords — hand off to the user in the windowed Chrome for authenticated flows
- Detect Desktop Bash sandbox (which cannot reach localhost) and refuse gracefully

## Interoperability

- Screenshots are PNGs → read them back with Claude Code's `Read` tool.
- `snapshot --json` gives structured output → pipe to `jq`.
- Pairs well with `eval` for surgical DOM manipulation:
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
- Chrome binary path is hardcoded to the macOS default. Edit `CHROME_BIN` in `browser-cdp.mjs` for other OSes.
- The CLI's `eval` wraps input in `return (${expr})`, so top-level `const`/`let`/`var` statements don't parse. Use an IIFE.
- On Angular / Vue / React apps with custom elements, standard `.click()` sometimes doesn't fire event handlers. Tag the element (`el.setAttribute('data-browser-cdp-ref', 'foo')`) then use `browser-cdp click foo` — the CLI uses puppeteer's real mouse click.

## Troubleshooting

- **"nothing listening at endpoint"** — prior `launch` state is stale. Run `browser-cdp shutdown` then relaunch.
- **"ref not found"** — snapshot again; the DOM changed.
- **Chrome not found** — edit `CHROME_BIN` in `browser-cdp.mjs`.
- **Port already in use** — another Chrome or leftover process on 9222. Use `--port 9223` or `pkill -f "remote-debugging-port"`.

## License

MIT — see [LICENSE](./LICENSE).
