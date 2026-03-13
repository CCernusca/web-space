(function () {
    "use strict";

    // --- Config ---
    const SPEED = 3;          // pixels per frame (PC)
    const JOYSTICK_RADIUS = 60; // half the base diameter

    // --- State ---
    const player = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
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

    // --- Device detection ---
    const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i
        .test(navigator.userAgent) || window.matchMedia("(pointer: coarse)").matches;

    // --- Initialise ---
    function init() {
        placePlayer();
        updateHUD();

        if (isMobile) {
            joystickContainer.classList.remove("hidden");
            controlHint.textContent = "Use the joystick to move";
            setupJoystick();
        } else {
            controlHint.textContent = "Use WASD or arrow keys to move";
            setupKeyboard();
        }

        requestAnimationFrame(gameLoop);
    }

    // --- Render helpers ---
    function placePlayer() {
        playerEl.style.left = player.x + "px";
        playerEl.style.top = player.y + "px";
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
        let dx = 0;
        let dy = 0;

        if (isMobile) {
            dx = joystickDir.x * SPEED;
            dy = joystickDir.y * SPEED;
        } else {
            if (keys["w"] || keys["arrowup"])    dy -= SPEED;
            if (keys["s"] || keys["arrowdown"])  dy += SPEED;
            if (keys["a"] || keys["arrowleft"])  dx -= SPEED;
            if (keys["d"] || keys["arrowright"]) dx += SPEED;

            // Normalise diagonal so speed is consistent
            if (dx !== 0 && dy !== 0) {
                dx *= Math.SQRT1_2;
                dy *= Math.SQRT1_2;
            }
        }

        const moving = dx !== 0 || dy !== 0;
        playerEl.classList.toggle("moving", moving);

        // Clamp inside viewport with a small margin
        const margin = 16;
        player.x = Math.max(margin, Math.min(window.innerWidth  - margin, player.x + dx));
        player.y = Math.max(margin, Math.min(window.innerHeight - margin, player.y + dy));
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
