/**
 * The proxy gateway.
 *
 * Customers point their browser here with a short-lived token. The gateway checks
 * the token, then relays the connection to the real per-country proxy using
 * credentials that never leave this server.
 *
 * Two rules make this a product feature rather than an open relay, and both are
 * enforced before a single byte is forwarded:
 *
 *   1. Only a valid, unexpired token issued by our own API gets through.
 *   2. Only Fiverr, only on ordinary web ports.
 *
 * Without the second, anyone holding a token could send arbitrary traffic through
 * the server. Open proxies are found by scanners within hours, and the abuse
 * complaints arrive at whoever owns the IP.
 */

import { createServer } from 'node:http';
import { connect } from 'node:net';
import { proxyForCountry } from '../worker/proxies.js';
import { isAllowedHost, parseConnectTarget, readProxyAuth, verifyProxyToken } from './token.js';

const UPSTREAM_TIMEOUT_MS = 20000;

const deny = (socket, code, message) => {
  socket.write(`HTTP/1.1 ${code} ${message}\r\n\r\n`);
  socket.destroy();
};

/**
 * Relay a CONNECT through the upstream proxy.
 *
 * The upstream is itself an HTTP proxy, so this is CONNECT-over-CONNECT: dial the
 * upstream, ask *it* to open the tunnel, then splice the two sockets together
 * once it agrees.
 */
function relay(clientSocket, target, upstream, head) {
  const url = new URL(upstream.server);
  const upstreamSocket = connect(
    { host: url.hostname, port: Number(url.port) || 8080 },
    () => {
      const lines = [`CONNECT ${target.host}:${target.port} HTTP/1.1`, `Host: ${target.host}:${target.port}`];
      if (upstream.username) {
        const credentials = Buffer.from(`${upstream.username}:${upstream.password || ''}`).toString('base64');
        lines.push(`Proxy-Authorization: Basic ${credentials}`);
      }
      upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
    },
  );

  upstreamSocket.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstreamSocket.destroy());

  let established = false;
  let buffer = Buffer.alloc(0);

  upstreamSocket.on('data', (chunk) => {
    if (established) return;

    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return; // Response headers still arriving.

    const status = buffer.slice(0, end).toString('utf8').split('\r\n')[0];
    if (!/^HTTP\/1\.[01] 2\d\d/.test(status)) {
      // Surface the upstream's own refusal rather than a generic failure — "407
      // Proxy Authentication Required" tells you the credentials are wrong, which
      // a 502 would not.
      deny(clientSocket, 502, 'Bad Gateway');
      upstreamSocket.destroy();
      return;
    }

    established = true;
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // Anything after the headers is already tunnel payload.
    const leftover = buffer.slice(end + 4);
    if (leftover.length) clientSocket.write(leftover);
    if (head?.length) upstreamSocket.write(head);

    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  });

  const teardown = () => {
    clientSocket.destroy();
    upstreamSocket.destroy();
  };
  upstreamSocket.on('error', () => {
    if (!established) deny(clientSocket, 502, 'Bad Gateway');
    teardown();
  });
  clientSocket.on('error', teardown);
  upstreamSocket.on('close', teardown);
  clientSocket.on('close', () => upstreamSocket.destroy());
}

export function createProxyGateway(env) {
  const server = createServer((req, res) => {
    // Plain HTTP proxying is not offered: everything we care about is HTTPS, and
    // supporting it would widen what this relay can be used for.
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('This gateway only handles CONNECT.\n');
  });

  server.on('connect', async (req, clientSocket, head) => {
    clientSocket.on('error', () => clientSocket.destroy());

    const target = parseConnectTarget(req.url);
    if (!target) return deny(clientSocket, 400, 'Bad Request');
    if (!isAllowedHost(target.host)) return deny(clientSocket, 403, 'Forbidden');

    const auth = readProxyAuth(req.headers['proxy-authorization']);
    if (!auth) {
      clientSocket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\n' +
          'Proxy-Authenticate: Basic realm="RankPeek"\r\n\r\n',
      );
      return clientSocket.destroy();
    }

    // The token rides in the username; the password is ignored, because Chrome
    // insists on sending something.
    const session = await verifyProxyToken(env, auth.username);
    if (!session) return deny(clientSocket, 407, 'Proxy Authentication Required');

    const { proxy, usedFallback } = proxyForCountry(session.country);
    // Falling back would quietly serve a different country's results than the
    // customer asked for and paid for.
    if (!proxy || usedFallback) return deny(clientSocket, 503, 'Service Unavailable');

    relay(clientSocket, target, proxy, head);
  });

  return server;
}
