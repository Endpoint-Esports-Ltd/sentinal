# Project Name

<!-- TODO: Update with your project name and description -->

## Overview

<!-- TODO: Brief description of what this project does -->

## Tech Stack

- **Frontend:** <!-- e.g., Angular 17+, React 18+ -->
- **Backend:** <!-- e.g., NestJS, Express, Fastify -->
- **Database:** <!-- e.g., PostgreSQL, MongoDB -->
- **Testing:** <!-- e.g., Jest, Vitest, Playwright -->

## Directory Structure

```
<!-- TODO: Update with your project structure -->

src/
├── components/     # UI components
├── services/       # Business logic
├── models/         # Data models
├── utils/          functions
└── # Helper ...
```

## Commands

| Command         | Description              |
| --------------- | ------------------------ |
| `npm run dev`   | Start development server |
| `npm run build` | Build for production     |
| `npm test`      | Run tests                |
| `npm run lint`  | Run linter               |

## Coding Standards

This project uses Sentinal for quality enforcement. See `.sentinal/rules/` for detailed standards:

- **TypeScript** — `.sentinal/rules/standards-typescript.md`
- **Angular** — `.sentinal/rules/standards-angular.md`
- **NestJS** — `.sentinal/rules/standards-nestjs.md`
- **Frontend** — `.sentinal/rules/standards-frontend.md`
- **Backend** — `.sentinal/rules/standards-backend.md`

## Sentinal Workflow

Use `/spec` for structured development:

```
/spec Add user profile component
/spec Fix login bug
/spec docs/plans/2026-03-04-user-profile.md  # Resume existing plan
```

## Tips

<!-- TODO: Add project-specific tips -->

- Use `npm` as the package manager
- Run tests with `npm test`
- Lint before committing
