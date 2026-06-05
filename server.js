'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_CONFIG = {
  dashboardPort: 4200,
  // Address to bind the dashboard HTTP server to.
  //   '0.0.0.0' = listen on every IPv4 interface (default — reachable from LAN)
  //   '127.0.0.1' = localhost only
  //   '::'       = listen on every IPv6 interface (and IPv4 via dual-stack)
  //   'eth0'-style addresses can be looked up via `ip a` / `ipconfig`
  bindHost: '0.0.0.0',
  interface: null,
  ports: []
};

const RECENT_PACKETS = 60;
const IN_OUT_WINDOW = 30;
const REQ_PER_SEC_WINDOW_MS = 5000;
const TOP_SOURCE_WINDOW_MS = 30000;
const STATS_TICK_MS = 500;
const PACKET_FLUSH_MS = 60;

let config = loadConfig();
let portState = new Map();
syncPortState();

const captureStatus = { ok: false, message: 'initializing' };
let captureCleanup = null;
const capRefs = [];

let wss = null;
const pendingBatch = [];
let batchTimer = null;

startCapture();

wss = new WebSocketServer({ noServer: true });

const server = http.createServer(handleHttp);
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  const stats = computeAllStats();
  const meta = computeMeta();
  ws.send(JSON.stringify({ type: 'snapshot', config: publicConfig(), stats, meta, recent: collectRecent() }));
  ws.send(JSON.stringify({ type: 'status', captureOk: captureStatus.ok, message: captureStatus.message }));
});

setInterval(() => {
  const stats = computeAllStats();
  const meta = computeMeta();
  broadcast({ type: 'stats', stats, meta });
}, STATS_TICK_MS);

server.listen(config.dashboardPort, config.bindHost, () => {
  const port = config.dashboardPort;
  const host = config.bindHost;
  console.log(`[conduit] dashboard listening on ${host}:${port}`);
  const urls = dashboardUrls(host, port);
  if (urls.length) {
    console.log('[conduit] reachable at:');
    for (const u of urls) console.log('           ' + u);
  }
});

function dashboardUrls(host, port) {
  // localhost-only bind → just print the loopback URL
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') {
    return [`http://localhost:${port}`];
  }
  // any "bind to everything" host → enumerate LAN-facing IPv4 interfaces
  const all = host === '0.0.0.0' || host === '::' || host === '*';
  const urls = [`http://localhost:${port}`];
  if (!all) {
    urls.push(`http://${host}:${port}`);
    return urls;
  }
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        urls.push(`http://${ni.address}:${port}  (${name})`);
      }
    }
  }
  return urls;
}

// -----------------------------------------------------------------------------
// HTTP handlers
// -----------------------------------------------------------------------------

function handleHttp(req, res) {
  if (req.method === 'GET' && req.url === '/api/config') {
    return sendJson(res, 200, publicConfig());
  }
  if (req.method === 'PUT' && req.url === '/api/config') {
    return readBody(req).then((body) => {
      let next;
      try {
        next = JSON.parse(body);
      } catch (err) {
        return sendJson(res, 400, { error: 'invalid json' });
      }
      try {
        applyConfig(next);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      sendJson(res, 200, publicConfig());
      broadcast({ type: 'config', config: publicConfig() });
    });
  }
  if (req.method === 'GET' && req.url === '/api/status') {
    return sendJson(res, 200, { captureOk: captureStatus.ok, message: captureStatus.message });
  }
  return serveStatic(req, res);
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/settings') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-cache' });
    res.end(data);
  });
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed);
  } catch (err) {
    console.warn('[conduit] could not read config.json, using defaults:', err.message);
    const cfg = { ...DEFAULT_CONFIG };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    return cfg;
  }
}

function normalizeConfig(parsed) {
  const cfg = { ...DEFAULT_CONFIG, ...parsed };
  cfg.dashboardPort = Number(cfg.dashboardPort) || DEFAULT_CONFIG.dashboardPort;
  cfg.bindHost = (typeof cfg.bindHost === 'string' && cfg.bindHost.trim())
    ? cfg.bindHost.trim()
    : DEFAULT_CONFIG.bindHost;
  if (!Array.isArray(cfg.ports)) cfg.ports = [];
  const seen = new Set();
  cfg.ports = cfg.ports
    .map((p) => ({
      port: Number(p.port),
      name: String(p.name || '').trim() || `Port ${p.port}`,
      icon: String(p.icon || '').trim()
    }))
    .filter((p) => Number.isInteger(p.port) && p.port > 0 && p.port < 65536 && !seen.has(p.port) && seen.add(p.port));
  return cfg;
}

