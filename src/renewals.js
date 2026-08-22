// Renewals — ported from the standalone Renewals app into WellDone Money.
// Feature parity: add / edit / delete / edit-all drawer, export & import backup,
// "Load my services" seed, spend totals, upcoming grouping, timeline, urgency
// badges, custom-month and one-time cycles. Data is durable server-side via
// GET/PUT /api/renewals (never only in localStorage).
let subs = [];

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function safeHttpUrl(value) {
  try { const url = new URL(String(value || "")); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : ""; }
  catch { return ""; }
}
function money(n) { return "$" + Number(n || 0).toFixed(2); }
function daysLeft(dateStr) {
  if (!dateStr) return null;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00");
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((d - now) / 86400000);
}
function stateFor(d) { if (d === null) return "lifetime"; if (d < 0) return "expired"; if (d <= 14) return "urgent"; if (d <= 45) return "soon"; return "ok"; }
function fmtDate(s) { if (!s) return ""; return new Date(String(s).slice(0, 10) + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
function monthsPerCycle(s) {
  const c = s.cycle || "yearly";
  if (c === "monthly") return 1;
  if (c === "quarterly") return 3;
  if (c === "yearly") return 12;
  if (c === "custom") return Math.max(1, parseInt(s.months, 10) || 1);
  return null;
}
function lifetimeMonths(s) {
  const start = s.purchased;
  if (!start) return 1;
  const d = new Date(String(start).slice(0, 10) + "T00:00:00");
  const now = new Date();
  return Math.max(1, (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth()) + 1);
}
function monthlyAverage(s) {
  const p = Number(s.price || 0);
  if (!p) return 0;
  if ((s.cycle || "yearly") === "once") return p / lifetimeMonths(s);
  return p / monthsPerCycle(s);
}
function yearlyOf(s) { if ((s.cycle || "yearly") === "once") return 0; return monthlyAverage(s) * 12; }
function renewalLabel(s) {
  const c = s.cycle || "yearly";
  if (c === "once") return `Lifetime (${money(s.price)})`;
  const m = monthsPerCycle(s);
  return `${m === 1 ? "Monthly" : `Every ${m} months`} (${money(s.price)})`;
}

async function load() {
  const list = $("rn-list");
  list.innerHTML = `<div class="rn-empty">Loading renewals…</div>`;
  try {
    const r = await fetch("/api/renewals", { credentials: "same-origin" });
    if (!r.ok) throw new Error("http " + r.status);
    subs = await r.json();
    if (!Array.isArray(subs)) subs = [];
  } catch (e) {
    subs = [];
    list.innerHTML = `<div class="rn-empty"><b>Could not load renewals.</b><br>Check the bridge connection and try again.</div>`;
    return;
  }
  render();
}

// Server-authoritative item operations. A 409 (stale revision) never
// overwrites: refresh the list and surface the conflict.
async function apiMutate(path, method, body) {
  const r = await fetch(path, {
    method, credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 409) {
    const d = await r.json().catch(() => ({}));
    if (Array.isArray(d.current)) subs = d.current;
    render();
    toast("Changed elsewhere — list refreshed, review and retry");
    throw new Error("conflict");
  }
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || ("http " + r.status));
  }
  return r.json();
}

function cycleShort(s) {
  const c = s.cycle || "yearly";
  if (c === "once") return "lifetime";
  if (c === "monthly") return "mo";
  if (c === "quarterly") return "qtr";
  if (c === "yearly") return "yr";
  return `${Math.max(1, parseInt(s.months, 10) || 1)} mo`;
}
function badgeText(d) {
  if (d === null) return "Lifetime";
  if (d < 0) return "Expired";
  if (d === 0) return "Today";
  return `${d}d`;
}

function toast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3500);
}

