# [1.21.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.20.2...v1.21.0) (2026-03-19)


### Bug Fixes

* stop hook no longer blocks on PENDING plans ([66d7bff](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/66d7bffcd2f859f500bc1120dd0d3df260f97d51))


### Features

* add execution wave grouping and parallel task implementation to spec workflow ([685403b](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/685403b374cada82d437e9b3d69e0e5a4777d2f9))

## [1.20.2](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.20.1...v1.20.2) (2026-03-18)


### Bug Fixes

* add timeout and progress indicator to sentinal update downloads ([405d23e](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/405d23ed683ad1c26fcf587e3659ab8d081af818))

## [1.20.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.20.0...v1.20.1) (2026-03-18)


### Bug Fixes

* dashboard stale version, empty memories, and missing fragment routes ([1c603cc](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/1c603cc9465f8bbb480306e66e1e9549b7623170))

# [1.20.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.19.2...v1.20.0) (2026-03-18)


### Features

* add /quick command, /pause with resume detection, and spec_metrics ([5c6f8bd](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/5c6f8bdbef718940e341758333e8c8c9b67ceb14))

## [1.19.2](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.19.1...v1.19.2) (2026-03-18)


### Bug Fixes

* add verification action prompt for COMPLETE plans in prompt-context ([a027382](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/a027382b4ee956d7fa2d3c6bf7e7ac0ff90cc980))

## [1.19.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.19.0...v1.19.1) (2026-03-18)


### Bug Fixes

* resolve cross-platform parity issues and stale references from audit ([0314c8d](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/0314c8d0c31761e91a059d3717d3cf4953ab5eff))

# [1.19.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.18.0...v1.19.0) (2026-03-18)


### Features

* add GSD-inspired quality guards and compound spec_init MCP tool ([f9ca385](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/f9ca3852469ef5e562e6256f323a9925fe683ea5))

# [1.18.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.17.0...v1.18.0) (2026-03-18)


### Features

* add IN_PROGRESS status lifecycle and master plans with wave execution ([bac3009](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/bac30097701f076f00b724d0703b264ae3ac36ee))

# [1.17.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.16.0...v1.17.0) (2026-03-17)


### Bug Fixes

* add per-test timeouts to quality-check tests for CI reliability ([0fd2ec7](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/0fd2ec7549a143592b937733de1b629ad05ba110))
* use dynamic timestamps in getUsageSummary tests to avoid rolling window expiry ([309e81b](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/309e81b7043667a2258cf07f042c4808edb337f0))


### Features

* async hooks, subagent-scoped MCP, and prompt context injection ([80c7f11](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/80c7f11b73e3ae9153e30d6347a84ff6a886fb8f))

# [1.16.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.15.0...v1.16.0) (2026-03-16)


### Features

* make all quality checks on-demand instead of per-edit ([de2a53d](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/de2a53d296391f8cb272a3e0906fe651d62e934f))

# [1.15.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.14.1...v1.15.0) (2026-03-16)


### Features

* push out a release ([2484ee2](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/2484ee27dce45c54f808d3ab5772302bbdd2eb09))

## [1.14.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.14.0...v1.14.1) (2026-03-16)


### Bug Fixes

* return JSON errors from sidecar and prefer local tool binaries ([32e2f6e](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/32e2f6e843f8d72a100628bfcd2598272a1f8651))

# [1.14.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.13.0...v1.14.0) (2026-03-16)


### Features

* replace idle timeout with session-aware sidecar lifecycle ([92e9b3e](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/92e9b3eb1e22190eb7280e994aa8526716a3f76d))

# [1.13.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.12.0...v1.13.0) (2026-03-16)

### Features

- add cross-session conflict detection, OpenCode TDD parity, and LSP diagnostics ([0a6f1ad](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/0a6f1adf247b0b4e168ffb775977637c13534ecd))
- add project_context MCP tool and pre-edit guidance hook ([afba4b8](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/afba4b8826c3fe0a5843c0e866ea130e4572b0b6))
- add shareable project memory via .sentinal/project-memory.json ([2c046c0](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/2c046c0dfee93347996923f23922adfd923b9ecc))
- add smart memory with semantic restore, quality scoring, and failed approach detection ([49cf331](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/49cf33138b0f6642e477bc028cf6c982dceb7c4a))
- move quality checks into sidecar with incremental tsc and quality_report MCP tool ([749d25b](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/749d25b8f5e4bbe866c0ab6c8946d51c54b83aab))

# [1.12.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.11.2...v1.12.0) (2026-03-15)

### Features

- add offline observation queue and fix memory capture parity ([facc656](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/facc65643b0b9f26672b8d4145f9ef7560d85405))

## [1.11.2](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.11.1...v1.11.2) (2026-03-15)

### Bug Fixes

- read tool_response output in Claude Code memory-observer hook ([84a2728](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/84a2728ed2e8e54834a0e660cb9e38ac62165fd1))

## [1.11.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.11.0...v1.11.1) (2026-03-14)

### Bug Fixes

- stabilize sidecar port file and improve plugin auto-capture reliability ([2633ce0](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/2633ce057f8a75e5e0e3daecccb4c5bd8156acab))

# [1.11.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.10.1...v1.11.0) (2026-03-14)

### Bug Fixes

- support .tsx/.jsx files in TDD guard test detection and companion path resolution ([0fb700e](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/0fb700ec0ed6a05ffd4debe120281d5ad4d6364a))

### Features

- extend TDD guard to support Go, Python, Rust, and C/C++ languages ([207c45a](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/207c45a6f0df3f04b91887f08a3d2bfb5a09ab0a))

## [1.10.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.10.0...v1.10.1) (2026-03-14)

