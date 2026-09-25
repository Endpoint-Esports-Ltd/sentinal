/**
 * Install Constants
 *
 * Shared constants for the installer — MCP server configs, AGENTS.md templates,
 * and marketplace metadata. Extracted to keep install.ts under the line limit.
 */

import { join } from "node:path";
import { homedir } from "node:os";

export const MARKETPLACE_DIR = join(
  homedir(),
  ".claude",
  "plugins",
  "sentinal-marketplace",
);
export const MARKETPLACE_NAME = "sentinal-marketplace";
export const PLUGIN_NAME = "sentinal";

export const MCP_SERVERS_OPENCODE = {
  context7: {
    type: "local" as const,
    command: ["npx", "-y", "@upstash/context7-mcp"],
  },
  "web-search": {
    type: "local" as const,
    command: ["npx", "-y", "open-websearch"],
    environment: {
      MODE: "stdio",
      DEFAULT_SEARCH_ENGINE: "duckduckgo",
      ALLOWED_SEARCH_ENGINES: "duckduckgo,bing,exa",
    },
  },
  "grep-mcp": {
    type: "remote" as const,
    url: "https://mcp.grep.app",
  },
  "web-fetch": {
    type: "local" as const,
    command: ["npx", "-y", "fetcher-mcp"],
  },
  sentinal: {
    type: "local" as const,
    command: ["sentinal", "mcp-server"],
  },
};

/**
 * The `lsp` block written by a fresh `writeOpenCodeConfig` create. Exported so
 * the uninstall cleanup can tell a shipped-default block (safe to treat as
 * empty) from a user-customised one (content — the config must survive).
 */
export const OPENCODE_LSP_DEFAULT = {
  typescript: { command: ["typescript-language-server", "--stdio"] },
};

export const AGENTS_MD_GLOBAL = `# Sentinal Global Standards

This file is automatically loaded by OpenCode for all projects.

## Quality Enforcement

Sentinal runs fast structural checks on every file edit:
- **File length:** Warn at 400 lines, block at 600 lines (test files exempt)
- **TDD:** Check for companion test files on implementation files
- **NestJS:** Validate decorators on controllers, DTOs, and entities

tsc, ESLint and Prettier do NOT run on edit. After editing a file, call \`quality_report\` with \`file:\` set to it — that auto-fixes only that file. A project-wide call (no \`file\`) is report-only: it lists unformatted files and lint counts and never rewrites anything.

## Commands

- \`/spec <task>\` - Start a spec-driven plan-implement-verify workflow
- \`/spec <plan.md>\` - Resume an existing plan
- \`/sync\` - Analyze codebase and generate project-specific rules
- \`/learn\` - Extract reusable knowledge from this session

## Rule Files

The following rule files are loaded based on project context. Read them on a need-to-know basis:

- \`standards-typescript.md\` - TypeScript best practices
- \`standards-angular.md\` - Angular 17+ patterns (signals, control flow, standalone)
- \`standards-nestjs.md\` - NestJS patterns (DTOs, guards, Swagger)
- \`standards-frontend.md\` - Tailwind CSS, accessibility, responsive design
- \`standards-backend.md\` - REST API, security, database patterns
`;

export const AGENTS_MD_LOCAL_TEMPLATE = `# Project Name

TODO: Add project description.

## Sentinal Quality Enforcement

This project uses Sentinal for quality enforcement. See \`.sentinal/rules/\` for coding standards.

## Commands

- \`/spec <task>\` - Start a spec-driven plan-implement-verify workflow
- \`/sync\` - Analyze codebase and generate project-specific rules
`;

export const AGENTS_MD_APPEND = `
## Sentinal Quality Enforcement

This project uses Sentinal for quality enforcement. See \`.sentinal/rules/\` for coding standards.
`;
