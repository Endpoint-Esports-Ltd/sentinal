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

export const AGENTS_MD_GLOBAL = `# Sentinal Global Standards

This file is automatically loaded by OpenCode for all projects.

## Quality Enforcement

Sentinal automatically enforces quality standards on every file edit:
- **File length:** Warn at 400 lines, block at 600 lines (test files exempt)
- **TDD:** Check for companion test files on implementation files
- **NestJS:** Validate decorators on controllers, DTOs, and entities
- **TypeScript:** Run tsc --noEmit for type checking

Note: Prettier and ESLint are handled automatically by OpenCode's built-in formatter system.

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

This project uses Sentinal for quality enforcement. See \`.opencode/rules/\` for coding standards.

## Commands

- \`/spec <task>\` - Start a spec-driven plan-implement-verify workflow
- \`/sync\` - Analyze codebase and generate project-specific rules
`;

export const AGENTS_MD_APPEND = `
## Sentinal Quality Enforcement

This project uses Sentinal for quality enforcement. See \`.opencode/rules/\` for coding standards.
`;
