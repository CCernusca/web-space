// =========================================================================
// Tilemap system
//
// Block registry (server-authoritative, cached in localStorage):
//   { [typeId]: { properties: { id, size:{x,y}, color:{r,g,b}, maxHealth },
//                 data:       { health, ... } } }
//
// Per-entity block storage (part of entity objects):
//   entity.blockData  { [bui]: { typeId, health, ... } }   — one entry per instance
//   entity.blockMap   { "tx,ty": bui }                     — one entry per occupied tile
//   A multi-tile block (size.x * size.y > 1) will have several blockMap entries
//   pointing to the same bui.
//
// Exposed as window.tiles = { initRegistry, reconcileBlocks,
//                              addBlock, removeBlock,
//                              renderBlocks, getRegistry, TILE_SIZE }
// =========================================================================

(function () {
    "use strict";

    const TILE_SIZE    = 16;            // px per tile cell in entity-local space
    const REGISTRY_KEY = "ws_blockRegistry";
    const REGISTRY_URL = "/api/block-registry";

    let registry = null; // { [typeId]: { properties, data } }

    // ---- Registry loading ------------------------------------------

    // Load registry from localStorage; if absent, fetch from server.
    // Always returns a resolved promise.
    async function initRegistry() {
        const cached = localStorage.getItem(REGISTRY_KEY);
        if (cached) {
            try {
                registry = JSON.parse(cached);
                return;
            } catch (_) { /* corrupt cache — fall through to fetch */ }
        }
        await fetchRegistry();
    }

    // Fetch fresh registry from server and cache it.
    async function fetchRegistry() {
        try {
            const r = await fetch(REGISTRY_URL);
            if (!r.ok) throw new Error("HTTP " + r.status);
            registry = await r.json();
            localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry));
        } catch (e) {
            console.warn("tiles.js: failed to load block registry:", e);
            registry = registry || {}; // keep stale registry if we had one
        }
    }

    // ---- Reconciliation --------------------------------------------

    // Sync an entity's block instance data with the current registry definition:
    //   • Removes instances whose typeId is no longer in the registry.
    //   • Removes data fields that the registry no longer defines.
    //   • Adds new data fields with the registry's default value.
    // Call this after loading entities from Drive or after the registry updates.
    function reconcileBlocks(entity) {
        if (!registry) return;
        if (!entity.blockData) { entity.blockData = {}; }
        if (!entity.blockMap)  { entity.blockMap  = {}; }

        const busToRemove = [];

        for (const bui of Object.keys(entity.blockData)) {
            const datum = entity.blockData[bui];
            const type  = registry[datum.typeId];

            if (!type) {
                busToRemove.push(bui);
                continue;
            }

            const registryData = type.data;

            // Remove data fields no longer defined in the registry
            for (const key of Object.keys(datum)) {
                if (key !== "typeId" && !(key in registryData)) {
                    delete datum[key];
                }
            }

            // Add data fields that are new in the registry (with defaults)
            for (const [key, defaultVal] of Object.entries(registryData)) {
                if (!(key in datum)) {
                    datum[key] = defaultVal;
                }
            }
        }

        for (const bui of busToRemove) {
            removeBlock(entity, bui);
        }
    }

    // ---- Block helpers ---------------------------------------------

    function genBui() {
        return "bui_" + Math.random().toString(36).slice(2, 9);
    }

    // Place a new block instance of typeId with its top-left tile at (tx, ty).
    // Returns the generated bui on success, or null if tiles are occupied / type unknown.
    function addBlock(entity, typeId, tx, ty) {
        if (!registry) { console.warn("tiles: registry not loaded"); return null; }

        const type = registry[typeId];
        if (!type) { console.warn("tiles: unknown block type:", typeId); return null; }

        const { size } = type.properties;

        // Verify every tile the block would occupy is free
        for (let dy = 0; dy < size.y; dy++) {
            for (let dx = 0; dx < size.x; dx++) {
                if (entity.blockMap[(tx + dx) + "," + (ty + dy)] !== undefined) {
                    console.warn("tiles: tile already occupied at", (tx + dx), (ty + dy));
                    return null;
                }
            }
        }

        const bui = genBui();

        // Instance data: typeId + default values from registry
        const datum = { typeId };
        for (const [key, val] of Object.entries(type.data)) {
            datum[key] = val;
        }
        entity.blockData[bui] = datum;

        // Claim every tile the block occupies
        for (let dy = 0; dy < size.y; dy++) {
            for (let dx = 0; dx < size.x; dx++) {
                entity.blockMap[(tx + dx) + "," + (ty + dy)] = bui;
            }
        }

        return bui;
    }

    // Remove a block instance and all tile positions it occupies.
    function removeBlock(entity, bui) {
        delete entity.blockData[bui];
        for (const key of Object.keys(entity.blockMap)) {
            if (entity.blockMap[key] === bui) {
                delete entity.blockMap[key];
            }
        }
    }

    // ---- Rendering -------------------------------------------------

    // Draw all entity block tiles onto the canvas.
    // Each tile position in entity.blockMap gets a TILE_SIZE × TILE_SIZE rectangle
    // coloured by its block type.  The entity's (x, y) and angle are applied so
    // blocks rotate and translate with the entity.
    function renderBlocks(canvas, entities) {
        if (!registry) return;

        // Keep canvas backing store in sync with its CSS size
        const dpr = window.devicePixelRatio || 1;
        const w   = canvas.clientWidth;
        const h   = canvas.clientHeight;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width  = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }

        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // reset to logical pixels
        ctx.clearRect(0, 0, w, h);

        for (const entity of entities.values()) {
            const map = entity.blockMap;
            if (!map || Object.keys(map).length === 0) continue;

            ctx.save();
            ctx.translate(entity.x, entity.y);
            ctx.rotate(entity.angle);

            for (const [posKey, bui] of Object.entries(map)) {
                const datum = entity.blockData[bui];
                if (!datum) continue;
                const type = registry[datum.typeId];
                if (!type) continue;

                const [tx, ty] = posKey.split(",");
                const { r, g, b } = type.properties.color;
                ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
                ctx.fillRect(
                    Number(tx) * TILE_SIZE,
                    Number(ty) * TILE_SIZE,
                    TILE_SIZE,
                    TILE_SIZE
                );
            }

            ctx.restore();
        }
    }

    // ---- Public API ------------------------------------------------
    window.tiles = {
        initRegistry,
        fetchRegistry,
        reconcileBlocks,
        addBlock,
        removeBlock,
        renderBlocks,
        getRegistry: function () { return registry; },
        TILE_SIZE
    };
})();
