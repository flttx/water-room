# Drowned Halls

A first-person underwater survival game built with Three.js, the Web Audio API, and Vite. Explore a flooded bathhouse, activate its valves, follow the building's escape route, and avoid creatures with distinct movement and hunting behaviors.

The game supports English and Simplified Chinese. English is selected by default; use the language selector on the title screen or in Settings to switch languages. The choice is saved with the other game settings.

## Requirements

- Node.js 24 LTS
- npm (use the repository's `package-lock.json`)
- A browser with WebGL support for local play and visual regression. Browser automation scripts use system Chrome.

## Development

```sh
npm ci
npm run dev
```

Vite serves the game at `http://127.0.0.1:5173` by default. Open the local URL printed in the terminal.

## Controls

- `W/A/S/D` or the arrow keys to move; move the mouse to look around.
- `Shift` to run, `C` to crouch/stand or dive from the surface, and `Space` to jump or climb onto an edge.
- Hold `E` near a valve to turn it; press `F` to toggle the flashlight; press `Esc` to pause.

## Validation

```sh
npm run lint
npm run test:regression
npm run build
npm run check
```

`npm run check` runs ESLint, navigation and creature-collision regressions, and a production build in sequence. Additional focused checks include:

```sh
node tools/lurker-patrol-check.mjs
node tools/lurker-motion-check.mjs
node tools/swimmer-motion-check.mjs
node tools/dome-motion-check.mjs --only=angler
```

`node tools/difficulty-check.mjs` and `node tools/swimmer-visual-check.mjs` launch system Chrome. The difficulty check covers settings, navigation, live monster markers, and patrol scenes; the visual check inspects real WebGL models.

The full movement diagnostics are:

```sh
node tools/hunter-motion-check.mjs
node tools/dome-motion-check.mjs
```

These diagnostics currently report persistent stalls on the Hunter's narrow turns, the Kraken's dive, the Spider Crab's west side, and the Whale's route, and exit with a non-zero status. This records known unresolved behavior. Do not add these full diagnostics to the pass criteria or remove their failure assertions until the issues are fixed. Use `--only=whale`, `--only=crab`, or `--only=angler` to check one reservoir creature. Run the Hunter's focused regression with `node tools/hunter-motion-check.mjs --regression`.

## Project structure

- `src/main.js`: game setup, frame updates, and module orchestration.
- `src/player.js`, `src/input.js`: player movement and input.
- `src/level/`: map, building shell, floor elevation, route nodes, and level resources.
- `src/navigation.js`, `src/ui/navigation-hud.js`: traversable routes and navigation display.
- `src/creatures/`: creature behavior, models, rigged animation, and collision.
- `src/render/`: water, effects, and post-processing.
- `src/ui/`: title screen, settings, and HUD.
- `src/i18n.js`: English and Simplified Chinese messages and locale helpers.
- `public/`: runtime assets and processed models; model-generation tools are in `tools/`.

## Project guidelines

See [AGENTS.md](AGENTS.md) for collaboration and validation rules. See [tools/creature-collision-audit.md](tools/creature-collision-audit.md) for the background and process behind creature-collision checks.
