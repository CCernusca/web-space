// =========================================================================
// Ship editor
//
// Opens a full-screen overlay where the player can build their ship by
// placing / removing blocks on a tile grid. The grid is centred on the
// entity-local origin (0, 0) — the same point the physics engine uses as
// the entity centre.
//
// Coordinates: tile (tx, ty) in the same space as entity.blockMap keys.
// The editor works on a deep copy of the player's block data; the original
// is untouched until the player clicks Save.
//
// Public API: window.editor = { open(entity, registry, onSave), close() }
//   onSave(newBlockData, newBlockMap) — called when the player saves.
// =========================================================================

(function () {
    "use strict";

    const EDITOR_TILE = 28;           // px per tile in the editor grid
    const GRID_HALF   = 9;            // tiles from centre to edge
    const GRID_SIZE   = GRID_HALF * 2 + 1; // total columns = rows

    // Working copies — isolated from the live entity until Save is clicked
    let workingEntity  = null;  // { blockData: {…}, blockMap: {…} }
    let selectedTypeId = null;
    let hoverCol       = null;  // grid column the mouse is over
    let hoverRow       = null;
    let registry       = null;
    let onSaveCb       = null;

    let canvas = null;
    let ctx    = null;

    // ---- Coordinate helpers ----------------------------------------

    // Tile coords → grid column / row (integers, 0-based)
    function tileToGrid(tx, ty) {
        return { col: tx + GRID_HALF, row: ty + GRID_HALF };
    }

    // Grid column / row → tile coords
    function gridToTile(col, row) {
        return { tx: col - GRID_HALF, ty: row - GRID_HALF };
    }

    function inBounds(col, row) {
        return col >= 0 && col < GRID_SIZE && row >= 0 && row < GRID_SIZE;
    }

    // ---- Open / close ----------------------------------------------

    function open(entity, reg, onSave) {
        registry  = reg;
        onSaveCb  = onSave;

        // Deep-copy the entity's blocks so edits don't affect the live game
        workingEntity = {
            blockData: JSON.parse(JSON.stringify(entity.blockData || {})),
            blockMap:  JSON.parse(JSON.stringify(entity.blockMap  || {}))
        };

        buildPalette();

        // Select first registered type by default
        const ids = Object.keys(registry);
        selectedTypeId = ids.length ? ids[0] : null;
        updatePaletteSelection();

        document.getElementById("editor-overlay").classList.remove("hidden");

        canvas = document.getElementById("editor-canvas");
        ctx    = canvas.getContext("2d");
        const px = GRID_SIZE * EDITOR_TILE;
        canvas.width  = px;
        canvas.height = px;

        render();
    }

    function close() {
        document.getElementById("editor-overlay").classList.add("hidden");
        hoverCol = null;
        hoverRow = null;
    }

    // ---- Palette ---------------------------------------------------

    function buildPalette() {
        const bar = document.getElementById("editor-palette");
        bar.innerHTML = "";
        for (const [typeId, type] of Object.entries(registry)) {
            const { r, g, b } = type.properties.color;
            const { x: sw, y: sh } = type.properties.size;

            const btn = document.createElement("button");
            btn.className     = "editor-palette-btn";
            btn.dataset.typeId = typeId;

            const swatch = document.createElement("span");
            swatch.className = "palette-swatch";
            swatch.style.cssText = `width:${sw * 14}px;height:${sh * 14}px;background:rgb(${r},${g},${b})`;

            const label = document.createElement("span");
            label.className   = "palette-label";
            label.textContent = typeId.replace(/_/g, " ");

            btn.append(swatch, label);
            btn.addEventListener("click", function () {
                selectedTypeId = typeId;
                updatePaletteSelection();
            });
            bar.appendChild(btn);
        }
    }

    function updatePaletteSelection() {
        for (const btn of document.querySelectorAll(".editor-palette-btn")) {
            btn.classList.toggle("selected", btn.dataset.typeId === selectedTypeId);
        }
    }

    // ---- Rendering -------------------------------------------------

    function render() {
        if (!canvas || !ctx || !registry) return;

        const TS = EDITOR_TILE;
        const N  = GRID_SIZE;
        ctx.clearRect(0, 0, N * TS, N * TS);

        // Background cells
        for (let row = 0; row < N; row++) {
            for (let col = 0; col < N; col++) {
                const x = col * TS, y = row * TS;
                const isOrigin = col === GRID_HALF && row === GRID_HALF;
                ctx.fillStyle = isOrigin
                    ? "rgba(255,255,255,0.07)"
                    : "rgba(255,255,255,0.025)";
                ctx.fillRect(x, y, TS, TS);
                ctx.strokeStyle = "rgba(255,255,255,0.07)";
                ctx.strokeRect(x + 0.5, y + 0.5, TS - 1, TS - 1);
            }
        }

        // Placed blocks
        for (const [posKey, bui] of Object.entries(workingEntity.blockMap)) {
            const [tx, ty] = posKey.split(",").map(Number);
            const { col, row } = tileToGrid(tx, ty);
            if (!inBounds(col, row)) continue;
            const datum = workingEntity.blockData[bui];
            if (!datum) continue;
            const type = registry[datum.typeId];
            if (!type) continue;
            const { r, g, b } = type.properties.color;
            const x = col * TS, y = row * TS;
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(x + 1, y + 1, TS - 2, TS - 2);
        }

        // Hover preview
        if (hoverCol !== null && selectedTypeId && registry[selectedTypeId]) {
            const type = registry[selectedTypeId];
            const { r, g, b } = type.properties.color;
            const bw = type.properties.size.x;
            const bh = type.properties.size.y;
            const { tx: htx, ty: hty } = gridToTile(hoverCol, hoverRow);

            let canPlace = true;
            const cells = [];
            for (let dy = 0; dy < bh; dy++) {
                for (let dx = 0; dx < bw; dx++) {
                    const tx = htx + dx, ty = hty + dy;
                    const { col, row } = tileToGrid(tx, ty);
                    if (!inBounds(col, row) || workingEntity.blockMap[tx + "," + ty] !== undefined) {
                        canPlace = false;
                    }
                    cells.push({ col, row });
                }
            }

            const color = canPlace
                ? `rgba(${r},${g},${b},0.55)`
                : "rgba(230,60,60,0.4)";
            for (const { col, row } of cells) {
                if (!inBounds(col, row)) continue;
                ctx.fillStyle = color;
                ctx.fillRect(col * TS + 1, row * TS + 1, TS - 2, TS - 2);
            }
        }

        // Origin crosshair
        const ox = GRID_HALF * TS + TS / 2;
        const oy = GRID_HALF * TS + TS / 2;
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ox - 7, oy); ctx.lineTo(ox + 7, oy);
        ctx.moveTo(ox, oy - 7); ctx.lineTo(ox, oy + 7);
        ctx.stroke();
        ctx.restore();
    }

    // ---- Interaction -----------------------------------------------

    function canvasCoords(e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width  / rect.width;
        const scaleY = canvas.height / rect.height;
        return {
            col: Math.floor((e.clientX - rect.left)  * scaleX / EDITOR_TILE),
            row: Math.floor((e.clientY - rect.top)   * scaleY / EDITOR_TILE)
        };
    }

    function handleClick(e) {
        if (!canvas || !registry) return;
        const { col, row } = canvasCoords(e);
        if (!inBounds(col, row)) return;
        const { tx, ty } = gridToTile(col, row);
        const key = tx + "," + ty;
        const existingBui = workingEntity.blockMap[key];
        if (existingBui !== undefined) {
            tiles.removeBlock(workingEntity, existingBui);
        } else if (selectedTypeId) {
            tiles.addBlock(workingEntity, selectedTypeId, tx, ty);
        }
        render();
    }

    function handleMouseMove(e) {
        if (!canvas) return;
        const { col, row } = canvasCoords(e);
        hoverCol = inBounds(col, row) ? col : null;
        hoverRow = inBounds(col, row) ? row : null;
        render();
    }

    function handleMouseLeave() {
        hoverCol = null;
        hoverRow = null;
        render();
    }

    function save() {
        if (onSaveCb) onSaveCb(workingEntity.blockData, workingEntity.blockMap);
        close();
    }

    // ---- Wire up on load ------------------------------------------

    document.addEventListener("DOMContentLoaded", function () {
        document.getElementById("editor-canvas")
            .addEventListener("click",      handleClick);
        document.getElementById("editor-canvas")
            .addEventListener("mousemove",  handleMouseMove);
        document.getElementById("editor-canvas")
            .addEventListener("mouseleave", handleMouseLeave);

        document.getElementById("btn-editor-back")
            .addEventListener("click", close);
        document.getElementById("btn-editor-save")
            .addEventListener("click", save);
    });

    window.editor = { open, close };
})();
