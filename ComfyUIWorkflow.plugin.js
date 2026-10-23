/**
 * @name ComfyUIWorkflow
 * @author mr-asa
 * @description Marks images and videos in chat that contain an embedded ComfyUI workflow or prompt (PNG, WebP, JPEG, MP4, WebM, MOV, MKV, FLAC, MP3, OGG, OPUS, M4A, WAV). Click the badge for actions.
 * @version 0.5.0
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_FOLDER = path.join((process.env.USERPROFILE || process.env.HOME || "."), "Documents", "ComfyUI workflows");
const BADGE_CLASS = "cuw-badge";
const MARKED_ATTR = "data-cuw-checked";
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const KEYS = ["workflow", "prompt"];
const IMAGE_EXT = /\.(png|webp|jpe?g)$/i;
const RANGE_EXT = /\.(mp4|webm|mov|mkv|m4v|flac|mp3|ogg|opus|m4a|wav)$/i; // read head+tail only
const RANGE_CHUNK = 4 * 1024 * 1024; // bytes read from the head and tail of videos
const MAX_JSON = 32 * 1024 * 1024;

const css = `
.${BADGE_CLASS} {
    position: absolute; top: 6px; left: 6px; z-index: 10;
    width: 24px; height: 24px; border-radius: 6px;
    background: rgba(20, 20, 20, 0.8); color: #4ade80;
    font: 700 11px/24px sans-serif; text-align: center;
    cursor: pointer; user-select: none;
}
.${BADGE_CLASS}:hover { background: rgba(40, 40, 40, 0.95); }
`;

module.exports = class ComfyUIWorkflow {
    constructor(meta) {
        this.meta = meta;
        this.cache = new Map(); // url -> Promise<{workflow, prompt} | null>
        this.observer = null;
    }

    start() {
        BdApi.DOM.addStyle(this.meta.name, css);
        this.observer = new MutationObserver(() => this.scan());
        this.observer.observe(document.body, { childList: true, subtree: true });
        this.scan();
    }

    stop() {
        this.observer?.disconnect();
        this.observer = null;
        BdApi.DOM.removeStyle(this.meta.name);
        document.querySelectorAll(`.${BADGE_CLASS}`).forEach(b => b.remove());
        document.querySelectorAll(`[${MARKED_ATTR}]`).forEach(e => e.removeAttribute(MARKED_ATTR));
        this.cache.clear();
    }

    scan() {
        const media = document.querySelectorAll(
            `[class*="messagesWrapper"] :is(img, video, audio)[src*="discordapp"]:not([${MARKED_ATTR}])`
        );
        media.forEach(el => this.process(el));
        // Audio attachments are often just a file card with a link until played.
        const links = document.querySelectorAll(
            `[class*="messagesWrapper"] a[href*="discordapp"]:not([${MARKED_ATTR}])`
        );
        links.forEach(a => {
            if (RANGE_EXT.test(a.pathname)) this.process(a);
        });
    }

    async process(el) {
        const url = this.originalUrl(el.currentSrc || el.src || el.href);
        if (!url) return;
        el.setAttribute(MARKED_ATTR, "1");
        // skip tiny images (emoji, avatars, icons)
        if (el.naturalWidth && el.naturalWidth < 128) return;

        const data = await this.getMeta(url);
        if (!data || !el.isConnected) return;

        const host = el.matches("a")
            ? el.closest('[class*="attachment"], [class*="container"]') ?? el.parentElement
            : el.parentElement;
        if (!host || host.querySelector(`.${BADGE_CLASS}`)) return;
        if (getComputedStyle(host).position === "static") host.style.position = "relative";

        const badge = document.createElement("div");
        badge.className = BADGE_CLASS;
        badge.textContent = data.workflow ? "WF" : "P";
        badge.title = data.workflow
            ? "ComfyUI workflow found. Click for actions."
            : "ComfyUI prompt (no full workflow) found. Click for actions.";
        const openMenu = e => {
            e.preventDefault();
            e.stopPropagation();
            this.showMenu(e, url, data);
        };
        badge.addEventListener("click", openMenu);
        badge.addEventListener("contextmenu", openMenu);
        host.appendChild(badge);
    }

    get folder() {
        return BdApi.Data.load(this.meta.name, "folder") || DEFAULT_FOLDER;
    }

    async chooseFolder(onDone) {
        try {
            const res = await BdApi.UI.openDialog({
                mode: "open", openDirectory: true, openFile: false,
                title: "Choose folder for workflow JSON files", defaultPath: this.folder
            });
            if (res.canceled || !res.filePaths?.length) return;
            BdApi.Data.save(this.meta.name, "folder", res.filePaths[0]);
            BdApi.UI.showToast("Save folder: " + res.filePaths[0], { type: "success" });
            onDone?.(res.filePaths[0]);
        } catch (err) {
            BdApi.UI.showToast("Folder dialog failed: " + err.message, { type: "error" });
        }
    }

    getSettingsPanel() {
        const React = BdApi.React;
        const plugin = this;
        const Panel = () => {
            const [folder, setFolder] = React.useState(plugin.folder);
            return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8, color: "var(--header-primary)" } },
                React.createElement("div", null, "Save folder: " + folder),
                React.createElement("button", {
                    onClick: () => plugin.chooseFolder(setFolder),
                    style: { alignSelf: "flex-start", padding: "8px 16px", borderRadius: 4, border: "none", cursor: "pointer", background: "var(--brand-500, #5865f2)", color: "#fff" }
                }, "Choose folder...")
            );
        };
        return React.createElement(Panel);
    }

    showMenu(event, url, data) {
        const base = decodeURIComponent(new URL(url).pathname.split("/").pop()).replace(/\.[a-z0-9]+$/i, "");
        const items = [];
        for (const [key, suffix] of [["workflow", ""], ["prompt", ".prompt"]]) {
            if (!data[key]) continue;
            items.push(
                {
                    label: `Copy ${key}`,
                    action: () => {
                        DiscordNative.clipboard.copy(data[key]);
                        BdApi.UI.showToast(`${key[0].toUpperCase() + key.slice(1)} copied`, { type: "success" });
                    }
                },
                { label: `Save ${key} as JSON`, action: () => this.save(base + suffix, data[key]) }
            );
        }
        items.push(
            { label: "Change save folder...", action: () => this.chooseFolder() },
            {
                label: "Open save folder",
                action: () => {
                    fs.mkdirSync(this.folder, { recursive: true });
                    require("electron").shell.openPath(this.folder);
                }
            }
        );
        BdApi.ContextMenu.open(event, BdApi.ContextMenu.buildMenu(items));
    }

    save(base, json) {
        try {
            const dir = this.folder;
            fs.mkdirSync(dir, { recursive: true });
            const safe = base.replace(/[<>:"/\\|?*]/g, "_");
            let file = path.join(dir, safe + ".json");
            for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${safe} (${i}).json`);
            fs.writeFileSync(file, json, "utf8");
            BdApi.UI.showToast(`Saved: ${path.basename(file)}`, { type: "success" });
        } catch (err) {
            BdApi.UI.showToast("Save failed: " + err.message, { type: "error" });
        }
    }

    /** Strip Discord resize params so we get the original file with its metadata. */
    originalUrl(src) {
        try {
            const u = new URL(src);
            if (u.hostname === "media.discordapp.net") u.hostname = "cdn.discordapp.com";
            ["width", "height", "format", "quality", "animated"].forEach(p => u.searchParams.delete(p));
            if (!IMAGE_EXT.test(u.pathname) && !RANGE_EXT.test(u.pathname)) return null;
            return u.toString();
        } catch {
            return null;
        }
    }

    getMeta(url) {
        if (!this.cache.has(url)) this.cache.set(url, this.fetchMeta(url).catch(() => null));
        return this.cache.get(url);
    }

    async fetchMeta(url) {
        if (RANGE_EXT.test(new URL(url).pathname)) return this.fetchRangeMeta(url);
        const res = await BdApi.Net.fetch(url);
        if (!res.ok) return null;
        const buf = new Uint8Array(await res.arrayBuffer());
        return this.parsePng(buf) ?? this.scanJson(buf);
    }

    /** Videos and audio can be huge: read only the head and the tail (metadata sits in moov/Tags at either end). */
    async fetchRangeMeta(url) {
        const [head, tail] = await Promise.all([
            this.fetchRange(url, `bytes=0-${RANGE_CHUNK - 1}`, true),
            this.fetchRange(url, `bytes=-${RANGE_CHUNK}`, false)
        ]);
        const found = {};
        for (const buf of [head, tail]) if (buf) Object.assign(found, this.scanJson(buf) ?? {});
        return found.workflow || found.prompt ? found : null;
    }

    async fetchRange(url, range, isHead) {
        const res = await BdApi.Net.fetch(url, { headers: { Range: range } });
        if (!res.ok) return null;
        // Server ignored Range (200): only the head is usable; do not read the whole file for the tail.
        if (res.status !== 206 && !isHead) return null;
        const reader = res.body.getReader();
        const parts = [];
        let size = 0;
        while (size < RANGE_CHUNK) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            size += value.length;
        }
        reader.cancel().catch(() => {});
        const out = new Uint8Array(size);
        let off = 0;
        for (const p of parts) { out.set(p, off); off += p.length; }
        return out;
    }

    /**
     * Format-agnostic fallback (WebP/JPEG EXIF, MP4/WebM tags): find JSON objects in the raw bytes
     * and classify them. Workflow JSON has "nodes"; API prompt JSON has "class_type".
     */
    scanJson(buf) {
        const text = new TextDecoder("utf-8").decode(buf);
        const starts = /\{\s*"(?:last_node_id|id|revision|version|nodes|\d+)"\s*:/g;
        const found = {};
        let m;
        while ((m = starts.exec(text))) {
            const end = this.matchBrace(text, m.index);
            if (end < 0) continue;
            const chunk = text.slice(m.index, end + 1);
            let obj;
            try { obj = JSON.parse(chunk); } catch { continue; }
            if (Array.isArray(obj.nodes) && !found.workflow) found.workflow = chunk;
            else if (!found.prompt && Object.values(obj).some(v => v && typeof v === "object" && "class_type" in v)) found.prompt = chunk;
            starts.lastIndex = end + 1;
            if (found.workflow && found.prompt) break;
        }
        return found.workflow || found.prompt ? found : null;
    }

    /** Index of the brace closing the object that opens at `start`, string-aware; -1 if none. */
    matchBrace(text, start) {
        let depth = 0, inStr = false;
        const limit = Math.min(text.length, start + MAX_JSON);
        for (let i = start; i < limit; i++) {
            const c = text.charCodeAt(i);
            if (inStr) {
                if (c === 92) i++;
                else if (c === 34) inStr = false;
            } else if (c === 34) inStr = true;
            else if (c === 123) depth++;
            else if (c === 125 && --depth === 0) return i;
        }
        return -1;
    }

    parsePng(buf) {
        if (!PNG_SIG.every((b, i) => buf[i] === b)) return null;
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const dec = new TextDecoder("utf-8");
        const latin = new TextDecoder("latin1");
        const found = {};
        let pos = 8;

        while (pos + 8 <= buf.length) {
            const len = view.getUint32(pos);
            const type = latin.decode(buf.subarray(pos + 4, pos + 8));
            const start = pos + 8;
            const end = start + len;
            if (type === "tEXt" || type === "iTXt") {
                const chunk = buf.subarray(start, end);
                const nul = chunk.indexOf(0);
                const key = latin.decode(chunk.subarray(0, nul));
                if (KEYS.includes(key)) {
                    let text;
                    if (type === "tEXt") {
                        text = dec.decode(chunk.subarray(nul + 1));
                    } else {
                        // iTXt: key\0 compFlag compMethod lang\0 translated\0 text
                        if (chunk[nul + 1] === 1) { pos = end + 4; continue; } // compressed: skip
                        let p = nul + 3;
                        p = chunk.indexOf(0, p) + 1;
                        p = chunk.indexOf(0, p) + 1;
                        text = dec.decode(chunk.subarray(p));
                    }
                    found[key] = text;
                }
            }
            if (type === "IDAT" || type === "IEND") break; // text chunks come before image data in ComfyUI output
            pos = end + 4; // skip CRC
        }
        return found.workflow || found.prompt ? found : null;
    }
};
