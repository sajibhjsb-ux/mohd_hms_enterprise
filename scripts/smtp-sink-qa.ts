// MOHD.HMS ENTERPRISE — QA-only SMTP sink (throwaway test fixture, NOT app code).
// Listens on 127.0.0.1:2525 and speaks the real SMTP protocol so the REAL
// centralized EmailService (nodemailer transport) can be exercised end-to-end
// in the sandbox: TCP connect → EHLO → AUTH → MAIL FROM → RCPT TO → DATA.
// Every accepted message is logged (envelope + headers + subject) to stdout.
// Production never uses this — the corporate Mailflare SMTP endpoint comes
// from the admin-managed EmailConfig.

const PORT = 2525;

const encoder = new TextEncoder();

function line(socket: any, text: string) {
  socket.write(encoder.encode(text + "\r\n"));
}

Bun.listen({
  hostname: "127.0.0.1",
  port: PORT,
  socket: {
    open(socket) {
      (socket.data as any) = { inData: false, buffer: "", from: "", to: [] as string[], authed: false };
      line(socket, "220 qa-sink ESMTP MOHD-HMS-QA ready");
    },
    data(socket, chunk) {
      const state = socket.data as any;
      state.buffer += new TextDecoder().decode(chunk);
      let idx: number;
      while ((idx = state.buffer.indexOf("\r\n")) !== -1) {
        const raw = state.buffer.slice(0, idx);
        state.buffer = state.buffer.slice(idx + 2);
        if (state.inData) {
          if (raw === ".") {
            state.inData = false;
            const subject = /Subject: (.*)/i.exec(state.msg)?.[1] ?? "(no subject)";
            const to = /To: (.*)/i.exec(state.msg)?.[1] ?? "";
            console.log(`[SINK-ACCEPTED] from=${state.from} to=${state.to.join(",")} subject="${subject}" bytes=${state.msg.length} at=${new Date().toISOString()}`);
            line(socket, "250 2.0.0 OK queued as QA" + Math.random().toString(36).slice(2, 8));
            state.msg = "";
          } else {
            state.msg = (state.msg || "") + raw.replace(/^\.\./, ".") + "\n";
          }
          continue;
        }
        const cmd = raw.toUpperCase();
        if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) {
          line(socket, "250-qa-sink");
          line(socket, "250-8BITMIME");
          line(socket, "250-SIZE 26214400");
          line(socket, "250 OK");
        } else if (cmd.startsWith("STARTTLS")) {
          line(socket, "454 TLS not available");
        } else if (cmd.startsWith("AUTH PLAIN")) {
          state.authed = true;
          line(socket, "235 2.7.0 Authentication successful");
        } else if (cmd.startsWith("AUTH LOGIN")) {
          state.authChallenge = "user";
          line(socket, "334 VXNlcm5hbWU6");
        } else if (state.authChallenge === "user") {
          state.authChallenge = "pass";
          line(socket, "334 UGFzc3dvcmQ6");
        } else if (state.authChallenge === "pass") {
          state.authed = true;
          state.authChallenge = null;
          line(socket, "235 2.7.0 Authentication successful");
        } else if (cmd.startsWith("MAIL FROM")) {
          state.from = /<(.*)>/.exec(raw)?.[1] ?? raw;
          line(socket, "250 2.1.0 Sender OK");
        } else if (cmd.startsWith("RCPT TO")) {
          state.to.push(/<(.*)>/.exec(raw)?.[1] ?? raw);
          line(socket, "250 2.1.5 Recipient OK");
        } else if (cmd.startsWith("DATA")) {
          state.inData = true;
          state.msg = "";
          line(socket, "354 Start mail input; end with <CRLF>.<CRLF>");
        } else if (cmd.startsWith("RSET")) {
          state.from = ""; state.to = []; state.msg = "";
          line(socket, "250 2.0.0 OK");
        } else if (cmd.startsWith("NOOP")) {
          line(socket, "250 2.0.0 OK");
        } else if (cmd.startsWith("QUIT")) {
          line(socket, "221 2.0.0 Bye");
          socket.end();
        } else {
          line(socket, "502 5.5.2 Command not implemented");
        }
      }
    },
    error(socket, err) {
      console.error("[SINK-ERROR]", err.message);
    },
  },
});

console.log(`[SINK] QA SMTP sink listening on 127.0.0.1:${PORT}`);
