# web-space
A cloud-persistent web multiplayer 2d game where players build spaceships.

---

## Gameplay

### How to Play

You start as a single cockpit block floating in the world. Use the ship editor to build your spaceship, then fly it around and interact with the world.

#### PC Controls

| Input | Action |
|-------|--------|
| `W` / `Arrow Up` | Thrust forward |
| `S` / `Arrow Down` | Thrust backward |
| `A` / `Arrow Left` | Turn left |
| `D` / `Arrow Right` | Turn right |
| `Space` | Pause / unpause |
| `X` | Trigger explosion at cursor position |
| Left-click + hold | Attract nearby entities toward cursor |
| Right-click (empty space) | Spawn a new entity |
| Right-click (entity) | Delete that entity |
| `Ctrl` + Left-click | Take control of a nearby entity |

#### Mobile Controls

| Input | Action |
|-------|--------|
| Joystick (bottom-left) | Up/down: thrust — Left/right: turn |
| Tap (normal mode) | Attract entities toward tap point |
| Tap (right-click mode) | Spawn or delete entity at tap point |
| Double-tap | Take control of tapped entity |
| Right-click mode button | Toggle between attract and spawn/delete tap behavior |

### Features

- **Ship building** — Open the editor to place and remove blocks on a 33×33 tile grid. Your ship's physics (mass, moment of inertia) update automatically when you save.
- **Physics simulation** — Ships have realistic linear and angular momentum. Collisions exchange impulses between entities, applying both linear and rotational forces.
- **Explosions** — Press `X` on PC to trigger an explosion at your cursor. Explosions cast 360 rays that damage and push blocks; destroyed blocks allow rays to continue through.
- **Entity splitting** — If an explosion or collision disconnects parts of a ship, those parts split into separate independent entities.
- **Attraction** — Hold left-click (or tap on mobile) to pull nearby entities toward your cursor with a distance-scaled force.
- **Multiple entities** — Spawn extra ships with right-click. Switch control between them with `Ctrl`+click (PC) or double-tap (mobile).
- **Cloud saves** — Game state is saved to Google Drive automatically every 30 seconds and on page close. Your ships persist across sessions.

---

## Technical

### Architecture

The game runs entirely in the browser as a single-page application served by a Python/Flask backend. There is no server-side game simulation — all physics run client-side in JavaScript.

| File | Responsibility |
|------|---------------|
| `static/js/main.js` | Game loop, input handling, camera, explosions, entity lifecycle |
| `static/js/tiles.js` | Block registry, tile rendering, collision detection, physics helpers |
| `static/js/editor.js` | Ship editor overlay (canvas-based block placement UI) |
| `static/js/drive.js` | Google Drive OAuth 2.0 integration, save/load, autosave |

### World

| Parameter | Value |
|-----------|-------|
| World size | 1000 × 1000 px (testing) |
| Tile size | 16 px |
| World boundary | Hard walls with 16 px margin; velocity clamped on impact |

### Physics

| Parameter | Value |
|-----------|-------|
| Thrust | 0.6 force/frame |
| Turn speed | 0.025 rad/frame |
| Angular damping | 1.0 (no drag) |
| Restitution (bounciness) | 0.35 |
| Baumgarte position correction | 40% overlap per step, 0.5 px slop |
| Sub-steps | 1–8 per frame, scaled so displacement per step ≤ 8 px |
| Base entity mass | 1.0 + sum of block masses |

The physics pipeline each frame:
1. **Force application** — player input and attraction forces update velocities.
2. **Sub-stepped integration** — positions and angles integrated in up to 8 sub-steps.
3. **Collision resolution** — SAT (Separating Axis Theorem) narrow phase finds deepest contact; impulse resolution handles both linear and angular response via the parallel axis theorem.
4. **Entity cleanup** — entities with no blocks are removed; disconnected block graphs are split into new entities.
5. **Explosion impulse flush** — deferred explosion impulses are distributed to entities (or proportionally to split pieces by proximity).

### Camera

The camera uses lagged lerping in all three axes to smoothly follow the player. Position lerping is performed in camera-local space to eliminate circular drift when angle is also lagging.

| Parameter | Value |
|-----------|-------|
| Position lag | 8% per frame |
| Rotation lag | 10% per frame |
| Zoom lag | 6% per frame |
| Minimum visible height | 40 tiles (640 px world-space) |

Zoom automatically scales so the player's interaction radius fills the viewport height.

### Explosions

Explosions use a raycasting model:
- **360 rays** cast from the explosion origin.
- Each ray carries `strength / 360` of the total strength budget.
- Rays attenuate linearly with distance (range = √strength px).
- Blocks are damaged; if a block's health is less than the current ray strength, it is destroyed and the ray continues with reduced strength.
- Impulses are deferred and applied after entity splitting, so split pieces each receive physically correct forces.

| Parameter | Value |
|-----------|-------|
| Default strength | 5000 |
| Rays | 360 |
| Expansion speed | 0.5 px/ms |
| Impulse scale | 0.1 per unit ray strength |

### Block System

Block types are defined server-side and served from `/api/block-registry`, cached in `localStorage`. Each block type has:
- `size` — tile footprint (x × y tiles)
- `color` — RGB display color
- `maxHealth` — hit points
- `mass` — contribution to entity mass

Each block instance on an entity stores its current `health`. Damage reduces health; at zero the block is removed, and the entity's physics properties are recomputed. If the remaining blocks are no longer all connected, the entity is split.

### Persistence

Game state is serialized to JSON and stored in Google Drive under `/.webspace/save.json`. The save includes all entity positions, velocities, angles, and complete block data for every entity. Autosave triggers every 30 seconds and on page hide/close.
