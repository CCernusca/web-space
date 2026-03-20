(function () {
    "use strict";

    // --- Config ---
    const JOYSTICK_RADIUS = 60;   // half the base diameter (px)
    const THRUST     = 0.6;       // force per frame when W/S held
    const TURN_SPEED = 0.055;     // radians per frame when A/D held
    const ANG_DAMP       = 1.0;    // angular velocity damping factor per frame (1.0 = no drag)
    const ATTRACT_RADIUS = 200;   // max distance at which attraction acts (px)
    const ATTRACT_STRENGTH = 0.4; // acceleration at ATTRACT_RADIUS distance
    const WORLD_W    = 500;       // game world width  (px)
    const WORLD_H    = 500;       // game world height (px)

    // --- Entity store ---
    // Each entity: { uid, x, y, vx, vy, angle, angularVelocity,
    //                mass, interactionRadius, momentOfInertia,
    //                blockData, blockMap }
    // All entities receive physics integration each frame.
    // Only the entity whose uid matches playerUID responds to player controls.
    const entities = new Map();
    let playerUID = "player_" + Math.random().toString(36).slice(2, 9);

    // Bootstrap the initial player entity at screen centre
    entities.set(playerUID, {
        uid:             playerUID,
        x:               WORLD_W / 2,
        y:               WORLD_H / 2,
        vx:              0,
        vy:              0,
        angle:           0,
        angularVelocity: 0,   // collision-induced spin (rad/frame)
        mass:            1,   // recomputed by tiles.computeEntityProps
        interactionRadius: 0,
        momentOfInertia: 1,
        blockData: {},        // { [bui]: { typeId, health, ... } }
        blockMap:  {}         // { "tx,ty": bui }
    });

    // --- Editor / pause state ---
    let editorOpen = false;
    let paused     = false;

    // --- Input state ---
    const keys = {};
    let joystickActive = false;
    let joystickDir = { x: 0, y: 0 }; // normalised -1..1
    let attractPos  = null;            // world-space cursor pos while LMB held
    let mobileRightClickMode = false;  // mobile toggle: taps act as right-clicks

    // --- DOM refs ---
    const worldEl           = document.getElementById("world");
    const canvasEl          = document.getElementById("world-canvas");
    const posXEl            = document.getElementById("pos-x");
    const posYEl            = document.getElementById("pos-y");
    const joystickContainer = document.getElementById("joystick-container");
    const joystickBase      = document.getElementById("joystick-base");
    const joystickKnob      = document.getElementById("joystick-knob");
    const controlHint       = document.getElementById("control-hint");
    const deviceTypeEl      = document.getElementById("device-type");

    // --- Device detection ---
    const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i
        .test(navigator.userAgent) || window.matchMedia("(pointer: coarse)").matches;

    // --- Initialise ---
    async function init() {
        // Load block registry before starting (fast: localStorage hit, or one fetch)
        await tiles.initRegistry();

        // Now that registry is available, compute physics props for all entities
        for (const e of entities.values()) tiles.computeEntityProps(e);

        renderEntities();
        updateHUD();

        setupWorldMouse();

        if (isMobile) {
            deviceTypeEl.innerHTML = "Device: <span>Mobile</span>";
            joystickContainer.classList.remove("hidden");
            controlHint.textContent = "Up/Down: thrust  |  Left/Right: turn";
            setupJoystick();
            setupWorldTouch();
            const btnRCM = document.getElementById("btn-right-click-mode");
            btnRCM.classList.remove("hidden");
            btnRCM.addEventListener("click", function () {
                mobileRightClickMode = !mobileRightClickMode;
                btnRCM.classList.toggle("active", mobileRightClickMode);
            });
        } else {
            deviceTypeEl.innerHTML = "Device: <span>PC</span>";
            controlHint.textContent = "W/S: thrust  |  A/D: turn  |  Space: pause";
            setupKeyboard();
        }

        requestAnimationFrame(gameLoop);

        // --- Google Drive integration ---
        driveInit({
            getState: function () {
                return {
                    playerUID,
                    entities: Array.from(entities.values())
                };
            },
            setState: function (state) {
                entities.clear();
                for (const e of state.entities) {
                    const entity = Object.assign(
                        // Safe defaults for any properties absent in old saves
                        { blockData: {}, blockMap: {}, angularVelocity: 0,
                          mass: 1, interactionRadius: 0, momentOfInertia: 1 },
                        e
                    );
                    entities.set(entity.uid, entity);
                    tiles.reconcileBlocks(entity); // also calls computeEntityProps
                }
                playerUID = state.playerUID;
                renderEntities();
                updateHUD();
            }
        });

        // --- Ship editor ---
        document.getElementById("btn-open-editor").addEventListener("click", function () {
            const player = entities.get(playerUID);
            if (!player) return;
            editorOpen = true;
            editor.open(player, tiles.getRegistry(), function (newBlockData, newBlockMap) {
                player.blockData = newBlockData;
                player.blockMap  = newBlockMap;
                tiles.computeEntityProps(player);
                editorOpen = false;
            });
        });

        // Save full state when the page is hidden/closed
        window.addEventListener("pagehide", function () {
            if (typeof window.driveSave === "function") {
                window.driveSave(true /* keepalive */);
            }
        });
    }

    // --- Entity DOM management ---
    function getOrCreateEntityEl(uid) {
        let el = document.getElementById("ent-" + uid);
        if (!el) {
            el = document.createElement("div");
            el.id = "ent-" + uid;
            el.className = "entity";
            worldEl.appendChild(el);
        }
        return el;
    }

    function renderEntities() {
        // Update or create an element for each entity
        for (const [uid, e] of entities) {
            const el = getOrCreateEntityEl(uid);
            el.classList.toggle("entity--player", uid === playerUID);
            el.style.left      = e.x + "px";
            el.style.top       = e.y + "px";
            el.style.transform = "translate(-50%, -50%) rotate(" + e.angle + "rad)";
        }
        // Remove elements for entities that no longer exist
        for (const el of worldEl.querySelectorAll(".entity")) {
            if (!entities.has(el.id.slice(4))) el.remove(); // strip "ent-" prefix
        }
    }

    function updateHUD() {
        const e = entities.get(playerUID);
        if (!e) return;
        posXEl.textContent = Math.round(e.x - WORLD_W / 2);
        posYEl.textContent = Math.round(e.y - WORLD_H / 2);
    }

    // --- Game loop ---
    // Sub-step budget: keep displacement per step below half a tile (8 px).
    // Angular contribution: corner tip moves at |ω| * interactionRadius per frame.
    const SUBSTEP_THRESHOLD = 8;  // px per step before we add another step
    const MAX_SUBSTEPS       = 8;

    function gameLoop() {
        if (!editorOpen && !paused) {
            applyForces();

            // Choose sub-step count from the fastest-moving entity this frame
            let maxDisp = 0;
            for (const e of entities.values()) {
                const linear  = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
                const angular = Math.abs(e.angularVelocity) * (e.interactionRadius || 0);
                const disp    = linear + angular;
                if (disp > maxDisp) maxDisp = disp;
            }
            const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(maxDisp / SUBSTEP_THRESHOLD)));
            const dt    = 1 / steps;

            for (let s = 0; s < steps; s++) {
                integrateEntities(dt);
                tiles.resolveCollisions(entities);
            }
        }
        tiles.renderBlocks(canvasEl, entities);
        renderEntities();
        updateHUD();
        requestAnimationFrame(gameLoop);
    }

    // Phase 1 — apply forces/input to velocities (once per frame, before sub-stepping).
    function applyForces() {
        let thrust = 0;
        let turn   = 0;

        if (isMobile) {
            thrust = -joystickDir.y;
            turn   =  joystickDir.x;
        } else {
            if (keys["w"] || keys["arrowup"])    thrust += 1;
            if (keys["s"] || keys["arrowdown"])  thrust -= 1;
            if (keys["a"] || keys["arrowleft"])  turn   -= 1;
            if (keys["d"] || keys["arrowright"]) turn   += 1;
        }

        for (const [uid, e] of entities) {
            const isPlayer = uid === playerUID;

            if (isPlayer) {
                e.angularVelocity = (turn * TURN_SPEED) / e.mass + e.angularVelocity * ANG_DAMP;
                const accel = (thrust * THRUST) / e.mass;
                e.vx += Math.sin(e.angle) * accel;
                e.vy -= Math.cos(e.angle) * accel;
            } else {
                e.angularVelocity *= ANG_DAMP;
            }

            // Attraction force (position-dependent, but applied once per frame is fine)
            if (attractPos) {
                const dx   = attractPos.x - e.x;
                const dy   = attractPos.y - e.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > 0 && dist <= ATTRACT_RADIUS) {
                    const accel = (ATTRACT_STRENGTH * dist / ATTRACT_RADIUS) / e.mass;
                    e.vx += (dx / dist) * accel;
                    e.vy += (dy / dist) * accel;
                }
            }

            // Thruster glow
            if (isPlayer) {
                const el = document.getElementById("ent-" + uid);
                if (el) el.classList.toggle("entity--moving", e.vx * e.vx + e.vy * e.vy > 0.01);
            }
        }
    }

    // Phase 2 — integrate positions by fraction dt of a full frame, clamp to walls.
    function integrateEntities(dt) {
        const margin = 16;
        for (const e of entities.values()) {
            e.angle += e.angularVelocity * dt;
            e.x     += e.vx * dt;
            e.y     += e.vy * dt;

            if (e.x < margin)           { e.x = margin;           e.vx = Math.max(0, e.vx); }
            if (e.x > WORLD_W - margin) { e.x = WORLD_W - margin; e.vx = Math.min(0, e.vx); }
            if (e.y < margin)           { e.y = margin;           e.vy = Math.max(0, e.vy); }
            if (e.y > WORLD_H - margin) { e.y = WORLD_H - margin; e.vy = Math.min(0, e.vy); }
        }
    }

    // --- World-space mouse helpers ---
    function worldPosFromMouseEvent(e) {
        const rect = worldEl.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    }

    function isInsideWorld(pos) {
        return pos.x >= 0 && pos.x <= WORLD_W && pos.y >= 0 && pos.y <= WORLD_H;
    }

    function setupWorldMouse() {
        // Right-click: delete entity under cursor, or spawn a new one if none
        worldEl.addEventListener("contextmenu", function (e) {
            e.preventDefault();
            if (editorOpen) return;
            const pos = worldPosFromMouseEvent(e);
            if (!isInsideWorld(pos)) return;

            // Check if cursor is over an existing entity
            let hit = null;
            let hitDist = Infinity;
            for (const [uid, ent] of entities) {
                const dx = ent.x - pos.x;
                const dy = ent.y - pos.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const radius = Math.max(ent.interactionRadius, 16);
                if (dist <= radius && dist < hitDist) {
                    hitDist = dist;
                    hit = uid;
                }
            }

            if (hit !== null) {
                if (hit === playerUID) playerUID = null;
                entities.delete(hit);
                renderEntities();
                updateHUD();
                return;
            }

            const uid = "entity_" + Math.random().toString(36).slice(2, 9);
            const entity = {
                uid,
                x:               pos.x,
                y:               pos.y,
                vx:              0,
                vy:              0,
                angle:           0,
                angularVelocity: 0,
                mass:            1,
                interactionRadius: 0,
                momentOfInertia: 1,
                blockData: {},
                blockMap:  {}
            };
            tiles.computeEntityProps(entity);
            entities.set(uid, entity);
            renderEntities();
        });

        // Left-click hold: attract nearby entities toward cursor
        worldEl.addEventListener("mousedown", function (e) {
            if (e.button !== 0 || e.ctrlKey || editorOpen) return;
            const pos = worldPosFromMouseEvent(e);
            if (isInsideWorld(pos)) attractPos = pos;
        });
        worldEl.addEventListener("mousemove", function (e) {
            if (!attractPos) return;
            const pos = worldPosFromMouseEvent(e);
            attractPos = isInsideWorld(pos) ? pos : null;
        });
        document.addEventListener("mouseup", function (e) {
            if (e.button === 0) attractPos = null;
        });

        // Ctrl + left-click: take control of entity within interaction radius
        worldEl.addEventListener("click", function (e) {
            if (!e.ctrlKey) return;
            if (editorOpen) return;
            const pos = worldPosFromMouseEvent(e);
            if (!isInsideWorld(pos)) return;
            let best = null;
            let bestDist = Infinity;
            for (const [uid, ent] of entities) {
                if (uid === playerUID) continue;
                const dx = ent.x - pos.x;
                const dy = ent.y - pos.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const radius = Math.max(ent.interactionRadius, 16); // minimum click target
                if (dist <= radius && dist < bestDist) {
                    bestDist = dist;
                    best = uid;
                }
            }
            if (best !== null) {
                playerUID = best;
                renderEntities();
                updateHUD();
            }
        });
    }

    // --- World touch (Mobile) ---
    function worldPosFromTouch(touch) {
        const rect = worldEl.getBoundingClientRect();
        return {
            x: touch.clientX - rect.left,
            y: touch.clientY - rect.top
        };
    }

    function applyRightClickAt(pos) {
        // Mirrors the contextmenu handler: delete entity under pos, or spawn one
        let hit = null, hitDist = Infinity;
        for (const [uid, ent] of entities) {
            const dx = ent.x - pos.x, dy = ent.y - pos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const radius = Math.max(ent.interactionRadius, 16);
            if (dist <= radius && dist < hitDist) { hitDist = dist; hit = uid; }
        }
        if (hit !== null) {
            if (hit === playerUID) playerUID = null;
            entities.delete(hit);
            renderEntities();
            updateHUD();
            return;
        }
        const uid = "entity_" + Math.random().toString(36).slice(2, 9);
        const entity = {
            uid, x: pos.x, y: pos.y,
            vx: 0, vy: 0, angle: 0, angularVelocity: 0,
            mass: 1, interactionRadius: 0, momentOfInertia: 1,
            blockData: {}, blockMap: {}
        };
        tiles.computeEntityProps(entity);
        entities.set(uid, entity);
        renderEntities();
    }

    function applyTakeControlAt(pos) {
        // Mirrors Ctrl+click: take control of nearest entity within radius
        let best = null, bestDist = Infinity;
        for (const [uid, ent] of entities) {
            if (uid === playerUID) continue;
            const dx = ent.x - pos.x, dy = ent.y - pos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const radius = Math.max(ent.interactionRadius, 16);
            if (dist <= radius && dist < bestDist) { bestDist = dist; best = uid; }
        }
        if (best !== null) {
            playerUID = best;
            renderEntities();
            updateHUD();
        }
    }

    function setupWorldTouch() {
        const DBL_TAP_MS = 300; // max ms between taps to count as double-tap
        let lastTapTime = 0;
        let lastTapPos  = null;

        worldEl.addEventListener("touchstart", function (e) {
            if (editorOpen || e.touches.length !== 1) return;
            e.preventDefault();
            const touch = e.touches[0];
            const pos   = worldPosFromTouch(touch);
            if (!isInsideWorld(pos)) return;

            const now = Date.now();
            const isDoubleTap = lastTapPos &&
                (now - lastTapTime) < DBL_TAP_MS &&
                Math.hypot(pos.x - lastTapPos.x, pos.y - lastTapPos.y) < 30;

            if (isDoubleTap) {
                lastTapTime = 0;
                lastTapPos  = null;
                applyTakeControlAt(pos);
                return;
            }

            lastTapTime = now;
            lastTapPos  = pos;

            if (mobileRightClickMode) {
                applyRightClickAt(pos);
            } else {
                attractPos = pos;
            }
        }, { passive: false });

        worldEl.addEventListener("touchmove", function (e) {
            if (!attractPos || e.touches.length !== 1) return;
            e.preventDefault();
            const pos = worldPosFromTouch(e.touches[0]);
            attractPos = isInsideWorld(pos) ? pos : null;
        }, { passive: false });

        worldEl.addEventListener("touchend", function () {
            attractPos = null;
        }, { passive: false });

        worldEl.addEventListener("touchcancel", function () {
            attractPos = null;
        }, { passive: false });
    }

    // --- Keyboard (PC) ---
    function setupKeyboard() {
        document.addEventListener("keydown", function (e) {
            keys[e.key.toLowerCase()] = true;
            if (e.key === " ") {
                e.preventDefault();
                if (!editorOpen) paused = !paused;
            }
            if (["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(e.key.toLowerCase())) {
                e.preventDefault();
            }
        });
        document.addEventListener("keyup", function (e) {
            keys[e.key.toLowerCase()] = false;
        });
    }

    // --- Joystick (mobile) ---
    function setupJoystick() {
        let baseRect = null;

        function getBaseRect() {
            baseRect = joystickBase.getBoundingClientRect();
            return baseRect;
        }

        function updateKnob(touchX, touchY) {
            const rect = baseRect || getBaseRect();
            const cx = rect.left + rect.width  / 2;
            const cy = rect.top  + rect.height / 2;

            let dx = touchX - cx;
            let dy = touchY - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist > JOYSTICK_RADIUS) {
                dx = (dx / dist) * JOYSTICK_RADIUS;
                dy = (dy / dist) * JOYSTICK_RADIUS;
            }

            joystickKnob.style.transform = "translate(" + dx + "px, " + dy + "px)";
            joystickDir.x = dx / JOYSTICK_RADIUS;
            joystickDir.y = dy / JOYSTICK_RADIUS;
        }

        function resetKnob() {
            joystickKnob.style.transform = "translate(0px, 0px)";
            joystickDir.x = 0;
            joystickDir.y = 0;
            joystickActive = false;
        }

        joystickContainer.addEventListener("touchstart", function (e) {
            e.preventDefault();
            joystickActive = true;
            getBaseRect();
            const touch = e.touches[0];
            updateKnob(touch.clientX, touch.clientY);
        }, { passive: false });

        joystickContainer.addEventListener("touchmove", function (e) {
            e.preventDefault();
            if (!joystickActive) return;
            const touch = e.touches[0];
            updateKnob(touch.clientX, touch.clientY);
        }, { passive: false });

        joystickContainer.addEventListener("touchend", function (e) {
            e.preventDefault();
            resetKnob();
        }, { passive: false });

        joystickContainer.addEventListener("touchcancel", function (e) {
            e.preventDefault();
            resetKnob();
        }, { passive: false });

        window.addEventListener("resize", function () { baseRect = null; });
    }

    // --- Kick off ---
    init();
})();
