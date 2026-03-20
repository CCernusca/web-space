(function () {
    "use strict";

    // --- Config ---
    const JOYSTICK_RADIUS = 60;   // half the base diameter (px)
    const THRUST     = 0.25;      // force per frame when W/S held
    const TURN_SPEED = 0.055;     // radians per frame when A/D held
    const ANG_DAMP   = 0.99;      // angular velocity damping factor per frame
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
    function gameLoop() {
        if (!editorOpen && !paused) {
            move();
            tiles.resolveCollisions(entities);
        }
        tiles.renderBlocks(canvasEl, entities);
        renderEntities();
        updateHUD();
        requestAnimationFrame(gameLoop);
    }

    function move() {
        let thrust = 0;
        let turn   = 0;

        if (isMobile) {
            thrust = -joystickDir.y; // joystick up = negative screen Y = forward
            turn   =  joystickDir.x;
        } else {
            if (keys["w"] || keys["arrowup"])    thrust += 1;
            if (keys["s"] || keys["arrowdown"])  thrust -= 1;
            if (keys["a"] || keys["arrowleft"])  turn   -= 1;
            if (keys["d"] || keys["arrowright"]) turn   += 1;
        }

        const margin = 16;

        for (const [uid, e] of entities) {
            const isPlayer = uid === playerUID;

            // Player controls add directly to angle and linear velocity
            if (isPlayer) {
                e.angle += turn * TURN_SPEED;
                const accel = (thrust * THRUST) / e.mass;
                e.vx += Math.sin(e.angle) * accel;
                e.vy -= Math.cos(e.angle) * accel;
            }

            // Integrate collision-induced spin; damp each frame
            e.angle           += e.angularVelocity;
            e.angularVelocity *= ANG_DAMP;

            // Integrate position — no drag, velocity persists
            e.x += e.vx;
            e.y += e.vy;

            // Bounce off world edges: zero the component going into the wall
            if (e.x < margin)             { e.x = margin;             e.vx = Math.max(0, e.vx); }
            if (e.x > WORLD_W - margin)   { e.x = WORLD_W - margin;   e.vx = Math.min(0, e.vx); }
            if (e.y < margin)             { e.y = margin;             e.vy = Math.max(0, e.vy); }
            if (e.y > WORLD_H - margin)   { e.y = WORLD_H - margin;   e.vy = Math.min(0, e.vy); }

            // Thruster glow only on the player entity
            if (isPlayer) {
                const el = document.getElementById("ent-" + uid);
                if (el) {
                    el.classList.toggle("entity--moving", e.vx * e.vx + e.vy * e.vy > 0.01);
                }
            }
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
        // Right-click: spawn a new entity at cursor position
        worldEl.addEventListener("contextmenu", function (e) {
            e.preventDefault();
            if (editorOpen) return;
            const pos = worldPosFromMouseEvent(e);
            if (!isInsideWorld(pos)) return;
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
