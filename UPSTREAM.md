# Upstream relationship

AIKombinat is an independent experimental fork of [HyperAITeam/CLITrigger](https://github.com/HyperAITeam/CLITrigger).

## Attribution

The upstream CLITrigger project is authored by HyperAI Team and distributed under the MIT License.

AIKombinat preserves the original MIT copyright and license notice in [LICENSE](LICENSE). Git history is intentionally retained so the origin of inherited and modified code remains traceable.

AIKombinat is not an official CLITrigger release and should not be interpreted as being endorsed or maintained by HyperAI Team.

## What remains upstream

The following identities still belong to the upstream project unless/until this fork deliberately replaces them:

- the `clitrigger` npm package;
- upstream CLITrigger releases;
- upstream Wiki/documentation;
- CLITrigger branding that still exists in inherited runtime/UI code.

The fork is being renamed incrementally. Repository identity has changed to AIKombinat, while some executable/package/application identifiers remain inherited for compatibility during experimentation.

## Divergence policy

AIKombinat is expected to diverge rather than remain a minimal patch set.

The fork may:

- replace existing subsystems;
- make breaking schema or API changes;
- add experimental provider integrations;
- introduce autonomous-development features that are too opinionated or unstable for upstream;
- add broader AI automation features outside CLITrigger's original scope.

This is intentional.

At the same time, useful upstream fixes can still be selectively merged when they do not conflict with the fork's architecture.

## Suggested git remote layout

For a local checkout:

```bash
git remote -v

git remote add upstream https://github.com/HyperAITeam/CLITrigger.git
git fetch upstream
```

Recommended meaning:

```text
origin   -> bojlahg/AIKombinat
upstream -> HyperAITeam/CLITrigger
```

Do not blindly merge upstream `main` into AIKombinat once the same subsystem has substantially diverged. Prefer reviewing changes by topic and porting relevant fixes deliberately.

## Issues and pull requests

Use the upstream repository for issues that reproduce on unmodified CLITrigger and are unrelated to AIKombinat changes.

Use AIKombinat for:

- fork-specific regressions;
- Model Catalog / Execution Profile behavior;
- experimental routing and autonomous pipeline work;
- deliberate divergence from upstream behavior;
- broader AI Kombinat experiments.

## Publication safety

The npm name `clitrigger` belongs to the upstream project. AIKombinat should not publish a fork build under that package identity.

If the fork later gets packaged independently, it should use its own package/release identifiers and make the upstream relationship visible in its documentation and license materials.
