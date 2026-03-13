(function () {
    "use strict";

    // --- Config ---
    const JOYSTICK_RADIUS = 60; // half the base diameter (px)
    const MASS       = 1.0;    // kg  — increase for sluggish, decrease for snappy
    const THRUST     = 0.25;   // force per frame when W/S held
    const TURN_SPEED = 0.055;  // radians per frame when A/D held

    // --- State ---
    const player   = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const velocity = { x: 0, y: 0 };   // pixels per frame, no drag
    let   angle    = 0;                 // radians; 0 = pointing up
    const keys = {};
    let joystickActive = false;
    let joystickDir = { x: 0, y: 0 };  // normalised -1..1
    let animFrameId = null;

    // --- DOM refs ---
    const playerEl = document.getElementById("player");
    const posXEl = document.getElementById("pos-x");
    const posYEl = document.getElementById("pos-y");
    const joystickContainer = document.getElementById("joystick-container");
    const joystickBase = document.getElementById("joystick-base");
    const joystickKnob = document.getElementById("joystick-knob");
    const controlHint = document.getElementById("control-hint");
    const deviceTypeEl = document.getElementById("device-type");

    // --- Device detection ---
    const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i
        .test(navigator.userAgent) || window.matchMedia("(pointer: coarse)").matches;

    // --- Initialise ---
    function init() {
        placePlayer();
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
            getPosition: function () {
                return { x: player.x, y: player.y, vx: velocity.x, vy: velocity.y, angle: angle };
            },
            setPosition: function (x, y, vx, vy, ang) {
                const margin = 16;
                player.x  = Math.max(margin, Math.min(window.innerWidth  - margin, x));
                player.y  = Math.max(margin, Math.min(window.innerHeight - margin, y));
                velocity.x = vx  || 0;
                velocity.y = vy  || 0;
                angle      = ang || 0;
                placePlayer();
                updateHUD();
            }
        });

        // Save position when the page is hidden/closed
        window.addEventListener("pagehide", function () {
            if (typeof window.driveSavePosition === "function") {
                window.driveSavePosition(player.x, player.y, true /* keepalive */);
            }
        });
    }

    // --- Render helpers ---
    function placePlayer() {
        playerEl.style.left = player.x + "px";
        playerEl.style.top  = player.y + "px";
        playerEl.style.transform = "translate(-50%, -50%) rotate(" + angle + "rad)";
    }

    function updateHUD() {
        // Show position relative to start (centre of screen)
        posXEl.textContent = Math.round(player.x - window.innerWidth / 2);
        posYEl.textContent = Math.round(player.y - window.innerHeight / 2);
    }

    // --- Game loop ---
    function gameLoop() {
        move();
        placePlayer();
        updateHUD();
        animFrameId = requestAnimationFrame(gameLoop);
    }

    function move() {
        let thrust = 0; // -1 (back) to +1 (forward)
        let turn   = 0; // -1 (left) to +1 (right)

        if (isMobile) {
            thrust = -joystickDir.y; // joystick up = negative screen Y = forward
            turn   =  joystickDir.x;
        } else {
            if (keys["w"] || keys["arrowup"])    thrust += 1;
            if (keys["s"] || keys["arrowdown"])  thrust -= 1;
            if (keys["a"] || keys["arrowleft"])  turn   -= 1;
            if (keys["d"] || keys["arrowright"]) turn   += 1;
        }

        // Rotate the ship (turning doesn't add velocity)
        angle += turn * TURN_SPEED;

        // Thrust: F = ma  →  a = F/m, applied along current heading
        // angle=0 points up, so heading = (sin(angle), -cos(angle)) in screen coords
        const accel = (thrust * THRUST) / MASS;
        velocity.x += Math.sin(angle) * accel;
        velocity.y -= Math.cos(angle) * accel;

        // Integrate position (no drag — velocity persists forever)
        player.x += velocity.x;
        player.y += velocity.y;

        // Bounce off viewport edges: cancel the perpendicular velocity component
        const margin = 16;
        if (player.x < margin)                      { player.x = margin;                      velocity.x = Math.max(0, velocity.x); }
        if (player.x > window.innerWidth  - margin) { player.x = window.innerWidth  - margin; velocity.x = Math.min(0, velocity.x); }
        if (player.y < margin)                      { player.y = margin;                      velocity.y = Math.max(0, velocity.y); }
        if (player.y > window.innerHeight - margin) { player.y = window.innerHeight - margin; velocity.y = Math.min(0, velocity.y); }

        const isMoving = velocity.x * velocity.x + velocity.y * velocity.y > 0.01;
        playerEl.classList.toggle("moving", isMoving);
    }

    // --- Keyboard (PC) ---
    function setupKeyboard() {
        document.addEventListener("keydown", function (e) {
            keys[e.key.toLowerCase()] = true;
            // Prevent page scrolling with arrow keys / space
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

            // Clamp to joystick radius
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

        // Recalculate base rect on resize
        window.addEventListener("resize", function () {
            baseRect = null;
        });
    }

    // --- Kick off ---
    init();
})();
