'use strict';

const jwt = require('jsonwebtoken');

// Browser WebSockets cannot set headers, so the JWT stays in the query string.
// It is same-origin over TLS, and we additionally pin the Origin to the Host.
function createLogsHandler({ hub, jwtSecret }) {
  return (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const containerId = url.searchParams.get('containerId');
    const serverId = url.searchParams.get('serverId') || 'local';
    const token = url.searchParams.get('token');

    const fail = (message) => {
      try {
        ws.send(JSON.stringify({ type: 'error', message }));
        ws.close();
      } catch (e) {}
    };

    if (!originMatchesHost(req)) {
      return fail('Obehörig WebSocket-anslutning.');
    }

    try {
      if (!token) throw new Error('Ingen token angiven.');
      jwt.verify(token, jwtSecret);
    } catch (err) {
      return fail('Obehörig WebSocket-anslutning.');
    }

    if (!containerId) return fail('Saknar containerId.');

    const transport = hub.getTransport(serverId);
    if (!transport) return fail(`Okänd server: ${serverId}`);
    if (transport.status === 'offline') {
      return fail(`Servern "${transport.server.name}" är inte ansluten.`);
    }

    const stream = transport.openLogStream({ id: containerId, tail: 150 }, {
      onChunk: (text) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'log', data: text }));
      },
      onEnd: (message) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'end', message }));
      },
      onError: (err) => fail(err.userMessage || err.message)
    });

    ws.on('close', () => stream.close());
  };
}

// A missing Origin (non-browser client) is allowed; a mismatching one is not.
function originMatchesHost(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  try {
    return new URL(origin).host === host;
  } catch (err) {
    return false;
  }
}

module.exports = { createLogsHandler };
