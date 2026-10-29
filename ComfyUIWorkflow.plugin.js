/**
 * @name ComfyUIWorkflow
 * @author mr-asa
 * @description Marks images, videos, audio and .json files in chat that contain an embedded ComfyUI workflow or prompt. Click the badge to view the prompts, save the JSON, queue it in a running ComfyUI, or see the models and LoRAs it uses.
 * @version 0.18.0
 * @authorLink https://github.com/mr-asa
 * @website https://github.com/mr-asa/comfyui_workflow
 * @source https://raw.githubusercontent.com/mr-asa/comfyui_workflow/main/ComfyUIWorkflow.plugin.js
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_FOLDER = path.join((process.env.USERPROFILE || process.env.HOME || "."), "Documents", "ComfyUI workflows");
const DEFAULT_SERVER = "http://127.0.0.1:8188";
const BADGE_CLASS = "cuw-badge";
const MARKED_ATTR = "data-cuw-checked";
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const KEYS = ["workflow", "prompt"];
const IMAGE_EXT = /\.(png|webp|jpe?g)$/i;
const BOX_EXT = /\.(mp4|mov|m4v|m4a)$/i; // ISO base media: walk the boxes to find moov
const RANGE_EXT = /\.(mp4|webm|mov|mkv|m4v|flac|mp3|ogg|opus|m4a|wav)$/i; // large: never download whole
const JSON_EXT = /\.json$/i;
const RANGE_CHUNK = 4 * 1024 * 1024; // bytes read from the head and tail of large files
const MAX_MOOV = 64 * 1024 * 1024;
const MAX_JSON = 32 * 1024 * 1024;
const MAX_JSON_FILE = 16 * 1024 * 1024;
const MODEL_EXT = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i;

const css = `
.${BADGE_CLASS} {
    position: absolute; top: 6px; left: 6px; z-index: 10;
    width: 24px; height: 24px; border-radius: 6px;
    background: rgba(20, 20, 20, 0.8); color: #4ade80;
    font: 700 11px/24px sans-serif; text-align: center;
    cursor: pointer; user-select: none;
}
.${BADGE_CLASS}:hover { background: rgba(40, 40, 40, 0.95); }
.${BADGE_CLASS}.cuw-code { left: auto; right: 6px; }
.cuw-card { display: flex; flex-direction: column; gap: 14px; color: var(--text-normal); user-select: text; }
.cuw-card h4 { margin: 0 0 4px; font-size: 12px; text-transform: uppercase; color: var(--header-secondary); }
.cuw-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 14px; }
.cuw-row .cuw-name { flex: 1; word-break: break-all; }
.cuw-row .cuw-extra { color: var(--text-muted); font-size: 12px; }
.cuw-ok { color: #4ade80; } .cuw-similar { color: #fbbf24; } .cuw-related { color: var(--text-muted); } .cuw-missing { color: #f87171; } .cuw-unknown { color: var(--text-muted); }
.cuw-links a { margin-left: 8px; font-size: 12px; }
.cuw-links img { width: 18px; height: 18px; vertical-align: middle; border-radius: 3px; }
.cuw-note { color: var(--text-muted); font-size: 12px; }
/* Themes may make modals translucent: force an opaque surface for our windows. */
[role="dialog"]:has(.cuw-card),
[role="dialog"]:has(.cuw-card) :is([class*="root"], [class*="header"], [class*="content"], [class*="scroller"], [class*="footer"]):not(button, button *) {
    background: #2b2d31 !important; backdrop-filter: none !important; opacity: 1 !important;
}
.theme-light [role="dialog"]:has(.cuw-card),
.theme-light [role="dialog"]:has(.cuw-card) :is([class*="root"], [class*="header"], [class*="content"], [class*="scroller"], [class*="footer"]):not(button, button *) {
    background: #ffffff !important;
}
`;

/* ------------------------------- graph helpers ------------------------------- */

/** JSON.parse that also accepts the NaN/Infinity values Python-written ComfyUI JSON can contain (read as null). */
function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch (err) {
        const fixed = text.replace(/"(?:[^"\\]|\\.)*"|-?Infinity|NaN/g, m => (m[0] === '"' ? m : "null"));
        if (fixed === text) throw err;
        return JSON.parse(fixed);
    }
}

const isLink = v => Array.isArray(v) && v.length === 2 && (typeof v[0] === "string" || typeof v[0] === "number") && typeof v[1] === "number";

/** API prompt graph ({id: {class_type, inputs}}) built from an editor workflow, links resolved. */
function graphFromWorkflow(wf) {
    const links = new Map();
    for (const l of wf.links || []) {
        if (Array.isArray(l)) links.set(l[0], [l[1], l[2]]);
        else if (l && l.id != null) links.set(l.id, [l.origin_id, l.origin_slot]);
    }
    const g = {};
    for (const n of wf.nodes || []) {
        const inputs = {};
        for (const i of n.inputs || []) {
            if (i.link == null) continue;
            const l = links.get(i.link);
            if (l) inputs[i.name] = [String(l[0]), l[1]];
        }
        if (/TextEncode|String|Text|Prompt/i.test(n.type) && inputs.text === undefined) {
            const w = (n.widgets_values || []).find(x => typeof x === "string");
            if (w !== undefined) inputs.text = w;
        }
        g[String(n.id)] = { class_type: n.type, inputs, widgets: n.widgets_values };
    }
    return g;
}

function variantGraph(variant) {
    try {
        if (variant.prompt) return parseJson(variant.prompt);
        if (variant.workflow) return graphFromWorkflow(parseJson(variant.workflow));
    } catch { /* fall through */ }
    return null;
}

/** Follow a conditioning/text link back to the text it ultimately carries. */
function traceText(g, ref, seen = new Set()) {
    const id = String(ref[0]);
    const node = g[id];
    if (!node || seen.has(id)) return "";
    seen.add(id);
    const inp = node.inputs || {};
    const texts = [];
    for (const k of ["text", "text_g", "text_l", "prompt", "string", "value", "positive_prompt"]) {
        if (typeof inp[k] === "string" && inp[k].trim() && !texts.includes(inp[k])) texts.push(inp[k]);
    }
    if (texts.length) return texts.join("\n");
    const preferred = ["text", "string", "value", "conditioning", "conditioning_1", "conditioning_to", "positive", "prompt"];
    const keys = [...preferred.filter(k => k in inp), ...Object.keys(inp).filter(k => !preferred.includes(k))];
    for (const k of keys) {
        if (!isLink(inp[k])) continue;
        const r = traceText(g, inp[k], seen);
        if (r) return r;
    }
    return "";
}

/** {positive, negative} prompt texts, traced from the sampler; falls back to the first two text encoders. */
function extractPrompts(variant) {
    const g = variantGraph(variant);
    if (!g) return {};
    const entries = Object.entries(g).sort((a, b) => Number(a[0]) - Number(b[0]));
    const sampler = entries.find(([, n]) => /sampler|guider/i.test(n.class_type) && isLink(n.inputs?.positive))
        ?? entries.find(([, n]) => /guider/i.test(n.class_type) && isLink(n.inputs?.conditioning)); // BasicGuider: positive only
    if (sampler) {
        const inp = sampler[1].inputs;
        return {
            positive: traceText(g, inp.positive ?? inp.conditioning) || undefined,
            negative: isLink(inp.negative) ? traceText(g, inp.negative) || undefined : undefined
        };
    }
    const enc = entries.filter(([, n]) => /CLIPTextEncode/i.test(n.class_type) && typeof n.inputs?.text === "string");
    return { positive: enc[0]?.[1].inputs.text, negative: enc[1]?.[1].inputs.text };
}

function modelKind(key, cls) {
    const s = `${key ?? ""} ${cls ?? ""}`.toLowerCase();
    if (/lora/.test(s)) return "LoRA";
    if (/ckpt|checkpoint/.test(s)) return "Checkpoint";
    if (/vae/.test(s)) return "VAE";
    if (/controlnet|control_net/.test(s)) return "ControlNet";
    if (/unet|diffusion|gguf/.test(s)) return "Diffusion model";
    if (/clip|t5|text_encoder|llm/.test(s)) return "Text encoder";
    if (/upscale/.test(s)) return "Upscaler";
    if (/ipadapter|ip_adapter/.test(s)) return "IP-Adapter";
    if (/embedding|textual/.test(s)) return "Embedding";
    return "Model";
}

/** Model files (checkpoints, LoRAs, VAEs, ...) used by a variant. */
function extractModels(variant) {
    const out = [];
    const seen = new Set();
    const add = (name, key, cls, strength) => {
        const k = `${name}|${cls}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ name, kind: modelKind(key, cls), cls, key, strength });
    };
    try {
        if (variant.prompt) {
            for (const node of Object.values(parseJson(variant.prompt))) {
                const inp = node?.inputs;
                if (!inp) continue;
                const strength = inp.strength_model ?? inp.strength;
                for (const [key, v] of Object.entries(inp)) {
                    if (typeof v === "string" && MODEL_EXT.test(v)) add(v, key, node.class_type, typeof strength === "number" ? strength : undefined);
                    else if (v && typeof v === "object" && !Array.isArray(v)) {
                        // e.g. rgthree Power Lora Loader: {on, lora, strength}
                        const s = Object.values(v).find(x => typeof x === "string" && MODEL_EXT.test(x));
                        if (s) add(s, key, node.class_type, typeof v.strength === "number" ? v.strength : undefined);
                    }
                }
            }
        } else if (variant.workflow) {
            for (const node of parseJson(variant.workflow).nodes || []) {
                for (const w of node.widgets_values || []) {
                    if (typeof w === "string" && MODEL_EXT.test(w)) add(w, undefined, node.type);
                    else if (w && typeof w === "object" && !Array.isArray(w)) {
                        const s = Object.values(w).find(x => typeof x === "string" && MODEL_EXT.test(x));
                        if (s) add(s, undefined, node.type, typeof w.strength === "number" ? w.strength : undefined);
                    }
                }
            }
        }
    } catch { /* ignore malformed graphs */ }
    return out;
}

