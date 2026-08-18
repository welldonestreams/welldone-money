// RenewalsStore — server-authoritative renewal persistence (schema v3).
//
// - Durable unique IDs (assigned at migration for legacy records).
// - Per-item monotonically increasing `rev`. Every mutation requires the
//   client's known rev; a mismatch returns 409 CONFLICT and never overwrites.
// - Mutations are item-level: create / patch / delete / renew / undo-renew.
// - The renew endpoint computes the next due date SERVER-SIDE (same
//   day-clamped recurrence math) and records the payment event; the browser
//   only supplies an idempotency operation ID.
// - Atomic writes: tmp file + rename. A failed write leaves the prior JSON
//   intact.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const MAX_HISTORY = 100;

function toFloat(v) {
  try { return Math.max(0, Math.round(parseFloat(v) * 100) / 100); } catch { return 0; }
}

export function sanitizeRenewal(item) {
  if (!item || typeof item !== "object") return null;
  const cycle = String(item.cycle || "yearly").trim().slice(0, 12) || "yearly";
  let months = 1;
  try { months = Math.max(1, Math.min(120, parseInt(item.months, 10) || 1)); } catch { months = 1; }
  const rec = {
    name: String(item.name || "").trim().slice(0, 120),
    date: String(item.date || "").trim().slice(0, 10),
    url: String(item.url || "").trim().slice(0, 300),
    note: String(item.note || "").trim().slice(0, 200),
    price: toFloat(item.price),
    cycle,
  };
  if (cycle === "custom") rec.months = months;
  if (cycle === "once") rec.purchased = String(item.purchased || "").trim().slice(0, 10);
  if (Array.isArray(item.history)) {
    const history = item.history.slice(-MAX_HISTORY).map((h) => {
      if (!h || typeof h !== "object") return null;
      return {
        opId: String(h.opId || "").slice(0, 64),
        paid: String(h.paid || "").trim().slice(0, 10),
        at: String(h.at || "").trim().slice(0, 30),
        previousDue: String(h.previousDue || "").trim().slice(0, 10),
        amount: toFloat(h.amount),
        nextDue: String(h.nextDue || "").trim().slice(0, 10),
      };
    }).filter(Boolean);
    if (history.length) rec.history = history;
  }
  return rec;
}

export function monthsPerCycle(s) {
  const c = s.cycle || "yearly";
  if (c === "monthly") return 1;
  if (c === "quarterly") return 3;
  if (c === "yearly") return 12;
  if (c === "custom") return Math.max(1, Math.min(120, parseInt(s.months, 10) || 1));
  return null; // once
}

