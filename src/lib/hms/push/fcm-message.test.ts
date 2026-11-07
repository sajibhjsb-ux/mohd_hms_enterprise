import assert from "node:assert/strict";
import { buildFcmMessage, type FcmPayload } from "./fcm-message";

const payload: FcmPayload = {
  title: "Work order assigned",
  body: "WO-1042 is ready",
  route: "/work-orders/wo1",
  tag: "WORK_ORDER:wo1",
  priority: "HIGH",
  notificationId: "n1",
  type: "WORK_ORDER",
  resourceType: "WORK_ORDER",
  resourceId: "wo1",
};

const web = buildFcmMessage(payload, "web");
assert.ok(!("notification" in web), "web must stay data-only");
assert.equal(web.data.url, "/work-orders/wo1");
assert.equal(web.webpush.fcmOptions.link, "/work-orders/wo1");
assert.equal(web.webpush.headers.Urgency, "high");
assert.equal(web.android.priority, "high");

const native = buildFcmMessage(payload, "native");
assert.equal(native.notification.title, "Work order assigned");
assert.equal(native.notification.body, "WO-1042 is ready");
assert.equal(native.android.notification.channelId, "facilitypro_default");
assert.equal(native.android.notification.icon, "ic_stat_notification");
assert.equal(native.apns.payload.aps.alert.title, "Work order assigned");
assert.equal(native.data.url, "/work-orders/wo1", "tap routing data is preserved");

assert.ok(buildFcmMessage({ ...payload, title: "x".repeat(300) }, "native").notification.title.length <= 120);
assert.equal(buildFcmMessage({ ...payload, priority: "NORMAL" }, "web").webpush.headers.Urgency, "normal");

console.log("fcm-message: ok");
