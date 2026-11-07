import assert from "node:assert/strict";
import { notificationHref, notificationTarget } from "./notification-target";

assert.deepEqual(notificationTarget("COMPLAINT", "c1"), { module: "complaints", seg: ["c1"] });
assert.deepEqual(notificationTarget("pmtask", "t1"), { module: "pm", seg: ["tasks", "t1"] });
assert.deepEqual(notificationTarget("LeaveRequest", "l1"), { module: "hr", seg: [], query: { tab: "leave" } });
assert.deepEqual(notificationTarget("PAYROLL_ITEM", "p1"), { module: "profile", seg: [] });
assert.deepEqual(notificationTarget("INVENTORY_ITEM", "i1"), {
  module: "inventory",
  seg: [],
  query: { view: "items", focus: "i1" },
});
assert.deepEqual(notificationTarget("WHATSAPP_CONVERSATION", "chat-9"), { module: "whatsapp", seg: ["chat-9"] });
assert.deepEqual(notificationTarget("PM_FINDING", "f1"), { module: "pm", seg: [], query: { tab: "plans" } });
assert.deepEqual(notificationTarget("USER_DIRECTORY", "u1"), { module: "users", seg: ["u1"] });
assert.equal(notificationTarget("SOMETHING_NEW", "x"), null);
assert.equal(notificationTarget("COMPLAINT", ""), null);
assert.equal(notificationHref("COMPLAINT", "a/b"), "/complaints/a%2Fb");
assert.equal(notificationHref("NOPE", "x"), "/dashboard");
assert.equal(notificationHref("INVENTORY_ITEM", "i 1"), "/inventory?view=items&focus=i+1");

console.log("notification-target: ok");