function applyConfig(next) {
  const normalized = normalizeConfig({ ...config, ...next });
  if (normalized.dashboardPort !== config.dashboardPort) {
    // dashboard port change requires restart — accept it in the file but keep current listener
  }
  config = normalized;
  writeConfigAtomically(config);
  syncPortState();
}

function writeConfigAtomically(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
}

function publicConfig() {
  return {
    dashboardPort: config.dashboardPort,
    bindHost: config.bindHost,
    interface: config.interface,
    ports: config.ports.map((p) => ({ port: p.port, name: p.name, icon: p.icon || '' }))
  };
}

function syncPortState() {
  const wanted = new Set(config.ports.map((p) => p.port));
  for (const port of portState.keys()) {
    if (!wanted.has(port)) portState.delete(port);
  }
  for (const { port, name } of config.ports) {
    let state = portState.get(port);
    if (!state) {
      state = createPortState(port, name);
      portState.set(port, state);
    } else {
      state.name = name;
    }
  }
}

function createPortState(port, name) {
  return {
    port,
    name,
    recent: [],
    in30: [],
    out30: [],
    times: [],
    sources: [],
    total: 0,
    lastSeen: 0,
    startedAt: Date.now()
  };
}

// -----------------------------------------------------------------------------
// Packet capture
// -----------------------------------------------------------------------------

function startCapture() {
  // Refuse to even load cap unless we're root or the user explicitly opts in.
  // Loading cap and failing on open() can segfault its native handle on GC, so
  // we side-step the issue by checking permission up-front.
  const uid = process.getuid ? process.getuid() : 0;
  if (uid !== 0 && !process.env.CONDUIT_TRY_UNPRIV) {
    captureStatus.ok = false;
    captureStatus.message =
      'not running as root — start with `sudo node server.js`, or grant CAP_NET_RAW via setcap and set CONDUIT_TRY_UNPRIV=1';
    console.error('[conduit] ' + captureStatus.message);
    return;
  }

  let Cap;
  let decoders;
  try {
    const cap = require('cap');
    Cap = cap.Cap;
    decoders = cap.decoders;
  } catch (err) {
    captureStatus.ok = false;
    captureStatus.message = `cap module not available: ${err.message}. Run 'npm install' and ensure libpcap is installed.`;
    console.error('[conduit] ' + captureStatus.message);
    return;
  }

  const PROTOCOL = decoders.PROTOCOL;
  let device = config.interface;
  if (!device) {
    try {
      device = Cap.findDevice();
    } catch (err) {
      captureStatus.ok = false;
      captureStatus.message = `could not find capture device: ${err.message}`;
      console.error('[conduit] ' + captureStatus.message);
      return;
    }
  }
  if (!device) {
    captureStatus.ok = false;
    captureStatus.message = 'no capture device found';
    console.error('[conduit] ' + captureStatus.message);
    return;
  }

  const c = new Cap();
  capRefs.push(c); // prevent GC of half-initialized handles (cap segfaults otherwise)
  const buffer = Buffer.alloc(65535);
  let linkType;
  try {
    linkType = c.open(device, 'ip', 10 * 1024 * 1024, buffer);
    if (typeof c.setMinBytes === 'function') c.setMinBytes(0);
  } catch (err) {
    captureStatus.ok = false;
    captureStatus.message = `failed to open ${device}: ${err.message}. Run with sudo or grant CAP_NET_RAW.`;
    console.error('[conduit] ' + captureStatus.message);
    return;
  }

  // Different libpcap builds report link types either as "ETHERNET" or
  // as "LINKTYPE_ETHERNET" — strip the prefix once so the dispatch below
  // doesn't need to handle both forms.
  if (typeof linkType === 'string' && linkType.startsWith('LINKTYPE_')) {
    linkType = linkType.slice('LINKTYPE_'.length);
  }

  captureStatus.ok = true;
  captureStatus.message = `capturing on ${device}`;
  console.log(`[conduit] ${captureStatus.message} (linkType=${linkType})`);

  c.on('packet', (nbytes) => {
    try {
      let offset = 0;
      let proto;
      if (linkType === 'ETHERNET') {
        const eth = decoders.Ethernet(buffer);
        if (eth.info.type !== PROTOCOL.ETHERNET.IPV4) return;
        offset = eth.offset;
      } else if (linkType === 'RAW' || linkType === 'LINUX_SLL') {
        offset = linkType === 'LINUX_SLL' ? 16 : 0;
      } else {
        return;
      }
      const ip = decoders.IPV4(buffer, offset);
      proto = ip.info.protocol;
      let srcPort, dstPort;
      if (proto === PROTOCOL.IP.TCP) {
        const tcp = decoders.TCP(buffer, ip.offset);
        srcPort = tcp.info.srcport;
        dstPort = tcp.info.dstport;
      } else if (proto === PROTOCOL.IP.UDP) {
        const udp = decoders.UDP(buffer, ip.offset);
        srcPort = udp.info.srcport;
        dstPort = udp.info.dstport;
      } else {
        return;
      }
      const ts = Date.now();
      if (portState.has(dstPort)) {
        recordPacket(dstPort, 'in', nbytes, ip.info.srcaddr, ts);
      }
      if (portState.has(srcPort) && srcPort !== dstPort) {
        recordPacket(srcPort, 'out', nbytes, ip.info.dstaddr, ts);
      }
    } catch (err) {
      // a malformed packet should not crash the loop
    }
  });

  captureCleanup = () => {
    try { c.close(); } catch (_) {}
  };
}