// Advance a YYYY-MM-DD date by N months, clamping the day to the target month.
function addMonths(dateStr, months) {
  const d = new Date(String(dateStr).slice(0, 10) + "T12:00:00");
  if (Number.isNaN(d.getTime())) return dateStr;
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

// Mark paid: the SERVER computes the next due date, records the payment
// event, and bumps the revision. The browser only supplies an idempotency
// operation ID so retries cannot double-pay.
let renewing = new Set();
let lastRenewal = null; // { id }
let undoHideTimer = null;

async function renewSub(i) {
  if (renewing.has(i)) return;
  const s = subs[i];
  if (!s || !s.id) return;
  renewing.add(i);
  const btn = document.querySelector(`.rn-renew[data-renew="${i}"]`);
  if (btn) { btn.disabled = true; btn.classList.add("rn-renew--busy"); }
  try {
    const opId = crypto.randomUUID();
    const updated = await apiMutate(`/api/renewals/${s.id}/renew`, "POST", { opId });
    subs[i] = updated;
    lastRenewal = { id: s.id };
    render();
    showUndo(updated.name);
    const h = Array.isArray(updated.history) ? updated.history : [];
    const last = h[h.length - 1];
    toast(last ? `Paid ${fmtDate(last.paid)} — next renewal ${fmtDate(last.nextDue)}` : "Marked paid");
  } catch (e) {
    if (e.message !== "conflict") toast("Could not save — try again");
  } finally {
    renewing.delete(i);
  }
}

function showUndo(name) {
  const el = document.getElementById("rn-undo");
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `↶ Undo (${esc(name)})`;
  clearTimeout(undoHideTimer);
  undoHideTimer = setTimeout(hideUndo, 10000);
}
function hideUndo() {
  const el = document.getElementById("rn-undo");
  if (el) el.hidden = true;
}
async function undoLast() {
  if (!lastRenewal) return;
  const id = lastRenewal.id;
  lastRenewal = null;
  hideUndo();
  try {
    const updated = await apiMutate(`/api/renewals/${id}/undo-renew`, "POST", {});
    const idx = subs.findIndex((s) => s.id === id);
    if (idx >= 0) subs[idx] = updated;
    render();
    toast("Renewal undone");
  } catch (e) {
    if (e.message !== "conflict") toast("Could not undo — try again");
  }
}

// "renew?" (pale, not yet paid this cycle) vs "renewed" (dark green, already
// paid for the current due date — the last payment produced this next due).
function renewState(s) {
  return s.renewed ? "done" : "idle";
}

function render() {
  const spend = $("rn-spend");
  const summary = $("rn-summary");
  const list = $("rn-list");
  const timeline = $("rn-timeline");

  const yr = subs.reduce((a, s) => a + yearlyOf(s), 0);
  spend.innerHTML = yr > 0 ? `Spend: <b>${money(yr)}</b>/yr · <b>${money(yr / 12)}</b>/mo` : "";

  if (!subs.length) {
    list.innerHTML = `<div class="rn-empty"><b>Nothing tracked yet.</b><br>Add a subscription, or open the ☰ menu → “Load my services”.</div>`;
    summary.textContent = "No subscriptions tracked.";
    timeline.innerHTML = "";
    return;
  }
  const wd = subs.map((s, i) => ({ ...s, _i: i, _d: daysLeft(s.date) }));
  wd.sort((a, b) => { if (a._d === null) return 1; if (b._d === null) return -1; return a._d - b._d; });

  const dated = wd.filter((s) => s._d !== null);
  const within30 = dated.filter((s) => s._d >= 0 && s._d <= 30);
  const upcoming = (dated.slice(0, 5).length > within30.length ? dated.slice(0, 5) : within30);
  const due30 = within30.length;
  const expired = dated.filter((s) => s._d < 0).length;
  summary.innerHTML =
    `<span>${subs.length} tracked</span><span class="rn-pill rn-pill--soon">${due30} due in 30d</span>` +
    (expired ? `<span class="rn-pill rn-pill--urgent">${expired} expired</span>` : "");

  list.innerHTML = upcoming.map((s) => `
    <div class="rn-card" data-i="${s._i}">
      <div class="rn-card-main" data-edit="${s._i}">
        <strong>${esc(s.name)}</strong>
        <span class="rn-note">${s.note ? esc(s.note) : ""}${safeHttpUrl(s.url) ? ` <a href="${esc(safeHttpUrl(s.url))}" target="_blank" rel="noopener noreferrer">↗</a>` : ""}</span>
        <span class="rn-meta">${s.date ? fmtDate(s.date) : "No date"} · ${renewalLabel(s)}</span>
        ${Array.isArray(s.history) && s.history.length ? `<span class="rn-paid">Paid ${fmtDate(s.history[s.history.length - 1].paid)}</span>` : ""}
      </div>
      <div class="rn-card-side">
        <span class="rn-price">${money(s.price)}</span>
        <span class="rn-cadence">${cycleShort(s)}</span>
        <div class="rn-badge-row">
          <span class="rn-badge rn-badge--${stateFor(s._d)}">${badgeText(s._d)}</span>
          <button type="button" class="rn-renew rn-renew--${renewState(s)}" data-renew="${s._i}" title="Mark paid and advance one cycle">${renewState(s) === "done" ? "renewed ✓" : "renew?"}</button>
        </div>
      </div>
    </div>`).join("");

  timeline.innerHTML = wd.map((s) => `
    <div class="rn-timeline-row" data-edit="${s._i}">
      <span class="rn-timeline-dot rn-dot--${stateFor(s._d)}"></span>
      <span class="rn-timeline-name">${esc(s.name)}</span>
      <span class="rn-timeline-date">${s.date ? fmtDate(s.date) : "—"}</span>
      <span class="rn-timeline-days">${s._d === null ? "·" : s._d < 0 ? `${Math.abs(s._d)}d ago` : s._d === 0 ? "today" : `${s._d}d`}</span>
    </div>`).join("");

  list.querySelectorAll("[data-edit]").forEach((el) => el.addEventListener("click", () => editSub(Number(el.dataset.edit))));
  timeline.querySelectorAll("[data-edit]").forEach((el) => el.addEventListener("click", () => editSub(Number(el.dataset.edit))));
  list.querySelectorAll(".rn-renew").forEach((el) => el.addEventListener("click", (e) => { e.stopPropagation(); renewSub(Number(el.dataset.renew)); }));
}

// ---- modal ----
function toggleBillingFields() {
  const c = $("rn-fCycle").value;
  $("rn-fMonthsWrap").hidden = c !== "custom";
  $("rn-fPurchasedWrap").hidden = c !== "once";
}
function openLayer(id) {
  const layer = $(id);
  layer.hidden = false;
  requestAnimationFrame(() => layer.classList.add("open"));
}
function closeLayer(id) {
  const layer = $(id);
  layer.classList.remove("open");
  window.setTimeout(() => { if (!layer.classList.contains("open")) layer.hidden = true; }, 220);
}
function openModal() { openLayer("rn-overlay"); }
function closeModal() { closeLayer("rn-overlay"); }
function openAdd() {
  $("rn-modal-title").textContent = "Add subscription";
  $("rn-edit-id").value = "";
  ["rn-fName", "rn-fDate", "rn-fUrl", "rn-fNote", "rn-fPrice"].forEach((id) => ($(id).value = ""));
  $("rn-fCycle").value = "yearly";
  $("rn-fMonths").value = "6";
  $("rn-fPurchased").value = new Date().toISOString().slice(0, 10);
  $("rn-del").hidden = true;
  toggleBillingFields();
  renderHistory({ history: [] });
  openModal();
  $("rn-fName").focus();
}
function editSub(i) {
  const s = subs[i];
  $("rn-modal-title").textContent = "Edit subscription";
  $("rn-edit-id").value = i;
  $("rn-fName").value = s.name || "";
  $("rn-fDate").value = s.date || "";
  $("rn-fUrl").value = s.url || "";
  $("rn-fNote").value = s.note || "";
  $("rn-fPrice").value = s.price || "";
  $("rn-fCycle").value = s.cycle || "yearly";
  $("rn-fMonths").value = Math.max(1, parseInt(s.months, 10) || 1);
  $("rn-fPurchased").value = s.purchased || new Date().toISOString().slice(0, 10);
  $("rn-del").hidden = false;
  toggleBillingFields();
  renderHistory(s);
  openModal();
  $("rn-fName").focus();
}
function renderHistory(s) {
  const box = $("rn-history");
  const h = Array.isArray(s.history) ? s.history : [];
  if (!h.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="rn-history-head">Payment history</div>` +
    h.slice(-5).reverse().map((e) => `
      <div class="rn-history-row">
        <span class="rn-history-paid">Paid ${fmtDate(e.paid)}</span>
        <span class="rn-history-due">${e.previousDue ? `due ${fmtDate(e.previousDue)}` : ""} → next ${fmtDate(e.nextDue)}</span>
        <span class="rn-history-amt">${money(e.amount)}</span>
      </div>`).join("");
}
async function saveSub() {
  const name = $("rn-fName").value.trim();
  if (!name) { $("rn-fName").focus(); return; }
  const cycle = $("rn-fCycle").value;
  const months = cycle === "custom" ? Math.min(120, Math.max(1, parseInt($("rn-fMonths").value, 10) || 1)) : undefined;
  const purchased = cycle === "once" ? ($("rn-fPurchased").value || new Date().toISOString().slice(0, 10)) : undefined;
  const rec = {
    name,
    date: $("rn-fDate").value || "",
    url: $("rn-fUrl").value.trim(),
    note: $("rn-fNote").value.trim(),
    price: parseFloat($("rn-fPrice").value) || 0,
    cycle,
    ...(months ? { months } : {}),
    ...(purchased ? { purchased } : {}),
  };
  const idx = $("rn-edit-id").value;
  try {
    if (idx === "") {
      const created = await apiMutate("/api/renewals", "POST", rec);
      subs.push(created);
    } else {
      const existing = subs[Number(idx)];
      const updated = await apiMutate(`/api/renewals/${existing.id}`, "PATCH", { rev: existing.rev, ...rec });
      subs[Number(idx)] = updated;
    }
    closeModal();
    render();
  } catch (e) { /* conflict handled in apiMutate */ }
}
async function delSub() {
  const idx = $("rn-edit-id").value;
  if (idx === "") return;
  const existing = subs[Number(idx)];
  try {
    await apiMutate(`/api/renewals/${existing.id}`, "DELETE", { rev: existing.rev });
    subs.splice(Number(idx), 1);
    closeModal();
    render();
  } catch (e) { /* conflict handled in apiMutate */ }
}

// ---- edit-all drawer overlay ----
function eaRowHtml(s, i) {
  return `<div class="ea-row" data-i="${i}">
    <input class="ea-name" value="${esc(s.name || "")}" placeholder="Name">
    <input class="ea-date" type="date" value="${s.date || ""}">
    <input class="ea-price" type="number" step="0.01" min="0" value="${s.price || ""}" placeholder="0.00">
    <button type="button" class="ea-del" data-del="${i}">✕</button>
  </div>`;
}
function eaRender() {
  $("rn-eaRows").innerHTML = subs.map(eaRowHtml).join("");
  $("rn-eaRows").querySelectorAll(".ea-del").forEach((b) => b.addEventListener("click", () => { subs.splice(Number(b.dataset.del), 1); eaRender(); }));
}
function openEditAll() { eaRender(); openLayer("rn-ea-overlay"); }
function closeEditAll() { closeLayer("rn-ea-overlay"); }
async function saveAll() {
  const rows = [...document.querySelectorAll("#rn-eaRows .ea-row")];
  const rebuilt = rows.map((r) => {
    const i = parseInt(r.dataset.i, 10);
    const old = subs[i] || {};
    return {
      ...old,
      name: r.querySelector(".ea-name").value.trim(),
      date: r.querySelector(".ea-date").value || "",
      price: parseFloat(r.querySelector(".ea-price").value) || 0,
    };
  }).filter((s) => s.name);
  try {
    // deletes: rows that existed and are gone now
    const kept = new Set(rebuilt.filter((s) => s.id).map((s) => s.id));
    for (const old of subs) {
      if (old.id && !kept.has(old.id)) {
        await apiMutate(`/api/renewals/${old.id}`, "DELETE", { rev: old.rev });
      }
    }
    // creates + patches
    const next = [];
    for (const row of rebuilt) {
      if (row.id) {
        if (row.name !== row.name || row.date !== row.date || row.price !== row.price) { /* noop */ }
        const updated = await apiMutate(`/api/renewals/${row.id}`, "PATCH", { rev: row.rev, name: row.name, date: row.date, price: row.price });
        next.push(updated);
      } else {
        const created = await apiMutate("/api/renewals", "POST", { name: row.name, date: row.date, price: row.price, cycle: "yearly", url: "", note: "" });
        next.push(created);
      }
    }
    subs = next;
    closeEditAll();
    render();
    toast("Edit-all saved");
  } catch (e) { /* conflict handled in apiMutate */ }
}

// ---- drawer menu ----
function openDrawer() {
  const drawer = $("rn-drawer");
  const scrim = $("rn-scrim");
  drawer.hidden = false;
  scrim.hidden = false;
  requestAnimationFrame(() => { drawer.classList.add("open"); scrim.classList.add("open"); });
}
function closeDrawer() {
  const drawer = $("rn-drawer");
  const scrim = $("rn-scrim");
  drawer.classList.remove("open");
  scrim.classList.remove("open");
  window.setTimeout(() => {
    if (!drawer.classList.contains("open")) drawer.hidden = true;
    if (!scrim.classList.contains("open")) scrim.hidden = true;
  }, 280);
}
async function seedDefaults() {
  if (subs.length && !confirm("Add your homelab services to the list?")) return;
  const d = [
    { name: "Drunken Slug", url: "https://drunkenslug.com", note: "Usenet indexer" },
    { name: "NZBGeek", url: "https://nzbgeek.info", note: "Usenet indexer" },
    { name: "NZBFinder", url: "https://nzbfinder.ws", note: "Usenet indexer" },
    { name: "Frugal Usenet", url: "https://frugalusenet.com", note: "Usenet provider" },
    { name: "Real-Debrid", url: "https://real-debrid.com", note: "Debrid" },
    { name: "Cloudflare domain", url: "https://dash.cloudflare.com", note: "welldonestreams.com" },
    { name: "Plex Pass", url: "https://plex.tv", note: "Lifetime", cycle: "once" },
  ];
  const have = new Set(subs.map((s) => s.name.toLowerCase()));
  const fresh = d.filter((x) => !have.has(x.name.toLowerCase()));
  for (const x of fresh) {
    try { subs.push(await apiMutate("/api/renewals", "POST", x)); } catch (e) {}
  }
  render();
  closeDrawer();
}
function exportData() {
  const b = new Blob([JSON.stringify(subs, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(b);
  a.download = `renewals-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  closeDrawer();
}
function importData() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".json";
  inp.onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then(async (t) => {
      const d = JSON.parse(t);
      if (Array.isArray(d)) {
        subs = [];
        for (const x of d) {
          try { subs.push(await apiMutate("/api/renewals", "POST", x)); } catch (e) {}
        }
        render();
      }
    }).catch(() => alert("Could not read that file."));
  };
  inp.click();
  closeDrawer();
}

