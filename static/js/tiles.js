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
    const DAMAGE_SCALE = 1.0;            // damage dealt to each block = j * DAMAGE_SCALE
    const POS_CORRECTION_FACTOR = 0.4;  // fraction of overlap corrected per step (Baumgarte)
    const POS_SLOP              = 0.5;  // overlap tolerance (px) before correction kicks in
    const REGISTRY_KEY = "ws_blockRegistry_v2";
    const REGISTRY_URL = "/api/block-registry";

    let registry = null; // { [typeId]: { properties, data } }

    // Shape animation time — advances only when not paused.
    let _shapeTime      = 0;
    let _shapeRunning   = true;
    let _shapeWallStart = performance.now() / 1000;

    function setShapePaused(paused) {
        if (paused && _shapeRunning) {
            _shapeTime   += performance.now() / 1000 - _shapeWallStart;
            _shapeRunning  = false;
        } else if (!paused && !_shapeRunning) {
            _shapeWallStart = performance.now() / 1000;
            _shapeRunning   = true;
        }
    }

    // =========================================================================
    // Registry loading
    // =========================================================================

    // Load registry from localStorage; if absent or outdated, fetch from server.
    async function initRegistry() {
        const cached = localStorage.getItem(REGISTRY_KEY);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                // Invalidate cache if any block type is missing the shapes field
                // (indicates a pre-shapes-system cache).
                const stale = Object.values(parsed).some(
                    t => t.properties && !("shapes" in t.properties)
                );
                if (!stale) {
                    registry = parsed;
                    return;
                }
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

        applyDesignChange(entity);
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

    // Reduce block health by damage; destroy it (and refresh physics) if health hits zero.
    function _damageBlock(entity, bui, damage) {
        const datum = entity.blockData[bui];
        if (!datum) return;
        datum.health -= damage;
        if (datum.health <= 0) {
            // Notify particle system before removing the block
            if (typeof window._particleOnBlockDestroyed === "function" && registry) {
                let anchorTx = null, anchorTy = null;
                for (const [key, b] of Object.entries(entity.blockMap)) {
                    if (b === bui) {
                        const [kx, ky] = key.split(",").map(Number);
                        if (anchorTx === null || kx < anchorTx || (kx === anchorTx && ky < anchorTy)) {
                            anchorTx = kx; anchorTy = ky;
                        }
                    }
                }
                const type = registry[datum.typeId];
                if (anchorTx !== null && type) {
                    const { x: sw, y: sh } = type.properties.size;
                    const [wx, wy] = _tileWorldCenter(anchorTx + (sw - 1) / 2, anchorTy + (sh - 1) / 2, entity);
                    window._particleOnBlockDestroyed(wx, wy, _firstShapeColor(type));
                }
            }
            _removeBlock(entity, bui);
            computeEntityProps(entity);
            entity._pendingSplit = true;
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

    // Recompute entity physics properties and update entity.x/y to track the block
    // center of mass.
    //
    // blockMap keys remain integers throughout (editor-safe).  Instead, the CoM
    // offset from the integer-tile origin is stored as entity.comOffsetX/Y (local px).
    // Only the *delta* since the last call is applied to entity.x/y, so this is
    // idempotent: calling it twice with no block changes is a no-op.
    function computeEntityProps(entity) {
        if (!entity.blockData) { entity.blockData = {}; }
        if (!entity.blockMap)  { entity.blockMap  = {}; }

        const anchors = _blockAnchors(entity);

        // Compute block CoM in integer-tile local space (px from grid origin)
        let blockMassSum = 0;
        let newComOX = 0, newComOY = 0;

        for (const [bui, datum] of Object.entries(entity.blockData)) {
            if (!registry) continue;
            const type = registry[datum.typeId];
            if (!type) continue;
            const m          = type.properties.mass || 0;
            const { x: w, y: h } = type.properties.size;
            const anchor     = anchors[bui];
            if (!anchor) continue;
            const bcx = (anchor.tx + (w - 1) / 2) * TILE_SIZE;
            const bcy = (anchor.ty + (h - 1) / 2) * TILE_SIZE;
            newComOX += m * bcx;
            newComOY += m * bcy;
            blockMassSum += m;
        }
        if (blockMassSum > 0) { newComOX /= blockMassSum; newComOY /= blockMassSum; }

        // Store new CoM offset (position shift is NOT applied here — call
        // applyDesignChange() instead when the block layout has intentionally changed).
        entity.comOffsetX = newComOX;
        entity.comOffsetY = newComOY;

        // Physics properties — block positions measured from CoM
        let totalMass   = BASE_MASS;
        let maxRadiusSq = 0;
        let moi         = BASE_MASS; // bare hull: point mass at CoM

        for (const posKey of Object.keys(entity.blockMap)) {
            const [tx, ty] = posKey.split(",").map(Number);
            for (let cx = tx; cx <= tx + 1; cx++) {
                for (let cy = ty; cy <= ty + 1; cy++) {
                    const lx = (cx - 0.5) * TILE_SIZE - newComOX;
                    const ly = (cy - 0.5) * TILE_SIZE - newComOY;
                    const dSq = lx * lx + ly * ly;
                    if (dSq > maxRadiusSq) maxRadiusSq = dSq;
                }
            }
        }

        for (const [bui, datum] of Object.entries(entity.blockData)) {
            if (!registry) continue;
            const type = registry[datum.typeId];
            if (!type) continue;
            const m          = type.properties.mass || 0;
            const { x: w, y: h } = type.properties.size;
            totalMass += m;
            const anchor = anchors[bui];
            if (!anchor) continue;
            const bcx   = (anchor.tx + (w - 1) / 2) * TILE_SIZE - newComOX;
            const bcy   = (anchor.ty + (h - 1) / 2) * TILE_SIZE - newComOY;
            const Iself = m * ((w * TILE_SIZE) ** 2 + (h * TILE_SIZE) ** 2) / 12;
            moi += Iself + m * (bcx * bcx + bcy * bcy);
        }

        entity.mass              = totalMass;
        entity.interactionRadius = Math.sqrt(maxRadiusSq);
        entity.momentOfInertia   = Math.max(moi, 1);
    }

    // Call this (instead of computeEntityProps) whenever the block layout has
    // intentionally changed (editor save, Drive load/migration).
    // Shifts entity.x/y so it tracks the new CoM, then calls computeEntityProps.
    function applyDesignChange(entity) {
        const prevOX = entity.comOffsetX || 0;
        const prevOY = entity.comOffsetY || 0;
        computeEntityProps(entity);
        const dox = entity.comOffsetX - prevOX;
        const doy = entity.comOffsetY - prevOY;
        if ((Math.abs(dox) > 1e-9 || Math.abs(doy) > 1e-9) && entity.x !== undefined) {
            const cos = Math.cos(entity.angle || 0);
            const sin = Math.sin(entity.angle || 0);
            entity.x += dox * cos - doy * sin;
            entity.y += dox * sin + doy * cos;
        }
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
    // Tile local positions are offset by -comOffset so entity.x/y is the CoM.
    function _tileWorldCorners(tx, ty, entity) {
        const TS  = TILE_SIZE;
        const ox  = entity.comOffsetX || 0;
        const oy  = entity.comOffsetY || 0;
        const cos = Math.cos(entity.angle);
        const sin = Math.sin(entity.angle);
        const ex  = entity.x, ey = entity.y;
        return [
            [(tx - 0.5) * TS - ox, (ty - 0.5) * TS - oy],
            [(tx + 0.5) * TS - ox, (ty - 0.5) * TS - oy],
            [(tx + 0.5) * TS - ox, (ty + 0.5) * TS - oy],
            [(tx - 0.5) * TS - ox, (ty + 0.5) * TS - oy]
        ].map(function ([lx, ly]) {
            return [ex + lx * cos - ly * sin,
                    ey + lx * sin + ly * cos];
        });
    }

    // Return the world-space center of a tile at (tx, ty) belonging to entity.
    function _tileWorldCenter(tx, ty, entity) {
        const lx  = tx * TILE_SIZE - (entity.comOffsetX || 0);
        const ly  = ty * TILE_SIZE - (entity.comOffsetY || 0);
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

        // Damage the blocks at the contact point, proportional to impulse magnitude
        const damage = j * DAMAGE_SCALE;
        _damageBlock(entityA, contact.buiA, damage);
        _damageBlock(entityB, contact.buiB, damage);

        // Positional correction (Baumgarte): push entities apart to prevent sinking
        const correction = Math.max(contact.overlap - POS_SLOP, 0) * POS_CORRECTION_FACTOR
            / (invMA + invMB);
        entityA.x += nx * correction * invMA;
        entityA.y += ny * correction * invMA;
        entityB.x -= nx * correction * invMB;
        entityB.y -= ny * correction * invMB;
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
    // Connectivity split
    // =========================================================================

    // After a block is destroyed, check whether the remaining blocks are still
    // all 4-adjacent-connected.  If they split into two or more components:
    //   • The component whose CoM is closest to the entity's current world
    //     position stays as the original entity (uid preserved).
    //   • Every other component is returned as a new plain entity-like object
    //     with fully computed physics (blockData, blockMap, x, y, vx, vy,
    //     angle, angularVelocity, comOffsetX, comOffsetY, mass,
    //     interactionRadius, momentOfInertia).
    // Returns [] when the entity is still fully connected (common case).
    function splitIfDisconnected(entity) {
        const keys = Object.keys(entity.blockMap);
        if (keys.length === 0) return [];

        // ---- BFS flood-fill – find connected components (4-adjacent) ----
        // Only consider tiles whose bui still exists in blockData.
        const liveKeys = keys.filter(k => entity.blockData[entity.blockMap[k]] !== undefined);
        if (liveKeys.length === 0) return [];

        const visited = new Set();
        const groups  = [];
        for (const startKey of liveKeys) {
            if (visited.has(startKey)) continue;
            const group = [];
            const queue = [startKey];
            visited.add(startKey);
            while (queue.length > 0) {
                const key = queue.shift();
                group.push(key);
                const [tx, ty] = key.split(",").map(Number);
                for (const [nx, ny] of [[tx-1,ty],[tx+1,ty],[tx,ty-1],[tx,ty+1]]) {
                    const nk = nx + "," + ny;
                    if (!visited.has(nk) &&
                        entity.blockMap[nk] !== undefined &&
                        entity.blockData[entity.blockMap[nk]] !== undefined) {
                        visited.add(nk);
                        queue.push(nk);
                    }
                }
            }
            groups.push(group);
        }
        if (groups.length <= 1) return [];

        // ---- Snapshot entity state before any modifications ----
        const oldX  = entity.x;
        const oldY  = entity.y;
        const oldOX = entity.comOffsetX || 0;
        const oldOY = entity.comOffsetY || 0;
        const cos   = Math.cos(entity.angle || 0);
        const sin   = Math.sin(entity.angle || 0);

        // Compute mass-weighted local CoM for a set of tile keys.
        // Uses the same anchor logic as _blockAnchors / computeEntityProps.
        function groupLocalCoM(tileKeys) {
            const buiAnchor = {};
            for (const key of tileKeys) {
                const bui = entity.blockMap[key];
                const [tx, ty] = key.split(",").map(Number);
                if (!buiAnchor[bui]) {
                    buiAnchor[bui] = { tx, ty };
                } else {
                    if (tx < buiAnchor[bui].tx) buiAnchor[bui].tx = tx;
                    if (ty < buiAnchor[bui].ty) buiAnchor[bui].ty = ty;
                }
            }
            let cx = 0, cy = 0, massSum = 0;
            for (const [bui, anchor] of Object.entries(buiAnchor)) {
                const datum = entity.blockData[bui];
                if (!datum) continue;
                const type = registry[datum.typeId];
                if (!type) continue;
                const m = type.properties.mass || 0;
                const { x: w, y: h } = type.properties.size;
                cx += m * (anchor.tx + (w - 1) / 2) * TILE_SIZE;
                cy += m * (anchor.ty + (h - 1) / 2) * TILE_SIZE;
                massSum += m;
            }
            if (massSum > 0) { cx /= massSum; cy /= massSum; }
            return { lcx: cx, lcy: cy };
        }

        // World CoM for each group (relative to oldX/oldY via old comOffset)
        const groupCoMs = groups.map(tileKeys => {
            const { lcx, lcy } = groupLocalCoM(tileKeys);
            const dx = lcx - oldOX;
            const dy = lcy - oldOY;
            return { worldX: oldX + cos * dx - sin * dy,
                     worldY: oldY + sin * dx + cos * dy };
        });

        // ---- Pick group closest to the old world CoM ----
        let closestIdx  = 0;
        let closestDist = Infinity;
        for (let i = 0; i < groups.length; i++) {
            const d = Math.hypot(groupCoMs[i].worldX - oldX, groupCoMs[i].worldY - oldY);
            if (d < closestDist) { closestDist = d; closestIdx = i; }
        }

        // Extract blockData + blockMap for a set of tile keys
        function extractBlocks(tileKeys) {
            const blockMap = {};
            const buiSet   = new Set();
            for (const key of tileKeys) {
                blockMap[key] = entity.blockMap[key];
                buiSet.add(entity.blockMap[key]);
            }
            const blockData = {};
            for (const bui of buiSet) {
                if (entity.blockData[bui] === undefined) continue;
                blockData[bui] = JSON.parse(JSON.stringify(entity.blockData[bui]));
            }
            return { blockMap, blockData };
        }

        // ---- Extract all groups before modifying the entity ----
        const allExtracted = groups.map(g => extractBlocks(g));

        // ---- Keep closest group as original entity ----
        entity.blockData = allExtracted[closestIdx].blockData;
        entity.blockMap  = allExtracted[closestIdx].blockMap;
        applyDesignChange(entity);

        // ---- Build new entity specs for every other group ----
        const newEntities = [];
        for (let i = 0; i < groups.length; i++) {
            if (i === closestIdx) continue;
            const { blockMap, blockData } = allExtracted[i];
            const { worldX, worldY }      = groupCoMs[i];
            // Rigid-body velocity at this CoM: v = v_CoM + ω × r
            const rdx = worldX - oldX;
            const rdy = worldY - oldY;
            const spec = {
                blockData,
                blockMap,
                x:               worldX,
                y:               worldY,
                vx:              entity.vx - entity.angularVelocity * rdy,
                vy:              entity.vy + entity.angularVelocity * rdx,
                angle:           entity.angle,
                angularVelocity: entity.angularVelocity,
                comOffsetX:      0,
                comOffsetY:      0,
                mass:            1,
                interactionRadius: 0,
                momentOfInertia: 1,
            };
            computeEntityProps(spec);
            newEntities.push(spec);
        }
        return newEntities;
    }

    // =========================================================================
    // Rendering
    // =========================================================================

    // =========================================================================
    // Shape rendering
    // =========================================================================

    // Parse a comma-separated shapes string into an array of {id, params} objects.
    // Shape format: "<id>:<expr>:<expr>:..." where coordinates/sizes are in tiles (1=one tile)
    // and colors are in 0–1 range.  Each parameter may be a plain number or a math expression
    // (evaluated each render cycle).
    // Available functions/constants: sin cos tan abs sqrt pow log floor ceil round min max PI E
    // Available operators:  + - * / % (modulo) ** (exponent)
    // Available variables:  t (seconds since page load)  h (health/maxHealth, 0–1)
    //                       x y (tile-unit position of current pixel within block, color fields only;
    //                            resolves to 0 in position/size fields)
    // Supported shapes:
    //   r:x:y:w:h:rot:cr:cg:cb[:ca]  — filled rectangle
    //   c:cx:cy:radius:rot:cr:cg:cb[:ca] — filled circle
    // rot is 0–1 (0=0°, 0.5=180°, 1=360°); any value is modulo'd into range.
    // Alpha (ca) is optional and defaults to 1.
    //
    // PERFORMANCE WARNING: using x, y, t, or h in color fields triggers a per-pixel
    // slow path (OffscreenCanvas pixel loop) instead of a single fillRect/arc call.
    // This runs in JS for every pixel of every affected shape every frame. Use
    // sparingly — large shapes, many blocks, or high display DPI will tank frame rate.
    function parseShapes(shapesStr) {
        if (!shapesStr) return null;
        const shapes = [];
        for (const part of shapesStr.split(",")) {
            const tokens = part.trim().split(":");
            if (tokens.length < 2) continue;
            const params = tokens.slice(1).map(function (token) {
                const n = Number(token);
                if (!isNaN(n)) return n; // plain number — fast path
                // Math expression — compile once, evaluate each frame
                try {
                    return new Function("_m", "_t", "_h", "_x", "_y",
                        "\"use strict\";" +
                        "var sin=_m.sin,cos=_m.cos,tan=_m.tan,abs=_m.abs," +
                        "sqrt=_m.sqrt,pow=_m.pow,log=_m.log,floor=_m.floor," +
                        "ceil=_m.ceil,round=_m.round,min=_m.min,max=_m.max," +
                        "PI=_m.PI,E=_m.E,t=_t,h=_h,x=_x,y=_y;" +
                        "return (" + token + ");");
                } catch (e) {
                    console.warn("shapes: bad expression \"" + token + "\":", e.message);
                    return 0;
                }
            });
            shapes.push({ id: tokens[0], params: params });
        }
        return shapes.length > 0 ? shapes : null;
    }

    // Return the {r,g,b} color (0–1 channels) of the bottom-most (first) shape in a block
    // type's shapes string, evaluated at full health (h=1) and the current game time.
    // Falls back to the block's flat `color` property (normalised), or white if absent.
    function _firstShapeColor(type) {
        const t = _shapeRunning
            ? _shapeTime + (performance.now() / 1000 - _shapeWallStart)
            : _shapeTime;
        if (type && type.properties && type.properties.shapes) {
            const shapes = parseShapes(type.properties.shapes);
            if (shapes && shapes.length > 0) {
                const { id, params } = shapes[0];
                function ev(p) { return typeof p === "function" ? p(Math, t, 1, 0, 0) : p; }
                if (id === "r") return { r: ev(params[6]), g: ev(params[7]), b: ev(params[8]) };
                if (id === "c") return { r: ev(params[4]), g: ev(params[5]), b: ev(params[6]) };
            }
        }
        if (type && type.properties && type.properties.color) {
            const { r, g, b } = type.properties.color;
            return { r: r / 255, g: g / 255, b: b / 255 };
        }
        return { r: 1, g: 1, b: 1 };
    }

    // Draw parsed shapes onto ctx, with block origin at (bx, by) and TS pixels per tile.
    // Optional alpha (0–1) applied via globalAlpha.
    // Math-expression params are evaluated with the current time and health ratio.
    // Color params that use x/y trigger per-pixel rendering via OffscreenCanvas (slow path).
    // The slow path draws onto an OffscreenCanvas in entity-local pixel space, then blits it
    // with ctx.drawImage which correctly respects the current canvas transform (DPR, camera,
    // entity rotation) — unlike getImageData/putImageData which use raw device pixels.
    function drawShapes(ctx, shapes, bx, by, TS, alpha, h) {
        const t = _shapeRunning
            ? _shapeTime + (performance.now() / 1000 - _shapeWallStart)
            : _shapeTime;
        const hv = (h !== undefined) ? h : 1;
        const prevAlpha = ctx.globalAlpha;
        if (alpha !== undefined) ctx.globalAlpha = alpha;

        // Evaluate a param; position/size params always pass x=0,y=0.
        function ev(p, px, py) {
            return typeof p === "function" ? p(Math, t, hv, px, py) : p;
        }

        // Render a pixel loop into an OffscreenCanvas and blit it at (x0,y0) in the
        // current transform space.  fillPixel(d,i,elx,ely) should set d[i..i+3] or skip.
        function blitPixels(x0, y0, W, H, fillPixel) {
            const off = new OffscreenCanvas(W, H);
            const idata = off.getContext("2d").createImageData(W, H);
            const d = idata.data;
            for (let offy = 0; offy < H; offy++) {
                for (let offx = 0; offx < W; offx++) {
                    fillPixel(d, (offy * W + offx) * 4,
                              x0 + offx + 0.5, y0 + offy + 0.5);
                }
            }
            off.getContext("2d").putImageData(idata, 0, 0);
            ctx.drawImage(off, x0, y0);
        }

        for (const { id, params } of shapes) {
            if (id === "r") {
                const [xP, yP, wP, hP, rotP, crP, cgP, cbP, caP] = params;
                const xv = ev(xP, 0, 0), yv = ev(yP, 0, 0);
                const wv = ev(wP, 0, 0), hv_r = ev(hP, 0, 0);
                const rotv = ev(rotP, 0, 0);
                const angle = ((rotv % 1) + 1) % 1 * Math.PI * 2;
                const rcx = bx + (xv + wv / 2) * TS;
                const rcy = by + (yv + hv_r / 2) * TS;
                const hw = wv * TS / 2, hh = hv_r * TS / 2;
                const dynColor = typeof crP === "function" || typeof cgP === "function" ||
                                 typeof cbP === "function" || typeof caP === "function";
                if (!dynColor) {
                    const cr = ev(crP, 0, 0), cg = ev(cgP, 0, 0), cb = ev(cbP, 0, 0);
                    const ca = caP !== undefined ? ev(caP, 0, 0) : 1;
                    ctx.save();
                    ctx.translate(rcx, rcy);
                    ctx.rotate(angle);
                    ctx.fillStyle = "rgba(" + Math.round(cr * 255) + "," + Math.round(cg * 255) + "," + Math.round(cb * 255) + "," + ca + ")";
                    ctx.fillRect(-hw, -hh, wv * TS, hv_r * TS);
                    ctx.restore();
                } else {
                    const cosA = Math.cos(angle), sinA = Math.sin(angle);
                    const rad = Math.sqrt(hw * hw + hh * hh);
                    const x0 = Math.floor(rcx - rad), y0 = Math.floor(rcy - rad);
                    const W = Math.ceil(rcx + rad) - x0, H = Math.ceil(rcy + rad) - y0;
                    if (W <= 0 || H <= 0) continue;
                    blitPixels(x0, y0, W, H, function (d, i, elx, ely) {
                        const dx = elx - rcx, dy = ely - rcy;
                        if (Math.abs(dx * cosA + dy * sinA) > hw) return;
                        if (Math.abs(-dx * sinA + dy * cosA) > hh) return;
                        const tx = (elx - bx) / TS, ty = (ely - by) / TS;
                        const cr = ev(crP, tx, ty), cg = ev(cgP, tx, ty), cb = ev(cbP, tx, ty);
                        const ca = caP !== undefined ? ev(caP, tx, ty) : 1;
                        const a = Math.min(1, Math.max(0, ca));
                        if (a <= 0) return;
                        d[i] = Math.round(cr * 255); d[i+1] = Math.round(cg * 255);
                        d[i+2] = Math.round(cb * 255); d[i+3] = Math.round(a * 255);
                    });
                }
            } else if (id === "c") {
                const [cxP, cyP, radiusP, rotP, crP, cgP, cbP, caP] = params;
                const cxv = ev(cxP, 0, 0), cyv = ev(cyP, 0, 0), rv = ev(radiusP, 0, 0);
                const ccx = bx + cxv * TS, ccy = by + cyv * TS, rPx = rv * TS;
                const dynColor = typeof crP === "function" || typeof cgP === "function" ||
                                 typeof cbP === "function" || typeof caP === "function";
                if (!dynColor) {
                    const cr = ev(crP, 0, 0), cg = ev(cgP, 0, 0), cb = ev(cbP, 0, 0);
                    const ca = caP !== undefined ? ev(caP, 0, 0) : 1;
                    ctx.fillStyle = "rgba(" + Math.round(cr * 255) + "," + Math.round(cg * 255) + "," + Math.round(cb * 255) + "," + ca + ")";
                    ctx.beginPath();
                    ctx.arc(ccx, ccy, rPx, 0, Math.PI * 2);
                    ctx.fill();
                } else {
                    const x0 = Math.floor(ccx - rPx), y0 = Math.floor(ccy - rPx);
                    const W = Math.ceil(ccx + rPx) - x0, H = Math.ceil(ccy + rPx) - y0;
                    if (W <= 0 || H <= 0) continue;
                    const rPx2 = rPx * rPx;
                    blitPixels(x0, y0, W, H, function (d, i, elx, ely) {
                        const dx = elx - ccx, dy = ely - ccy;
                        if (dx * dx + dy * dy > rPx2) return;
                        const tx = (elx - bx) / TS, ty = (ely - by) / TS;
                        const cr = ev(crP, tx, ty), cg = ev(cgP, tx, ty), cb = ev(cbP, tx, ty);
                        const ca = caP !== undefined ? ev(caP, tx, ty) : 1;
                        const a = Math.min(1, Math.max(0, ca));
                        if (a <= 0) return;
                        d[i] = Math.round(cr * 255); d[i+1] = Math.round(cg * 255);
                        d[i+2] = Math.round(cb * 255); d[i+3] = Math.round(a * 255);
                    });
                }
            }
        }
        ctx.globalAlpha = prevAlpha;
    }

    // Draw all entity block tiles onto the canvas.
    // Each block instance is rendered once (multi-tile blocks anchored at their min tile).
    // Block appearance is defined by the shapes string in the block type's properties;
    // falls back to a solid color rectangle if no shapes are defined.
    // The entity's (x, y) and angle are applied so blocks rotate and translate with the entity.
    function renderBlocks(canvas, entities, camera) {
        if (!registry) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
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

        if (camera) {
            ctx.translate(w / 2, h / 2);
            ctx.rotate(-camera.angle);
            ctx.scale(camera.zoom, camera.zoom);
            ctx.translate(-camera.x, -camera.y);

            // Background world grid — drawn in world space before entities.
            // Visible region is bounded by a circle of radius = half-diagonal
            // (conservative, covers all rotations) and clamped to world bounds.
            const halfDiag = Math.hypot(w, h) / (2 * camera.zoom);
            const wW = camera.worldW || 0;
            const wH = camera.worldH || 0;
            const gx0 = Math.max(0,  Math.floor((camera.x - halfDiag) / TILE_SIZE) * TILE_SIZE);
            const gx1 = Math.min(wW, Math.ceil( (camera.x + halfDiag) / TILE_SIZE) * TILE_SIZE);
            const gy0 = Math.max(0,  Math.floor((camera.y - halfDiag) / TILE_SIZE) * TILE_SIZE);
            const gy1 = Math.min(wH, Math.ceil( (camera.y + halfDiag) / TILE_SIZE) * TILE_SIZE);

            ctx.save();
            ctx.strokeStyle = "rgba(255,255,255,0.06)";
            ctx.lineWidth   = 1 / camera.zoom;
            ctx.beginPath();
            for (let x = gx0; x <= gx1; x += TILE_SIZE) { ctx.moveTo(x, gy0); ctx.lineTo(x, gy1); }
            for (let y = gy0; y <= gy1; y += TILE_SIZE) { ctx.moveTo(gx0, y); ctx.lineTo(gx1, y); }
            ctx.stroke();
            ctx.restore();
        }

        for (const entity of entities.values()) {
            const map = entity.blockMap;
            if (!map || Object.keys(map).length === 0) continue;

            ctx.save();
            ctx.translate(entity.x, entity.y);
            ctx.rotate(entity.angle);

            const ox = entity.comOffsetX || 0;
            const oy = entity.comOffsetY || 0;

            // Find the anchor tile (min tx, min ty) for each block instance so
            // multi-tile blocks are drawn once at their top-left corner.
            const buiAnchor = {};
            for (const [posKey, bui] of Object.entries(map)) {
                const [tx, ty] = posKey.split(",").map(Number);
                if (!buiAnchor[bui]) {
                    buiAnchor[bui] = { tx, ty };
                } else {
                    if (tx < buiAnchor[bui].tx) buiAnchor[bui].tx = tx;
                    if (ty < buiAnchor[bui].ty) buiAnchor[bui].ty = ty;
                }
            }

            for (const [bui, anchor] of Object.entries(buiAnchor)) {
                const datum = entity.blockData[bui];
                if (!datum) continue;
                const type = registry[datum.typeId];
                if (!type) continue;

                const bw = type.properties.size.x * TILE_SIZE;
                const bh = type.properties.size.y * TILE_SIZE;
                const bx = (anchor.tx - 0.5) * TILE_SIZE - ox;
                const by = (anchor.ty - 0.5) * TILE_SIZE - oy;

                const maxHealth = type.properties.maxHealth || 1;
                const h = (datum.health ?? maxHealth) / maxHealth;

                const shapes = parseShapes(type.properties.shapes);
                if (shapes) {
                    drawShapes(ctx, shapes, bx, by, TILE_SIZE, undefined, h);
                } else {
                    const { r, g, b } = type.properties.color;
                    ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
                    ctx.fillRect(bx, by, bw, bh);
                }

                const damage = maxHealth - (datum.health ?? maxHealth);
                const redAlpha = Math.min(damage / maxHealth, 1) * 0.3;
                if (redAlpha > 0) {
                    ctx.fillStyle = "rgba(220,30,30," + redAlpha.toFixed(3) + ")";
                    ctx.fillRect(bx, by, bw, bh);
                }
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
        damageBlock: function (entity, bui, damage) { _damageBlock(entity, bui, damage); },
        computeEntityProps,
        applyDesignChange,
        splitIfDisconnected,
        // Rendering
        renderBlocks,
        parseShapes,
        drawShapes,
        // Collision
        resolveCollisions,
        resolveContact,
        // Force helpers
        applyImpulse,
        applyLinearImpulse,
        applyTorque,
        // Utilities
        setShapePaused,
        getRegistry: function () { return registry; },
        TILE_SIZE,
        BASE_MASS,
        RESTITUTION
    };
})();
