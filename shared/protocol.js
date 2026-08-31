'use strict';

// Wire protocol + op allowlist shared by the hub and the agents.
// Both sides validate: the hub before sending, the agent before executing.
// Never trust one side alone.

const PROTOCOL_VERSION = 'harbor-agent-v1';

// Frame types
const FRAME = {
  HELLO: 'hello',
  WELCOME: 'welcome',
  REQ: 'req',
  RES: 'res',
  SNAPSHOT: 'snapshot',
  STREAM: 'stream',
  STREAM_END: 'streamEnd',
  CANCEL: 'cancel'
};

// WebSocket close codes used by the agent hub
const CLOSE = {
  UNAUTHENTICATED: 4401,
  FORBIDDEN: 4403,
  DUPLICATE: 4409
};

class OpError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'OpError';
    this.code = code;
    this.userMessage = message;
    this.httpStatus = httpStatus || HTTP_STATUS_FOR[code] || 500;
  }
}

const HTTP_STATUS_FOR = {
  UNKNOWN_OP: 400,
  BAD_ARGS: 400,
  FORBIDDEN: 403,
  LOCKED: 423,
  NOT_FOUND: 404,
  OFFLINE: 503,
  BUSY: 503,
  TIMEOUT: 504
};

// ======================= ARGUMENT VALIDATORS =======================

const ID_RE = /^[a-zA-Z0-9_.\-]{1,128}$/;
const VALID_RESTART_POLICIES = ['always', 'unless-stopped', 'no', 'on-failure'];
const FILE_TYPES = ['compose', 'dockerfile'];
const MAX_DESCRIPTION_LENGTH = 2000;

function requireId(args) {
  if (!args || typeof args.id !== 'string' || !ID_RE.test(args.id)) {
    throw new OpError('BAD_ARGS', 'Ogiltigt container-ID.');
  }
}

function clampTail(args, fallback) {
  const n = parseInt(args && args.tail, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), 5000);
}

function clampStopTimeout(args) {
  const n = parseInt(args && args.t, 10);
  if (!Number.isFinite(n)) return 10;
  return Math.min(Math.max(n, 0), 600);
}

// Each spec declares the capabilities it needs and normalises its own args.
// `validate` returns the sanitised args actually passed to the implementation —
// anything not returned here never reaches dockerode.
const OP_SPECS = {
  'system.info': {
    mutates: false,
    validate: () => ({})
  },
  'system.prune': {
    mutates: true,
    validate: () => ({})
  },
  'snapshot': {
    mutates: false,
    validate: () => ({})
  },
  'host.metrics': {
    mutates: false,
    validate: () => ({})
  },
  'containers.list': {
    mutates: false,
    validate: (a) => ({ withStats: !a || a.withStats !== false })
  },
  'containers.inspect': {
    mutates: false,
    validate: (a) => { requireId(a); return { id: a.id }; }
  },
  'containers.start': {
    mutates: true,
    validate: (a) => { requireId(a); return { id: a.id }; }
  },
  'containers.stop': {
    mutates: true,
    validate: (a) => { requireId(a); return { id: a.id, t: clampStopTimeout(a) }; }
  },
  'containers.restart': {
    mutates: true,
    validate: (a) => { requireId(a); return { id: a.id, t: clampStopTimeout(a) }; }
  },
  'containers.rebuild': {
    mutates: true,
    validate: (a) => { requireId(a); return { id: a.id }; }
  },
  'containers.remove': {
    mutates: true,
    validate: (a) => { requireId(a); return { id: a.id, force: a.force === true, v: a.v === true }; }
  },
  'containers.logsTail': {
    mutates: false,
    validate: (a) => { requireId(a); return { id: a.id, tail: clampTail(a, 200) }; }
  },
  'containers.restartPolicy': {
    mutates: true,
    validate: (a) => {
      requireId(a);
      if (!a.policy || !VALID_RESTART_POLICIES.includes(a.policy)) {
        throw new OpError('BAD_ARGS', 'Ogiltig restart policy angiven.');
      }
      return { id: a.id, policy: a.policy };
    }
  },
  // NOTE: takes a fileType, never a path. The path is resolved on the executing
  // side from the container's own compose labels. Do not add a path argument.
  'containers.readFile': {
    mutates: false,
    readsFiles: true,
    validate: (a) => {
      requireId(a);
      if (!FILE_TYPES.includes(a.fileType)) {
        throw new OpError('BAD_ARGS', 'Ogiltig filtyp.');
      }
      return { id: a.id, fileType: a.fileType };
    }
  },
  'containers.writeComposeDescription': {
    mutates: false,
    writesFiles: true,
    validate: (a) => {
      requireId(a);
      const description = typeof a.description === 'string' ? a.description.trim() : '';
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        throw new OpError('BAD_ARGS', `Infotexten är för lång (max ${MAX_DESCRIPTION_LENGTH} tecken).`);
      }
      return { id: a.id, description };
    }
  },
  // Streaming op — handled outside the normal request/response path.
  'logs.follow': {
    mutates: false,
    streaming: true,
    validate: (a) => { requireId(a); return { id: a.id, tail: clampTail(a, 150) }; }
  }
};

// Per-op request timeouts (ms). Rebuild pulls an image, so it gets much longer.
const OP_TIMEOUT = {
  'containers.rebuild': 120000,
  'system.prune': 60000
};
const DEFAULT_OP_TIMEOUT = 20000;

function getSpec(op) {
  const spec = OP_SPECS[op];
  if (!spec) throw new OpError('UNKNOWN_OP', `Okänd operation: ${op}`);
  return spec;
}

// Validate an op and its args, and check the caller's capabilities allow it.
// Returns the sanitised args.
function validateOp(op, args, caps) {
  const spec = getSpec(op);
  const c = caps || {};
  if (spec.mutates && !c.allowActions) {
    throw new OpError('FORBIDDEN', 'Servern är i skrivskyddat läge.');
  }
  if (spec.readsFiles && !c.allowFileRead) {
    throw new OpError('FORBIDDEN', 'Filläsning är avstängd för denna server.');
  }
  if (spec.writesFiles && !c.allowFileWrite) {
    throw new OpError('FORBIDDEN', 'Filskrivning är avstängd för denna server.');
  }
  return spec.validate(args || {});
}

module.exports = {
  PROTOCOL_VERSION,
  FRAME,
  CLOSE,
  OpError,
  OP_SPECS,
  OP_TIMEOUT,
  DEFAULT_OP_TIMEOUT,
  VALID_RESTART_POLICIES,
  MAX_DESCRIPTION_LENGTH,
  getSpec,
  validateOp
};