function showRenewals() {
  load();
}

// The "Detected activity" subtab was removed: it restated the same bills the
// Renewals tracker already lists, guessed from transaction history, with no
// action attached to any row.

// ---- wire up ----
$("rn-add").addEventListener("click", openAdd);
$("rn-cancel").addEventListener("click", closeModal);
$("rn-save").addEventListener("click", saveSub);
$("rn-del").addEventListener("click", delSub);
$("rn-overlay").addEventListener("click", (e) => { if (e.target.id === "rn-overlay") closeModal(); });
$("rn-fCycle").addEventListener("change", toggleBillingFields);
$("rn-edit-all").addEventListener("click", openEditAll);
$("rn-ea-cancel").addEventListener("click", closeEditAll);
$("rn-ea-save").addEventListener("click", saveAll);
$("rn-ea-add").addEventListener("click", () => { subs.push({ name: "", date: "", price: 0, cycle: "yearly", url: "", note: "" }); eaRender(); });
$("rn-ea-overlay").addEventListener("click", (e) => { if (e.target.id === "rn-ea-overlay") closeEditAll(); });
$("rn-menu").addEventListener("click", openDrawer);
$("rn-close-drawer").addEventListener("click", closeDrawer);
$("rn-scrim").addEventListener("click", closeDrawer);
$("rn-seed").addEventListener("click", seedDefaults);
$("rn-export").addEventListener("click", exportData);
$("rn-import").addEventListener("click", importData);
$("rn-undo").addEventListener("click", undoLast);
document.addEventListener("wmd:view", (event) => { if (event.detail?.view === "renewals") showRenewals(); });
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeModal();
  closeEditAll();
  closeDrawer();
});
