// =========================================================================
// Tilemap system
//
// Block registry (server-authoritative, cached in localStorage):
//   { [typeId]: { properties: { id, size:{x,y}, color:{r,g,b}, maxHealth, mass },
//                 data:       { health, ... } } }
//
// Per-entity block storage (part of entity objects):
//   entity.blockData  { [bui]: { typeId, health, ... } }   — one entry per instance
//   entity.blockMap   { "tx,ty": bui }                     — one entry per occupied tile
//   A multi-tile block (size.x * size.y > 1) will have several blockMap entries
//   pointing to the same bui.
//
// Derived entity physics properties (recomputed via computeEntityProps):
//   entity.mass              — BASE_MASS + sum of all block type masses
//   entity.interactionRadius — distance from entity center to furthest block corner
//   entity.momentOfInertia   — computed via parallel axis theorem; not drive-stored
//
// Collision pipeline (called once per frame after position integration):
//   resolveCollisions(entities)
//     → broad phase:  distance < rA + rB
//     → narrow phase: SAT per tile pair, find deepest contact
//     → impulse:      resolveContact() — affects vx, vy, angularVelocity on both entities
//
// Force helpers:
//   applyImpulse(entity, ix, iy, wx, wy)  — at world point (linear + angular)
//   applyLinearImpulse(entity, ix, iy)    — at center of mass only
//   applyTorque(entity, torque)           — pure rotation
//
// Exposed as window.tiles = { ... }
// =========================================================================