const normName = s => String(s).trim().replace(/\\/g, "/").toLowerCase();
const noExt = s => normName(s).split("/").pop().replace(MODEL_EXT, "");
const QUANT_TOKENS = new Set([
    "fp4", "fp8", "fp16", "fp32", "bf16", "f16", "f32", "nf4", "nvfp4", "mxfp4", "int4", "int8", "fn", "fnuz",
    "scaled", "convrot", "gptq", "awq", "svdq", "svdquant", "nunchaku", "gguf"
]);

/**
 * File name reduced to its identity: no folder, extension, or quantization/precision tokens
 * (Q4_K_M, IQ4_XS, fp8_e4m3fn, bf16, int8, convrot, ...). Variants like "turbo" are kept.
 */
function quantKey(name) {
    const tokens = normName(name).split("/").pop().replace(MODEL_EXT, "").split(/[-_. ]+/).filter(Boolean);
    const kept = [];
    let afterQ = false;
    for (const t of tokens) {
        if (/^i?q\d+$/.test(t)) { afterQ = true; continue; }
        if (afterQ && /^(?:k|m|s|l|xs|xxs|\d)$/.test(t)) continue; // the K_M / _0 part of Q4_K_M, Q8_0
        afterQ = false;
        if (QUANT_TOKENS.has(t) || /^e\dm\d(?:fnuz|fn)?$/.test(t) || /^w\d+a\d+$/.test(t)) continue;
        kept.push(t);
    }
    return kept.join("_");
}

