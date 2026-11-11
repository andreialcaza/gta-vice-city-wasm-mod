"use strict";

// Save-game manager (requires shared.js).
//
// The engine mounts IDBFS at SAVE_DIR and populates it from IndexedDB when it
// starts (asm_consts/en.js: FS.mount(IDBFS) + FS.syncfs(true)). IDBFS keeps
// one database per mount point, named after the mount path, with every file
// stored in FILE_DATA as { timestamp, mode, contents } keyed by its full path
// (modules/fs.js). Writing a record in that format before the game starts is
// therefore enough for the engine to see it as a normal save.
(function () {
    const U = window.vcUserData;
    const {
        reqToPromise, txDone, openDB, withDB, expandZips,
        equalBytes, formatSize, formatDate, download, readFile, el, ready,
        createPanel,
    } = U;
    const { t } = window.vcI18n;
    const { setStatus, run } = createPanel("saves-status");

    const SAVE_DIR = "/vc-assets/local/userfiles";
    const SAVE_SLOTS = 8;
    const saveKey = (slot) => `${SAVE_DIR}/GTAVCsf${slot}.b`;

    // Must match IDBFS in modules/fs.js, otherwise opening the database
    // would trigger a version change the engine does not expect.
    const IDBFS_VERSION = 21;
    const IDBFS_STORE = "FILE_DATA";
    const FILE_MODE = 0o100666; // S_IFREG | rw-rw-rw-

    const SAVE_MIN_SIZE = 1024;
    const SAVE_MAX_SIZE = 4 * 1024 * 1024;

    // ─── Data ───────────────────────────────────────────────────────

    // Same schema IDBFS.getDB creates, so it is safe if the game never ran.
    function openSaveDB() {
        return openDB(SAVE_DIR, IDBFS_VERSION, (db, tx) => {
            const store = db.objectStoreNames.contains(IDBFS_STORE)
                ? tx.objectStore(IDBFS_STORE)
                : db.createObjectStore(IDBFS_STORE);
            if (!store.indexNames.contains("timestamp")) {
                store.createIndex("timestamp", "timestamp", { unique: false });
            }
        });
    }

    // GTA VC PC saves end with a 32-bit little-endian sum of every
    // preceding byte; the engine rejects the file if it does not match.
    function validateSave(bytes) {
        if (bytes.length < SAVE_MIN_SIZE) {
            return t("saves.tooSmall", { size: bytes.length });
        }
        if (bytes.length > SAVE_MAX_SIZE) {
            return t("saves.tooLarge", { size: formatSize(bytes.length) });
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const firstBlock = view.getUint32(0, true);
        if (firstBlock === 0 || firstBlock >= bytes.length) {
            return t("saves.invalidBlock");
        }
        let sum = 0;
        const end = bytes.length - 4;
        for (let i = 0; i < end; i++) sum = (sum + bytes[i]) >>> 0;
        const stored = view.getUint32(end, true);
        if (sum !== stored) {
            return t("saves.checksum");
        }
        return null;
    }

    // The first block starts with the save's display name as 24 UTF-16 chars.
    function saveName(bytes) {
        if (!bytes || bytes.length < 52) return "";
        const chars = new Uint16Array(bytes.slice(4, 52).buffer);
        const end = chars.indexOf(0);
        return String.fromCharCode(...(end < 0 ? chars : chars.subarray(0, end))).trim();
    }

    async function readSlots() {
        return withDB(openSaveDB, async (db) => {
            const store = db.transaction(IDBFS_STORE, "readonly").objectStore(IDBFS_STORE);
            const slots = [];
            for (let slot = 1; slot <= SAVE_SLOTS; slot++) {
                slots.push({ slot, entry: await reqToPromise(store.get(saveKey(slot))) });
            }
            return slots;
        });
    }

    // Writes the save and reads it back to confirm the write.
    async function writeSlot(slot, bytes) {
        const key = saveKey(slot);
        await withDB(openSaveDB, async (db) => {
            const tx = db.transaction(IDBFS_STORE, "readwrite");
            tx.objectStore(IDBFS_STORE).put({
                timestamp: new Date(),
                mode: FILE_MODE,
                contents: new Uint8Array(bytes),
            }, key);
            await txDone(tx);
        });
        const written = await withDB(openSaveDB, (db) =>
            reqToPromise(db.transaction(IDBFS_STORE, "readonly").objectStore(IDBFS_STORE).get(key)));
        if (!written || !equalBytes(written.contents, bytes)) {
            throw new Error(t("saves.readBack"));
        }
    }

    async function removeSlot(slot) {
        await withDB(openSaveDB, async (db) => {
            const tx = db.transaction(IDBFS_STORE, "readwrite");
            tx.objectStore(IDBFS_STORE).delete(saveKey(slot));
            await txDone(tx);
        });
    }


    // ─── ZIP writing (stored, no compression: saves are small) ──────

    const CRC_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c >>> 0;
        }
        return table;
    })();

    function crc32(bytes) {
        let crc = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
    }

    // files: [{ name, bytes }] -> Uint8Array of a valid .zip
    function buildZip(files, date = new Date()) {
        const encoder = new TextEncoder();
        const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
        const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
        const parts = [];
        const central = [];
        let offset = 0;
        for (const { name, bytes } of files) {
            const nameBytes = encoder.encode(name);
            const crc = crc32(bytes);
            const local = new DataView(new ArrayBuffer(30));
            local.setUint32(0, 0x04034b50, true);
            local.setUint16(4, 20, true);
            local.setUint16(6, 0x0800, true); // UTF-8 names
            local.setUint16(8, 0, true); // stored
            local.setUint16(10, dosTime, true);
            local.setUint16(12, dosDate, true);
            local.setUint32(14, crc, true);
            local.setUint32(18, bytes.length, true);
            local.setUint32(22, bytes.length, true);
            local.setUint16(26, nameBytes.length, true);
            parts.push(new Uint8Array(local.buffer), nameBytes, bytes);

            const dir = new DataView(new ArrayBuffer(46));
            dir.setUint32(0, 0x02014b50, true);
            dir.setUint16(4, 20, true);
            dir.setUint16(6, 20, true);
            dir.setUint16(8, 0x0800, true);
            dir.setUint16(10, 0, true);
            dir.setUint16(12, dosTime, true);
            dir.setUint16(14, dosDate, true);
            dir.setUint32(16, crc, true);
            dir.setUint32(20, bytes.length, true);
            dir.setUint32(24, bytes.length, true);
            dir.setUint16(28, nameBytes.length, true);
            dir.setUint32(42, offset, true);
            central.push(new Uint8Array(dir.buffer), nameBytes);
            offset += 30 + nameBytes.length + bytes.length;
        }
        const centralSize = central.reduce((n, c) => n + c.length, 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true);
        end.setUint16(8, files.length, true);
        end.setUint16(10, files.length, true);
        end.setUint32(12, centralSize, true);
        end.setUint32(16, offset, true);
        return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
    }

    const SAVE_FILE_RE = /^GTAVCsf([1-8])\.b$/i;

    function exportAllFileName() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        return `GTAVC-saves-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.zip`;
    }

    // Exports every filled slot. A single save is downloaded as a plain .b
    // file, several as one .zip. Returns the number of saves exported.
    async function exportAllSaves() {
        const filled = (await readSlots()).filter(({ entry }) => entry && entry.contents);
        if (!filled.length) throw new Error(t("saves.noSaves"));
        if (filled.length === 1) {
            const { slot, entry } = filled[0];
            download(entry.contents, `GTAVCsf${slot}.b`);
        } else {
            download(buildZip(filled.map(({ slot, entry }) => ({ name: `GTAVCsf${slot}.b`, bytes: entry.contents }))), exportAllFileName());
        }
        return filled.length;
    }

    // ─── In-game export ─────────────────────────────────────────────
    // The panel above locks once the game starts (writing behind the
    // engine's back would be overwritten by its own sync). Reading is safe,
    // so during play a small button opens a dialog that only exports.

    function initInGameExport() {
        const button = el("button", { type: "button", className: "save-export-fab", "aria-label": t("saves.openExport"), title: t("saves.openExport") }, "💾");
        const list = el("ul", { className: "userdata-list" });
        const status = el("div", { className: "userdata-status", role: "status", hidden: "" });
        const title = el("h2", {}, t("saves.ingameTitle"));
        const note = el("p", { className: "userdata-note" }, t("saves.ingameNote"));
        const exportAllBtn = el("button", { type: "button", className: "userdata-btn" }, t("saves.exportAll"));
        const closeBtn = el("button", { type: "button", className: "userdata-btn" }, t("saves.close"));
        const dialog = el("div", { className: "save-export-dialog", role: "dialog", "aria-modal": "true", hidden: "" },
            el("div", { className: "save-export-card" }, title, note, status, list,
                el("div", { className: "save-export-footer" }, exportAllBtn, closeBtn)));
        document.body.append(button, dialog);

        const say = (message, state = "info") => {
            status.textContent = message;
            status.dataset.state = state;
            status.hidden = !message;
        };
        const guard = (fn) => async () => {
            try {
                await fn();
            } catch (err) {
                console.error("[saves]", err);
                say(t("errors.generic", { message: err && err.message ? err.message : err }), "error");
            }
        };

        async function refresh() {
            const slots = await readSlots();
            const filled = slots.filter(({ entry }) => entry && entry.contents);
            exportAllBtn.disabled = filled.length === 0;
            list.replaceChildren(...(filled.length
                ? filled.map(({ slot, entry }) => el("li", { className: "userdata-row" },
                    el("span", { className: "userdata-row-title" }, t("saves.slot", { slot })),
                    el("span", { className: "userdata-row-info" }, `${saveName(entry.contents) || t("saves.unnamed")} · ${formatDate(entry.timestamp)}`),
                    el("span", { className: "userdata-row-actions" },
                        el("button", {
                            type: "button",
                            className: "userdata-btn",
                            onclick: guard(async () => {
                                download(entry.contents, `GTAVCsf${slot}.b`);
                                say(t("saves.exported", { slot, file: `GTAVCsf${slot}.b` }), "ok");
                            }),
                        }, t("saves.export")))))
                : [el("li", { className: "userdata-empty" }, t("saves.noSaves"))]));
        }

        const open = guard(async () => {
            say("");
            title.textContent = t("saves.ingameTitle");
            dialog.hidden = false;
            if (document.pointerLockElement) document.exitPointerLock();
            await refresh();
        });
        const close = () => { dialog.hidden = true; };

        button.addEventListener("click", open);
        closeBtn.addEventListener("click", close);
        dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !dialog.hidden) close(); });
        // Keep key presses and touches in the dialog away from the game.
        for (const type of ["keydown", "keyup", "pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup"]) {
            dialog.addEventListener(type, (e) => e.stopPropagation());
            button.addEventListener(type, (e) => e.stopPropagation());
        }
        exportAllBtn.addEventListener("click", guard(async () => {
            const count = await exportAllSaves();
            say(t("saves.exportedAll", { count }), "ok");
        }));

        const refreshText = () => {
            button.setAttribute("aria-label", t("saves.openExport"));
            button.title = t("saves.openExport");
            title.textContent = t("saves.ingameTitle");
            note.textContent = t("saves.ingameNote");
            exportAllBtn.textContent = t("saves.exportAll");
            closeBtn.textContent = t("saves.close");
            if (!dialog.hidden) refresh().catch(() => {});
        };
        window.addEventListener("vc:languagechange", refreshText);
    }

    // ─── UI ─────────────────────────────────────────────────────────

    function initSaves() {
        const slotList = document.getElementById("save-slot-list");
        if (!slotList) return;

        const saveInput = document.getElementById("save-file-input");
        const exportAllBtn = document.getElementById("save-export-all");

        let slots = [];
        let targetSlot = 0; // slot chosen by the Import button that opened the picker

        async function refreshSlots() {
            slots = await readSlots();
            slotList.replaceChildren(...slots.map(({ slot, entry }) => {
                const filled = Boolean(entry && entry.contents);
                const info = filled
                    ? `${saveName(entry.contents) || t("saves.unnamed")} · ${formatDate(entry.timestamp)}`
                    : t("saves.empty");
                const button = (label, handler, className = "") =>
                    el("button", { type: "button", className: `userdata-btn ${className}`.trim(), onclick: run(handler) }, label);
                return el("li", { className: "userdata-row" },
                    el("span", { className: "userdata-row-title" }, t("saves.slot", { slot })),
                    el("span", { className: "userdata-row-info" }, info),
                    el("span", { className: "userdata-row-actions" },
                        ...(filled
                            ? [button(t("saves.export"), () => exportSlot(slot)), button(t("saves.remove"), () => removeSave(slot), "userdata-btn-danger")]
                            : [button(t("saves.import"), () => pickSaveFor(slot))])));
            }));
        }

        function pickSaveFor(slot) {
            targetSlot = slot;
            saveInput.click();
        }

        async function importSave(picked, slot) {
            const saves = await expandZips([picked], /\.b$/i, SAVE_MAX_SIZE);
            // A zip made by "Export all" holds GTAVCsf1.b..GTAVCsf8.b:
            // put each one back into its own slot.
            if (saves.length > 1 && saves.every((f) => SAVE_FILE_RE.test(f.name))) {
                return restoreAll(saves);
            }
            if (saves.length !== 1) {
                throw new Error(t("saves.multiple", { file: picked.name, count: saves.length, names: saves.map((f) => f.name).join(", ") }));
            }
            const bytes = await readFile(saves[0]);
            const error = validateSave(bytes);
            if (error) throw new Error(`${saves[0].name}: ${error}`);
            await writeSlot(slot, bytes);
            setStatus(t("saves.imported", { name: saveName(bytes) || t("saves.unnamed"), slot }), "ok");
            await refreshSlots();
        }

        async function restoreAll(files) {
            const items = [];
            for (const file of files) {
                const bytes = await readFile(file);
                const error = validateSave(bytes);
                if (error) throw new Error(`${file.name}: ${error}`);
                items.push({ slot: Number(file.name.match(SAVE_FILE_RE)[1]), bytes });
            }
            const taken = items.filter(({ slot }) => slots.find((s) => s.slot === slot)?.entry?.contents).map(({ slot }) => slot);
            if (taken.length && !confirm(t("saves.overwriteConfirm", { slots: taken.join(", ") }))) return;
            for (const { slot, bytes } of items) await writeSlot(slot, bytes);
            setStatus(t("saves.restored", { count: items.length }), "ok");
            await refreshSlots();
        }

        async function exportSlot(slot) {
            const entry = slots.find((s) => s.slot === slot)?.entry;
            if (!entry || !entry.contents) throw new Error(t("saves.slotEmpty", { slot }));
            download(entry.contents, `GTAVCsf${slot}.b`);
            setStatus(t("saves.exported", { slot, file: `GTAVCsf${slot}.b` }), "ok");
        }

        async function removeSave(slot) {
            const entry = slots.find((s) => s.slot === slot)?.entry;
            const name = (entry && saveName(entry.contents)) || t("saves.unnamed");
            if (!confirm(t("saves.removeConfirm", { name, slot }))) return;
            await removeSlot(slot);
            setStatus(t("saves.removed", { slot }), "ok");
            await refreshSlots();
        }

        if (exportAllBtn) {
            exportAllBtn.addEventListener("click", run(async () => {
                const count = await exportAllSaves();
                setStatus(t("saves.exportedAll", { count }), "ok");
            }));
        }

        saveInput.addEventListener("change", run(async () => {
            const picked = saveInput.files[0];
            saveInput.value = "";
            if (picked) await importSave(picked, targetSlot);
        }));

        const showStorageError = (err) => {
            console.error("[userdata]", err);
            setStatus(t("userdata.storageError", { message: err && err.message ? err.message : err }), "error");
        };
        refreshSlots().catch(showStorageError);
        window.addEventListener("vc:languagechange", () => refreshSlots().catch(showStorageError));
        initInGameExport();
    }

    Object.assign(U, { validateSave, saveName, buildZip, exportAllSaves });
    ready(initSaves);
})();
