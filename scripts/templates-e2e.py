#!/usr/bin/env python3
"""Template Management System E2E — Settings → Templates (spec §59).

Runs the complete lifecycle against a live server started INSIDE this script
(kept in one invocation — the sandbox reaps background processes):
  login → list → create → draft edit → preview (real PDF) → publish →
  set default → real document generation → snapshot pin → v2 publish →
  history lock → duplicate → archive → restore → audit → RBAC negatives.
"""
import io
import json
import subprocess
import sys
import time

import requests

BASE = "http://localhost:3000"
results = []


def ok(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("PASS " if cond else "FAIL ") + name + (f" — {extra}" if extra and not cond else ""))


def wait_ready(timeout=90):
    start = time.time()
    while time.time() - start < timeout:
        try:
            if requests.get(BASE + "/api/v1/auth/session", timeout=5).status_code in (200, 401):
                return True
        except Exception:
            pass
        time.sleep(2)
    return False


def main():
    # ── start server only if not already running (warm server reuse) ──
    try:
        if requests.get(BASE + "/api/v1/auth/session", timeout=5).status_code in (200, 401):
            print("server already running")
        else:
            raise Exception("not ready")
    except Exception:
        subprocess.run("pkill -f 'next dev' ; pkill -f next-server", shell=True, capture_output=True)
        subprocess.Popen(
            "cd /home/z/my-project && setsid nohup bun run dev > /tmp/tpl-e2e-dev.log 2>&1 < /dev/null",
            shell=True,
            start_new_session=True,
        )
    ok("server ready", wait_ready())

    # ── login ──
    a = requests.Session()
    r = a.post(BASE + "/api/v1/auth/login", json={"email": "admin@mohdhms.com", "password": "Password@123"}, timeout=30)
    ok("admin login", r.status_code == 200, str(r.status_code))

    fin = requests.Session()
    r = fin.post(BASE + "/api/v1/auth/login", json={"email": "finance@mohdhms.com", "password": "Password@123"}, timeout=30)
    ok("finance login (read-only RBAC)", r.status_code == 200, str(r.status_code))

    # ── clean slate from previous runs (QA data only) ──
    subprocess.run(
        [
            "bun", "-e",
            "import {PrismaClient} from '@prisma/client'; const p=new PrismaClient();"
            "const t=await p.documentTemplate.deleteMany({where:{name:{startsWith:'E2E Standard Invoice'}}});"
            "const s=await p.documentTemplateSnapshot.deleteMany({where:{entityType:'invoice',entityId:'cmugvy1dh009zq976i76txzab'}});"
            "console.log('cleaned',t.count,s.count); process.exit(0);",
        ],
        capture_output=True, text=True, timeout=60, cwd="/home/z/my-project",
    )

    # ── list (empty) ──
    r = a.get(BASE + "/api/v1/templates", timeout=30)
    ok("list templates 200", r.status_code == 200, str(r.status_code))
    ok("list shape okList", r.json().get("ok") is True and isinstance(r.json().get("data"), list))

    # ── create ──
    r = a.post(
        BASE + "/api/v1/templates",
        json={"templateType": "invoice", "name": "E2E Standard Invoice", "description": "QA lifecycle template"},
        timeout=30,
    )
    ok("create template 201", r.status_code == 201, f"{r.status_code} {r.text[:120]}")
    tid = r.json()["data"]["id"]

    # ── draft edit: reorder + custom text (valid var) + invalid var separately ──
    r = a.get(BASE + f"/api/v1/templates/{tid}", timeout=30)
    d = r.json()["data"]
    cur = d["currentVersion"]
    ok("detail returns currentVersion with layout/style", cur is not None and "layout" in cur)
    v1_layout = cur["layout"]

    good_layout = {
        "order": ["summary", "items", "totals", "balance-banner", "custom-text", "qr"],
        "hidden": ["payments"],
        "headings": {"totals": "Amount Payable"},
        "config": {"custom-text": {"text": "Pay by {{due_date}} to {{company_name}} — ref {{invoice_number}}"}},
    }
    r = a.patch(BASE + f"/api/v1/templates/{tid}", json={"layout": good_layout}, timeout=30)
    ok("save draft v1 (valid vars)", r.status_code == 200 and r.json()["data"]["version"] == 1, r.text[:160])

    bad_layout = dict(good_layout)
    bad_layout["config"] = {"custom-text": {"text": "Wrong var {{customer_full_adress}} here"}}
    r = a.patch(BASE + f"/api/v1/templates/{tid}", json={"layout": bad_layout}, timeout=30)
    ok("draft accepts unknown var (validation gates PUBLISH, not editing)", r.status_code == 200, r.text[:160])

    # ── preview BEFORE publish is possible (draft preview, real PDF) ──
    r = a.post(
        BASE + "/api/v1/templates/preview",
        json={"templateType": "invoice", "layout": bad_layout, "style": {}},
        timeout=60,
    )
    ok("preview renders even with unknown var (substitution → empty, sample PDF)",
       r.status_code == 200 and r.headers.get("Content-Type") == "application/pdf" and len(r.content) > 1000,
       f"{r.status_code} ct={r.headers.get('Content-Type')} len={len(r.content)}")
    ok("preview starts with %PDF", r.content[:4] == b"%PDF")

    # ── publish must FAIL on unknown variable ──
    r = a.post(BASE + f"/api/v1/templates/{tid}/publish", timeout=90)
    ok("publish blocked on unknown variable", r.status_code == 400 and "customer_full_adress" in json.dumps(r.json()), r.text[:200])

    # fix → save → publish
    r = a.patch(BASE + f"/api/v1/templates/{tid}", json={"layout": good_layout}, timeout=30)
    ok("fix draft", r.status_code == 200)
    r = a.post(BASE + f"/api/v1/templates/{tid}/publish", timeout=120)
    ok("publish succeeds after fix (sample PDF gate)", r.status_code == 200, r.text[:200])
    ok("template now ACTIVE", a.get(BASE + f"/api/v1/templates/{tid}", timeout=30).json()["data"]["status"] == "ACTIVE")

    # ── set default ──
    r = a.post(BASE + f"/api/v1/templates/{tid}/default", timeout=30)
    ok("set default", r.status_code == 200, r.text[:120])
    ok("isDefault persisted", a.get(BASE + f"/api/v1/templates/{tid}", timeout=30).json()["data"]["isDefault"] is True)

    # ── REAL invoice PDF → snapshot pinned ──
    inv_id = "cmugvy1dh009zq976i76txzab"  # INV-2025-0001

    def snapshot_version():
        out = subprocess.run(
            [
                "bun", "-e",
                "import {PrismaClient} from '@prisma/client'; const p=new PrismaClient();"
                f"p.documentTemplateSnapshot.findUnique({{where:{{entityType_entityId:{{entityType:'invoice',entityId:'{inv_id}'}}}}}})"
                ".then(r=>{console.log(r?r.templateId+':'+r.versionNumber:'NONE');process.exit(0)})",
            ],
            capture_output=True, text=True, timeout=60, cwd="/home/z/my-project",
        )
        return out.stdout.strip()

    r = a.get(BASE + f"/api/v1/pdf/invoice/{inv_id}", timeout=120)
    ok("real invoice PDF via template", r.status_code == 200 and r.content[:4] == b"%PDF", f"{r.status_code} len={len(r.content)}")
    ok("snapshot pinned to E2E template v1", snapshot_version() == f"{tid}:1", snapshot_version())

    # ── v2 draft → publish → OLD document must stay on v1 ──
    v2_layout = dict(good_layout)
    v2_layout["order"] = ["summary", "items", "custom-text", "totals", "balance-banner", "qr"]
    v2_layout["headings"] = {"totals": "TOTAL PAYABLE"}
    r = a.patch(BASE + f"/api/v1/templates/{tid}", json={"layout": v2_layout}, timeout=30)
    ok("edit published → next draft created (v2)", r.json()["data"]["newVersionCreated"] is True and r.json()["data"]["version"] == 2, r.text[:160])
    r = a.post(BASE + f"/api/v1/templates/{tid}/publish", timeout=120)
    ok("publish v2", r.status_code == 200, r.text[:160])

    r = a.get(BASE + f"/api/v1/pdf/invoice/{inv_id}", timeout=120)
    ok("re-download WITHOUT regenerate → snapshot STILL v1 (history lock)",
       r.status_code == 200 and snapshot_version() == f"{tid}:1", snapshot_version())

    # regenerate with ?regenerate=1 → v2 applies
    r = a.get(BASE + f"/api/v1/pdf/invoice/{inv_id}?regenerate=1", timeout=120)
    ok("explicit ?regenerate=1 re-pins snapshot to v2", r.status_code == 200 and snapshot_version() == f"{tid}:2", snapshot_version())

    # ── duplicate ──
    r = a.post(BASE + f"/api/v1/templates/{tid}/duplicate", timeout=30)
    ok("duplicate → new DRAFT copy", r.status_code == 201, r.text[:120])
    copy_id = r.json()["data"]["id"]
    d2 = a.get(BASE + f"/api/v1/templates/{copy_id}", timeout=30).json()["data"]
    ok("copy is DRAFT v1 with copied layout", d2["status"] == "DRAFT" and d2["currentVersion"]["version"] == 1)

    # ── archive copy ──
    r = a.post(BASE + f"/api/v1/templates/{copy_id}/archive", timeout=30)
    ok("archive copy", r.status_code == 200)
    d2 = a.get(BASE + f"/api/v1/templates/{copy_id}", timeout=30).json()["data"]
    ok("copy ARCHIVED + not default", d2["status"] == "ARCHIVED" and d2["isDefault"] is False)

    # ── version history + restore ──
    d1 = a.get(BASE + f"/api/v1/templates/{tid}", timeout=30).json()["data"]
    ok("version history has v1+v2 PUBLISHED", len(d1["versions"]) >= 2 and all(v["status"] == "PUBLISHED" for v in d1["versions"][:2]))
    v1_row = next(v for v in d1["versions"] if v["version"] == 1)
    r = a.post(BASE + f"/api/v1/templates/{tid}/restore", json={"versionId": v1_row["id"]}, timeout=30)
    ok("restore v1 → new draft v3 (history intact)", r.status_code == 200 and r.json()["data"]["version"] == 3, r.text[:160])
    d1 = a.get(BASE + f"/api/v1/templates/{tid}", timeout=30).json()["data"]
    ok("v1 row still PUBLISHED (never overwritten)", next(v for v in d1["versions"] if v["version"] == 1)["status"] == "PUBLISHED")

    # ── required-block guard: QR cannot be removed ──
    no_qr = {"order": ["summary", "items"], "hidden": [], "headings": {}, "config": {}}
    r = a.patch(BASE + f"/api/v1/templates/{tid}", json={"layout": no_qr}, timeout=30)
    r = a.post(BASE + f"/api/v1/templates/{tid}/publish", timeout=120)
    ok("publish blocked when QR missing", r.status_code == 400 and "QR" in json.dumps(r.json()), r.text[:200])

    # ── RBAC: finance read-only ──
    r = fin.get(BASE + "/api/v1/templates", timeout=30)
    ok("finance CAN list (templates.read)", r.status_code == 200)
    r = fin.post(BASE + "/api/v1/templates", json={"templateType": "invoice", "name": "Nope"}, timeout=30)
    ok("finance CANNOT create (403)", r.status_code == 403, str(r.status_code))
    r = fin.post(BASE + f"/api/v1/templates/{tid}/publish", timeout=30)
    ok("finance CANNOT publish (403)", r.status_code == 403, str(r.status_code))
    r = fin.post(BASE + "/api/v1/templates/preview", json={"templateType": "invoice", "layout": {}, "style": {}}, timeout=60)
    ok("finance CAN preview (view/preview per constants)", r.status_code == 200, str(r.status_code))

    # ── audit trail ──
    r = a.get(BASE + "/api/v1/audit-logs?limit=40", timeout=30)
    actions = {row.get("action") for row in (r.json().get("data") or [])}
    expected = {"TEMPLATE_CREATED", "TEMPLATE_DRAFT_SAVED", "TEMPLATE_PUBLISHED", "TEMPLATE_SET_DEFAULT", "TEMPLATE_DUPLICATED", "TEMPLATE_ARCHIVED", "TEMPLATE_VERSION_RESTORED"}
    ok("audit trail covers all template actions", expected.issubset(actions), f"missing={expected - actions}")

    # ── rate limit on preview (bucket is per-minute; stop at first 429) ──
    limited = False
    for i in range(25):
        try:
            rr = a.post(BASE + "/api/v1/templates/preview", json={"templateType": "invoice", "layout": good_layout, "style": {}}, timeout=60)
        except Exception:
            continue
        if rr.status_code == 429:
            limited = True
            break
    ok("preview rate limit kicks in (20/min)", limited)

    # ── summary ──
    passed = sum(1 for _, c, _ in results if c)
    print(f"\n===== {passed}/{len(results)} PASS =====")
    if passed != len(results):
        print("FAILURES:")
        for n, c, x in results:
            if not c:
                print(f"  ✗ {n} {x}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
