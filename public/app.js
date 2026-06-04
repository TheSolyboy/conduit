/* ──────────────────────────────────────────────────────────────
   Conduit dashboard client — WS stream + canvas sparklines
   ────────────────────────────────────────────────────────────── */

(() => {
  'use strict';

  // ── state ───────────────────────────────────────────────────

  const state = {
    config: { ports: [], dashboardPort: 4200, interface: null },
    stats: {},
    prevStats: {},
    captureOk: false,
    captureMsg: 'connecting…',
    wsState: 'connecting'
  };

  const sparkState = new Map(); // port -> { packets: [{dir,size,ts}], pendingShift }
  const SPARK_W = 180, SPARK_H = 28;
  const BAR_STRIDE = 3, BAR_W = 2;
  const MAX_BARS = Math.floor(SPARK_W / BAR_STRIDE);
  const ANIM_MS = 160;
  const FLOOR_SIZE = 200;

  const COL_IN  = '#5a6470';
  const COL_OUT = '#727f8a';
  const COL_NEW = '#6b8db5';

  // ── ws connect with backoff ─────────────────────────────────

  let ws;
  let wsBackoff = 800;

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    state.wsState = 'connecting';
    setStatusDot();
    updateBanner();
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch (err) {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      state.wsState = 'ok';
      wsBackoff = 800;
      setStatusDot();
      updateBanner();
    };
    ws.onclose = () => {
      state.wsState = 'closed';
      setStatusDot();
      updateBanner();
      scheduleReconnect();
    };
    ws.onerror = () => { /* close fires next */ };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMsg(msg);
    };
  }

  function scheduleReconnect() {
    setTimeout(connectWs, wsBackoff);
    wsBackoff = Math.min(Math.round(wsBackoff * 1.6), 8000);
  }

  function handleMsg(msg) {
    switch (msg.type) {
      case 'snapshot':
        state.config = msg.config;
        state.stats = msg.stats || {};
        for (const port in msg.recent || {}) {
          const st = getSparkState(Number(port));
          st.packets = (msg.recent[port] || []).slice(-60);
          st.pendingShift = 0;
        }
        renderRows();
        for (const port in state.stats) updateRowStats(Number(port));
        if (currentRoute() === 'settings') renderSettings();
        updateFooter();
        drawAllSparks();
        refreshLiveState();
        break;

      case 'config':
        state.config = msg.config;
        renderRows();
        for (const port in state.stats) updateRowStats(Number(port));
        if (currentRoute() === 'settings') renderSettings();
        updateFooter();
        drawAllSparks();
        refreshLiveState();
        break;

      case 'stats':
        state.prevStats = state.stats;
        state.stats = msg.stats || {};
        for (const port in state.stats) updateRowStats(Number(port));
        break;

      case 'packets':
        for (const p of msg.batch || []) {
          const st = getSparkState(p.port);
          st.packets.push({ dir: p.dir, size: p.size, ts: p.ts });
          if (st.packets.length > 60) st.packets.shift();
          st.pendingShift = Math.min(st.pendingShift + 1, 6);
        }
        scheduleAnim();
        break;

      case 'status':
        state.captureOk = !!msg.captureOk;
        state.captureMsg = msg.message || '';
        setStatusDot();
        updateBanner();
        break;
    }
  }

  function getSparkState(port) {
    let st = sparkState.get(port);
    if (!st) { st = { packets: [], pendingShift: 0 }; sparkState.set(port, st); }
    return st;
  }

  // ── routing ─────────────────────────────────────────────────

  function currentRoute() {
    return location.hash.startsWith('#/settings') ? 'settings' : 'dashboard';
  }

  function applyRoute() {
    const r = currentRoute();
    document.getElementById('view-dashboard').hidden = r !== 'dashboard';
    document.getElementById('view-settings').hidden  = r !== 'settings';
    document.querySelectorAll('.nav-link').forEach((a) => {
      a.classList.toggle('active', a.dataset.route === r);
    });
    if (r === 'settings') renderSettings();
  }

  window.addEventListener('hashchange', applyRoute);

  // ── header status ───────────────────────────────────────────

  function setStatusDot() {
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    if (state.wsState === 'closed') {
      dot.dataset.state = 'error';
      txt.textContent = 'disconnected';
      return;
    }
    if (state.wsState === 'connecting') {
      dot.dataset.state = 'connecting';
      txt.textContent = 'connecting';
      return;
    }
    if (!state.captureOk) {
      dot.dataset.state = 'error';
      txt.textContent = 'capture stopped';
      return;
    }
    dot.dataset.state = 'ok';
    txt.textContent = state.captureMsg || 'capturing';
  }

  function updateBanner() {
    const banner = document.getElementById('banner');
    if (state.wsState === 'closed') {
      banner.hidden = false;
      banner.className = 'banner banner-warn';
      banner.textContent = 'Connection to server lost · reconnecting…';
      return;
    }
    if (state.wsState === 'connecting') {
      banner.hidden = true;
      return;
    }
    if (!state.captureOk) {
      banner.hidden = false;
      banner.className = 'banner';
      banner.textContent = 'Packet capture is not running — ' + (state.captureMsg || 'unknown error');
      return;
    }
    banner.hidden = true;
  }

  function updateFooter() {
    const meta = document.getElementById('ftr-meta');
    const n = state.config.ports.length;
    const iface = (state.captureMsg || '').replace(/^capturing on /, '');
    const ifacePart = state.captureOk && iface ? `${iface} · ` : '';
    meta.textContent = `${ifacePart}${n} port${n === 1 ? '' : 's'} · dashboard :${state.config.dashboardPort}`;
  }

  // ── dashboard rows ──────────────────────────────────────────

  function renderRows() {
    const rowsEl = document.getElementById('rows');
    const existing = new Map();
    rowsEl.querySelectorAll('.row').forEach((el) => existing.set(Number(el.dataset.port), el));
    const wantedSet = new Set(state.config.ports.map((p) => p.port));

    for (const [port, el] of existing) {
      if (!wantedSet.has(port)) { el.remove(); existing.delete(port); sparkState.delete(port); }
    }

    const frag = document.createDocumentFragment();
    for (const p of state.config.ports) {
      let el = existing.get(p.port);
      if (!el) {
        el = buildRow(p);
        existing.set(p.port, el);
      } else {
        el.querySelector('.port-name').textContent = p.name;
      }
      frag.appendChild(el);
    }
    rowsEl.appendChild(frag);

    document.getElementById('empty').hidden = state.config.ports.length > 0;
    updateFooter();
  }

  function buildRow(p) {
    const el = document.createElement('div');
    el.className = 'row is-idle';
    el.dataset.port = String(p.port);
    el.innerHTML =
      `<span class="dot"></span>` +
      `<span class="port-chip">${escapeHtml(String(p.port))}</span>` +
      `<span class="port-name"></span>` +
      `<canvas class="spark" width="${SPARK_W}" height="${SPARK_H}"></canvas>` +
      `<span class="num js-in"><span class="empty-val">—</span></span>` +
      `<span class="num js-out"><span class="empty-val">—</span></span>` +
      `<span class="num js-rps"><span class="empty-val">—</span></span>` +
      `<span class="src js-src"><span class="empty-val">—</span></span>` +
      `<span class="num js-total"><span class="empty-val">—</span></span>` +
      `<span class="seen js-seen"><span class="empty-val">—</span></span>`;
    el.querySelector('.port-name').textContent = p.name;
    initCanvas(el.querySelector('canvas'));
    return el;
  }

  function initCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = SPARK_W * dpr;
    canvas.height = SPARK_H * dpr;
    canvas.style.width  = SPARK_W + 'px';
    canvas.style.height = SPARK_H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }

  function updateRowStats(port) {
    const row = document.querySelector(`.row[data-port="${port}"]`);
    if (!row) return;
    const s = state.stats[port];
    if (!s) return;
    const prev = (state.prevStats || {})[port] || {};

    row.querySelector('.js-in').innerHTML  = renderNum(s.inAvg,  prev.inAvg);
    row.querySelector('.js-out').innerHTML = renderNum(s.outAvg, prev.outAvg);
    row.querySelector('.js-rps').innerHTML = s.reqPerSec > 0
      ? formatRps(s.reqPerSec)
      : '<span class="empty-val">—</span>';
    row.querySelector('.js-src').innerHTML = s.topSource
      ? escapeHtml(s.topSource)
      : '<span class="empty-val">—</span>';
    row.querySelector('.js-total').textContent = s.total > 0 ? formatInt(s.total) : '—';
    row.querySelector('.js-seen').textContent  = s.lastSeen ? formatTime(s.lastSeen) : '—';
  }

  // ── formatting ──────────────────────────────────────────────

  function renderNum(curr, prev) {
    if (!curr || curr <= 0) return '<span class="empty-val">—</span>';
    const valHtml = formatInt(Math.round(curr));
    if (typeof prev === 'number' && prev > 0) {
      const diff = curr - prev;
      const rel = Math.abs(diff) / Math.max(prev, 1);
      if (rel >= 0.05) {
        const pct = (diff / prev) * 100;
        const cls = pct > 0 ? 'delta-up' : 'delta-down';
        const arrow = pct > 0 ? '▲' : '▼';
        const pctStr = Math.abs(pct).toFixed(pct >= 100 ? 0 : 1);
        return `<span class="delta ${cls}">${arrow}${pctStr}</span>${valHtml}`;
      }
    }
    return valHtml;
  }

  function formatRps(v) {
    if (v >= 100) return Math.round(v).toString();
    if (v >= 10)  return v.toFixed(1);
    return v.toFixed(2);
  }

  function formatInt(n) {
    if (n < 1000) return String(n);
    // narrow no-break space as thousands separator — terminal-y look
    return n.toLocaleString('en-US').replace(/,/g, ' ');
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const pad = (x) => String(x).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── canvas sparkline render loop ────────────────────────────

  function drawSpark(canvas, st) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, SPARK_W, SPARK_H);
    const pkts = st.packets;
    if (!pkts.length) return;

    let maxSize = FLOOR_SIZE;
    for (let i = 0; i < pkts.length; i++) {
      if (pkts[i].size > maxSize) maxSize = pkts[i].size;
    }

    const offset = st.pendingShift * BAR_STRIDE;
    const start = Math.max(0, pkts.length - MAX_BARS - 1);
    const sub = pkts.slice(start);
    const n = sub.length;

    for (let i = 0; i < n; i++) {
      const p = sub[i];
      const xFinal = (i - (n - 1)) * BAR_STRIDE + (SPARK_W - BAR_W);
      const x = Math.round(xFinal + offset);
      if (x + BAR_W < 0 || x > SPARK_W) continue;
      const ratio = Math.min(1, p.size / maxSize);
      const barH = Math.max(1, Math.round(ratio * (SPARK_H - 2)));
      const y = SPARK_H - barH;
      const isNewest = (i === n - 1 && st.pendingShift < 0.4);
      ctx.fillStyle = isNewest ? COL_NEW : (p.dir === 'in' ? COL_IN : COL_OUT);
      ctx.fillRect(x, y, BAR_W, barH);
    }
  }

  let lastTickTime = 0;
  let animFrame = 0;

  function scheduleAnim() {
    if (animFrame || document.hidden) return;
    animFrame = requestAnimationFrame(animTick);
  }

  function animTick(now) {
    animFrame = 0;
    const dt = lastTickTime ? now - lastTickTime : 0;
    lastTickTime = now;
    const decay = dt / ANIM_MS;

    let stillAnimating = false;
    for (const [port, st] of sparkState) {
      if (st.pendingShift > 0) {
        st.pendingShift = Math.max(0, st.pendingShift - decay);
        if (st.pendingShift > 0) stillAnimating = true;
      }
      const row = document.querySelector(`.row[data-port="${port}"]`);
      if (!row) continue;
      const canvas = row.querySelector('.spark');
      if (canvas) drawSpark(canvas, st);
    }

    if (stillAnimating) scheduleAnim();
    else lastTickTime = 0;
  }

  function refreshLiveState() {
    const liveNow = Date.now();
    for (const [port] of sparkState) {
      const row = document.querySelector(`.row[data-port="${port}"]`);
      if (!row) continue;
      const s = state.stats[port];
      const ls = s ? s.lastSeen : 0;
      const sinceLast = liveNow - ls;
      row.classList.toggle('is-live', !!ls && sinceLast < 1500);
      row.classList.toggle('is-idle', !ls || sinceLast > 10000);
    }
  }

  function drawAllSparks() {
    for (const [port, st] of sparkState) {
      const row = document.querySelector(`.row[data-port="${port}"]`);
      if (!row) continue;
      const canvas = row.querySelector('.spark');
      if (canvas) drawSpark(canvas, st);
    }
  }

  setInterval(refreshLiveState, 300);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      drawAllSparks();
      scheduleAnim();
    }
  });

  // ── settings page ───────────────────────────────────────────

  function renderSettings() {
    const list = document.getElementById('setlist');
    list.innerHTML = '';

    if (!state.config.ports.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.style.padding = '20px 14px';
      empty.innerHTML = '<span>No ports yet — add one below.</span>';
      list.appendChild(empty);
    }

    state.config.ports.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'setrow';
      row.innerHTML =
        `<span class="port-chip">${escapeHtml(String(p.port))}</span>` +
        `<input type="text" class="js-name" value="${escapeHtml(p.name)}" maxlength="40" />` +
        `<span class="move">` +
          `<button class="icon-btn js-up"   ${i === 0 ? 'disabled' : ''} title="move up">▲</button>` +
          `<button class="icon-btn js-down" ${i === state.config.ports.length - 1 ? 'disabled' : ''} title="move down">▼</button>` +
        `</span>` +
        `<button class="icon-btn danger js-rm" title="remove">×</button>`;
      row.querySelector('.js-up').onclick   = () => move(i, -1);
      row.querySelector('.js-down').onclick = () => move(i, +1);
      row.querySelector('.js-rm').onclick   = () => removeAt(i);
      const nameInput = row.querySelector('.js-name');
      nameInput.onchange = () => renameAt(i, nameInput.value);
      list.appendChild(row);
    });

    document.getElementById('dash-port').value = state.config.dashboardPort;
    document.getElementById('iface').value     = state.config.interface || '';
    setSaveHint('', '');
  }

  function move(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= state.config.ports.length) return;
    const arr = state.config.ports.slice();
    [arr[i], arr[j]] = [arr[j], arr[i]];
    putConfig({ ports: arr });
  }

  function removeAt(i) {
    const arr = state.config.ports.slice();
    arr.splice(i, 1);
    putConfig({ ports: arr });
  }

  function renameAt(i, name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    const arr = state.config.ports.slice();
    arr[i] = { ...arr[i], name: trimmed };
    putConfig({ ports: arr });
  }

  function putConfig(patch) {
    const next = { ...state.config, ...patch };
    return fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next)
    })
      .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || 'request failed');
        state.config = body;
        renderRows();
        if (currentRoute() === 'settings') renderSettings();
        return body;
      });
  }

  function setSaveHint(text, cls) {
    const hint = document.getElementById('save-hint');
    if (!hint) return;
    hint.textContent = text;
    hint.className = 'actions-hint' + (cls ? ' ' + cls : '');
  }

  document.getElementById('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const portInput = document.getElementById('add-port');
    const nameInput = document.getElementById('add-name');
    const port = Number(portInput.value);
    const name = (nameInput.value || '').trim();
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setSaveHint('invalid port', 'fail'); return;
    }
    if (!name) { setSaveHint('name required', 'fail'); return; }
    if (state.config.ports.some((p) => p.port === port)) {
      setSaveHint(`port ${port} already monitored`, 'fail'); return;
    }
    const arr = state.config.ports.slice();
    arr.push({ port, name });
    putConfig({ ports: arr })
      .then(() => { portInput.value = ''; nameInput.value = ''; portInput.focus(); setSaveHint(`added ${name}`, 'ok'); })
      .catch((err) => setSaveHint(err.message, 'fail'));
  });

  document.getElementById('save-dash').addEventListener('click', () => {
    const dp    = Number(document.getElementById('dash-port').value);
    const iface = document.getElementById('iface').value.trim();
    if (!Number.isInteger(dp) || dp < 1 || dp > 65535) {
      setSaveHint('invalid dashboard port', 'fail'); return;
    }
    putConfig({ dashboardPort: dp, interface: iface || null })
      .then(() => setSaveHint('saved · restart for listener changes', 'ok'))
      .catch((err) => setSaveHint(err.message, 'fail'));
  });

  // ── boot ────────────────────────────────────────────────────

  applyRoute();
  connectWs();
})();
