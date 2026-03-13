(function () {
    "use strict";

    // --- Config ---
    const JOYSTICK_RADIUS = 60;   // half the base diameter (px)
    const MASS       = 1.0;       // kg — increase for sluggish, decrease for snappy
    const THRUST     = 0.25;      // force per frame when W/S held
    const TURN_SPEED = 0.055;     // radians per frame when A/D held

    // --- Entity store ---
    // Each entity: { uid, x, y, vx, vy, angle }
    // All entities receive physics integration each frame.
    // Only the entity whose uid matches playerUID responds to player controls.
    const entities = new Map();
    let playerUID = "player_" + Math.random().toString(36).slice(2, 9);

    // Bootstrap the initial player entity at screen centre
    entities.set(playerUID, {
        uid:   playerUID,
        x:     window.innerWidth  / 2,
        y:     window.innerHeight / 2,
        vx:    0,
        vy:    0,
        angle: 0
    });

    // --- Input state ---
    const keys = {};
    let joystickActive = false;
    let joystickDir = { x: 0, y: 0 }; // normalised -1..1

    // --- DOM refs ---
    const worldEl           = document.getElementById("world");
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
    function init() {
        renderEntities();
        updateHUD();

        if (isMobile) {
            deviceTypeEl.innerHTML = "Device: <span>Mobile</span>";
            joystickContainer.classList.remove("hidden");
            controlHint.textContent = "Up/Down: thrust  |  Left/Right: turn";
            setupJoystick();
        } else {
            deviceTypeEl.innerHTML = "Device: <span>PC</span>";
            controlHint.textContent = "W/S: thrust  |  A/D: turn";
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
                    entities.set(e.uid, Object.assign({}, e));
                }
                playerUID = state.playerUID;
                renderEntities();
                updateHUD();
            }
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
        posXEl.textContent = Math.round(e.x - window.innerWidth  / 2);
        posYEl.textContent = Math.round(e.y - window.innerHeight / 2);
    }

    // --- Game loop ---
    function gameLoop() {
        move();
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

            // Controls only affect the player entity
            if (isPlayer) {
                e.angle += turn * TURN_SPEED;
                const accel = (thrust * THRUST) / MASS;
                e.vx += Math.sin(e.angle) * accel;
                e.vy -= Math.cos(e.angle) * accel;
            }

            // Integrate position — no drag, velocity persists
            e.x += e.vx;
            e.y += e.vy;

            // Bounce off viewport edges: zero the component going into the wall
            if (e.x < margin)                      { e.x = margin;                      e.vx = Math.max(0, e.vx); }
            if (e.x > window.innerWidth  - margin) { e.x = window.innerWidth  - margin; e.vx = Math.min(0, e.vx); }
            if (e.y < margin)                      { e.y = margin;                      e.vy = Math.max(0, e.vy); }
            if (e.y > window.innerHeight - margin) { e.y = window.innerHeight - margin; e.vy = Math.min(0, e.vy); }

            // Thruster glow only on the player entity
            if (isPlayer) {
                const el = document.getElementById("ent-" + uid);
                if (el) {
                    el.classList.toggle("entity--moving", e.vx * e.vx + e.vy * e.vy > 0.01);
                }
            }
        }
    }

    // --- Keyboard (PC) ---
    function setupKeyboard() {
        document.addEventListener("keydown", function (e) {
            keys[e.key.toLowerCase()] = true;
            if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(e.key.toLowerCase())) {
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
