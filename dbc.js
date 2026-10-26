"use strict";

/* DBC Bit Layout view
   - Loads the converted DBC files (data/dbc/*.json) the first time the tab is opened.
   - Search by hex ID (334 / 0x334), decimal ID (820) or message/signal name.
   - Shows the CANdb-style byte x bit grid, signal properties and value tables.
   - Optional: paste a payload (hex bytes) to decode every signal. */

(() => {
  const DBC_INDEX_URL = "./data/dbc/index.json";
  const CONFIDENCE = { 0: "validated", 1: "plausible", 2: "layout-only", 3: "contradicted" };
  const MOBILE = window.matchMedia("(max-width: 800px)");

  const $ = (id) => document.getElementById(id);
  const ui = {
    tabs: document.querySelectorAll(".view-tab"),
    framesView: $("frames-view"),
    dbcView: $("dbc-view"),
    file: $("dbc-file"),
    search: $("dbc-search"),
    results: $("dbc-results"),
    list: $("dbc-list"),
    title: $("dbc-title"),
    subtitle: $("dbc-subtitle"),
    detail: $("dbc-detail"),
    back: $("dbc-back"),
  };

  const st = {
    loaded: false,
    loading: null,
    files: [], // [{key,label,file,messages}]
    groups: [], // [{id, x, key, name, entries:[{file, msg}]}]
    groupByKey: new Map(),
    filtered: [],
    current: null, // group
    fileKey: "",
    mux: null,
    selectedSignal: "",
    payload: "",
    searchTimer: null,
  };

  const esc = (v) =>
    String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const hex = (n, pad = 0) => "0x" + Number(n).toString(16).toUpperCase().padStart(pad, "0");
  const groupKey = (id, x) => `${x ? "x" : "s"}${id}`;

  // ---------- view switching ----------
  function setView(view, { push = false } = {}) {
    const isDbc = view === "dbc";
    ui.framesView.hidden = isDbc;
    ui.dbcView.hidden = !isDbc;
    document.body.classList.toggle("mode-dbc", isDbc);
    document.body.classList.remove("show-detail");
    ui.tabs.forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    const params = new URLSearchParams(location.search);
    if (isDbc) params.set("view", "dbc");
    else {
      params.delete("view");
      params.delete("id");
      params.delete("dbc");
    }
    const url = `${location.pathname}?${params.toString()}`;
    if (push) history.pushState(history.state, "", url);
    else history.replaceState(history.state, "", url);
    if (isDbc) ensureLoaded();
  }

  function updateUrlForMessage() {
    if (!st.current) return;
    const params = new URLSearchParams(location.search);
    params.set("view", "dbc");
    params.set("id", st.current.id.toString(16).toUpperCase());
    if (st.fileKey) params.set("dbc", st.fileKey);
    history.replaceState(history.state, "", `${location.pathname}?${params.toString()}`);
  }

  // ---------- loading ----------
  async function ensureLoaded() {
    if (st.loaded) return;
    if (st.loading) return st.loading;
    ui.results.textContent = "Loading DBC files...";
    st.loading = (async () => {
      try {
        const index = await (await fetch(DBC_INDEX_URL)).json();
        let done = 0;
        ui.results.textContent = `Loading DBC files 0/${index.length}...`;
        const files = await Promise.all(
          index.map(async (f) => {
            const res = await fetch(f.url);
            if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
            const data = await res.json();
            done += 1;
            ui.results.textContent = `Loading DBC files ${done}/${index.length}...`;
            return {
              key: f.key,
              label: f.label,
              group: f.group || "",
              file: f.file,
              eth: /ETH/.test(f.key),
              nodes: data.nodes || {},
              messages: data.messages,
            };
          })
        );
        st.files = files;
        buildGroups();
        const groups = [...new Set(files.map((f) => f.group))];
        ui.file.innerHTML =
          '<option value="">All files</option>' +
          groups
            .map(
              (gname) =>
                `<optgroup label="${esc(gname)}">${files
                  .filter((f) => f.group === gname)
                  .map((f) => `<option value="${esc(f.key)}">${esc(f.label)} (${f.messages.length})</option>`)
                  .join("")}</optgroup>`
            )
            .join("");
        st.loaded = true;
        const params = new URLSearchParams(location.search);
        const wantId = params.get("id");
        if (wantId) {
          ui.search.value = wantId;
        }
        applySearch();
        if (wantId) {
          const g = st.groupByKey.get(groupKey(parseInt(wantId, 16), 0));
          if (g) openGroup(g, params.get("dbc") || "", { mobile: true });
        }
      } catch (err) {
        console.error(err);
        ui.results.textContent = "Could not load DBC files. Open this tab once while online.";
        st.loading = null;
      }
    })();
    return st.loading;
  }

  function buildGroups() {
    const map = new Map();
    for (const f of st.files) {
      for (const msg of f.messages) {
        const k = groupKey(msg.id, msg.x);
        let g = map.get(k);
        if (!g) {
          g = { key: k, id: msg.id, x: msg.x, name: msg.n, entries: [], names: new Set(), sigText: "" };
          map.set(k, g);
        }
        g.entries.push({ file: f, msg });
        g.names.add(msg.n.toLowerCase());
      }
    }
    for (const g of map.values()) {
      const sigs = new Set();
      for (const e of g.entries) for (const s of e.msg.s) sigs.add(s.n.toLowerCase());
      g.sigText = [...sigs].join(" ");
      g.nameText = [...g.names].join(" ");
      g.hexText = g.id.toString(16).toLowerCase();
    }
    st.groups = [...map.values()].sort((a, b) => a.id - b.id || a.x - b.x);
    st.groupByKey = map;
  }

  // ---------- search ----------
  function scoreGroup(g, q) {
    if (!q) return 10;
    const isHexish = /^(0x)?[0-9a-f]+$/i.test(q);
    if (isHexish) {
      const h = q.replace(/^0x/i, "").toLowerCase();
      if (g.hexText === h) return 0;
      if (/^\d+$/.test(q) && g.id === Number(q)) return 1;
      if (g.hexText.startsWith(h)) return 3;
    }
    const lq = q.toLowerCase();
    if (g.nameText.includes(lq)) return 4;
    if (g.sigText.includes(lq)) return 5;
    return -1;
  }

  function applySearch() {
    if (!st.loaded) return;
    const q = ui.search.value.trim();
    const fk = ui.file.value;
    const out = [];
    for (const g of st.groups) {
      if (fk && !g.entries.some((e) => e.file.key === fk)) continue;
      const sc = scoreGroup(g, q);
      if (sc >= 0) out.push([sc, g]);
    }
    out.sort((a, b) => a[0] - b[0] || a[1].id - b[1].id);
    st.filtered = out.map((x) => x[1]);
    const exact = out.length && out[0][0] <= 1 ? out[0][1] : null;
    ui.results.textContent = `${st.filtered.length} message IDs` + (q ? ` matching "${q}"` : "");
    renderList();
    // Desktop: show the exact ID match right away.
    if (exact && !MOBILE.matches && st.current !== exact) {
      openGroup(exact, fk, { mobile: false });
    }
    return exact;
  }

  function renderList() {
    const max = 400;
    const items = st.filtered.slice(0, max).map((g) => {
      const files = g.entries.map((e) => e.file);
      const uniq = [...new Map(files.map((f) => [f.key, f])).values()];
      const active = st.current === g ? " active" : "";
      return `<article class="frame-item${active}" data-gkey="${esc(g.key)}">
        <div class="dbc-item-top">
          <strong class="dbc-item-name">${esc(g.name)}</strong>
          <code class="dbc-item-id">${hex(g.id, 3)}</code>
        </div>
        <div class="dbc-item-meta">
          <span>dec ${g.id}${g.x ? " · ext" : ""}</span>
          ${uniq.map((f) => `<span class="dbc-badge">${esc(f.key)}</span>`).join("")}
        </div>
      </article>`;
    });
    if (st.filtered.length > max) {
      items.push(`<div class="empty-state">Showing first ${max}. Type more to narrow down.</div>`);
    }
    if (!items.length) items.push('<div class="empty-state">No message matches this ID or name.</div>');
    ui.list.innerHTML = items.join("");
  }

  // ---------- bit math ----------
  function signalBits(sig) {
    // Returns bit positions (byte*8 + bitInByte) ordered from MSB to LSB of the value.
    const bits = [];
    if (sig.o === 1) {
      for (let i = sig.l - 1; i >= 0; i -= 1) bits.push(sig.b + i);
    } else {
      let b = sig.b;
      for (let i = 0; i < sig.l; i += 1) {
        bits.push(b);
        b = b % 8 === 0 ? b + 15 : b - 1;
      }
    }
    return bits;
  }

  function parsePayload(text) {
    const clean = String(text || "").replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
    if (!clean) return null;
    const bytes = [];
    for (let i = 0; i + 1 < clean.length + 1; i += 2) {
      const pair = clean.slice(i, i + 2);
      if (pair.length) bytes.push(parseInt(pair.padEnd(2, "0"), 16));
    }
    return bytes;
  }

  function decode(sig, bytes) {
    let raw = 0n;
    for (const b of signalBits(sig)) {
      const byte = bytes[b >> 3] ?? 0;
      raw = (raw << 1n) | BigInt((byte >> (b & 7)) & 1);
    }
    if (sig.sg && sig.l > 0 && raw & (1n << BigInt(sig.l - 1))) raw -= 1n << BigInt(sig.l);
    const rawNum = Number(raw);
    const phys = rawNum * (Number(sig.f) || 1) + (Number(sig.of) || 0);
    const label = (sig.v || []).find((p) => Number(p[0]) === rawNum);
    return { raw: rawNum, phys, label: label ? label[1] : "" };
  }

  // ---------- detail ----------
  function signalColor(i) {
    const h = (i * 137.508 + 18) % 360;
    return `hsl(${h.toFixed(0)} 42% 36%)`;
  }

  function currentEntry() {
    if (!st.current) return null;
    return st.current.entries.find((e) => e.file.key === st.fileKey) || st.current.entries[0];
  }

  function visibleSignals(msg) {
    const muxer = msg.s.find((s) => s.M && s.m === undefined) || msg.s.find((s) => s.M);
    const muxValues = [...new Set(msg.s.filter((s) => s.m !== undefined).map((s) => s.m))].sort((a, b) => a - b);
    let mux = null;
    if (muxValues.length) {
      const bytes = parsePayload(st.payload);
      if (bytes && muxer) {
        const fromPayload = decode(muxer, bytes).raw;
        if (muxValues.includes(fromPayload)) st.mux = fromPayload;
      }
      mux = muxValues.includes(st.mux) ? st.mux : muxValues[0];
      st.mux = mux;
    }
    const sigs = msg.s.filter((s) => s.m === undefined || s.m === mux);
    return { sigs, muxer, muxValues, mux };
  }

  function openGroup(g, preferredFile, { mobile = true } = {}) {
    const changed = st.current !== g;
    st.current = g;
    const keys = g.entries.map((e) => e.file.key);
    st.fileKey = keys.includes(preferredFile) ? preferredFile : keys.includes(ui.file.value) ? ui.file.value : keys[0];
    if (changed) {
      st.mux = null;
      st.selectedSignal = "";
    }
    renderDetail();
    ui.list.querySelectorAll(".frame-item").forEach((el) => el.classList.toggle("active", el.dataset.gkey === g.key));
    updateUrlForMessage();
    if (mobile && typeof openMobileDetail === "function") openMobileDetail();
  }

  function renderDetail() {
    const entry = currentEntry();
    if (!entry) return;
    const { msg, file } = entry;
    const g = st.current;
    const { sigs, muxer, muxValues, mux } = visibleSignals(msg);
    const bytes = parsePayload(st.payload);
    const dlc = Math.max(1, msg.dlc || 8);

    ui.title.textContent = `${msg.n} (${hex(msg.id, 3)})`;
    ui.subtitle.textContent =
      `ID ${msg.id} dec · ${dlc} bytes · ${file.file}` + (file.eth ? " · Ethernet-side ID, not the CAN ID" : "");

    if (!st.selectedSignal || !sigs.some((s) => s.n === st.selectedSignal)) {
      const withValues = sigs.find((s) => s.v && s.v.length && !s.M);
      st.selectedSignal = (withValues || sigs[0] || {}).n || "";
    }

    // colour + cell ownership
    const colorOf = new Map();
    msg.s.forEach((s, i) => colorOf.set(s.n, signalColor(i)));
    const owner = new Array(dlc * 8).fill(null);
    const overlap = new Set();
    const firstCell = new Map();
    for (const s of sigs) {
      const bits = signalBits(s);
      let first = null;
      for (const b of bits) {
        if (b < 0 || b >= dlc * 8) continue;
        if (owner[b] && owner[b] !== s) overlap.add(b);
        else owner[b] = s;
        const pos = (b >> 3) * 8 + (7 - (b & 7)); // reading order
        if (first === null || pos < first) first = pos;
      }
      firstCell.set(s.n, first);
    }

    // file switcher
    const fileChips =
      g.entries.length > 1
        ? `<div class="dbc-files">${g.entries
            .map(
              (e) =>
                `<button type="button" class="dbc-file-btn${e.file.key === file.key ? " active" : ""}" data-file="${esc(e.file.key)}">${esc(e.file.label)}</button>`
            )
            .join("")}</div>`
        : "";

    const meta = [
      `<span class="chip">ID: <code>${hex(msg.id, 3)}</code> / <code>${msg.id}</code>${msg.x ? " ext" : ""}</span>`,
      `<span class="chip">DLC: <code>${msg.dlc}</code></span>`,
      `<span class="chip">Signals: <code>${msg.s.length}</code></span>`,
      msg.tx
        ? `<span class="chip">TX: <code>${esc(msg.tx)}</code>${file.nodes[msg.tx] ? ` · ${esc(file.nodes[msg.tx])}` : ""}</span>`
        : "",
      msg.fd ? `<span class="chip">CAN FD</span>` : "",
      msg.cy ? `<span class="chip">Cycle: <code>${msg.cy} ms</code></span>` : "",
      `<span class="chip">File: <code>${esc(file.file)}</code></span>`,
    ].join("");

    const muxBox = muxValues.length
      ? `<label class="field dbc-mux">
          <span>Multiplexor ${muxer ? `<code>${esc(muxer.n)}</code>` : ""} value</span>
          <select id="dbc-mux">${muxValues
            .map((v) => `<option value="${v}"${v === mux ? " selected" : ""}>m${v} (${hex(v)}) · ${msg.s.filter((s) => s.m === v).length} signals</option>`)
            .join("")}</select>
        </label>`
      : "";

    // grid
    let grid = `<div class="bit-grid" style="--rows:${dlc}">
      <div class="bg-corner">Start Bit:<br><span>BITS &rarr;</span></div>`;
    for (let c = 7; c >= 0; c -= 1) grid += `<div class="bg-colhead">${c}</div>`;
    for (let row = 0; row < dlc; row += 1) {
      grid += `<div class="bg-rowhead">${row}</div>`;
      let col = 0;
      while (col < 8) {
        const bit = row * 8 + (7 - col);
        const s = owner[bit];
        let span = 1;
        while (col + span < 8 && owner[row * 8 + (7 - (col + span))] === s && s) span += 1;
        const nums = [];
        for (let k = 0; k < span; k += 1) {
          const b = row * 8 + (7 - (col + k));
          nums.push(`<i class="${overlap.has(b) ? "ov" : ""}">${b}</i>`);
        }
        if (s) {
          const isFirst = firstCell.get(s.n) === row * 8 + col;
          const sel = s.n === st.selectedSignal ? " selected" : "";
          grid += `<button type="button" class="bg-seg${sel}" data-sig="${esc(s.n)}" title="${esc(s.n)}"
              style="grid-column: span ${span}; background-color:${colorOf.get(s.n)}">
              <span class="bg-nums">${nums.join("")}</span>
              <span class="bg-label">${isFirst ? esc(s.n) : ""}</span>
            </button>`;
        } else {
          grid += `<div class="bg-seg empty"><span class="bg-nums">${nums.join("")}</span></div>`;
        }
        col += span;
      }
    }
    grid += "</div>";
    const byteLetters = `<div class="bg-bytes-label" aria-hidden="true">${"BYTES".split("").map((c) => `<span>${c}</span>`).join("")}</div>`;

    // selected signal
    const sel = msg.s.find((s) => s.n === st.selectedSignal);
    let selHtml = "";
    if (sel) {
      const dec = bytes ? decode(sel, bytes) : null;
      const props = [
        ["Start bit", sel.b],
        ["Length", `${sel.l} bit${sel.l === 1 ? "" : "s"}`],
        ["Byte order", sel.o === 1 ? "Intel (little endian)" : "Motorola (big endian)"],
        ["Type", sel.sg ? "Signed" : "Unsigned"],
        ["Factor", sel.f],
        ["Offset", sel.of],
        ["Min / Max", `${sel.mn} / ${sel.mx}`],
        ["Unit", sel.u || "-"],
        sel.rx ? ["Receivers", sel.rx] : null,
        sel.M ? ["Multiplexing", "Multiplexor"] : sel.m !== undefined ? ["Multiplexing", `m${sel.m}`] : null,
        sel.cf !== undefined ? ["Confidence", CONFIDENCE[sel.cf] || sel.cf] : null,
        sel.sna !== undefined ? ["SNA (not available)", `raw ${sel.sna}`] : null,
        sel.c ? ["Comment", sel.c] : null,
        dec ? ["Decoded", `${dec.label ? dec.label + " · " : ""}${formatPhys(dec.phys)}${sel.u ? " " + sel.u : ""} (raw ${dec.raw})`] : null,
      ].filter(Boolean);
      const vals = sel.v || [];
      const digits = Math.max(2, Math.ceil(sel.l / 4));
      selHtml = `<div class="dbc-sel">
        <h3><span class="swatch" style="background:${colorOf.get(sel.n)}"></span>${esc(sel.n)}</h3>
        <dl class="dbc-props">${props.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
        <h4>Value Table</h4>
        ${
          vals.length
            ? `<div class="dbc-vt-wrap"><table class="values-table dbc-vt">
            <thead><tr><th>#</th><th>Value</th><th>Dec</th><th>Description</th></tr></thead>
            <tbody>${vals
              .map(
                ([v, label], i) =>
                  `<tr class="${dec && Number(v) === dec.raw ? "hit" : ""}"><td>${i + 1}</td><td><code>${typeof v === "number" ? hex(v, digits) : esc(v)}</code></td><td><code>${esc(v)}</code></td><td>${esc(label)}</td></tr>`
              )
              .join("")}</tbody></table></div>`
            : '<div class="empty-state">No value table for this signal.</div>'
        }
      </div>`;
    }

    // all signals table
    const sorted = [...sigs].sort((a, b) => {
      const fa = firstCell.get(a.n) ?? 999;
      const fb = firstCell.get(b.n) ?? 999;
      return fa - fb;
    });
    const sigRows = sorted
      .map((s) => {
        const d = bytes ? decode(s, bytes) : null;
        return `<tr class="dbc-sig-row${s.n === st.selectedSignal ? " active" : ""}" data-sig="${esc(s.n)}">
          <td><span class="swatch" style="background:${colorOf.get(s.n)}"></span>${esc(s.n)}${s.M ? ' <em class="mux-tag">M</em>' : s.m !== undefined ? ` <em class="mux-tag">m${s.m}</em>` : ""}${s.cf !== undefined ? ` <em class="cf-tag cf-${esc(s.cf)}" title="Confidence">${esc(CONFIDENCE[s.cf] || s.cf)}</em>` : ""}</td>
          <td>${s.b}</td><td>${s.l}</td><td>${s.o === 1 ? "Intel" : "Motorola"}</td>
          <td>${esc(s.f)}</td><td>${esc(s.of)}</td><td>${esc(s.u || "")}</td>
          <td>${s.v ? s.v.length : ""}</td>
          ${bytes ? `<td class="dec">${d.label ? esc(d.label) + " · " : ""}${esc(formatPhys(d.phys))}</td>` : ""}
        </tr>`;
      })
      .join("");

    ui.detail.innerHTML = `
      ${fileChips}
      <div class="chips">${meta}</div>
      ${msg.c ? `<p class="dbc-comment">${esc(msg.c)}</p>` : ""}
      <div class="dbc-tools">
        ${muxBox}
        <label class="field dbc-payload">
          <span>Decode payload (hex bytes, optional)</span>
          <input id="dbc-payload" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false"
            placeholder="${"00 ".repeat(Math.min(dlc, 8)).trim()}" value="${esc(st.payload)}" />
        </label>
      </div>
      <div class="bit-grid-wrap">${byteLetters}${grid}</div>
      ${selHtml}
      <h4 class="dbc-h">Signals${muxValues.length ? ` (m${mux} + common)` : ""}</h4>
      <div class="signal-table-wrap"><table class="signal-table dbc-sig-table">
        <thead><tr><th>Name</th><th>Start</th><th>Len</th><th>Order</th><th>Factor</th><th>Offset</th><th>Unit</th><th>Values</th>${bytes ? "<th>Decoded</th>" : ""}</tr></thead>
        <tbody>${sigRows}</tbody>
      </table></div>`;
  }

  function formatPhys(v) {
    if (!Number.isFinite(v)) return String(v);
    return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
  }

  // ---------- events ----------
  ui.tabs.forEach((t) =>
    t.addEventListener("click", () => {
      setView(t.dataset.view);
      window.scrollTo(0, 0);
    })
  );

  ui.search.addEventListener("input", () => {
    clearTimeout(st.searchTimer);
    st.searchTimer = setTimeout(applySearch, 120);
  });
  ui.search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(st.searchTimer);
    applySearch();
    const top = st.filtered[0];
    if (top) {
      ui.search.blur();
      openGroup(top, ui.file.value);
    }
  });
  ui.file.addEventListener("change", applySearch);

  ui.list.addEventListener("click", (e) => {
    const item = e.target.closest("[data-gkey]");
    if (!item) return;
    const g = st.groupByKey.get(item.dataset.gkey);
    if (g) openGroup(g, ui.file.value);
  });

  ui.detail.addEventListener("click", (e) => {
    const fileBtn = e.target.closest("[data-file]");
    if (fileBtn) {
      st.fileKey = fileBtn.dataset.file;
      st.mux = null;
      renderDetail();
      updateUrlForMessage();
      return;
    }
    const sigEl = e.target.closest("[data-sig]");
    if (sigEl) {
      st.selectedSignal = sigEl.dataset.sig;
      const y = window.scrollY;
      const inTable = !!sigEl.closest(".dbc-sig-table");
      renderDetail();
      if (inTable) {
        const grid = ui.detail.querySelector(".bit-grid-wrap");
        if (grid) grid.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        window.scrollTo(0, y);
      }
    }
  });

  ui.detail.addEventListener("change", (e) => {
    if (e.target.id === "dbc-mux") {
      st.mux = Number(e.target.value);
      st.selectedSignal = "";
      renderDetail();
    }
  });

  let payloadTimer = null;
  ui.detail.addEventListener("input", (e) => {
    if (e.target.id !== "dbc-payload") return;
    st.payload = e.target.value;
    clearTimeout(payloadTimer);
    payloadTimer = setTimeout(() => {
      const caret = e.target.selectionStart;
      renderDetail();
      const inp = $("dbc-payload");
      if (inp) {
        inp.focus();
        try {
          inp.setSelectionRange(caret, caret);
        } catch (_) {}
      }
    }, 250);
  });

  if (ui.back) {
    ui.back.addEventListener("click", () => {
      if (history.state && history.state.mobileDetail) history.back();
      else if (typeof closeMobileDetail === "function") closeMobileDetail();
    });
  }

  // Link from the Frames view: "Bit layout (DBC)"
  document.addEventListener("click", async (e) => {
    const link = e.target.closest("[data-dbc-id]");
    if (!link) return;
    const id = Number(link.dataset.dbcId);
    setView("dbc", { push: false });
    window.scrollTo(0, 0);
    await ensureLoaded();
    ui.search.value = id.toString(16).toUpperCase();
    applySearch();
    const g = st.groupByKey.get(groupKey(id, 0));
    if (g) openGroup(g, "");
  });

  // initial view from URL
  if (new URLSearchParams(location.search).get("view") === "dbc") {
    setView("dbc");
  }

  window.openDbcView = (id) => {
    setView("dbc");
    if (id !== undefined) {
      ensureLoaded().then(() => {
        ui.search.value = String(id);
        applySearch();
      });
    }
  };
})();
