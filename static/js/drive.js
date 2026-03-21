// =========================================================================
// Google Drive integration — saves/loads all physics entities to
//   Google Drive → /.webspace/save.json
//
// Save format (JSON):
//   {
//     "playerUID": "<uid>",
//     "entities": [
//       { "uid", "x", "y", "vx", "vy", "angle",
//         "blockData": { "<bui>": { "typeId", "health", ... } },
//         "blockMap":  { "tx,ty": "<bui>", ... } },
//       ...
//     ]
//   }
//
// Legacy CSV saves (save.csv) are detected and migrated automatically.
//
// SETUP (one-time):
//   1. Go to https://console.cloud.google.com/
//   2. Create a project → Enable "Google Drive API"
//   3. APIs & Services → Credentials → Create OAuth 2.0 Client ID (Web app)
//   4. Add your domain (e.g. http://localhost:5000) to Authorised JS origins
//   5. Replace YOUR_CLIENT_ID below with the generated Client ID
// =========================================================================

const DRIVE_CLIENT_ID  = "YOUR_CLIENT_ID.apps.googleusercontent.com";
const DRIVE_SCOPE      = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME      = ".webspace";
const SAVE_FILE        = "save.json";
const LEGACY_SAVE_FILE = "save.csv";
const AUTOSAVE_MS      = 30_000; // autosave every 30 s

let tokenClient    = null;
let accessToken    = null;
let folderId       = null; // cached after first lookup
let saveFileId     = null; // cached after first lookup/create
let autosaveTimer  = null;
let driveCallbacks = null; // { getState(), setState(state) }
let reconnectCancelled = false; // set true when user cancels a silent reconnect

// ---- Token persistence (localStorage survives tab/browser close) --
function storeToken(token, expiresIn) {
    localStorage.setItem("ws_token", JSON.stringify({
        token,
        expiry: Date.now() + (expiresIn - 60) * 1000
    }));
    accessToken = token;
}

function restoreToken() {
    const raw = localStorage.getItem("ws_token");
    if (!raw) return false;
    try {
        const { token, expiry } = JSON.parse(raw);
        if (Date.now() >= expiry) return false;
        accessToken = token;
        return true;
    } catch (_) { return false; }
}

// ---- Drive API helpers --------------------------------------------
async function driveGet(url) {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
    if (!r.ok) throw new Error("Drive GET " + r.status);
    return r.json();
}

async function getOrCreateFolder() {
    if (folderId) return folderId;
    const q = "name='" + FOLDER_NAME + "' and mimeType='application/vnd.google-apps.folder' and trashed=false";
    const res = await driveGet(
        "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) + "&fields=files(id)"
    );
    if (res.files && res.files.length > 0) {
        return (folderId = res.files[0].id);
    }
    const r = await fetch("https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" })
    });
    return (folderId = (await r.json()).id);
}

// findSaveFile looks for save.json; if absent, checks legacy save.csv.
async function findSaveFile() {
    if (saveFileId) return { id: saveFileId, legacy: false };
    const parent = await getOrCreateFolder();

    // Try new JSON save first
    const qNew = "name='" + SAVE_FILE + "' and '" + parent + "' in parents and trashed=false";
    const resNew = await driveGet(
        "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(qNew) + "&fields=files(id)"
    );
    if (resNew.files && resNew.files.length > 0) {
        saveFileId = resNew.files[0].id;
        return { id: saveFileId, legacy: false };
    }

    // Fall back to legacy CSV
    const qLeg = "name='" + LEGACY_SAVE_FILE + "' and '" + parent + "' in parents and trashed=false";
    const resLeg = await driveGet(
        "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(qLeg) + "&fields=files(id)"
    );
    if (resLeg.files && resLeg.files.length > 0) {
        return { id: resLeg.files[0].id, legacy: true };
    }

    return null;
}

// ---- JSON serialisation -------------------------------------------
function formatSave(playerUID, entities, projectiles) {
    // blockData and blockMap are already part of each entity object.
    // Round physics values to keep the file compact.
    const slim = entities.map(function (e) {
        return {
            uid:             e.uid,
            x:               Math.round(e.x),
            y:               Math.round(e.y),
            vx:              parseFloat(e.vx.toFixed(4)),
            vy:              parseFloat(e.vy.toFixed(4)),
            angle:           parseFloat(e.angle.toFixed(6)),
            angularVelocity: parseFloat((e.angularVelocity || 0).toFixed(6)),
            mass:            e.mass            || 1,
            interactionRadius: e.interactionRadius || 0,
            blockData:       e.blockData || {},
            blockMap:        e.blockMap  || {}
        };
    });
    const slimProj = (projectiles || []).map(function (p) {
        return {
            x:                parseFloat(p.x.toFixed(2)),
            y:                parseFloat(p.y.toFixed(2)),
            vx:               parseFloat(p.vx.toFixed(4)),
            vy:               parseFloat(p.vy.toFixed(4)),
            impactDamage:     p.impactDamage,
            pierce:           parseFloat(p.pierce.toFixed(4)),
            explosionStrength: p.explosionStrength,
            lifetime:         parseFloat(p.lifetime.toFixed(4)),
            remaining:        parseFloat(p.remaining.toFixed(4)),
            shapeStr:         p.shapeStr,
            spawnerKey:       p.spawnerKey || null,
            particleInterval: p.particleInterval
        };
    });
    return JSON.stringify({ playerUID, entities: slim, projectiles: slimProj });
}

