## Browser Automation with playwright-cli

**MANDATORY for E2E testing of any app with a UI.** API tests verify backend; playwright-cli verifies what the user sees.

### Browser Selection

**Use Firefox or Brave — NOT Chrome.** Chrome is not installed on this machine.

- **Project config:** `.playwright/cli.config.json` with `{"browser": "firefox"}` handles this automatically.
- **Manual override:** `playwright-cli -s="$PW_SESSION" open --browser=firefox <url>`
- **If Firefox unavailable:** `playwright-cli -s="$PW_SESSION" open --browser=chromium <url>`

### Session Isolation (Parallel Workflows)

**⛔ MANDATORY when running inside `/spec` or any parallel workflow.** Without session isolation, parallel agents share the default browser instance and overwrite each other's state.

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

| Command | Example |
|---------|---------|
| Click | `click e1`, `dblclick e1` |
| Text input | `fill e2 "text"` (clear+type), `type "text"` (append) |
| Keys | `press Enter`, `press Control+a` |
| Forms | `check e1`, `uncheck e1`, `select e1 "value"` |
| Other | `hover e1`, `drag e1 e2`, `upload ./file.pdf` |

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