function recordPacket(port, dir, size, ip, ts) {
  const s = portState.get(port);
  if (!s) return;
  s.recent.push({ dir, size, ts });
  if (s.recent.length > RECENT_PACKETS) s.recent.shift();
  if (dir === 'in') {
    s.in30.push(size);
    if (s.in30.length > IN_OUT_WINDOW) s.in30.shift();
    s.sources.push({ ip, ts });
  } else {
    s.out30.push(size);
    if (s.out30.length > IN_OUT_WINDOW) s.out30.shift();
  }
  s.times.push(ts);
  s.total += 1;
  s.lastSeen = ts;
  enqueuePacket({ port, dir, size, srcIp: dir === 'in' ? ip : null, ts });
}

// -----------------------------------------------------------------------------
// Stats computation
// -----------------------------------------------------------------------------

function avg(arr) {
  if (!arr.length) return 0;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

function computeAllStats() {
  const now = Date.now();
  const out = {};
  for (const [port, s] of portState) {
    while (s.times.length && now - s.times[0] > REQ_PER_SEC_WINDOW_MS) s.times.shift();
    while (s.sources.length && now - s.sources[0].ts > TOP_SOURCE_WINDOW_MS) s.sources.shift();
    let topSource = null;
    if (s.sources.length) {
      const counts = new Map();
      for (const { ip } of s.sources) counts.set(ip, (counts.get(ip) || 0) + 1);
      let best = null;
      let bestCount = -1;
      for (const [ip, count] of counts) {
        if (count > bestCount) { bestCount = count; best = ip; }
      }
      topSource = best;
    }
    out[port] = {
      port,
      name: s.name,
      inAvg: avg(s.in30),
      outAvg: avg(s.out30),
      reqPerSec: s.times.length / (REQ_PER_SEC_WINDOW_MS / 1000),
      topSource,
      total: s.total,
      lastSeen: s.lastSeen
    };
  }
  return out;
}

function collectRecent() {
  const out = {};
  for (const [port, s] of portState) {
    out[port] = s.recent.slice();
  }
  return out;
}

// Top source IPs across all ports, plus a unique-source count.
// Relies on s.sources being pruned (computeAllStats does that each tick).
function computeMeta(limit) {
  limit = limit || 8;
  const counts = new Map();   // ip -> { count, ports: Set }
  const allIps = new Set();
  for (const [port, s] of portState) {
    for (const { ip } of s.sources) {
      allIps.add(ip);
      let r = counts.get(ip);
      if (!r) { r = { count: 0, ports: new Set() }; counts.set(ip, r); }
      r.count += 1;
      r.ports.add(port);
    }
  }
  const arr = [];
  for (const [ip, r] of counts) {
    arr.push({
      ip,
      count: r.count,
      ports: Array.from(r.ports).sort((a, b) => a - b)
    });
  }
  arr.sort((a, b) => b.count - a.count);
  return {
    topSources: arr.slice(0, limit),
    activeSourcesCount: allIps.size
  };
}

// -----------------------------------------------------------------------------
// Broadcast
// -----------------------------------------------------------------------------

function broadcast(msg) {
  if (!wss) return;
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

function enqueuePacket(p) {
  pendingBatch.push(p);
  if (!batchTimer) {
    batchTimer = setTimeout(flushBatch, PACKET_FLUSH_MS);
  }
}

function flushBatch() {
  batchTimer = null;
  if (!pendingBatch.length) return;
  const batch = pendingBatch.splice(0, pendingBatch.length);
  broadcast({ type: 'packets', batch });
}

// -----------------------------------------------------------------------------
// Shutdown
// -----------------------------------------------------------------------------

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[conduit] received ${sig}, shutting down`);
    if (captureCleanup) captureCleanup();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
