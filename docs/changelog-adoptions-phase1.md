# OpenCode Adoption Notes — Phase 1

Supplementary documentation covering OpenCode CLI flags, MDM deployment, and Sentinal integration ergonomics introduced or clarified in the 2026 Q1–Q2 timeframe.

---

## 1. `opencode run --dangerously-skip-permissions`

The `--dangerously-skip-permissions` flag auto-approves all non-denied permission prompts during a headless `opencode run -p "..."` invocation. When running `/spec` phases via spec-master orchestration or other scripted workflows, interactive permission prompts would stall an unattended CI pipeline. This flag eliminates that friction.

Importantly, the flag respects explicit deny rules configured in `opencode.json` — only prompts that are not explicitly denied are auto-approved. This means Sentinal's `permission.edit` configuration still controls which write operations are permitted, so you retain write-path safety while removing read-only and skill-invocation prompts from the approval queue.

Recommended usage pattern in CI: combine `--dangerously-skip-permissions` with a restrictive `opencode.json` that denies high-risk operations (e.g., `shell` without allowlist, arbitrary `fetch`). This gives you a headless-friendly session without fully opening the permission surface.

---

## 2. macOS MDM Guidance for Enterprise Deployments

Sentinal's `opencode.json` config template (installed to `~/.config/opencode/opencode.json`) can be enforced across a team via macOS MDM (Mobile Device Management) profiles. Distributing a managed `opencode.json` pins Sentinal as the active plugin, locks permission settings, and registers MCP servers consistently across every developer machine — removing per-developer setup drift.

MDM support for OpenCode was added on 2026-04-04, using macOS Managed Preferences (the `com.opencode` preference domain). The relevant mechanism is a plist-based configuration profile that maps to the `opencode.json` settings structure. Administrators can deploy this profile through any standard MDM solution (Jamf, Mosyle, Kandji, Apple Business Manager). For reference, see [Apple's MDM Configuration Profile documentation](https://developer.apple.com/documentation/devicemanagement/profile-specific_payload_keys) for plist deployment patterns.

When authoring the MDM profile, use the `opencode.json` top-level keys as your plist keys under the `com.opencode` domain. Pay particular attention to the `plugins` and `mcpServers` arrays — these are the entries that ensure Sentinal and its companion MCP servers (`context7`, `web-search`, `grep-mcp`, `web-fetch`) are present and correctly configured on every managed machine.

---

## 3. `--agent` CLI Override on Session Resume

When resuming an OpenCode session with `opencode -s <session-id>` or `opencode --session <id>`, the `--agent <name>` flag overrides the agent that was saved on the session record. Previously, resuming a session always restored the original agent context, which made it difficult to switch modes mid-workflow.

This is particularly useful in `/spec` workflows: you might start a planning session under the `build` agent, then want to resume in `plan` mode to add tasks, or switch to `verify` mode to run quality checks. Example:

```
opencode -s abc123 --agent plan
```

The session's saved agent is ignored for that run only — the underlying session record is not mutated, so subsequent resumes without `--agent` return to the original saved agent. This makes it safe to use as a one-off override rather than a permanent reassignment.

---

## 4. `opencode export --sanitize`

`opencode export --sanitize` exports a session transcript with PII and sensitive data redacted before writing to disk. The `--sanitize` flag applies heuristic detection across the transcript for names, email addresses, API keys, filesystem paths that could reveal username or project structure, and other common sensitive patterns.

This is the recommended companion to Sentinal's `/learn` command when sharing spec output or session observations with teammates. The typical workflow is: run `/learn` at the end of a spec session to extract reusable observations into Sentinal's memory store, then run `opencode export --sanitize` to produce a shareable transcript artifact. The sanitized output file can be committed to `docs/` or attached to issue trackers and pull requests without risk of leaking environment-specific details.

The export produces a local file (path printed on completion). Because the sanitization is heuristic rather than guaranteed-complete, treat the output as "reduced risk" rather than fully scrubbed — review it before sharing externally if the session touched credentials or proprietary data.

---

## 5. `.sentinal/` Gitignore Ergonomics

Sentinal writes runtime state to `.sentinal/` in the project root. Not all of it belongs in version control — some files are ephemeral per-machine state, while others (rules, skills) are project-specific configuration that your team should share.

**Exclude from git** (add to `.gitignore`): the following are ephemeral runtime state that varies per machine and per session:

```
.sentinal/compact-state.json
.sentinal/project-memory.json
.sentinal/sidecar.pid
.sentinal/sidecar.port
.sentinal/sidecar.sock
.sentinal/sidecar.log
.sentinal/plugin.debug.log
.sentinal/tsbuildinfo/
.sentinal/worktrees/
```

**Include in git** (do NOT gitignore): `.sentinal/rules/*.md` and `.sentinal/skills/` are project-specific rules and skills that benefit from version control. They encode your team's conventions, checker configurations, and reusable skill workflows — committing them means every developer who clones the repo gets Sentinal pre-configured with the project's standards.

The split between excluded and included paths under `.sentinal/` is intentional: the directory functions simultaneously as a runtime scratch space (excluded paths) and a project configuration namespace (included paths). A single top-level `!.sentinal/` gitignore entry is not appropriate; use the specific path list above.
