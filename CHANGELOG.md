## [1.11.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.11.0...v1.11.1) (2026-03-14)


### Bug Fixes

* stabilize sidecar port file and improve plugin auto-capture reliability ([2633ce0](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/2633ce057f8a75e5e0e3daecccb4c5bd8156acab))

# [1.11.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.10.1...v1.11.0) (2026-03-14)


### Bug Fixes

* support .tsx/.jsx files in TDD guard test detection and companion path resolution ([0fb700e](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/0fb700ec0ed6a05ffd4debe120281d5ad4d6364a))


### Features

* extend TDD guard to support Go, Python, Rust, and C/C++ languages ([207c45a](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/207c45a6f0df3f04b91887f08a3d2bfb5a09ab0a))

## [1.10.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.10.0...v1.10.1) (2026-03-14)


### Bug Fixes

* dual-write skills to both .claude/skills/ and .opencode/skills/ in learn and sync commands ([b34de87](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/b34de871da1f3fb261f321f2f2ec3410f935988a))

# [1.10.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.9.2...v1.10.0) (2026-03-12)


### Bug Fixes

* prevent sidecar idle-shutdown mid-session via MCP keepalive ping loop ([2690b04](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/2690b04ecea407bb412bb48ff5f57cb44d8963f3))


### Features

* add LSP integration — rules, analysis MCP tools, and skill updates ([0909da4](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/0909da4515d01bcb59dfe89d796e6aba566241bc))

## [1.9.2](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.9.1...v1.9.2) (2026-03-12)


### Bug Fixes

* prevent stale sidecar processes via idle auto-shutdown and cleanup handlers ([632cea6](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/632cea6d4744ca24484cbc2932e61c307a6f1af6))

## [1.9.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.9.0...v1.9.1) (2026-03-12)


### Bug Fixes

* add mandatory verification handoff to spec-implement skill ([07ef101](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/07ef10194ad13512e2fe6e08cf44c43070559a74))
* isolate sidecar client tests from live sidecar via path mocks ([175fa99](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/175fa990db403a359168a3d3ad2b82f243d3e80c))

# [1.9.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.8.0...v1.9.0) (2026-03-12)


### Bug Fixes

* replace hardcoded cwd in worktree test with dynamic project root ([ee11e98](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/ee11e98b4f49686885a53fa91361b3da7b3f678a))


### Features

* add 10 MCP tools for spec/worktree workflows and move worktree domain ([9aa69de](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/9aa69de330e078104f2052b415a60838702f98ea))
* add TDD guard MCP tools and refactor spec/worktree tools for sidecar-first ([ebe84c7](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/ebe84c7cc1c642ed91acf5552910001dabc9c8e9))

# [1.8.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.7.0...v1.8.0) (2026-03-12)


### Features

* deep-merge install config, smart uninstall cleanup, and plan-adjacent reviewer output ([e8fe092](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/e8fe092be680e18cdd39da3ce17f70179ca2ec82))

# [1.7.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.6.0...v1.7.0) (2026-03-12)


### Features

* exempt NestJS convention files from TDD guard and expand agent permissions ([99fa887](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/99fa8871b16a2505b4165636762f7479a77fe620))

# [1.6.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.5.1...v1.6.0) (2026-03-11)


### Features

* preserve binary during uninstall, auto-reinstall plugins on update ([df24cf2](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/df24cf295f1c5a5861b07d7001beeea26b0cf62d))

## [1.5.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.5.0...v1.5.1) (2026-03-11)


### Bug Fixes

* incorrect opencode agent fields causing crash to terminal and fix sidecar cleanup race condition ([8dded54](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/8dded5450102d2126c5917de04ab9c664c92dd9e))

# [1.5.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.4.4...v1.5.0) (2026-03-11)


### Features

* market research feature parity - rules, commands, agents upgrade ([999cc5f](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/999cc5fa39c283ca307231ac002718fb4ed0bdd0))

## [1.4.4](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.4.3...v1.4.4) (2026-03-11)


### Bug Fixes

* claude status line updates and permission relaxing ([f556ed3](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/f556ed3fce4687383b1ae5ef47ad5085f798c2d9))
* claude status line updates and permission relaxing ([a0a6ff8](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/a0a6ff89d4260832b743ece27adeb8a4af47a589))

## [1.4.3](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.4.2...v1.4.3) (2026-03-11)


### Bug Fixes

* opencode permissions ([04ede1e](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/04ede1e84af4f723d19302155353a8cc06c779bc))

## [1.4.2](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.4.1...v1.4.2) (2026-03-11)


### Bug Fixes

* multiple sidecars spawning ([ad0e3a4](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/ad0e3a409e4120f76087844df47a289bdb32959a))

## [1.4.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.4.0...v1.4.1) (2026-03-11)


### Bug Fixes

* sentinal update CLI command not working ([a90984a](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/a90984ae8b5add0965da417a9ab2ad599c4ade3e))

# [1.4.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.3.1...v1.4.0) (2026-03-10)


### Features

* **cli:** add usage stats statusline and detailed usage report ([3c626dd](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/3c626dd0e3ff8223161077f3c3c145e64349aa86))

## [1.3.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.3.0...v1.3.1) (2026-03-10)


### Bug Fixes

* opencode agents and overall skills being broken ([bc11bf1](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/bc11bf184b2556d62b7381b52ee39c3c7faa5f74))

# [1.3.0](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.2.3...v1.3.0) (2026-03-10)


### Features

* **cli:** add support for GITHUB_TOKEN to the update CLI command ([5f20dde](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/5f20dde6f0791870b2ed1771e15f7dd566aa65e7))

## [1.2.3](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.2.2...v1.2.3) (2026-03-10)


### Bug Fixes

* installer to use embedded plugin assets ([7b5d3b1](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/7b5d3b1b59406aa21a1e4dbaa78a8579d243000f))

## [1.2.2](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.2.1...v1.2.2) (2026-03-10)


### Bug Fixes

* installer and uninstaller ([a0fedef](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/a0fedef77c25719d512667fdf4bdb9806478a0f7))

## [1.2.1](https://github.com/Endpoint-Esports-Ltd/sentinal/compare/v1.2.0...v1.2.1) (2026-03-10)


### Bug Fixes

* **ci:** update Bun test timeout to 30s ([fe66b5e](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/fe66b5ec2b0eb8c3b1177c19136e0dd02f6692e8))
* release process and installer issues ([a197736](https://github.com/Endpoint-Esports-Ltd/sentinal/commit/a1977362182dbef1fe0b0f43639b8384fd478a29))

# Changelog

All notable changes to this project will be automatically documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.