/** Files sharing most name tokens with `name` (extra or missing words like "attn", "KJ", "turbo"); suggestions only. */
function relatedModels(name, available) {
    const tokens = n => new Set(quantKey(n).split("_").filter(Boolean));
    const want = tokens(name);
    return available.map(o => {
        const have = tokens(o);
        const shared = [...want].filter(t => have.has(t));
        return { o, words: shared.filter(t => !/^\d+$/.test(t)).length, score: shared.length / Math.max(want.size, have.size, 1) };
    })
        .filter(x => x.words >= 2 && x.score >= 0.7)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(x => x.o);
}

/**
 * How a wanted model file relates to the files a server offers: ok (exact, or same file name in
 * another folder, with `matches` set), similar (other quantization), or missing.
 */
function matchModel(name, available) {
    const want = normName(name);
    if (available.some(o => normName(o) === want)) return { st: "ok" };
    const folder = want.split("/").slice(0, -1).join("/");
    const closest = list => list.sort((x, y) =>
        (normName(y).startsWith(folder + "/") ? 1 : 0) - (normName(x).startsWith(folder + "/") ? 1 : 0));
    // .sft is the short extension for the same safetensors format
    const canon = o => normName(o).replace(/\.sft$/, ".safetensors");
    const wantCanon = canon(name);
    const base = wantCanon.split("/").pop();
    const moved = available.filter(o => canon(o).split("/").pop() === base);
    if (moved.length) {
        const sameFolder = moved.some(o => canon(o) === wantCanon);
        return { st: "ok", matches: closest(moved), hint: sameFolder ? "found with another extension: " : "found in another folder: " };
    }
    const key = quantKey(name);
    const similar = key.length >= 3 ? available.filter(o => quantKey(o) === key) : [];
    if (similar.length) return { st: "similar", matches: closest(similar), hint: "similar (other quantization): " };
    const related = relatedModels(name, available);
    return related.length ? { st: "related", matches: related, hint: "possibly related: " } : { st: "missing" };
}

const searchLinks = name => [
    ["Civitai", `https://civitai.com/search/models?query=${encodeURIComponent(noExt(name))}`, "civitai.com"],
    ["Hugging Face", `https://huggingface.co/models?search=${encodeURIComponent(noExt(name))}`, "huggingface.co"],
    ["Web", `https://www.google.com/search?q=${encodeURIComponent(noExt(name))}`, "www.google.com"]
];

/* ------------------------------- byte helpers ------------------------------- */

async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