// Parse a save file.  Handles:
//   • new JSON format (save.json)
//   • old multi-entity CSV (playerUID=... header)
//   • oldest single-entity CSV (x,y,vx,vy,angle header)
function parseSave(text, isLegacyCsv) {
    if (!isLegacyCsv) {
        try {
            const obj = JSON.parse(text);
            if (obj && obj.playerUID && Array.isArray(obj.entities)) {
                // Ensure blockData/blockMap exist on every entity
                for (const e of obj.entities) {
                    if (!e.blockData) e.blockData = {};
                    if (!e.blockMap)  e.blockMap  = {};
                }
                return obj;
            }
        } catch (_) {}
    }

    // Legacy CSV handling (both formats)
    const lines = text.trim().split("\n");
    if (lines.length < 2) return null;

    // Multi-entity CSV: first line is "playerUID=<uid>"
    if (lines[0].startsWith("playerUID=")) {
        const playerUID = lines[0].replace("playerUID=", "");
        const entities = [];
        for (let i = 2; i < lines.length; i++) {
            const parts = lines[i].split(",");
            if (parts.length < 6) continue;
            entities.push({
                uid:             parts[0],
                x:               Number(parts[1]),
                y:               Number(parts[2]),
                vx:              Number(parts[3]),
                vy:              Number(parts[4]),
                angle:           Number(parts[5]),
                angularVelocity: 0,
                mass:            1,
                interactionRadius: 0,
                blockData: {},
                blockMap:  {}
            });
        }
        return entities.length ? { playerUID, entities } : null;
    }

    // Oldest single-entity CSV: header row then data row
    const vals = lines[1].split(",").map(Number);
    if (vals.length >= 2 && !isNaN(vals[0])) {
        const uid = "player_legacy";
        return {
            playerUID: uid,
            entities: [{
                uid,
                x: vals[0], y: vals[1],
                vx: vals[2] || 0, vy: vals[3] || 0, angle: vals[4] || 0,
                angularVelocity: 0, mass: 1, interactionRadius: 0,
                blockData: {}, blockMap: {}
            }]
        };
    }

    return null;
}

// ---- Public: load / save ------------------------------------------
async function driveLoad() {
    if (!accessToken) return null;
    try {
        const found = await findSaveFile();
        if (!found) return null;
        const r = await fetch(
            "https://www.googleapis.com/drive/v3/files/" + found.id + "?alt=media",
            { headers: { Authorization: "Bearer " + accessToken } }
        );
        if (!r.ok) return null;
        return parseSave(await r.text(), found.legacy);
    } catch (e) {
        console.warn("Drive load error:", e);
        return null;
    }
}

async function driveSave(keepalive = false) {
    if (!accessToken) return;
    if (!driveCallbacks || !driveCallbacks.getState) return;

    setDriveStatus("saving");
    const { playerUID, entities, projectiles } = driveCallbacks.getState();
    const content     = formatSave(playerUID, entities, projectiles);
    const contentType = "application/json";

    try {
        const parent = await getOrCreateFolder();
        const found  = await findSaveFile();

        // If only a legacy CSV exists, create the new JSON file fresh
        // (leave the old CSV in place; user can delete manually)
        const existingJsonId = (found && !found.legacy) ? found.id : null;

        if (existingJsonId) {
            await fetch(
                "https://www.googleapis.com/upload/drive/v3/files/" + existingJsonId + "?uploadType=media",
                {
                    method: "PATCH",
                    headers: { Authorization: "Bearer " + accessToken, "Content-Type": contentType },
                    body: content,
                    keepalive
                }
            );
        } else {
            const boundary = "ws_bound_" + Date.now();
            const metadata = JSON.stringify({ name: SAVE_FILE, parents: [parent] });
            const body = [
                "--" + boundary,
                "Content-Type: application/json; charset=UTF-8",
                "",
                metadata,
                "--" + boundary,
                "Content-Type: " + contentType,
                "",
                content,
                "--" + boundary + "--"
            ].join("\r\n");
            const r = await fetch(
                "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
                {
                    method: "POST",
                    headers: {
                        Authorization: "Bearer " + accessToken,
                        "Content-Type": "multipart/related; boundary=" + boundary
                    },
                    body,
                    keepalive
                }
            );
            saveFileId = (await r.json()).id;
        }
        setDriveStatus("linked");
    } catch (e) {
        console.warn("Drive save error:", e);
        setDriveStatus("linked");
    }
}

// Exposed so main.js pagehide handler can call it
window.driveSave = driveSave;

