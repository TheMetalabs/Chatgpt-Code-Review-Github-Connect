import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import * as https from "node:https";
import { GithubTransportError, mayResendOnOtherHost, trackRequestSent } from "./github-transport.ts";

/** Runs one request against 127.0.0.1:port and reports whether its bytes may have been sent. */
function sentOnError(port: number, opts: { tls?: boolean; timeoutMs?: number } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    // TLS as production connects (https.request to an address with the GitHub SNI)
    const target = { hostname: "127.0.0.1", port, method: "POST", path: "/", agent: false as const };
    const req = opts.tls ? https.request({ ...target, servername: "api.github.com" }) : http.request(target);
    const sent = trackRequestSent(req);
    req.setTimeout(opts.timeoutMs ?? 300, () => req.destroy(new Error("GitHub API timeout")));
    req.on("error", () => resolve(sent()));
    req.end("{}");
  });
}

function listen(onConn: (s: net.Socket) => void): Promise<{ port: number; close: () => void }> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => {
    sockets.push(s);
    onConn(s);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      }),
    ),
  );
}

describe("mayResendOnOtherHost (a write whose request may have reached GitHub is never re-sent)", () => {
  it("re-sends reads after any failure", () => {
    assert.equal(mayResendOnOtherHost("GET", new Error("GitHub API timeout")), true);
    assert.equal(mayResendOnOtherHost("head", new GithubTransportError("reset", true)), true);
  });

  it("re-sends a write only when the connection never came up", () => {
    for (const m of ["POST", "PATCH", "PUT", "DELETE"]) {
      assert.equal(mayResendOnOtherHost(m, new GithubTransportError("ECONNREFUSED", false)), true, m);
      assert.equal(mayResendOnOtherHost(m, new GithubTransportError("GitHub API timeout", true)), false, m);
      assert.equal(mayResendOnOtherHost(m, new Error("unknown failure")), false, `${m}: unknown → not re-sent`);
    }
  });
});

describe("trackRequestSent", () => {
  it("a refused connection sent nothing", async () => {
    const { port, close } = await listen(() => {});
    close(); // the port is now closed: connect is refused
    assert.equal(await sentOnError(port), false);
  });

  it("a TLS handshake that never completes sent nothing (timeout before the request)", async () => {
    const { port, close } = await listen(() => {}); // accepts TCP, never answers the TLS hello
    try {
      assert.equal(await sentOnError(port, { tls: true }), false);
    } finally {
      close();
    }
  });

  it("a timeout after the connection came up may have sent the request", async () => {
    const { port, close } = await listen(() => {}); // plain TCP: connected, never responds
    try {
      assert.equal(await sentOnError(port), true);
    } finally {
      close();
    }
  });
});
