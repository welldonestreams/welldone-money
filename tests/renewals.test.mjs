// Regression tests for the server-authoritative RenewalsStore (schema v3).
// Run: node --test tests/renewals.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RenewalsStore, addMonths } from "../scripts/renewals-store.mjs";

function freshStore(seed = []) {
  const dir = mkdtempSync(join(tmpdir(), "rn-test-"));
  const file = join(dir, "renewals.json");
  writeFileSync(file, JSON.stringify(seed), "utf8");
  return { store: new RenewalsStore(file), file, dir };
}

const base = { name: "A", date: "2026-09-01", price: 10, cycle: "monthly", url: "", note: "" };

test("1. two stale clients edit different records; both changes survive", () => {
  const { store } = freshStore();
  const a = store.create({ ...base, name: "A" });
  const b = store.create({ ...base, name: "B" });
  // client X and Y both hold rev 1 of their own item
  const x = store.patch(a.id, 1, { price: 99 });
  const y = store.patch(b.id, 1, { price: 5 });
  const list = store.list();
  assert.equal(list.find((i) => i.id === a.id).price, 99);
  assert.equal(list.find((i) => i.id === b.id).price, 5);
  assert.equal(x.rev, 2);
  assert.equal(y.rev, 2);
});

test("2. a stale tab cannot delete a record created later", () => {
  const { store } = freshStore();
  const a = store.create({ ...base, name: "A" });
  const b = store.create({ ...base, name: "B" });
  // stale client (rev 1) tries to delete B AFTER B was already updated by someone else
  store.patch(b.id, 1, { note: "changed elsewhere" });
  assert.throws(() => store.remove(b.id, 1), (e) => e.status === 409);
  // B survives; A untouched
  assert.equal(store.list().length, 2);
  assert.equal(store.list().find((i) => i.id === b.id).note, "changed elsewhere");
});

test("3. two simultaneous renewals on different records both survive", () => {
  const { store } = freshStore();
  const a = store.create({ ...base, name: "A" });
  const b = store.create({ ...base, name: "B" });
  const ra = store.renew(a.id, "op-a");
  const rb = store.renew(b.id, "op-b");
  assert.equal(ra.date, "2026-10-01");
  assert.equal(rb.date, "2026-10-01");
  assert.equal(store.list().length, 2);
});

test("4. retrying the same renew request creates one payment event", () => {
  const { store } = freshStore();
  const a = store.create({ ...base, name: "A" });
  const r1 = store.renew(a.id, "op-1");
  const r2 = store.renew(a.id, "op-1"); // retry with same opId
  assert.equal(r2.duplicate, true);
  assert.equal(r1.date, r2.date, "date must not advance twice");
  const hist = r2.history;
  assert.equal(hist.length, 1, "exactly one payment event");
  assert.equal(hist[0].opId, "op-1");
});

test("5. a stale revision returns 409 without modifying data", () => {
  const { store } = freshStore();
  const a = store.create({ ...base, name: "A" });
  store.patch(a.id, 1, { price: 50 }); // now rev 2
  assert.throws(() => store.patch(a.id, 1, { price: 999 }), (e) => e.status === 409);
  const cur = store.list().find((i) => i.id === a.id);
  assert.equal(cur.price, 50, "stale write must not modify");
  assert.equal(cur.rev, 2);
});

test("6. payment history survives edits, refreshes, and conflicts", () => {
  const { store } = freshStore();
  const a = store.create({ ...base, name: "A" });
  const r = store.renew(a.id, "op-1");
  assert.equal(r.history.length, 1);
  // edit (non-conflict) preserves history
  const edited = store.patch(a.id, r.rev, { note: "edited" });
  assert.equal(edited.history.length, 1);
  // a conflict leaves history intact
  assert.throws(() => store.patch(a.id, edited.rev - 1, { note: "stale" }), (e) => e.status === 409);
  // fresh store instance (simulated refresh/reload from disk) still has it
  const file = edited && store.file;
  const reloaded = new RenewalsStore(file);
  assert.equal(reloaded.list().find((i) => i.id === a.id).history.length, 1);
  assert.equal(reloaded.list().find((i) => i.id === a.id).note, "edited");
});

test("7. undo affects only the exact latest renewal operation", () => {
  const { store } = freshStore();
  const a = store.create({ ...base, name: "A" });
  const r1 = store.renew(a.id, "op-1"); // Sep 1 -> Oct 1
  const r2 = store.renew(a.id, "op-2"); // Oct 1 -> Nov 1
  assert.equal(r2.history.length, 2);
  const undone = store.undoRenew(a.id);
  assert.equal(undone.date, "2026-10-01", "undo restores the previous due only");
  assert.equal(undone.history.length, 1, "only the latest event removed");
  assert.equal(undone.history[0].opId, "op-1");
  // a second undo removes the first event
  const undone2 = store.undoRenew(a.id);
  assert.equal(undone2.date, "2026-09-01");
  assert.equal(undone2.history.length, 0);
});

test("8. atomic-write failure leaves the prior valid JSON intact", () => {
  const { store, file } = freshStore();
  const a = store.create({ ...base, name: "A" });
  const before = readFileSync(file, "utf8");
  // force the tmp write to fail (EISDIR) without touching the real file —
  // works even when the test runs as root (chmod is a no-op for root).
  mkdirSync(file + ".tmp");
  let threw = false;
  try {
    store.create({ ...base, name: "B" });
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "write must throw");
  assert.equal(readFileSync(file, "utf8"), before, "prior JSON intact");
  assert.equal(store.list().length, 1);
});

test("day-clamping preserved: Jan 31 + 1mo -> Feb 28", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2024-01-31", 1), "2024-02-29");
  assert.equal(addMonths("2026-08-15", 12), "2027-08-15");
  assert.equal(addMonths("2026-11-30", 3), "2027-02-28");
});