// ---- UI -----------------------------------------------------------
function setDriveStatus(state) {
    const el = document.getElementById("drive-status");
    if (!el) return;
    switch (state) {
        case "linked":
            el.innerHTML = 'Drive: <span class="drive-ok">Linked ✓</span>'
                + ' <button id="btn-drive-unlink" class="drive-unlink-btn">Unlink</button>';
            document.getElementById("btn-drive-unlink").addEventListener("click", driveUnlink);
            break;
        case "saving":
            el.innerHTML = 'Drive: <span class="drive-saving">Saving…</span>';
            break;
        case "reconnecting":
            el.innerHTML = 'Drive: <span class="drive-saving">Reconnecting…</span>'
                + ' <button id="btn-drive-cancel" class="drive-unlink-btn">Cancel</button>';
            document.getElementById("btn-drive-cancel").addEventListener("click", driveUnlink);
            break;
        default:
            el.innerHTML = '<button id="btn-drive-link" class="drive-link-btn">Link Google Drive</button>';
            document.getElementById("btn-drive-link").addEventListener("click", requestDriveLink);
    }
}

function driveUnlink() {
    reconnectCancelled = true;
    if (autosaveTimer) { clearInterval(autosaveTimer); autosaveTimer = null; }
    if (accessToken && typeof google !== "undefined") {
        google.accounts.oauth2.revoke(accessToken, function () {});
    }
    accessToken = null;
    folderId    = null;
    saveFileId  = null;
    localStorage.removeItem("ws_token");
    localStorage.setItem("ws_driveConsent", "false");
    setDriveStatus("unlinked");
}

function showModal() { document.getElementById("drive-modal").classList.remove("hidden"); }
function hideModal() { document.getElementById("drive-modal").classList.add("hidden"); }

// ---- Auth ---------------------------------------------------------
function setupTokenClient() {
    if (DRIVE_CLIENT_ID === "YOUR_CLIENT_ID.apps.googleusercontent.com") {
        console.warn("drive.js: Replace DRIVE_CLIENT_ID with your real OAuth Client ID.");
        return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: DRIVE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: async function (resp) {
            if (resp.error) { console.error("OAuth error:", resp.error); return; }
            // If the user cancelled a silent reconnect while the GSI request was
            // in-flight, discard this late token and reset the flag.
            if (reconnectCancelled) { reconnectCancelled = false; return; }
            storeToken(resp.access_token, resp.expires_in);
            localStorage.setItem("ws_driveConsent", "true");
            setDriveStatus("linked");

            const saved = await driveLoad();
            if (saved) {
                if (driveCallbacks) driveCallbacks.setState(saved);
            } else {
                // First-ever link: write current state to warm the cache
                await driveSave();
            }
            startAutosave();
        }
    });
}

function requestDriveLink() {
    if (!tokenClient) {
        // GSI library hasn't finished loading yet — give feedback and retry once ready
        const el = document.getElementById("drive-status");
        if (el) el.innerHTML = 'Drive: <span class="drive-saving">Loading… tap again shortly</span>';
        waitForGSI(function () {
            // tokenClient should now be initialised by setupTokenClient; re-show button
            if (!tokenClient) setDriveStatus("unlinked");
            else setDriveStatus("unlinked"); // let user tap again within gesture context
        });
        return;
    }
    reconnectCancelled = false;
    tokenClient.requestAccessToken({ prompt: "select_account" });
}

function startAutosave() {
    if (autosaveTimer) clearInterval(autosaveTimer);
    autosaveTimer = setInterval(driveSave, AUTOSAVE_MS);
}

function waitForGSI(cb) {
    if (typeof google !== "undefined") { cb(); return; }
    const t = setInterval(function () {
        if (typeof google !== "undefined") { clearInterval(t); cb(); }
    }, 100);
}

// ---- Entry point called from main.js -----------------------------
function driveInit(callbacks) {
    driveCallbacks = callbacks;

    waitForGSI(setupTokenClient);

    const consent = localStorage.getItem("ws_driveConsent");

    if (consent === null) {
        showModal();
        setDriveStatus("unlinked");
        return;
    }

    if (consent === "true") {
        if (restoreToken()) {
            // Valid cached token — restore immediately without any prompt
            setDriveStatus("linked");
            driveLoad().then(function (saved) {
                if (saved && driveCallbacks) driveCallbacks.setState(saved);
            });
            startAutosave();
        } else {
            // Token expired — silently re-acquire via GSI hidden iframe (no popup)
            reconnectCancelled = false;
            setDriveStatus("reconnecting");
            waitForGSI(function () {
                if (tokenClient) tokenClient.requestAccessToken({ prompt: "" });
            });
        }
        return;
    }

    // consent === "false": show button, no modal
    setDriveStatus("unlinked");
}

// ---- Modal button wiring -----------------------------------------
document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("btn-drive-yes").addEventListener("click", function () {
        hideModal();
        waitForGSI(requestDriveLink);
    });

    document.getElementById("btn-drive-no").addEventListener("click", function () {
        hideModal();
        localStorage.setItem("ws_driveConsent", "false");
    });
});
