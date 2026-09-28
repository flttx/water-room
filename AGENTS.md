# Project Collaboration Guide

## Project scope

This is a first-person underwater survival game built with Three.js and Vite. Runtime code lives in `src/`, and the browser entry point is `index.html`. Art, audio, and game models are under `public/`. The `tools/` directory contains validation scripts, model-processing utilities, and related notes.

## Change principles

- Before editing, read the target module and its callers. Check map units, coordinates, elevation, and collision constraints.
- Keep changes within the current request. Reuse existing modules and data formats; avoid abstractions or dependencies without a concrete need.
- Physics and creature movement must use the existing collision, pose-safety, and player-traversal rules. Do not fake success by teleporting, clipping through walls, skipping collisions, or freezing objects.
- The game uses procedurally generated audio and Three.js resource cleanup. When changing async flows, scene lifecycles, geometry, or materials, check failure handling and cleanup paths.
- UI changes must preserve narrow-screen support, keyboard operation, and relevant ARIA semantics.
- Do not add secrets or expose raw errors in the UI. Do not leave `console.log` calls in production code.
- Do not edit `node_modules/` or `dist/`.

## Tools and validation

- Use Node.js 24 LTS and npm. Dependencies are locked by `package-lock.json`; install them with `npm ci`.
- Run `npm run dev` to start the local development server. Vite listens on `127.0.0.1` by default.
- Before submitting, run `npm run check`. It runs ESLint, whole-map navigation and creature-collision regressions, and a production build in sequence.
- For creature behavior changes, run the relevant checks: `node tools/creature-check.mjs`, `node tools/lurker-motion-check.mjs`, `node tools/swimmer-motion-check.mjs`, or `node tools/dome-motion-check.mjs --only=<whale|crab|angler>`.
- For difficulty, HUD, or game-flow changes, run the relevant Node regressions. `tools/difficulty-check.mjs` and `tools/swimmer-visual-check.mjs` require local Chrome.
- The full `tools/hunter-motion-check.mjs` and `tools/dome-motion-check.mjs` diagnostics currently include known route failures and report them with a non-zero exit code. They are not part of `npm run test:regression`. Once those issues are fixed, include the results in the pass criteria.
- Keep failures and explain them unless a check depends on an external service or an expensive hands-on process. Do not remove or weaken checks to get a green run.

## Code style

- Use JavaScript ES modules, single quotes, semicolons, and two-space indentation.
- Use browser globals only in `src/`; use Node globals only in `tools/` and root configuration scripts.
- Avoid unnecessary global state in production code. Follow the import order used by nearby modules.
- Use `rg` to locate code and scripts. Keep validation instructions and documentation aligned with the actual scripts and their current results.

## Git conventions

- Commit messages use `<type>(<scope>): <description>`. Supported types are `feat`, `fix`, `refactor`, `style`, `chore`, `docs`, and `i18n`.
- Before committing, run `git diff --check` and stage only files related to the current task.
- Do not push or publish unless explicitly requested.
