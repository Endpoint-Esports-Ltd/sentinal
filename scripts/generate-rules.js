#!/usr/bin/env node
/**
 * Rules Template Generator
 *
 * Generates Claude Code and OpenCode rule files from shared templates.
 *
 * Usage:
 *   node scripts/generate-rules.js
 *   node scripts/generate-rules.js --claude
 *   node scripts/generate-rules.js --opencode
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");
const ROOT = join(__dirname, "..");

const TEMPLATES_DIR = join(ROOT, "templates", "rules");
const OUTPUT_DIRS = {
  claude: join(ROOT, "targets", "claude-code", "rules"),
  opencode: join(ROOT, "targets", "opencode", "rules"),
};

const FRONTMATTERS = {
  claude: {
    typescript: `---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.mjs"
  - "**/*.mts"
---

`,
    angular: `---
paths:
  - "**/*.component.ts"
  - "**/*.component.html"
  - "**/*.directive.ts"
  - "**/*.pipe.ts"
  - "**/*.module.ts"
  - "**/*.guard.ts"
  - "**/*.resolver.ts"
  - "**/*.interceptor.ts"
---

`,
    nestjs: `---
paths:
  - "**/*.controller.ts"
  - "**/*.service.ts"
  - "**/*.module.ts"
  - "**/*.guard.ts"
  - "**/*.interceptor.ts"
  - "**/*.dto.ts"
  - "**/*.entity.ts"
  - "**/*.pipe.ts"
  - "**/*.filter.ts"
  - "**/*.middleware.ts"
---

`,
    frontend: `---
paths:
  - "**/*.html"
  - "**/*.css"
  - "**/*.scss"
  - "**/*.component.ts"
  - "**/*.component.html"
---

`,
    backend: `---
paths:
  - "**/controllers/**"
  - "**/services/**"
  - "**/repositories/**"
  - "**/entities/**"
  - "**/migrations/**"
  - "**/middleware/**"
  - "**/guards/**"
  - "**/interceptors/**"
  - "**/filters/**"
---

`,
  },
  opencode: {
    typescript: "",
    angular: "",
    nestjs: "",
    frontend: "",
    backend: "",
  },
};

function getRuleKey(filename) {
  return filename.replace("standards-", "").replace(".md", "");
}

function processTemplate(templatePath, variant) {
  let content = readFileSync(templatePath, "utf-8");
  const filename = templatePath.replace(TEMPLATES_DIR + "/", "");
  const ruleKey = getRuleKey(filename);
  const frontmatter = FRONTMATTERS[variant][ruleKey] || "";

  content = content.replace("{{frontmatter}}", frontmatter);

  return content;
}

const args = process.argv.slice(2);
const target = args[0]?.replace("--", "") || "both";

console.log(
  "═══════════════════════════════════════════════════════════════════",
);
console.log("  Sentinal Rules Generator");
console.log(
  "═══════════════════════════════════════════════════════════════════\n",
);

if (!existsSync(TEMPLATES_DIR)) {
  console.error("Templates directory not found:", TEMPLATES_DIR);
  process.exit(1);
}

const templates = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".md"));

if (target === "both" || target === "claude") {
  console.log("Generating Claude Code rules...");
  for (const template of templates) {
    const content = processTemplate(join(TEMPLATES_DIR, template), "claude");
    const outPath = join(OUTPUT_DIRS.claude, template);
    writeFileSync(outPath, content);
    console.log(`  ✓ ${template} -> targets/claude-code/rules/`);
  }
}

if (target === "both" || target === "opencode") {
  console.log("\nGenerating OpenCode rules...");
  for (const template of templates) {
    const content = processTemplate(join(TEMPLATES_DIR, template), "opencode");
    const outPath = join(OUTPUT_DIRS.opencode, template);
    writeFileSync(outPath, content);
    console.log(`  ✓ ${template} -> targets/opencode/rules/`);
  }
}

console.log("\nDone!");