const utf8 = new TextDecoder("utf-8");
const latin = new TextDecoder("latin1");

/**
 * Find workflow/prompt JSON objects inside arbitrary text. Workflow JSON has "nodes";
 * API prompt JSON has "class_type". Returns variants paired by order of appearance.
 */
function scanText(text) {
    const starts = /\{\s*"(?:last_node_id|id|revision|version|nodes|\d+)"\s*:/g;
    const workflows = [];
    const prompts = [];
    let m;
    while ((m = starts.exec(text))) {
        const end = matchBrace(text, m.index);
        if (end < 0) continue;
        starts.lastIndex = end + 1;
        const chunk = text.slice(m.index, end + 1);
        let obj;
        try { obj = parseJson(chunk); } catch { continue; }
        if (Array.isArray(obj.nodes)) { if (!workflows.includes(chunk)) workflows.push(chunk); }
        else if (Object.values(obj).some(v => v && typeof v === "object" && "class_type" in v)) { if (!prompts.includes(chunk)) prompts.push(chunk); }
    }
    return pairVariants(workflows, prompts);
}

function pairVariants(workflows, prompts) {
    const variants = [];
    for (let i = 0; i < Math.max(workflows.length, prompts.length); i++) {
        variants.push({ workflow: workflows[i], prompt: prompts[i] });
    }
    return variants.length ? { variants } : null;
}

/** Index of the brace closing the object that opens at `start`, string-aware; -1 if none. */
function matchBrace(text, start) {
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

const scanBytes = buf => scanText(utf8.decode(buf));

async function parsePng(buf) {
    if (!PNG_SIG.every((b, i) => buf[i] === b)) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const found = {};
    let pos = 8;

    while (pos + 8 <= buf.length) {
        const len = view.getUint32(pos);
        const type = latin.decode(buf.subarray(pos + 4, pos + 8));
        const start = pos + 8;
        const end = start + len;
        if (type === "IEND") break;
        if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
            const chunk = buf.subarray(start, end);
            const nul = chunk.indexOf(0);
            const key = latin.decode(chunk.subarray(0, nul)).toLowerCase();
            if (KEYS.includes(key)) {
                try {
                    if (type === "tEXt") {
                        found[key] = utf8.decode(chunk.subarray(nul + 1));
                    } else if (type === "zTXt") {
                        found[key] = utf8.decode(await inflate(chunk.subarray(nul + 2)));
                    } else {
                        // iTXt: key\0 compFlag compMethod lang\0 translated\0 text
                        let p = chunk.indexOf(0, nul + 3) + 1;
                        p = chunk.indexOf(0, p) + 1;
                        const body = chunk.subarray(p);
                        found[key] = utf8.decode(chunk[nul + 1] === 1 ? await inflate(body) : body);
                    }
                } catch { /* unreadable chunk: skip */ }
            }
        }
        pos = end + 4; // skip CRC
    }
    return found.workflow || found.prompt ? { variants: [{ workflow: found.workflow, prompt: found.prompt }] } : null;
}

module.exports = class ComfyUIWorkflow {
    constructor(meta) {
        this.meta = meta;
        this.cache = new Map(); // url -> Promise<{variants} | null>
        this.observer = null;
        this.scanTimer = null;
        this.iconCache = null;
        this.positioned = new Set(); // hosts whose position style we set
    }

    start() {
        BdApi.DOM.addStyle(this.meta.name, css);
        this.observer = new MutationObserver(() => {
            if (this.scanTimer) return;
            this.scanTimer = setTimeout(() => { this.scanTimer = null; this.scan(); }, 150);
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
        this.scan();
    }

    stop() {
        this.observer?.disconnect();
        this.observer = null;
        clearTimeout(this.scanTimer);
        this.scanTimer = null;
        BdApi.DOM.removeStyle(this.meta.name);
        document.querySelectorAll(`.${BADGE_CLASS}`).forEach(b => b.remove());
        this.positioned.forEach(h => { h.style.position = ""; });
        this.positioned.clear();
        document.querySelectorAll(`[${MARKED_ATTR}]`).forEach(e => e.removeAttribute(MARKED_ATTR));
        this.cache.clear();
    }

    /* ----------------------------------- chat ----------------------------------- */

    scan() {
        const root = `[class*="messagesWrapper"]`;
        document.querySelectorAll(`${root} :is(img, video, audio)[src*="discordapp"]:not([${MARKED_ATTR}])`)
            .forEach(el => this.process(el));
        // Audio and .json attachments are file cards with a link.
        document.querySelectorAll(`${root} a[href*="discordapp"]:not([${MARKED_ATTR}])`).forEach(a => {
            if (RANGE_EXT.test(a.pathname) || JSON_EXT.test(a.pathname)) this.process(a);
        });
        // Workflow JSON pasted as a code block.
        document.querySelectorAll(`${root} code:not([${MARKED_ATTR}])`).forEach(code => this.processCode(code));
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
        this.addBadge(host, url, data);
    }

    processCode(code) {
        code.setAttribute(MARKED_ATTR, "1");
        const text = code.textContent;
        if (text.length < 300 || !/class_type|"nodes"/.test(text)) return;
        const data = scanText(text);
        if (!data) return;
        const host = code.closest("pre") ?? code;
        this.addBadge(host, `pasted-${Date.now()}.json`, data, true);
    }

    addBadge(host, url, data, isCode = false) {
        if (!host || host.querySelector(`:scope > .${BADGE_CLASS}`)) return;
        if (!this.observer) return; // plugin was stopped while the file was being checked
        if (getComputedStyle(host).position === "static") {
            host.style.position = "relative";
            this.positioned.add(host);
        }

        const hasWorkflow = data.variants.some(v => v.workflow);
        const badge = document.createElement("div");
        badge.className = BADGE_CLASS + (isCode ? " cuw-code" : "");
        badge.textContent = hasWorkflow ? "WF" : "P";
        badge.title = hasWorkflow
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

    /* -------------------------------- settings / UI ------------------------------- */

    get folder() {
        return BdApi.Data.load(this.meta.name, "folder") || DEFAULT_FOLDER;
    }

    get server() {
        return (BdApi.Data.load(this.meta.name, "server") || DEFAULT_SERVER).trim().replace(/\/+$/, "");
    }

    get copyPathOnSave() {
        return !!BdApi.Data.load(this.meta.name, "copyPathOnSave");
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

    async readClipboard() {
        try { return (await navigator.clipboard.readText()).trim(); } catch { return ""; }
    }

    async testServer(url) {
        try {
            const res = await BdApi.Net.fetch(`${url}/system_stats`);
            if (!res.ok) throw new Error("HTTP " + res.status);
            BdApi.UI.showToast("ComfyUI is reachable", { type: "success" });
            return true;
        } catch (err) {
            BdApi.UI.showToast(`Cannot reach ${url}: ${err.message}`, { type: "error" });
            return false;
        }
    }

    getSettingsPanel() {
        const React = BdApi.React;
        const h = React.createElement;
        const plugin = this;
        const btn = (label, onClick) => h("button", {
            onClick,
            style: { padding: "8px 16px", borderRadius: 4, border: "none", cursor: "pointer", background: "var(--brand-500, #5865f2)", color: "#fff" }
        }, label);
        const Panel = () => {
            const [folder, setFolder] = React.useState(plugin.folder);
            const [server, setServer] = React.useState(plugin.server);
            const [copyPath, setCopyPath] = React.useState(plugin.copyPathOnSave);
            const update = v => { setServer(v); BdApi.Data.save(plugin.meta.name, "server", v.trim()); };
            const inputRef = el => {
                // Discord swallows key events in plugin settings; keep them on the input.
                if (!el || el.cuwPatched) return;
                el.cuwPatched = true;
                ["keydown", "keyup", "keypress"].forEach(ev => el.addEventListener(ev, e => e.stopImmediatePropagation()));
            };
            return h("div", { style: { display: "flex", flexDirection: "column", gap: 12, color: "var(--header-primary)" } },
                h("div", null, "Save folder: " + folder),
                h("div", null, btn("Choose folder...", () => plugin.chooseFolder(setFolder))),
                h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
                    h("input", {
                        type: "checkbox", checked: copyPath,
                        onChange: e => { setCopyPath(e.target.checked); BdApi.Data.save(plugin.meta.name, "copyPathOnSave", e.target.checked); }
                    }),
                    "Copy the file path to the clipboard after saving"),
                h("div", { style: { marginTop: 8 } }, "ComfyUI server URL (used by \"Send to ComfyUI\" and the model check):"),
                h("input", {
                    ref: inputRef, type: "text", value: server, spellCheck: false,
                    onChange: e => update(e.target.value),
                    style: { padding: 8, borderRadius: 4, border: "none", userSelect: "text", background: "var(--input-background, #1e1f22)", color: "var(--text-normal, #fff)" }
                }),
                h("div", { style: { display: "flex", gap: 8 } },
                    btn("Paste from clipboard", async () => { const t = await plugin.readClipboard(); if (t) update(t); }),
                    btn("Test connection", () => plugin.testServer(server.trim().replace(/\/+$/, "")))
                )
            );
        };
        return h(Panel);
    }

    showMenu(event, url, data) {
        const base = decodeURIComponent(new URL(url, "https://x.invalid/").pathname.split("/").pop()).replace(/\.[a-z0-9]+$/i, "");
        const multi = data.variants.length > 1;
        const items = [];
        data.variants.forEach((variant, i) => {
            const tag = multi ? ` #${i + 1}` : "";
            const file = multi ? `${base}_${i + 1}` : base;
            const { positive, negative } = extractPrompts(variant);
            if (positive || negative) items.push({ label: `Prompts${tag}`, action: () => this.showPrompts({ positive, negative }, file) });
            if (variant.prompt) items.push({ label: `Queue in ComfyUI${tag}`, action: () => this.sendToComfy(variant.prompt) });
            if (extractModels(variant).length) items.push({ label: `Models and LoRAs${tag}`, action: () => this.showModels(variant, file) });
            if (variant.workflow) items.push({ label: `Save workflow as JSON${tag}`, action: () => this.save(file, variant.workflow) });
            if (variant.prompt) items.push({ label: `Save prompt as JSON${tag}`, action: () => this.save(file + ".prompt", variant.prompt) });
        });
        items.push(
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

    showPrompts({ positive, negative }, title) {
        const React = BdApi.React;
        const h = React.createElement;
        const section = (label, text) => text && h("div", { key: label },
            h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 } },
                h("h4", { style: { margin: 0 } }, label),
                h("button", {
                    onClick: () => {
                        DiscordNative.clipboard.copy(text);
                        BdApi.UI.showToast(`${label} prompt copied`, { type: "success" });
                    },
                    style: { padding: "4px 12px", borderRadius: 4, border: "none", cursor: "pointer", background: "var(--brand-500, #5865f2)", color: "#fff" }
                }, "Copy")
            ),
            h("textarea", {
                readOnly: true, value: text, rows: Math.min(10, Math.max(3, Math.ceil(text.length / 70))),
                style: { width: "100%", boxSizing: "border-box", padding: 8, borderRadius: 4, border: "none", resize: "vertical", userSelect: "text", background: "var(--input-background, #1e1f22)", color: "var(--text-normal, #fff)" }
            })
        );
        const content = h("div", { className: "cuw-card" }, section("Positive", positive), section("Negative", negative));
        BdApi.UI.showConfirmationModal(`Prompts: ${title}`, content, { confirmText: "Close", cancelText: null });
    }

    save(base, json) {
        try {
            const dir = this.folder;
            fs.mkdirSync(dir, { recursive: true });
            const safe = base.replace(/[<>:"/\\|?*]/g, "_");
            let file = path.join(dir, safe + ".json");
            for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${safe} (${i}).json`);
            fs.writeFileSync(file, json, "utf8");
            if (this.copyPathOnSave) DiscordNative.clipboard.copy(file);
            BdApi.UI.showToast(`Saved: ${path.basename(file)}` + (this.copyPathOnSave ? " (path copied)" : ""), { type: "success" });
        } catch (err) {
            BdApi.UI.showToast("Save failed: " + err.message, { type: "error" });
        }
    }

    /* ----------------------------------- ComfyUI ----------------------------------- */

    /**
     * Compare every model file in the prompt with what the server offers. Same file in another
     * folder or another quantization is rewritten to the server's name; the rest is reported missing.
     */
    async planModels(graph) {
        const changes = [];
        const missing = [];
        const classes = [...new Set(Object.values(graph).map(n => n?.class_type).filter(Boolean))];
        const options = new Map();
        await Promise.all(classes.map(async c => options.set(c, await this.comboOptions(c))));
        for (const [id, node] of Object.entries(graph)) {
            const combos = options.get(node?.class_type);
            if (!combos) continue;
            for (const [key, val] of Object.entries(node.inputs || {})) {
                if (typeof val !== "string" || !MODEL_EXT.test(val) || !combos[key]) continue;
                const r = matchModel(val, combos[key]);
                if (r.st === "ok" && !r.matches) continue;
                if (r.st === "missing" || r.st === "related") missing.push({ cls: node.class_type, key, name: val });
                else changes.push({ id, cls: node.class_type, key, from: val, to: r.matches[0], st: r.st });
            }
        }
        return { changes, missing };
    }

    async sendToComfy(promptJson) {
        let graph;
        try { graph = parseJson(promptJson); } catch {
            BdApi.UI.showToast("The prompt JSON is not valid", { type: "error" });
            return;
        }
        const { changes, missing } = await this.planModels(graph);
        if (missing.length) {
            this.showLines("Not sent: models missing on the ComfyUI server",
                missing.map(m => `${m.cls} (${m.key}): ${m.name}`));
            return;
        }
        for (const c of changes) graph[c.id].inputs[c.key] = c.to;
        const similar = changes.filter(c => c.st === "similar");
        if (!similar.length) return this.postPrompt(graph, changes.length);

        const h = BdApi.React.createElement;
        BdApi.UI.showConfirmationModal("Use similar models?", h("div", { className: "cuw-card" },
            h("div", { className: "cuw-note" }, "These files are not on the server. Send with the similar ones instead?"),
            similar.map(c => h("div", { key: c.id + c.key, className: "cuw-row" },
                h("span", { className: "cuw-name" }, c.from, h("div", { className: "cuw-extra" }, "→ " + c.to))))
        ), { confirmText: "Send", cancelText: "Cancel", onConfirm: () => this.postPrompt(graph, changes.length) });
    }

    async postPrompt(graph, adjusted) {
        const server = this.server;
        try {
            const res = await BdApi.Net.fetch(`${server}/prompt`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: graph, client_id: "discord-comfyui-workflow" })
            });
            const text = await res.text();
            if (res.ok) {
                let n = "";
                try { n = ` (queue #${JSON.parse(text).number})`; } catch { /* no number */ }
                BdApi.UI.showToast("Queued in ComfyUI" + n + (adjusted ? `, ${adjusted} model name(s) adjusted` : ""), { type: "success" });
                return;
            }
            let title = `ComfyUI rejected the prompt (HTTP ${res.status})`;
            const lines = [];
            try {
                const err = JSON.parse(text);
                if (err.error?.message) lines.push(err.error.message + (err.error.details ? `: ${err.error.details}` : ""));
                for (const [id, ne] of Object.entries(err.node_errors || {})) {
                    const detail = (ne.errors || []).map(e => [e.message, e.details].filter(Boolean).join(" ")).join("; ");
                    lines.push(`${ne.class_type} (#${id}): ${detail}`);
                }
            } catch { lines.push(text.slice(0, 500)); }
            this.showLines(title, lines);
        } catch (err) {
            BdApi.UI.showToast(`Cannot reach ComfyUI at ${server} (${err.message}). Set the URL in plugin settings.`, { type: "error", timeout: 8000 });
        }
    }

    showLines(title, lines) {
        const h = BdApi.React.createElement;
        BdApi.UI.showConfirmationModal(title, h("div", { className: "cuw-card" },
            lines.map((l, i) => h("div", { key: i, className: "cuw-row" }, h("span", { className: "cuw-name" }, l)))
        ), { confirmText: "Close", cancelText: null });
    }

    /** Option lists of every combo input of a node class on the server, or null if unreachable. */
    async comboOptions(cls) {
        try {
            const res = await BdApi.Net.fetch(`${this.server}/object_info/${encodeURIComponent(cls)}`);
            if (!res.ok) return null;
            const info = (await res.json())[cls];
            if (!info) return null;
            const out = {};
            for (const group of [info.input?.required, info.input?.optional]) {
                for (const [key, spec] of Object.entries(group || {})) {
                    const opts = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options;
                    if (Array.isArray(opts)) out[key] = opts;
                }
            }
            return out;
        } catch {
            return null;
        }
    }

    /** Site favicons as data URIs (fetched outside the page, so Discord's CSP does not apply). */
    async loadIcons() {
        this.iconCache ??= new Map();
        await Promise.all(searchLinks("x").map(async ([, , domain]) => {
            if (this.iconCache.has(domain)) return;
            try {
                const res = await BdApi.Net.fetch(`https://${domain}/favicon.ico`);
                if (!res.ok) return;
                const bytes = new Uint8Array(await res.arrayBuffer());
                let bin = "";
                for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                this.iconCache.set(domain, `data:${res.headers?.get?.("content-type") || "image/x-icon"};base64,${btoa(bin)}`);
            } catch { /* fall back to the text label */ }
        }));
        return this.iconCache;
    }

    async showModels(variant, title) {
        const models = extractModels(variant);
        const classes = [...new Set(models.map(m => m.cls))];
        const options = new Map();
        await Promise.all(classes.map(async c => options.set(c, await this.comboOptions(c))));
        const status = m => {
            const combos = options.get(m.cls);
            if (!combos) return { st: "unknown" };
            const lists = m.key && combos[m.key] ? [combos[m.key]] : Object.values(combos);
            return matchModel(m.name, lists.flat());
        };
        const symbols = { ok: "✓", similar: "≈", related: "~", missing: "✗", unknown: "?" };
        const reachable = [...options.values()].some(Boolean);
        const icons = await this.loadIcons();

        const React = BdApi.React;
        const h = React.createElement;
        const kinds = [...new Set(models.map(m => m.kind))];
        const content = h("div", { className: "cuw-card" },
            !reachable && h("div", { className: "cuw-note" }, `ComfyUI at ${this.server} is not reachable, so availability is unknown.`),
            kinds.map(kind => h("div", { key: kind },
                h("h4", null, kind),
                models.filter(m => m.kind === kind).map(m => {
                    const { st, matches, hint } = status(m);
                    return h("div", { className: "cuw-row", key: m.name + m.cls },
                        h("span", { className: `cuw-${st}`, title: st }, symbols[st]),
                        h("span", { className: "cuw-name" }, m.name,
                            matches && h("div", { className: "cuw-extra" }, hint + matches.slice(0, 3).join(", ") + (matches.length > 3 ? ` (+${matches.length - 3})` : ""))),
                        m.strength !== undefined && h("span", { className: "cuw-extra" }, `strength ${m.strength}`),
                        h("span", { className: "cuw-links" },
                            searchLinks(m.name).map(([label, href, domain]) => h("a", { key: label, href, title: `Search ${label}`, target: "_blank", rel: "noreferrer" },
                                icons.get(domain) ? h("img", { src: icons.get(domain), alt: label }) : label)))
                    );
                })
            ))
        );
        BdApi.UI.showConfirmationModal(`Models and LoRAs: ${title}`, content, { confirmText: "Close", cancelText: null });
    }

    /* ------------------------------------ fetching ----------------------------------- */

    /** Strip Discord resize params so we get the original file with its metadata. */
    originalUrl(src) {
        try {
            const u = new URL(src);
            if (u.hostname === "media.discordapp.net") u.hostname = "cdn.discordapp.com";
            ["width", "height", "format", "quality", "animated"].forEach(p => u.searchParams.delete(p));
            if (![IMAGE_EXT, RANGE_EXT, JSON_EXT].some(re => re.test(u.pathname))) return null;
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
        const name = new URL(url).pathname;
        if (RANGE_EXT.test(name)) return this.fetchLargeMeta(url, BOX_EXT.test(name));
        const res = await BdApi.Net.fetch(url);
        if (!res.ok) return null;
        const buf = new Uint8Array(await res.arrayBuffer());
        if (JSON_EXT.test(name)) return buf.length > MAX_JSON_FILE ? null : scanBytes(buf);
        return (await parsePng(buf)) ?? scanBytes(buf);
    }

    /** Video/audio can be huge: read only the parts that hold metadata. */
    async fetchLargeMeta(url, isBox) {
        const workflows = [];
        const prompts = [];
        const collect = buf => {
            const r = buf && scanBytes(buf);
            for (const v of r?.variants ?? []) {
                if (v.workflow && !workflows.includes(v.workflow)) workflows.push(v.workflow);
                if (v.prompt && !prompts.includes(v.prompt)) prompts.push(v.prompt);
            }
        };
        if (isBox) collect(await this.readMoov(url));
        if (!workflows.length && !prompts.length) {
            const [head, tail] = await Promise.all([
                this.fetchRange(url, `bytes=0-${RANGE_CHUNK - 1}`, RANGE_CHUNK, true),
                this.fetchRange(url, `bytes=-${RANGE_CHUNK}`, RANGE_CHUNK, false)
            ]);
            collect(head);
            collect(tail);
        }
        return pairVariants(workflows, prompts);
    }

    /** Walk the top-level ISO boxes with small Range requests and read the moov box. */
    async readMoov(url) {
        let off = 0;
        for (let guard = 0; guard < 64; guard++) {
            const hdr = await this.fetchRange(url, `bytes=${off}-${off + 15}`, 16, off === 0);
            if (!hdr || hdr.length < 8) return null;
            const view = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
            let size = view.getUint32(0);
            const type = latin.decode(hdr.subarray(4, 8));
            if (size === 1 && hdr.length >= 16) size = Number(view.getBigUint64(8));
            if (size < 8) return null; // size 0 = "to end of file": nothing more to walk
            if (type === "moov") {
                return size <= MAX_MOOV ? this.fetchRange(url, `bytes=${off}-${off + size - 1}`, size, false) : null;
            }
            off += size;
        }
        return null;
    }

    /**
     * Fetch a byte range. When the server ignores Range (status 200) only the head of the file is
     * usable, and only when `allowFull` is set; the stream is cancelled after `maxBytes`.
     */
    async fetchRange(url, range, maxBytes, allowFull) {
        const res = await BdApi.Net.fetch(url, { headers: { Range: range } });
        if (!res.ok) return null;
        if (res.status !== 206 && !allowFull) return null;
        const reader = res.body.getReader();
        const parts = [];
        let size = 0;
        while (size < maxBytes) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            size += value.length;
        }
        reader.cancel().catch(() => {});
        const out = new Uint8Array(Math.min(size, maxBytes));
        let at = 0;
        for (const p of parts) {
            const piece = p.subarray(0, out.length - at);
            out.set(piece, at);
            at += piece.length;
            if (at >= out.length) break;
        }
        return out;
    }
};
