## Browser Automation

> Despite the filename, this rule covers browser automation generally — **playwright-cli** and **Chrome DevTools MCP**. The rest of the file documents playwright-cli in depth because it is the tool Sentinal can install and give a full command reference for.

**E2E verification through a browser-automation tool is MANDATORY for any UI change.** API tests verify the backend; only a browser verifies what the user sees. **Either tool satisfies this requirement:**

| Tool                    | Use when                                                                    |
| ----------------------- | --------------------------------------------------------------------------- |
| **playwright-cli**      | Default. Installable, scriptable, works with Firefox/Chromium/Brave.        |
| **Chrome DevTools MCP** | Already configured in your MCP setup, or you specifically need real Chrome. |

Pick one per verification run and say which you picked. Do not mix them in a single run — they drive different browser instances and their state will not agree.

**⛔ Whichever you pick, the isolation rule below is not optional.** See _Browser Instance Isolation_.

Sentinal **detects** Chrome DevTools MCP at install time when Chrome is present; it never installs or configures it. Adding it to your MCP config is your decision.

### Installation

```bash
npm install -g @playwright/cli@latest
```

**⛔ Install the scoped `@playwright/cli` package, NOT the bare `playwright-cli` package.** The bare `playwright-cli` on npm is a **deprecated legacy stub** (marked "Deprecated, use @playwright/cli instead"). The scoped `@playwright/cli` is Microsoft's current tool — it ships a binary named `playwright-cli` with the `open`, `snapshot`, `click <ref>`, `-s=<session>` interface documented below.

Verify the install:

```bash
playwright-cli --version     # should print a version like 0.1.6 or newer
playwright-cli --help        # header should read "run playwright mcp commands from terminal"
```

If `playwright-cli: command not found` after install, ensure your global npm `bin` directory (`npm config get prefix`/bin or `~/.npm-global/bin`) is on `$PATH`.

### Browser Selection

**Check what is actually available before choosing — do not assume.** Browser availability is per-machine.

```bash
command -v firefox || ls -d /Applications/Firefox.app 2>/dev/null
command -v google-chrome chromium chromium-browser || ls -d "/Applications/Google Chrome.app" 2>/dev/null
```

- **Project config:** `.playwright/cli.config.json` with `{"browser": "firefox"}` pins the choice for everyone.
- **Manual override:** `playwright-cli -s="$PW_SESSION" open --browser=firefox <url>`
- **Fallbacks in order:** `firefox` → `chromium` → `chrome`.
- **Prefer a browser you do not use interactively.** Driving the browser you have open yourself means the automation shares your profile, cookies and logged-in sessions — see below.

### Browser Instance Isolation (Parallel Workflows)

**⛔ MANDATORY when running inside `/spec` or any parallel workflow, for whichever tool you chose.** The browser is shared runtime state exactly like a port or a database: without isolation, parallel agents drive the same instance and overwrite each other's state.

| Tool                    | The hazard                                                                                                                                                          | The requirement                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **playwright-cli**      | Parallel agents share the default browser instance.                                                                                                                 | Pass `-s=$SENTINAL_SESSION_ID` on **every** command (below).                                                                                    |
| **Chrome DevTools MCP** | Sharper: it can attach to a Chrome **you are actively using** — your profile, cookies, logged-in sessions — and two worktrees collide on one instance / debug port. | Point it at a **dedicated Chrome instance with its own user-data-dir and debug port**. Never attach to your everyday browser during a spec run. |

**Use `-s=$SENTINAL_SESSION_ID` on ALL `playwright-cli` commands:**

```bash
PW_SESSION="${SENTINAL_SESSION_ID:-default}"

playwright-cli -s="$PW_SESSION" open <url>
playwright-cli -s="$PW_SESSION" snapshot
playwright-cli -s="$PW_SESSION" click e1
playwright-cli -s="$PW_SESSION" close
```

**⛔ NEVER use bare `playwright-cli` commands (without `-s=`) during `/spec` workflows.**

### Core Workflow

```bash
PW_SESSION="${SENTINAL_SESSION_ID:-default}"
playwright-cli -s="$PW_SESSION" open <url>        # 1. Open browser
playwright-cli -s="$PW_SESSION" snapshot          # 2. Get elements with refs (e1, e2, ...)
playwright-cli -s="$PW_SESSION" fill e1 "text"    # 3. Interact using refs
playwright-cli -s="$PW_SESSION" click e2
playwright-cli -s="$PW_SESSION" snapshot          # 4. Re-snapshot to verify result
playwright-cli -s="$PW_SESSION" close             # 5. Clean up
```

### Command Reference

**Navigation:** `open <url>`, `goto <url>`, `go-back`, `go-forward`, `reload`, `close`

**Interactions (use refs from snapshot):**

| Command    | Example                                               |
| ---------- | ----------------------------------------------------- |
| Click      | `click e1`, `dblclick e1`                             |
| Text input | `fill e2 "text"` (clear+type), `type "text"` (append) |
| Keys       | `press Enter`, `press Control+a`                      |
| Forms      | `check e1`, `uncheck e1`, `select e1 "value"`         |
| Other      | `hover e1`, `drag e1 e2`, `upload ./file.pdf`         |

**JavaScript:** `eval "document.title"`, `eval "el => el.textContent" e5`

**Screenshots:** `screenshot`, `screenshot e5`, `screenshot --filename=p`

**Dialogs:** `dialog-accept`, `dialog-accept "text"`, `dialog-dismiss`

**Tabs:** `tab-list`, `tab-new [url]`, `tab-select 0`, `tab-close [index]`

**State:** `state-save [file]`, `state-load file`

**Storage:** `cookie-list`, `cookie-get name`, `cookie-set name value`, `cookie-delete name`, `cookie-clear`. Same API for `localstorage-*` and `sessionstorage-*`.

**Network mocking:** `route "**/*.jpg" --status=404`, `route "**/api/**" --body='{"mock":true}'`

**DevTools:** `console [level]`, `network`

**Browser config:** `open --browser=firefox`, `open --headed`, `resize 1920 1080`

### E2E Checklist

- [ ] User can complete the main workflow
- [ ] Forms validate and show errors correctly
- [ ] Success states display after operations
- [ ] Navigation works between pages
- [ ] Error states render properly
