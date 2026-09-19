// Next.js instrumentation hook — starts the MOHD.HMS workflow scheduler
// (outbox worker + PM/escalation/SLA/overdue scans) once per server process,
// independent of any browser session (§35 SCHEDULER).

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("./lib/hms/workflows/scheduler");
    startScheduler();
  }
}
