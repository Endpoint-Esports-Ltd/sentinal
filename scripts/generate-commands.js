#!/usr/bin/env node
/**
 * Command Template Generator
 * 
 * Generates Claude Code and OpenCode command files from shared templates.
 * 
 * Usage:
 *   node scripts/generate-commands.js
 *   node scripts/generate-commands.js --claude
 *   node scripts/generate-commands.js --opencode
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const TEMPLATES_DIR = join(ROOT, "templates", "commands");
const OUTPUT_DIRS = {
  claude: join(ROOT, "targets", "claude-code", "commands"),
  opencode: join(ROOT, "targets", "opencode", "commands"),
};

// Variables for each target
const VARIANTS = {
  claude: {
    routeSkill: (name, args) => `Skill(skill='${name}', args='${args}')`,
  },
  opencode: {
    routeSkill: (name, args) => `/${name} ${args}`,
  },
};

// Process a template file
function processTemplate(templatePath, variant) {
  let content = readFileSync(templatePath, "utf-8");
  const vars = VARIANTS[variant];
  const filename = templatePath.replace(TEMPLATES_DIR + "/", "").replace(".md", "");
  
  // Replace variables in frontmatter
  content = content.replace(/{{description}}/g, getDescription(filename));
  content = content.replace(/{{agent}}/g, "");
  content = content.replace(/{{subtask}}/g, "");
  
  // Process route replacements
  content = content.replace(/Skill\(skill='(\w+)', args='([^']+)'\)/g, (_, name, args) => {
    return vars.routeSkill(name, args);
  });
  
  // Clean up empty frontmatter fields
  content = content.replace(/^(\w+): $\n/gm, "");
  content = content.replace(/^(\w+): \n/gm, "");
  
  return content;
}

function getDescription(filename) {
  const descriptions = {
    "spec": "Spec-driven development - plan, implement, verify workflow",
    "spec-plan": "Feature planning phase - explore codebase, design plan, get approval",
    "spec-bugfix-plan": "Bugfix planning phase - analyze bug, design fix, get approval",
    "spec-implement": "TDD implementation phase - execute plan tasks with RED-GREEN-REFACTOR",
    "spec-verify": "Feature verification phase - tests, automated checks, code review, E2E",
    "spec-bugfix-verify": "Bugfix verification phase - Behavior Contract audit, tests, process compliance",
    "sync": "Sync project rules and generate AGENTS.md from codebase analysis",
    "learn": "Extract reusable knowledge from the current session",
  };
  return descriptions[filename] || filename;
}

// Main
const args = process.argv.slice(2);
const target = args[0]?.replace("--", "") || "both";

console.log("═══════════════════════════════════════════════════════════════════");
console.log("  Sentinal Command Generator");
console.log("═══════════════════════════════════════════════════════════════════\n");

if (!existsSync(TEMPLATES_DIR)) {
  console.error("Templates directory not found:", TEMPLATES_DIR);
  process.exit(1);
}

const templates = readdirSync(TEMPLATES_DIR).filter(f => f.endsWith(".md"));

if (target === "both" || target === "claude") {
  console.log("Generating Claude Code commands...");
  for (const template of templates) {
    const content = processTemplate(join(TEMPLATES_DIR, template), "claude");
    const outPath = join(OUTPUT_DIRS.claude, template);
    writeFileSync(outPath, content);
    console.log(`  ✓ ${template} -> targets/claude-code/commands/`);
  }
}

if (target === "both" || target === "opencode") {
  console.log("\nGenerating OpenCode commands...");
  for (const template of templates) {
    const content = processTemplate(join(TEMPLATES_DIR, template), "opencode");
    const outPath = join(OUTPUT_DIRS.opencode, template);
    writeFileSync(outPath, content);
    console.log(`  ✓ ${template} -> targets/opencode/commands/`);
  }
}

console.log("\nDone!");