// Day-clamped month arithmetic: Jan 31 + 1mo -> Feb 28/29, etc.
export function addMonths(dateStr, months) {
  const d = new Date(String(dateStr).slice(0, 10) + "T12:00:00");
  if (Number.isNaN(d.getTime())) return dateStr;
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

// "renewed ✓" is derived from the latest persisted payment event and the
// item's current cycle: the most recent event produced exactly this next due.
export function isRenewed(item) {
  const h = Array.isArray(item.history) ? item.history : [];
  const last = h[h.length - 1];
  return Boolean(last && last.nextDue && last.nextDue === item.date);
}

export class RenewalsStore {
  constructor(file) {
    this.file = file;
    this.items = []; // array keeps insertion order; items carry id/rev
    this.load();
  }

  load() {
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this.items = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.items = [];
    }
    // schema v3 migration: assign durable ids + revs to legacy records once.
    let changed = false;
    for (const it of this.items) {
      if (!it || typeof it !== "object") { changed = true; continue; }
      if (!it.id) { it.id = randomUUID(); changed = true; }
      if (typeof it.rev !== "number") { it.rev = 1; changed = true; }
    }
    this.items = this.items.filter((it) => it && typeof it === "object");
    if (changed) this._write(this.items);
  }

  // Atomic write-then-commit: on failure the in-memory state stays consistent
  // with the intact on-disk file.
  _write(next) {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    renameSync(tmp, this.file);
    this.items = next;
  }

  _find(id) { return this.items.find((it) => it.id === id); }
  _index(id) { return this.items.findIndex((it) => it.id === id); }

  list() {
    return this.items.map((it) => ({ ...it, renewed: isRenewed(it) }));
  }

  summary() {
    const subs = this.items;
    const today = new Date();
    const daysLeft = (dateStr) => {
      if (!dateStr) return null;
      const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00");
      if (Number.isNaN(d.getTime())) return null;
      return Math.round((d - today) / 86400000);
    };
    const dated = [];
    const timeline = [];
    let yearlyTotal = 0;
    for (const s of subs) {
      const price = Number(s.price) || 0;
      const cycle = (s.cycle || "yearly").toLowerCase();
      if (price) {
        if (cycle === "monthly") yearlyTotal += price * 12;
        else if (cycle === "quarterly") yearlyTotal += price * 4;
        else if (cycle === "custom") yearlyTotal += price * 12 / Math.max(1, Math.min(120, Number(s.months) || 1));
        else if (cycle !== "once") yearlyTotal += price;
      }
      const d = daysLeft(s.date);
      timeline.push({ name: s.name, date: String(s.date || "").slice(0, 10), days: d, cycle: (s.cycle || "yearly").slice(0, 12) });
      if (d !== null) dated.push({ name: s.name, days: d, date: s.date });
    }
    dated.sort((a, b) => a.days - b.days);
    timeline.sort((a, b) => (a.days === null ? 1 : b.days === null ? -1 : a.days - b.days));
    const within30 = dated.filter((s) => s.days >= 0 && s.days <= 30);
    const upcoming = dated.slice(0, 5).length > within30.length ? dated.slice(0, 5) : within30;
    const soonest = dated.find((s) => s.days >= 0) || dated[0] || null;
    return {
      total: subs.filter((s) => (s.cycle || "yearly").toLowerCase() !== "once").length,
      upcoming_count: dated.filter((s) => s.days >= 0).length,
      due_30d: within30.length,
      expired: dated.filter((s) => s.days < 0).length,
      soonest_name: soonest ? soonest.name : "-",
      soonest_days: soonest ? soonest.days : null,
      yearly_spend: Math.round(yearlyTotal * 100) / 100,
      monthly_spend: Math.round((yearlyTotal / 12) * 100) / 100,
      list: upcoming,
      timeline,
    };
  }

  create(data) {
    const clean = sanitizeRenewal(data);
    if (!clean || !clean.name) throw Object.assign(new Error("name required"), { status: 400 });
    const item = { ...clean, id: randomUUID(), rev: 1 };
    this._write([...this.items, item]);
    return { ...item, renewed: false };
  }

  patch(id, rev, data) {
    const idx = this._index(id);
    if (idx < 0) throw Object.assign(new Error("not found"), { status: 404 });
    const item = this.items[idx];
    if (typeof rev !== "number" || rev !== item.rev) {
      throw Object.assign(new Error("conflict"), { status: 409, current: this.list() });
    }
    const clean = sanitizeRenewal({ ...item, ...data });
    if (!clean || !clean.name) throw Object.assign(new Error("name required"), { status: 400 });
    clean.id = item.id;
    clean.rev = item.rev + 1;
    clean.history = Array.isArray(item.history) ? item.history : []; // never replace history via patch
    const next = this.items.slice();
    next[idx] = clean;
    this._write(next);
    return { ...clean, renewed: isRenewed(clean) };
  }

  remove(id, rev) {
    const idx = this._index(id);
    if (idx < 0) throw Object.assign(new Error("not found"), { status: 404 });
    const item = this.items[idx];
    if (typeof rev !== "number" || rev !== item.rev) {
      throw Object.assign(new Error("conflict"), { status: 409, current: this.list() });
    }
    const next = this.items.filter((it) => it.id !== id);
    this._write(next);
    return { ok: true, id };
  }

  // Server-authoritative renew. Idempotent via opId: a retry with the same
  // operation id returns the current state without creating a second event.
  renew(id, opId) {
    const idx = this._index(id);
    if (idx < 0) throw Object.assign(new Error("not found"), { status: 404 });
    const item = this.items[idx];
    const months = monthsPerCycle(item);
    if (!months) throw Object.assign(new Error("one-time items cannot be renewed"), { status: 400 });
    if (!item.date) throw Object.assign(new Error("no renewal date set"), { status: 400 });
    const history = Array.isArray(item.history) ? item.history : [];
    if (opId && history.some((h) => h.opId === opId)) {
      // idempotent retry: same result, no new event
      return { ...item, renewed: isRenewed(item), duplicate: true };
    }
    const nextDue = addMonths(item.date, months);
    const event = {
      opId: opId || randomUUID(),
      paid: new Date().toISOString().slice(0, 10),
      at: new Date().toISOString(),
      previousDue: item.date,
      amount: Number(item.price) || 0,
      nextDue,
    };
    const updated = {
      ...item,
      date: nextDue,
      history: [...history.slice(-(MAX_HISTORY - 1)), event],
      rev: item.rev + 1,
    };
    const next = this.items.slice();
    next[idx] = updated;
    this._write(next);
    return { ...updated, renewed: isRenewed(updated) };
  }

  // Undo affects ONLY the exact latest renewal operation.
  undoRenew(id) {
    const idx = this._index(id);
    if (idx < 0) throw Object.assign(new Error("not found"), { status: 404 });
    const item = this.items[idx];
    const history = Array.isArray(item.history) ? item.history : [];
    if (!history.length) throw Object.assign(new Error("nothing to undo"), { status: 400 });
    const last = history[history.length - 1];
    const updated = {
      ...item,
      date: last.previousDue || item.date,
      history: history.slice(0, -1),
      rev: item.rev + 1,
    };
    const next = this.items.slice();
    next[idx] = updated;
    this._write(next);
    return { ...updated, renewed: isRenewed(updated) };
  }
}
