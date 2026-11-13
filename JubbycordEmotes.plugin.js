/**
 * @name JubbycordEmotes
 * @description Renders Uncxity's emotes in Discord. Search for and autofill emotes with semicolon.
 * @version 1.0.0
 * @author you
 */

module.exports = class JubbycordEmotes {
  constructor(meta) {
    this.name = meta.name;
    this.defaults = { channels: "haxitydota, pooploofster", sevenTvSets: "01H3ZQJDPG000FFX1CY9011KZQ, 01K87B9A2AD2CW1WA3S6EQJ38F", use7tv: true, useBttv: true, useFfz: true, useGlobal: false, size: 28, autocomplete: true, minChars: 1, jumbo: true, jumboSize: 48 };
    this.emotes = {};
    this.imgCache = new Map();
    this.SEL = '[id^="message-content-"], [class*="repliedTextContent"], [class*="embedDescription"]';
    this.queue = new Set();
    this.scheduled = false;
    this.seedIds = { haxitydota: "42649203", pooploofster: "169423343"}; // known channel -> Twitch ID, no lookup needed
    this.timers = []; this.stopped = false;
    this.names = []; this.matches = []; this.sel = 0; this.tok = null; this.pop = null;
  }

  // ---------- settings ----------
  get cfg() {
    const saved = BdApi.Data.load(this.name, "cfg") || {};
    const c = { ...this.defaults, ...saved };
    // settings saved by the single-channel version: carry the old channel over
    if (saved.channels === undefined && (saved.twitchId || saved.login)) c.channels = saved.twitchId || saved.login;
    // blank text fields fall back to the built-in defaults
    for (const k of ["channels", "sevenTvSets"]) if (!c[k]) c[k] = this.defaults[k];
    return c;
  }
  saveCfg(c) { BdApi.Data.save(this.name, "cfg", c); }

  // ---------- network ----------
  net(url) { return (BdApi.Net && BdApi.Net.fetch) ? BdApi.Net.fetch(url) : fetch(url); }
  async json(url) {
    const r = await this.net(url);
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }
  abs(u) { return u.startsWith("//") ? "https:" + u : u; }

  async loadImg(url) {
    if (!this.imgCache.has(url)) {
      this.imgCache.set(url, (async () => {
        try {
          const r = await this.net(url);
          if (!r.ok) { this.imgCache.delete(url); return null; }
          const buf = new Uint8Array(await r.arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
          const mime = url.endsWith(".png") ? "image/png" : url.endsWith(".gif") ? "image/gif" : "image/webp";
          return `data:${mime};base64,${btoa(bin)}`;
        } catch (e) { this.imgCache.delete(url); return null; }
      })());
    }
    return this.imgCache.get(url);
  }

  cacheKey() {
    const c = this.cfg;
    return JSON.stringify([c.channels, c.sevenTvSets, c.use7tv, c.useBttv, c.useFfz, c.useGlobal]);
  }

  // Load emotes at launch: instantly from cache, then refresh from the network (with retries).
  initEmotes() {
    const cache = BdApi.Data.load(this.name, "cache");
    if (cache && cache.key === this.cacheKey() && cache.map) {
      this.emotes = cache.map;
      this.names = Object.keys(cache.map);
      this.rescan();
    }
    let attempt = 0;
    const delays = [0, 3000, 8000, 20000, 45000];
    const tryLoad = async () => {
      if (this.stopped) return;
      const r = await this.buildEmotes();
      if (this.stopped) return;
      if (r.count > 0) { this.rescan(); return; }
      if (++attempt < delays.length) this.later(tryLoad, delays[attempt]);
      else BdApi.UI.showToast("JubbycordEmotes: couldn't load emotes. Check the plugin settings.", { type: "error" });
    };
    tryLoad();
  }

  later(fn, ms) {
    const id = setTimeout(fn, ms);
    this.timers.push(id);
  }

  // Discord renders chat gradually at launch, so scan a few times after emotes arrive.
  rescan() {
    this.scan(document.body);
    this.later(() => this.scan(document.body), 1500);
    this.later(() => this.scan(document.body), 5000);
  }

  // ---------- emote sources ----------
  add7tv(set, map) {
    for (const e of (set && set.emotes) || []) {
      const h = e.data && e.data.host;
      if (h) map[e.name] = this.abs(h.url) + "/2x.webp";
    }
  }
  addBttv(list, map) {
    for (const e of list || []) map[e.code] = `https://cdn.betterttv.net/emote/${e.id}/2x.webp`;
  }
  addFfz(data, map) {
    for (const s of Object.values((data && data.sets) || {})) {
      for (const e of s.emoticons || []) {
        const u = e.urls && (e.urls["2"] || e.urls["1"]);
        if (u) map[e.name] = this.abs(u);
      }
    }
  }

  // Turn a username or numeric ID into a Twitch user ID.
  async resolveChannel(entry, errors) {
    if (/^\d+$/.test(entry)) return entry;
    const key = entry.toLowerCase();
    if (this.seedIds[key]) return this.seedIds[key];
    const ids = BdApi.Data.load(this.name, "ids") || {};
    if (ids[key]) return ids[key];
    try {
      const r = await this.json("https://api.ivr.fi/v2/twitch/user?login=" + encodeURIComponent(key));
      if (r && r[0] && r[0].id) {
        ids[key] = r[0].id;
        BdApi.Data.save(this.name, "ids", ids);
        return r[0].id;
      }
      throw new Error("user not found");
    } catch (e) {
      errors.push(`Twitch lookup (${entry}): ${e.message}`);
      return null;
    }
  }

  async buildEmotes() {
    const c = this.cfg, map = {}, errors = [];
    const run = async (label, fn) => { try { await fn(); } catch (e) { errors.push(`${label}: ${e.message}`); } };

    const ids = [];
    for (const entry of c.channels.split(/[\s,]+/).filter(Boolean)) {
      const id = await this.resolveChannel(entry, errors);
      if (id && !ids.includes(id)) ids.push(id);
    }

    if (c.useGlobal) {
      if (c.use7tv) await run("7TV global", async () => this.add7tv(await this.json("https://7tv.io/v3/emote-sets/global"), map));
      if (c.useBttv) await run("BTTV global", async () => this.addBttv(await this.json("https://api.betterttv.net/3/cached/emotes/global"), map));
      if (c.useFfz) await run("FFZ global", async () => this.addFfz(await this.json("https://api.frankerfacez.com/v1/set/global"), map));
    }
    // Last-added wins on a name clash, so go through channels in reverse: the first one listed has priority.
    for (const id of ids.slice().reverse()) {
      if (c.useFfz) await run(`FFZ ${id}`, async () => this.addFfz(await this.json(`https://api.frankerfacez.com/v1/room/id/${id}`), map));
      if (c.useBttv) await run(`BTTV ${id}`, async () => {
        const d = await this.json(`https://api.betterttv.net/3/cached/users/twitch/${id}`);
        this.addBttv(d.channelEmotes, map); this.addBttv(d.sharedEmotes, map);
      });
      if (c.use7tv) await run(`7TV ${id}`, async () => this.add7tv((await this.json(`https://7tv.io/v3/users/twitch/${id}`)).emote_set, map));
    }
    if (c.use7tv) {
      for (const sid of c.sevenTvSets.split(/[\s,]+/).filter(Boolean)) {
        await run("7TV set " + sid, async () => this.add7tv(await this.json(`https://7tv.io/v3/emote-sets/${sid}`), map));
      }
    }
    const count = Object.keys(map).length;
    if (count > 0 || errors.length === 0) {
      this.emotes = map;
      this.names = Object.keys(map);
    }
    if (count > 0) BdApi.Data.save(this.name, "cache", { key: this.cacheKey(), map });
    return { count, errors };
  }

  // ---------- DOM replacement ----------
  has(k) { return Object.prototype.hasOwnProperty.call(this.emotes, k); }

  handle(el) {
    if (!el || el.nodeType !== 1) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const t of nodes) {
      const p = t.parentElement;
      if (!p || p.closest("code, pre, img.de-emote")) continue;
      const parts = t.nodeValue.split(/(\s+)/);
      if (!parts.some((x) => this.has(x))) continue;
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        if (this.has(part)) {
          const img = document.createElement("img");
          img.className = "de-emote";
          img.alt = part; img.title = part; img.draggable = false;
          this.loadImg(this.emotes[part]).then((d) => { if (d) img.src = d; });
          frag.appendChild(img);
        } else if (part) frag.appendChild(document.createTextNode(part));
      }
      t.replaceWith(frag);
    }
    this.updateJumbo(el);
  }

  // Make emotes larger when a message contains nothing but emotes.
  updateJumbo(el) {
    const imgs = el.querySelectorAll("img.de-emote");
    if (!imgs.length) return;
    const isMessage = el.matches('[id^="message-content-"]');
    const only = this.cfg.jumbo && isMessage &&
      el.textContent.trim() === "" &&
      !el.querySelector("img:not(.de-emote)");
    imgs.forEach((img) => img.classList.toggle("de-jumbo", !!only));
  }

  scan(node) {
    if (!node) return;
    if (node.nodeType === 3) node = node.parentElement;
    if (!node || node.nodeType !== 1) return;
    const up = node.closest(this.SEL);
    if (up) this.handle(up);
    else node.querySelectorAll(this.SEL).forEach((e) => this.handle(e));
  }

  flush() {
    this.scheduled = false;
    const q = this.queue; this.queue = new Set();
    q.forEach((n) => this.scan(n));
  }

  applyStyle() {
    BdApi.DOM.removeStyle(this.name);
    BdApi.DOM.addStyle(this.name, `img.de-emote{height:${this.cfg.size}px;width:auto;vertical-align:middle;margin:0 1px;object-fit:contain;display:inline-block}img.de-emote.de-jumbo{height:${this.cfg.jumboSize || 48}px;margin:2px 2px}`);
  }

  // ---------- autocomplete ----------
  editorOf(t) { return t && t.closest ? t.closest('[role="textbox"][data-slate-editor="true"]') : null; }

  getToken() {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || !sel.anchorNode || sel.anchorNode.nodeType !== 3) return null;
    if (!this.editorOf(sel.anchorNode.parentElement)) return null;
    const node = sel.anchorNode, upto = node.nodeValue.slice(0, sel.anchorOffset);
    const m = upto.match(/(\S+)$/);
    // only trigger on a word that starts with ";"
    if (!m || m[1][0] !== ";") return null;
    const query = m[1].slice(1);
    if (query.length < (this.cfg.minChars || 1)) return null;
    return { node, text: m[1], query, start: sel.anchorOffset - m[1].length, end: sel.anchorOffset };
  }

  search(q) {
    const l = q.toLowerCase(), pre = [], sub = [];
    for (const n of this.names) {
      const nl = n.toLowerCase();
      if (nl.startsWith(l)) pre.push(n);
      else if (nl.includes(l)) sub.push(n);
    }
    const by = (a, b) => a.length - b.length || a.localeCompare(b);
    return pre.sort(by).concat(sub.sort(by)).slice(0, 10);
  }

  updatePopup() {
    if (!this.cfg.autocomplete || !this.names.length) return this.hidePopup();
    const tok = this.getToken();
    if (!tok) return this.hidePopup();
    const matches = this.search(tok.query);
    if (!matches.length) return this.hidePopup();
    this.tok = tok; this.matches = matches;
    if (this.sel >= matches.length) this.sel = 0;
    this.renderPopup();
  }

  renderPopup() {
    const ed = this.editorOf(this.tok.node.parentElement);
    if (!ed) return this.hidePopup();
    if (!this.pop) {
      this.pop = document.createElement("div");
      this.pop.style.cssText = "position:fixed;z-index:10000;background:var(--background-base-lower,var(--background-secondary,#2b2d31));color:var(--text-normal,#fff);border-radius:6px;box-shadow:0 8px 16px rgba(0,0,0,.4);padding:6px;max-height:340px;overflow:auto;font-size:14px";
      this.pop.addEventListener("mousedown", (e) => e.preventDefault());
      document.body.appendChild(this.pop);
    }
    const r = ed.closest("form") ? ed.closest("form").getBoundingClientRect() : ed.getBoundingClientRect();
    this.pop.style.left = r.left + "px";
    this.pop.style.width = r.width + "px";
    this.pop.style.bottom = (window.innerHeight - r.top + 8) + "px";
    this.pop.textContent = "";
    const head = document.createElement("div");
    head.textContent = "EMOTES MATCHING " + this.tok.query;
    head.style.cssText = "font-size:12px;font-weight:700;opacity:.7;padding:4px 8px";
    this.pop.appendChild(head);
    this.matches.forEach((name, i) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:10px;padding:4px 8px;border-radius:4px;cursor:pointer;" + (i === this.sel ? "background:var(--background-modifier-selected,rgba(255,255,255,.1))" : "");
      const img = document.createElement("img");
      img.style.cssText = "height:28px;width:auto;max-width:56px;object-fit:contain";
      this.loadImg(this.emotes[name]).then((d) => { if (d) img.src = d; });
      const label = document.createElement("span");
      label.textContent = name;
      row.append(img, label);
      row.onclick = () => this.complete(name);
      row.onmouseenter = () => {
        this.sel = i;
        Array.from(this.pop.children).slice(1).forEach((r, j) => {
          r.style.background = j === i ? "var(--background-modifier-selected,rgba(255,255,255,.1))" : "";
        });
      };
      this.pop.appendChild(row);
    });
  }

  hidePopup() {
    this.tok = null; this.matches = []; this.sel = 0;
    if (this.pop) { this.pop.remove(); this.pop = null; }
  }

  // Find Discord's Slate editor object by walking up the React fiber tree from the textbox.
  getSlate(el) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let f = key ? el[key] : null;
    for (let i = 0; f && i < 120; i++, f = f.return) {
      const cands = [f.memoizedProps && f.memoizedProps.editor, f.stateNode && f.stateNode.editor];
      for (const c of cands) {
        if (c && typeof c.insertText === "function" && typeof c.deleteBackward === "function" && Array.isArray(c.children)) return c;
      }
    }
    return null;
  }

  // Edit through Slate's own model so what is shown and what is sent can't disagree.
  completeViaSlate(ed, name) {
    const se = this.getSlate(ed);
    const sl = se && se.selection;
    if (!sl || sl.anchor.offset !== sl.focus.offset || sl.anchor.path.join() !== sl.focus.path.join()) return false;
    let n = se;
    for (const i of sl.anchor.path) { n = n && n.children && n.children[i]; }
    if (!n || typeof n.text !== "string") return false;
    const m = n.text.slice(0, sl.anchor.offset).match(/(\S+)$/);
    if (!m || m[1][0] !== ";") return false;
    try {
      const count = Array.from(m[1]).length;
      for (let i = 0; i < count; i++) se.deleteBackward("character");
      se.insertText(name + " ");
    } catch (err) {
      console.error("[DiscordEmotes] slate completion failed", err);
    }
    console.log("[DiscordEmotes] completed via Slate");
    return true;
  }

  // Fallback: simulate typing in the DOM.
  completeViaDom(t, name) {
    const count = Array.from(t.text).length;
    for (let i = 0; i < count; i++) document.execCommand("delete");
    document.execCommand("insertText", false, name + " ");
    console.log("[DiscordEmotes] completed via DOM fallback");
  }

  complete(name) {
    const t = this.tok;
    if (!t || !t.node.isConnected) return this.hidePopup();
    const ed = this.editorOf(t.node.parentElement);
    const sel = window.getSelection();
    // the caret must still be at the end of the typed token
    if (!ed || !sel.isCollapsed || sel.anchorNode !== t.node || sel.anchorOffset !== t.end) return this.hidePopup();
    ed.focus();
    this.busy = true;
    this.hidePopup();
    try {
      if (!this.completeViaSlate(ed, name)) this.completeViaDom(t, name);
    } finally {
      setTimeout(() => { this.busy = false; }, 0);
    }
  }

  onKeyDown(e) {
    if (!this.pop || !this.matches.length || !this.editorOf(e.target)) return;
    const n = this.matches.length;
    if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault(); e.stopPropagation();
      this.complete(this.matches[this.sel]);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      this.sel = (this.sel + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      this.renderPopup();
    } else if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      this.hidePopup();
    }
  }

  onInput(e) { if (!this.busy && this.editorOf(e.target)) { this.sel = 0; this.updatePopup(); } }
  onKeyUp(e) {
    if (this.busy || !this.editorOf(e.target)) return;
    if (["Tab", "Enter", "ArrowUp", "ArrowDown", "Escape"].includes(e.key) && this.pop) return;
    this.updatePopup();
  }

  // ---------- lifecycle ----------
  async start() {
    this.applyStyle();
    this.observer = new MutationObserver((muts) => {
      if (!Object.keys(this.emotes).length) return;
      for (const m of muts) {
        if (m.type === "characterData") this.queue.add(m.target);
        m.addedNodes.forEach((n) => this.queue.add(n));
      }
      if (!this.scheduled) { this.scheduled = true; requestAnimationFrame(() => this.flush()); }
    });
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    this._kd = (e) => this.onKeyDown(e);
    this._in = (e) => this.onInput(e);
    this._ku = (e) => this.onKeyUp(e);
    this._fo = (e) => { if (this.editorOf(e.target)) this.hidePopup(); };
    document.addEventListener("keydown", this._kd, true);
    document.addEventListener("input", this._in, true);
    document.addEventListener("keyup", this._ku, true);
    document.addEventListener("focusout", this._fo, true);

    this.stopped = false;
    this.initEmotes();
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearTimeout); this.timers = [];
    if (this.observer) this.observer.disconnect();
    document.removeEventListener("keydown", this._kd, true);
    document.removeEventListener("input", this._in, true);
    document.removeEventListener("keyup", this._ku, true);
    document.removeEventListener("focusout", this._fo, true);
    this.hidePopup();
    BdApi.DOM.removeStyle(this.name);
    document.querySelectorAll("img.de-emote").forEach((img) => img.replaceWith(document.createTextNode(img.alt)));
    this.emotes = {};
  }

  getSettingsPanel() {
    const c = this.cfg;
    const root = document.createElement("div");
    root.style.cssText = "color:var(--text-normal);display:flex;flex-direction:column;gap:10px;padding:8px";
    const field = (label, key, type = "text", placeholder = "", fallback = 28) => {
      const w = document.createElement("label");
      w.textContent = label;
      w.style.cssText = "display:flex;flex-direction:column;gap:4px;font-weight:600";
      const i = document.createElement("input");
      i.type = type; i.value = c[key]; i.placeholder = placeholder;
      i.style.cssText = "padding:6px;background:var(--input-background,#1e1f22);color:var(--text-normal);border:none;border-radius:4px";
      i.oninput = () => (c[key] = type === "number" ? parseInt(i.value, 10) || fallback : i.value.trim());
      w.appendChild(i); root.appendChild(w);
    };
    const check = (label, key) => {
      const w = document.createElement("label");
      const i = document.createElement("input");
      i.type = "checkbox"; i.checked = c[key];
      i.onchange = () => (c[key] = i.checked);
      w.append(i, " " + label); root.appendChild(w);
    };
    field("Twitch channels (usernames or IDs, comma separated; earlier ones win name clashes)", "channels", "text", "haxitydota, otherstreamer");
    field("Extra 7TV emote set IDs (comma separated)", "sevenTvSets");
    check("7TV", "use7tv"); check("BTTV", "useBttv"); check("FFZ", "useFfz");
    check("Include global emotes", "useGlobal");
    field("Emote height (px)", "size", "number");
    check("Larger emotes when a message is only emotes", "jumbo");
    field("Large emote height (px)", "jumboSize", "number", "", 48);
    check("Autocomplete popup (type ; then a name; Tab/Enter to accept, Esc to dismiss)", "autocomplete");
    field("Autocomplete: minimum characters after the ;", "minChars", "number", "", 1);

    const btn = document.createElement("button");
    btn.textContent = "Save & refresh";
    btn.style.cssText = "padding:8px 16px;align-self:flex-start;cursor:pointer";
    const status = document.createElement("div");
    status.style.whiteSpace = "pre-wrap";
    btn.onclick = async () => {
      this.saveCfg(c);
      this.applyStyle();
      status.textContent = "Loading emotes…";
      const r = await this.buildEmotes();
      this.scan(document.body);
      status.textContent = `Loaded ${r.count} emotes.` + (r.errors.length ? "\nProblems:\n" + r.errors.join("\n") : "");
    };
    root.append(btn, status);
    return root;
  }
};
