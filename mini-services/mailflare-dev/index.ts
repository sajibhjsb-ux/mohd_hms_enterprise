// mailflare-dev — local SMTP sink for MOHD.HMS Enterprise development/QA.
// A REAL SMTP server (RFC 5321 subset) that accepts mail exactly like the
// corporate Mailflare endpoint would in production, so the app's email
// pipeline is exercised end-to-end over the actual protocol:
//
//   EmailService → SMTP client → TCP :3095 → [EHLO/MAIL/RCPT/DATA/QUIT]
//
// Received messages are kept in memory and are inspectable over HTTP :3096
// (GET /messages, GET /messages/:id, DELETE /messages) — used by QA scripts
// to assert real acceptance evidence. NEVER use in production; production
// points the email configuration at the real Mailflare SMTP endpoint.

const SMTP_PORT = 3095;
const HTTP_PORT = 3096;

type Received = {
  id: string;
  from: string;
  to: string[];
  data: string;
  receivedAt: string;
};

const messages: Received[] = [];
let seq = 0;

function log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: "mailflare-dev", msg, ...extra }));
}

// ─── SMTP server ────────────────────────────────────────────────────────────

type Session = {
  buffer: string;
  from: string | null;
  to: string[];
  inData: boolean;
  dataLines: string[];
};

function handleLine(socket: { write: (data: string) => number; end: () => void }, session: Session, rawLine: string): void {
  if (session.inData) {
    // "." on a line by itself ends DATA (dot-stuffing: ".." is an escaped dot).
    if (rawLine === ".") {
      session.inData = false;
      const data = session.dataLines.join("\r\n").replace(/^>\./gm, ".");
      const id = `mf-${++seq}-${Date.now().toString(36)}`;
      messages.push({ id, from: session.from ?? "", to: [...session.to], data, receivedAt: new Date().toISOString() });
      log("info", "message-accepted", { id, from: session.from, to: session.to, bytes: data.length, total: messages.length });
      socket.write(`250 2.0.0 OK - message accepted as ${id}\r\n`);
      session.from = null;
      session.to = [];
      session.dataLines = [];
      return;
    }
    session.dataLines.push(rawLine);
    return;
  }

  const line = rawLine.trim();
  const verb = line.split(/\s+/)[0]?.toUpperCase() ?? "";

  switch (verb) {
    case "EHLO":
    case "HELO":
      socket.write(`250-mailflare-dev greets ${line.slice(verb.length).trim() || "client"}\r\n`);
      socket.write("250-SIZE 26214400\r\n");
      socket.write("250-8BITMIME\r\n");
      socket.write("250-ENHANCEDSTATUSCODES\r\n");
      socket.write("250 OK\r\n");
      break;
    case "STARTTLS":
      // Plain text dev sink — decline STARTTLS (clients configured with
      // security NONE talk plaintext to this endpoint).
      socket.write("454 4.7.0 TLS not available (dev sink)\r\n");
      break;
    case "AUTH":
      // Accept any AUTH PLAIN/LOGIN declaration for dev purposes.
      socket.write("235 2.7.0 Authentication successful\r\n");
      break;
    case "MAIL":
      session.from = /<([^>]*)>/.exec(line)?.[1] ?? line.replace(/^MAIL FROM:\s*/i, "").trim();
      socket.write("250 2.1.0 OK\r\n");
      break;
    case "RCPT":
      session.to.push(/<([^>]*)>/.exec(line)?.[1] ?? line.replace(/^RCPT TO:\s*/i, "").trim());
      socket.write("250 2.1.5 OK\r\n");
      break;
    case "DATA":
      if (!session.from || session.to.length === 0) {
        socket.write("503 5.5.1 MAIL and RCPT required first\r\n");
        break;
      }
      session.inData = true;
      session.dataLines = [];
      socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
      break;
    case "RSET":
      session.from = null;
      session.to = [];
      socket.write("250 2.0.0 OK\r\n");
      break;
    case "NOOP":
      socket.write("250 2.0.0 OK\r\n");
      break;
    case "QUIT":
      socket.write("221 2.0.0 Bye\r\n");
      socket.end();
      break;
    default:
      socket.write("500 5.5.2 Command not recognized\r\n");
  }
}

const decoder = new TextDecoder();

Bun.listen({
  hostname: "0.0.0.0",
  port: SMTP_PORT,
  socket: {
    open(socket) {
      const session: Session = { buffer: "", from: null, to: [], inData: false, dataLines: [] };
      socket.data = { session }; // socket.data starts as undefined in Bun — initialize it
      log("info", "connection-opened", { remote: String(socket.remoteAddress) });
      socket.write("220 mailflare-dev ESMTP service ready\r\n");
    },
    data(socket, chunk) {
      const session = (socket.data as { session?: Session } | undefined)?.session;
      if (!session) return;
      session.buffer += decoder.decode(chunk);
      let idx: number;
      while ((idx = session.buffer.indexOf("\r\n")) !== -1) {
        const line = session.buffer.slice(0, idx);
        session.buffer = session.buffer.slice(idx + 2);
        try {
          handleLine(socket, session, line);
        } catch (e) {
          log("error", "session-error", { err: String(e) });
          socket.write("421 4.3.0 Internal error\r\n");
          socket.end();
        }
      }
    },
    close(socket) {
      log("info", "connection-closed", { remote: String(socket.remoteAddress) });
    },
    error(socket, err) {
      log("warn", "socket-error", { err: err.message });
    },
  },
});
log("info", "smtp-listening", { port: SMTP_PORT });

// ─── HTTP inspection API (QA only) ──────────────────────────────────────────

Bun.serve({
  port: HTTP_PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "mailflare-dev", smtpPort: SMTP_PORT, messages: messages.length });
    }
    if (url.pathname === "/messages" && req.method === "GET") {
      const to = url.searchParams.get("to");
      const list = to ? messages.filter((m) => m.to.includes(to)) : messages;
      return Response.json({ ok: true, count: list.length, messages: list.map(({ id, from, to: t, receivedAt, data }) => ({ id, from, to: t, receivedAt, size: data.length, preview: data.slice(0, 600) })) });
    }
    const match = /\/messages\/([^/]+)$/.exec(url.pathname);
    if (match && req.method === "GET") {
      const m = messages.find((x) => x.id === match[1]);
      if (!m) return Response.json({ ok: false, error: "not found" }, { status: 404 });
      return Response.json({ ok: true, message: m });
    }
    if (url.pathname === "/messages" && req.method === "DELETE") {
      messages.length = 0;
      return Response.json({ ok: true, cleared: true });
    }
    return Response.json({ ok: false, error: "unknown route" }, { status: 404 });
  },
});
log("info", "http-listening", { port: HTTP_PORT });
