# AIKombinat

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bojlahg/AIKombinat/main/src/client/public/logo.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/bojlahg/AIKombinat/main/src/client/public/logo.svg">
  <img alt="AIKombinat" src="https://raw.githubusercontent.com/bojlahg/AIKombinat/main/src/client/public/logo.svg" width="360">
</picture>

**An IDE for AI CLI Agents**

*Docs, plans, terminals, autonomous agents, and git — one workspace instead of five scattered tools.*

<p align="center">
  <a href="https://github.com/bojlahg/AIKombinat/blob/main/README.md">English</a> ·
  <a href="https://github.com/bojlahg/AIKombinat/blob/main/README_KR.md">한국어</a>
</p>

> **Experimental fork of [CLITrigger](https://github.com/HyperAITeam/CLITrigger)** for multi-agent AI workflows, autonomous development experiments, and other AI automation ideas.

[![CI](https://github.com/bojlahg/AIKombinat/actions/workflows/ci.yml/badge.svg)](https://github.com/bojlahg/AIKombinat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Upstream](https://img.shields.io/badge/upstream-CLITrigger-blue.svg)](https://github.com/HyperAITeam/CLITrigger)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-18-61dafb.svg)](https://react.dev)
[![GitHub stars](https://img.shields.io/github/stars/bojlahg/AIKombinat.svg?style=social)](https://github.com/bojlahg/AIKombinat/stargazers)

AIKombinat starts from the excellent CLITrigger codebase and intentionally explores a more experimental direction.

The current main track is **AI-assisted and increasingly autonomous software development**: multiple coding CLIs, model discovery, execution profiles, task routing, isolated worktrees, review/rework loops, and eventually a resumable development pipeline that can keep working with limited human supervision.

The repository is also intentionally broader than coding alone. The long-term idea behind the name **AI Kombinat** is a collection of connected AI "workshops": coding is the first major one, but image generation, batch media workflows, transcription/audio, local models, and other useful AI automation may live here later.

<img src="https://raw.githubusercontent.com/bojlahg/AIKombinat/main/docs/images/demo.gif" alt="AIKombinat demo — parallel AI agents executing in isolated worktrees, then morning diff review" width="800">

> **Status:** experimental. Expect breaking changes, unfinished ideas, provider-specific edge cases, and features that may be redesigned or removed after testing.

---

> ### Docs → Plan → Terminal → Autonomous Tasks → Version Control. One pipeline.
>
> Developing with AI CLI agents (Claude Code, Codex, Antigravity, …) scatters the workflow across disconnected tools: requirements in a note app, plans somewhere else, agents across terminal windows, results in a git client. Editor-centric development has the IDE; CLI-agent-centric development usually does not.
>
> AIKombinat connects that workflow into a single pipeline: build project knowledge in **Docs**, shape it into a plan with the **planner & calendar**, refine it in **terminal sessions**, hand it to multiple AI CLIs for **parallel autonomous execution** in isolated git worktrees, and land the results through the **review queue and built-in Git client**.
>
> **Each stage can inherit the context of the one before it, so intent does not have to be manually ferried between five different tools.**

---

## Fork relationship

AIKombinat is a fork of **CLITrigger** by HyperAI Team.

- Original project: [HyperAITeam/CLITrigger](https://github.com/HyperAITeam/CLITrigger)
- License: [MIT](LICENSE)
- Upstream copyright and license notices are preserved.
- AIKombinat is an independent experimental fork and is not presented as an official CLITrigger release or endorsed continuation.
- Bugs in unmodified upstream behavior may belong upstream; bugs or behavior specific to this fork belong here.
- Upstream changes may be selectively merged when they remain compatible with the direction of this fork.

See [UPSTREAM.md](UPSTREAM.md) for the relationship and sync policy.

---

## Why this fork exists

CLITrigger already provides a strong practical base: a web/desktop workspace around AI CLI agents, isolated git worktrees, tasks, schedules, sessions, discussions, review, and Git tooling.

AIKombinat keeps that foundation but experiments more aggressively with the layer above individual CLI calls:

- a persistent **Model Catalog** instead of assuming a small hardcoded model list;
- **Execution Profiles** that describe task classes and allowed executor/model/effort candidates;
- provider-native effort/reasoning settings;
- model discovery for Claude Code, Codex, and Antigravity;
- explicit handling of missing models and uncertain provider capabilities;
- user-controlled ordering of commonly used models;
- stronger execution snapshots and preflight validation;
- experiments toward executor availability, quota-aware routing, shared resources, review/rework, and autonomous pipelines.

Some of these features are already implemented; others are roadmap items. The distinction matters because software has suffered enough from READMEs describing alternate universes.

---

## The "DarkFactory" direction

**DarkFactory** is an internal direction/codename for the autonomous-development track, not the public name of this repository.

The intended shape is roughly:

```mermaid
flowchart LR
    goal[Goal / Spec] --> plan[Planning & Decomposition]
    plan --> profile[Execution Profile]
    profile --> route[Executor Selection]
    route --> run[Implementation]
    run --> review[Review / QA]
    review -->|needs changes| rework[Rework]
    rework --> run
    review -->|approved| done[Done / Merge]