// =========================================================================
// Google Drive integration — saves/loads all physics entities to
//   Google Drive → /.webspace/save.csv
//
// CSV format:
//   playerUID=<uid>
//   uid,x,y,vx,vy,angle
//   <uid>,<x>,<y>,<vx>,<vy>,<angle>
//   ...  (one row per entity)
//
// SETUP (one-time):
//   1. Go to https://console.cloud.google.com/
//   2. Create a project → Enable "Google Drive API"
//   3. APIs & Services → Credentials → Create OAuth 2.0 Client ID (Web app)
//   4. Add your domain (e.g. http://localhost:5000) to Authorised JS origins
//   5. Replace YOUR_CLIENT_ID below with the generated Client ID
// =========================================================================

const DRIVE_CLIENT_ID = "YOUR_CLIENT_ID.apps.googleusercontent.com";
const DRIVE_SCOPE     = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME     = ".webspace";
const SAVE_FILE       = "save.csv";
const AUTOSAVE_MS     = 30_000; // autosave every 30 s

let tokenClient    = null;
let accessToken    = null;
let folderId       = null; // cached after first lookup
let saveFileId     = null; // cached after first lookup/create
let autosaveTimer  = null;
let driveCallbacks = null; // { getState(), setState(state) }

// ---- Session token ------------------------------------------------
function storeToken(token, expiresIn) {
    sessionStorage.setItem("ws_token", JSON.stringify({
        token,
        expiry: Date.now() + (expiresIn - 60) * 1000
    }));
    accessToken = token;
}

function restoreToken() {
    const raw = sessionStorage.getItem("ws_token");
    if (!raw) return false;
    const { token, expiry } = JSON.parse(raw);
    if (Date.now() >= expiry) return false;
    accessToken = token;
    return true;
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

async function findSaveFile() {
    if (saveFileId) return saveFileId;
    const parent = await getOrCreateFolder();
    const q = "name='" + SAVE_FILE + "' and '" + parent + "' in parents and trashed=false";
    const res = await driveGet(
        "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) + "&fields=files(id)"
    );
    if (res.files && res.files.length > 0) {
        return (saveFileId = res.files[0].id);
    }
    return null;
}

// ---- CSV serialisation --------------------------------------------
function formatSave(playerUID, entities) {
    const rows = ["playerUID=" + playerUID, "uid,x,y,vx,vy,angle"];
    for (const e of entities) {
        rows.push([
            e.uid,
            Math.round(e.x),
            Math.round(e.y),
            e.vx.toFixed(4),
            e.vy.toFixed(4),
            e.angle.toFixed(6)
        ].join(","));
    }
    return rows.join("\n");
}

function parseSave(text) {
    const lines = text.trim().split("\n");

    // Legacy format: old single-entity save (x,y,vx,vy,angle header)
    if (lines.length >= 2 && !lines[0].startsWith("playerUID=")) {
        const vals = lines[1].split(",").map(Number);
        if (vals.length >= 2 && !isNaN(vals[0]) && !isNaN(vals[1])) {
            const uid = "player_legacy";
            return {
                playerUID: uid,
                entities: [{
                    uid,
                    x: vals[0], y: vals[1],
                    vx: vals[2] || 0, vy: vals[3] || 0, angle: vals[4] || 0
                }]
            };
        }
        return null;
    }

    if (lines.length < 3) return null;

    const playerUID = lines[0].replace("playerUID=", "");
    // lines[1] is the header; entity rows start at index 2
    const entities = [];
    for (let i = 2; i < lines.length; i++) {
        const parts = lines[i].split(",");
        if (parts.length < 6) continue;
        entities.push({
            uid:   parts[0],
            x:     Number(parts[1]),
            y:     Number(parts[2]),
            vx:    Number(parts[3]),
            vy:    Number(parts[4]),
            angle: Number(parts[5])
        });
    }
    if (entities.length === 0) return null;
    return { playerUID, entities };
}

// ---- Public: load / save ------------------------------------------
async function driveLoad() {
    if (!accessToken) return null;
    try {
        const fileId = await findSaveFile();
        if (!fileId) return null;
        const r = await fetch(
            "https://www.googleapis.com/drive/v3/files/" + fileId + "?alt=media",
            { headers: { Authorization: "Bearer " + accessToken } }
        );
        if (!r.ok) return null;
        return parseSave(await r.text());
    } catch (e) {
        console.warn("Drive load error:", e);
        return null;
    }
}

async function driveSave(keepalive = false) {
    if (!accessToken) return;
    if (!driveCallbacks || !driveCallbacks.getState) return;

    setDriveStatus("saving");
    const { playerUID, entities } = driveCallbacks.getState();
    const content = formatSave(playerUID, entities);

    try {
        const parent = await getOrCreateFolder();
        const fileId = await findSaveFile();

        if (fileId) {
            await fetch(
                "https://www.googleapis.com/upload/drive/v3/files/" + fileId + "?uploadType=media",
                {
                    method: "PATCH",
                    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "text/csv" },
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
                "Content-Type: text/csv",
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
            el.innerHTML = 'Drive: <span class="drive-ok">Linked ✓</span>';
            break;
        case "saving":
            el.innerHTML = 'Drive: <span class="drive-saving">Saving…</span>';
            break;
        default:
            el.innerHTML = '<button id="btn-drive-link" class="drive-link-btn">Link Google Drive</button>';
            document.getElementById("btn-drive-link").addEventListener("click", requestDriveLink);
    }
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
    if (tokenClient) tokenClient.requestAccessToken({ prompt: "" });
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
            setDriveStatus("linked");
            driveLoad().then(function (saved) {
                if (saved && driveCallbacks) driveCallbacks.setState(saved);
            });
            startAutosave();
        } else {
            setDriveStatus("unlinked");
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