(function () {
    "use strict";

    const TILE_SIZE    = 16;             // px per tile cell in entity-local space
    const BASE_MASS    = 1.0;            // mass of a bare entity with no blocks
    const RESTITUTION  = 0.35;           // coefficient of restitution (0=inelastic, 1=elastic)
    const REGISTRY_KEY = "ws_blockRegistry";
    const REGISTRY_URL = "/api/block-registry";

    let registry = null; // { [typeId]: { properties, data } }

    // =========================================================================
    // Registry loading
    // =========================================================================

    // Load registry from localStorage; if absent, fetch from server.
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
            registry = registry || {};
        }
    }

    // =========================================================================
    // Reconciliation
    // =========================================================================

    // Sync an entity's block instance data with the current registry definition:
    //   • Removes instances whose typeId is no longer in the registry.
    //   • Removes data fields the registry no longer defines.
    //   • Adds new data fields with the registry's default value.
    // Recomputes entity physics properties afterward.
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

            for (const key of Object.keys(datum)) {
                if (key !== "typeId" && !(key in registryData)) {
                    delete datum[key];
                }
            }
            for (const [key, defaultVal] of Object.entries(registryData)) {
                if (!(key in datum)) datum[key] = defaultVal;
            }
        }

        // removeBlock without auto-recompute to avoid N redundant calls
        for (const bui of busToRemove) {
            _removeBlock(entity, bui);
        }

        computeEntityProps(entity);
    }

    // =========================================================================
    // Block helpers
    // =========================================================================

    function genBui() {
        return "bui_" + Math.random().toString(36).slice(2, 9);
    }

    // Internal remove that does NOT recompute entity props (caller is responsible).
    function _removeBlock(entity, bui) {
        delete entity.blockData[bui];
        for (const key of Object.keys(entity.blockMap)) {
            if (entity.blockMap[key] === bui) delete entity.blockMap[key];
        }
    }

    // Place a new block instance of typeId with its top-left tile at (tx, ty).
    // Returns the generated bui, or null if any tile is occupied / type unknown.
    // Recomputes entity physics properties on success.
    function addBlock(entity, typeId, tx, ty) {
        if (!registry) { console.warn("tiles: registry not loaded"); return null; }

        const type = registry[typeId];
        if (!type) { console.warn("tiles: unknown block type:", typeId); return null; }

        const { size } = type.properties;

        for (let dy = 0; dy < size.y; dy++) {
            for (let dx = 0; dx < size.x; dx++) {
                if (entity.blockMap[(tx + dx) + "," + (ty + dy)] !== undefined) {
                    console.warn("tiles: tile already occupied at", tx + dx, ty + dy);
                    return null;
                }
            }
        }

        const bui = genBui();
        const datum = { typeId };
        for (const [key, val] of Object.entries(type.data)) datum[key] = val;
        entity.blockData[bui] = datum;

        for (let dy = 0; dy < size.y; dy++) {
            for (let dx = 0; dx < size.x; dx++) {
                entity.blockMap[(tx + dx) + "," + (ty + dy)] = bui;
            }
        }

        computeEntityProps(entity);
        return bui;
    }

    // Remove a block instance by bui and recompute entity physics properties.
    function removeBlock(entity, bui) {
        _removeBlock(entity, bui);
        computeEntityProps(entity);
    }

    // =========================================================================
    // Entity physics property computation
    // =========================================================================

    // Build a bui → anchor-tile map by finding the min (tx, ty) for each bui.
    // Valid because all blocks are rectangular, so min-x and min-y give top-left.
    function _blockAnchors(entity) {
        const anchors = {};
        for (const [posKey, bui] of Object.entries(entity.blockMap)) {
            const [tx, ty] = posKey.split(",").map(Number);
            if (!anchors[bui]) {
                anchors[bui] = { tx, ty };
            } else {
                if (tx < anchors[bui].tx) anchors[bui].tx = tx;
                if (ty < anchors[bui].ty) anchors[bui].ty = ty;
            }
        }
        return anchors;
    }

    // Recompute and write entity.mass, entity.interactionRadius, entity.momentOfInertia.
    // - mass            = BASE_MASS + Σ block type masses
    // - interactionRadius = max distance from entity center (local 0,0) to any tile corner
    // - momentOfInertia = Σ (I_block + m_block * d²) via parallel axis theorem,
    //                     where d = distance from block center to entity center
    function computeEntityProps(entity) {
        if (!entity.blockData) { entity.blockData = {}; }
        if (!entity.blockMap)  { entity.blockMap  = {}; }

        let totalMass    = BASE_MASS;
        let maxRadiusSq  = 0;
        // Base moment of inertia for the bare hull — assume a point mass at origin
        let moi          = BASE_MASS * 1;

        const anchors = _blockAnchors(entity);

        // Interaction radius: check all 4 corners of every tile cell
        for (const posKey of Object.keys(entity.blockMap)) {
            const [tx, ty] = posKey.split(",").map(Number);
            for (let cx = tx; cx <= tx + 1; cx++) {
                for (let cy = ty; cy <= ty + 1; cy++) {
                    const lx = cx * TILE_SIZE;
                    const ly = cy * TILE_SIZE;
                    const dSq = lx * lx + ly * ly;
                    if (dSq > maxRadiusSq) maxRadiusSq = dSq;
                }
            }
        }

        // Mass and moment of inertia: one contribution per block instance
        for (const [bui, datum] of Object.entries(entity.blockData)) {
            if (!registry) continue;
            const type = registry[datum.typeId];
            if (!type) continue;

            const m    = type.properties.mass || 0;
            const { x: w, y: h } = type.properties.size;
            totalMass += m;

            const anchor = anchors[bui];
            if (!anchor) continue;

            // Block center in entity-local space
            const bcx = (anchor.tx + w / 2) * TILE_SIZE;
            const bcy = (anchor.ty + h / 2) * TILE_SIZE;

            // Rectangle moment of inertia about its own center
            const Iself = m * ((w * TILE_SIZE) ** 2 + (h * TILE_SIZE) ** 2) / 12;
            // Parallel axis: shift to entity center
            const d2 = bcx * bcx + bcy * bcy;
            moi += Iself + m * d2;
        }

        entity.mass             = totalMass;
        entity.interactionRadius = Math.sqrt(maxRadiusSq);
        entity.momentOfInertia  = Math.max(moi, 1); // never zero
    }

    // =========================================================================
    // Force / impulse application helpers
    // =========================================================================

    // Apply an impulse (kg·px/frame) at a world-space point.
    // Affects both linear velocity (vx, vy) and angularVelocity.
    function applyImpulse(entity, ix, iy, wx, wy) {
        if (!entity.mass) return;
        entity.vx += ix / entity.mass;
        entity.vy += iy / entity.mass;
        const rx = wx - entity.x;
        const ry = wy - entity.y;
        // 2D cross product: r × impulse
        entity.angularVelocity += (rx * iy - ry * ix) / entity.momentOfInertia;
    }

    // Apply a linear impulse at the center of mass (no torque).
    function applyLinearImpulse(entity, ix, iy) {
        if (!entity.mass) return;
        entity.vx += ix / entity.mass;
        entity.vy += iy / entity.mass;
    }

    // Apply a pure angular impulse (torque impulse).
    function applyTorque(entity, torque) {
        if (!entity.momentOfInertia) return;
        entity.angularVelocity += torque / entity.momentOfInertia;
    }

    // =========================================================================
    // Collision detection helpers
    // =========================================================================

    // Return the 4 world-space corners of a tile at (tx, ty) belonging to entity.
    function _tileWorldCorners(tx, ty, entity) {
        const TS  = TILE_SIZE;
        const cos = Math.cos(entity.angle);
        const sin = Math.sin(entity.angle);
        const ex  = entity.x, ey = entity.y;
        // Local corners (top-left, top-right, bottom-right, bottom-left)
        return [
            [tx * TS,       ty * TS      ],
            [(tx + 1) * TS, ty * TS      ],
            [(tx + 1) * TS, (ty + 1) * TS],
            [tx * TS,       (ty + 1) * TS]
        ].map(function ([lx, ly]) {
            return [ex + lx * cos - ly * sin,
                    ey + lx * sin + ly * cos];
        });
    }

    // Return the world-space center of a tile at (tx, ty) belonging to entity.
    function _tileWorldCenter(tx, ty, entity) {
        const lx  = (tx + 0.5) * TILE_SIZE;
        const ly  = (ty + 0.5) * TILE_SIZE;
        const cos = Math.cos(entity.angle);
        const sin = Math.sin(entity.angle);
        return [entity.x + lx * cos - ly * sin,
                entity.y + lx * sin + ly * cos];
    }

    // SAT test between two tiles from (possibly different) entities.
    // Returns { overlap, normal (from B toward A), contactPoint } or null if separated.
    // For squares rotated by their entity's angle, the separating axes are the
    // two face normals of each entity's oriented square (4 axes total).
    function _satTestTiles(txA, tyA, entityA, txB, tyB, entityB) {
        const cA  = _tileWorldCorners(txA, tyA, entityA);
        const cB  = _tileWorldCorners(txB, tyB, entityB);
        const ca  = Math.cos(entityA.angle), sa = Math.sin(entityA.angle);
        const cb  = Math.cos(entityB.angle), sb = Math.sin(entityB.angle);

        // Test axes: two per entity (the square only needs edge normals, not diagonals)
        const axes = [
            [ ca,  sa],
            [-sa,  ca],
            [ cb,  sb],
            [-sb,  cb]
        ];

        let minOverlap = Infinity;
        let minAxis    = null;

        for (const ax of axes) {
            let minA = Infinity,  maxA = -Infinity;
            let minB = Infinity,  maxB = -Infinity;
            for (const [x, y] of cA) {
                const p = x * ax[0] + y * ax[1];
                if (p < minA) minA = p;
                if (p > maxA) maxA = p;
            }
            for (const [x, y] of cB) {
                const p = x * ax[0] + y * ax[1];
                if (p < minB) minB = p;
                if (p > maxB) maxB = p;
            }
            const ov = Math.min(maxA, maxB) - Math.max(minA, minB);
            if (ov <= 0) return null; // separating axis found
            if (ov < minOverlap) { minOverlap = ov; minAxis = [ax[0], ax[1]]; }
        }

        // Orient normal from B toward A
        const [cenAx, cenAy] = _tileWorldCenter(txA, tyA, entityA);
        const [cenBx, cenBy] = _tileWorldCenter(txB, tyB, entityB);
        if ((cenAx - cenBx) * minAxis[0] + (cenAy - cenBy) * minAxis[1] < 0) {
            minAxis[0] = -minAxis[0];
            minAxis[1] = -minAxis[1];
        }

        return {
            overlap:      minOverlap,
            normal:       minAxis,
            // Contact point: midpoint of the two tile centers is a good approximation
            contactPoint: [(cenAx + cenBx) / 2, (cenAy + cenBy) / 2]
        };
    }

    // =========================================================================
    // Collision resolution
    // =========================================================================

    // Resolve a single contact between two entities using the impulse method.
    // Modifies vx, vy, angularVelocity on both entities.
    function resolveContact(entityA, entityB, contact) {
        const [nx, ny]   = contact.normal;
        const [cx, cy]   = contact.contactPoint;

        // Vectors from each entity's center to the contact point
        const rAx = cx - entityA.x,  rAy = cy - entityA.y;
        const rBx = cx - entityB.x,  rBy = cy - entityB.y;

        // Velocity of each body at the contact point (linear + angular contribution)
        const vAcx = entityA.vx - entityA.angularVelocity * rAy;
        const vAcy = entityA.vy + entityA.angularVelocity * rAx;
        const vBcx = entityB.vx - entityB.angularVelocity * rBy;
        const vBcy = entityB.vy + entityB.angularVelocity * rBx;

        // Relative velocity along the contact normal (positive = separating)
        const vRelN = (vAcx - vBcx) * nx + (vAcy - vBcy) * ny;
        if (vRelN >= 0) return; // already separating — no impulse needed

        // 2D scalar cross products: r × n
        const rAcrossN = rAx * ny - rAy * nx;
        const rBcrossN = rBx * ny - rBy * nx;

        const invMA = 1 / entityA.mass;
        const invMB = 1 / entityB.mass;
        const invIA = 1 / entityA.momentOfInertia;
        const invIB = 1 / entityB.momentOfInertia;

        // Impulse scalar: j = -(1+e) * vRel·n / (effective mass denominator)
        const j = -(1 + RESTITUTION) * vRelN /
            (invMA + invMB
             + rAcrossN * rAcrossN * invIA
             + rBcrossN * rBcrossN * invIB);

        // Apply equal-and-opposite impulses at the contact point
        applyImpulse(entityA,  j * nx,  j * ny, cx, cy);
        applyImpulse(entityB, -j * nx, -j * ny, cx, cy);
    }

    // Full collision resolution pass for all entity pairs.
    // Call once per frame, after position/angle integration.
    //
    // Steps:
    //  1. Broad phase:  skip pairs whose interaction radii don't overlap
    //  2. Narrow phase: SAT test every tile pair of the candidate entities
    //  3. Resolve:      apply impulse for the deepest penetrating contact
    function resolveCollisions(entities) {
        const list = Array.from(entities.values());

        for (let i = 0; i < list.length; i++) {
            for (let k = i + 1; k < list.length; k++) {
                const eA = list[i];
                const eB = list[k];

                // --- Broad phase ---
                const dx     = eA.x - eB.x;
                const dy     = eA.y - eB.y;
                const distSq = dx * dx + dy * dy;
                const radSum = (eA.interactionRadius || 0) + (eB.interactionRadius || 0);
                if (radSum === 0 || distSq > radSum * radSum) continue;

                // --- Narrow phase: find all colliding tile pairs ---
                let deepest = null;

                for (const [posKeyA, buiA] of Object.entries(eA.blockMap)) {
                    const [txA, tyA] = posKeyA.split(",").map(Number);
                    for (const [posKeyB, buiB] of Object.entries(eB.blockMap)) {
                        const [txB, tyB] = posKeyB.split(",").map(Number);
                        const hit = _satTestTiles(txA, tyA, eA, txB, tyB, eB);
                        if (!hit) continue;
                        hit.buiA = buiA;
                        hit.buiB = buiB;
                        if (!deepest || hit.overlap > deepest.overlap) deepest = hit;
                    }
                }

                if (!deepest) continue;

                // --- Impulse resolution for the deepest contact ---
                resolveContact(eA, eB, deepest);
            }
        }
    }

    // =========================================================================
    // Rendering
    // =========================================================================

    // Draw all entity block tiles onto the canvas.
    // Each tile position in entity.blockMap gets a TILE_SIZE × TILE_SIZE rectangle
    // coloured by its block type.  The entity's (x, y) and angle are applied so
    // blocks rotate and translate with the entity.
    function renderBlocks(canvas, entities) {
        if (!registry) return;

        const dpr = window.devicePixelRatio || 1;
        const w   = canvas.clientWidth;
        const h   = canvas.clientHeight;
        if (canvas.width  !== Math.round(w * dpr) ||
            canvas.height !== Math.round(h * dpr)) {
            canvas.width  = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }

        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

    // =========================================================================
    // Public API
    // =========================================================================
    window.tiles = {
        // Registry
        initRegistry,
        fetchRegistry,
        // Block lifecycle
        reconcileBlocks,
        addBlock,
        removeBlock,
        computeEntityProps,
        // Rendering
        renderBlocks,
        // Collision
        resolveCollisions,
        resolveContact,
        // Force helpers
        applyImpulse,
        applyLinearImpulse,
        applyTorque,
        // Utilities
        getRegistry: function () { return registry; },
        TILE_SIZE,
        BASE_MASS,
        RESTITUTION
    };
})();