### Bug Fixes

- dual-write skills to both .claude/skills/ and .opencode/skills/ in learn and sync commands ([b34de87](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/b34de871da1f3fb261f321f2f2ec3410f935988a))

# [1.10.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.9.2...v1.10.0) (2026-03-12)

### Bug Fixes

- prevent sidecar idle-shutdown mid-session via MCP keepalive ping loop ([2690b04](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/2690b04ecea407bb412bb48ff5f57cb44d8963f3))

### Features

- add LSP integration — rules, analysis MCP tools, and skill updates ([0909da4](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/0909da4515d01bcb59dfe89d796e6aba566241bc))

## [1.9.2](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.9.1...v1.9.2) (2026-03-12)

### Bug Fixes

- prevent stale sidecar processes via idle auto-shutdown and cleanup handlers ([632cea6](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/632cea6d4744ca24484cbc2932e61c307a6f1af6))

## [1.9.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.9.0...v1.9.1) (2026-03-12)

### Bug Fixes

- add mandatory verification handoff to spec-implement skill ([07ef101](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/07ef10194ad13512e2fe6e08cf44c43070559a74))
- isolate sidecar client tests from live sidecar via path mocks ([175fa99](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/175fa990db403a359168a3d3ad2b82f243d3e80c))

# [1.9.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.8.0...v1.9.0) (2026-03-12)

### Bug Fixes

- replace hardcoded cwd in worktree test with dynamic project root ([ee11e98](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/ee11e98b4f49686885a53fa91361b3da7b3f678a))

### Features

- add 10 MCP tools for spec/worktree workflows and move worktree domain ([9aa69de](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/9aa69de330e078104f2052b415a60838702f98ea))
- add TDD guard MCP tools and refactor spec/worktree tools for sidecar-first ([ebe84c7](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/ebe84c7cc1c642ed91acf5552910001dabc9c8e9))

# [1.8.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.7.0...v1.8.0) (2026-03-12)

### Features

- deep-merge install config, smart uninstall cleanup, and plan-adjacent reviewer output ([e8fe092](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/e8fe092be680e18cdd39da3ce17f70179ca2ec82))

# [1.7.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.6.0...v1.7.0) (2026-03-12)

### Features

- exempt NestJS convention files from TDD guard and expand agent permissions ([99fa887](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/99fa8871b16a2505b4165636762f7479a77fe620))

# [1.6.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.5.1...v1.6.0) (2026-03-11)

### Features

- preserve binary during uninstall, auto-reinstall plugins on update ([df24cf2](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/df24cf295f1c5a5861b07d7001beeea26b0cf62d))

## [1.5.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.5.0...v1.5.1) (2026-03-11)

### Bug Fixes

- incorrect opencode agent fields causing crash to terminal and fix sidecar cleanup race condition ([8dded54](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/8dded5450102d2126c5917de04ab9c664c92dd9e))

# [1.5.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.4.4...v1.5.0) (2026-03-11)

### Features

- market research feature parity - rules, commands, agents upgrade ([999cc5f](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/999cc5fa39c283ca307231ac002718fb4ed0bdd0))

## [1.4.4](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.4.3...v1.4.4) (2026-03-11)

### Bug Fixes

- claude status line updates and permission relaxing ([f556ed3](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/f556ed3fce4687383b1ae5ef47ad5085f798c2d9))
- claude status line updates and permission relaxing ([a0a6ff8](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/a0a6ff89d4260832b743ece27adeb8a4af47a589))

## [1.4.3](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.4.2...v1.4.3) (2026-03-11)

### Bug Fixes

- opencode permissions ([04ede1e](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/04ede1e84af4f723d19302155353a8cc06c779bc))

## [1.4.2](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.4.1...v1.4.2) (2026-03-11)

### Bug Fixes

- multiple sidecars spawning ([ad0e3a4](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/ad0e3a409e4120f76087844df47a289bdb32959a))

## [1.4.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.4.0...v1.4.1) (2026-03-11)

### Bug Fixes

- sentinal update CLI command not working ([a90984a](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/a90984ae8b5add0965da417a9ab2ad599c4ade3e))

# [1.4.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.3.1...v1.4.0) (2026-03-10)

### Features

- **cli:** add usage stats statusline and detailed usage report ([3c626dd](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/3c626dd0e3ff8223161077f3c3c145e64349aa86))

## [1.3.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.3.0...v1.3.1) (2026-03-10)

### Bug Fixes

- opencode agents and overall skills being broken ([bc11bf1](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/bc11bf184b2556d62b7381b52ee39c3c7faa5f74))

# [1.3.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.2.3...v1.3.0) (2026-03-10)

### Features

- **cli:** add support for GITHUB_TOKEN to the update CLI command ([5f20dde](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/5f20dde6f0791870b2ed1771e15f7dd566aa65e7))

## [1.2.3](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.2.2...v1.2.3) (2026-03-10)

### Bug Fixes

- installer to use embedded plugin assets ([7b5d3b1](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/7b5d3b1b59406aa21a1e4dbaa78a8579d243000f))

## [1.2.2](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.2.1...v1.2.2) (2026-03-10)

### Bug Fixes

- installer and uninstaller ([a0fedef](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/a0fedef77c25719d512667fdf4bdb9806478a0f7))

## [1.2.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.2.0...v1.2.1) (2026-03-10)

### Bug Fixes

- **ci:** update Bun test timeout to 30s ([fe66b5e](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/fe66b5ec2b0eb8c3b1177c19136e0dd02f6692e8))
- release process and installer issues ([a197736](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/a1977362182dbef1fe0b0f43639b8384fd478a29))

# Changelog

All notable changes to this project will be automatically documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.
