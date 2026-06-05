/* ──────────────────────────────────────────────────────────────
   conduit — dashboard client
   WS stream · queue-based bar animation · subtle row pulses
   ────────────────────────────────────────────────────────────── */

(() => {
  'use strict';

  // ── port -> icon mapping ────────────────────────────────────
  // slug refers to a Simple Icons CDN slug. null = no logo available;
  // the row falls back to showing just the port number.

  const PORT_ICONS = {
    21:    'filezilla',
    22:    null,         // SSH — no good Simple Icons slug (openssh is not in the set)
    25:    null,
    53:    null,
    80:    'nginx',
    110:   null,
    143:   null,
    443:   'nginx',
    465:   null,
    587:   null,
    993:   null,
    995:   null,
    1433:  'microsoftsqlserver',
    2379:  'etcd',
    3000:  'nodedotjs',
    3001:  'nodedotjs',
    3306:  'mysql',
    4200:  'angular',
    5000:  'flask',
    5173:  'vite',
    5432:  'postgresql',
    5672:  'rabbitmq',
    6379:  'redis',
    8000:  'python',
    8080:  null,
    8443:  'nginx',
    8888:  'jupyter',
    9000:  null,
    9092:  'apachekafka',
    9200:  'elasticsearch',
    9418:  'git',
    11211: 'memcached',
    15672: 'rabbitmq',
    25565: 'minecraft',
    27017: 'mongodb'
  };

  function isAutoName(port, name) {
    return name === `Port ${port}` || !name;
  }

  // ── state ───────────────────────────────────────────────────

  const state = {
    config: { ports: [], dashboardPort: 4200, bindHost: '0.0.0.0', interface: null },
    stats: {},
    captureOk: false,
    captureMsg: 'connecting…',
    wsState: 'connecting',
    bootAt: Date.now()
  };

  // per-port animation buffer
  // { bars, queue, current, pulse, pulseLastTick }
  const sparkState = new Map();

  // sparkline geometry
  const SPARK_W   = 200;
  const SPARK_H   = 28;
  const BAR_W     = 2;
  const STRIDE    = 3;            // 2px bar + 1px gap
  const MAX_BARS  = 60;
  const ANIM_MS   = 150;
  const FLOOR_SIZE = 200;
  const PULSE_MS  = 400;
  const MAX_QUEUE = 24;           // queued packets above this commit instantly

  // colors resolved at boot from CSS custom properties
  let COL_IN       = '#7466c4';
  let COL_OUT      = '#a888c8';
  let COL_NEW      = '#c19a5b';
  let COL_ACTIVITY = '#7466c4';
  let COL_BASELINE = 'rgba(255,255,255,0.05)';

  function resolveColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (k, fb) => (cs.getPropertyValue(k) || '').trim() || fb;
    COL_IN       = v('--bar-in',   COL_IN);
    COL_OUT      = v('--bar-out',  COL_OUT);
    COL_NEW      = v('--accent',   COL_NEW);
    COL_ACTIVITY = v('--activity', COL_ACTIVITY);
  }

  // aggregate sparkline buffer — one sample per 'stats' tick
  const aggHistory = [];
  const AGG_HISTORY_MAX = 600;   // 600 samples * 500ms tick = 5 min

  // ── ws connect with backoff ─────────────────────────────────

  let ws;
  let wsBackoff = 800;

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    state.wsState = 'connecting';
    setStatus();
    updateBanner();
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      state.wsState = 'ok';
      wsBackoff = 800;
      setStatus();
      updateBanner();
    };
    ws.onclose = () => {
      state.wsState = 'closed';
      setStatus();
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
        state.stats  = msg.stats || {};
        for (const port in msg.recent || {}) {
          const st = ensureSparkState(Number(port));
          // pre-fill committed bars so the row isn't empty at first paint
          st.bars  = (msg.recent[port] || []).slice(-MAX_BARS);
          st.queue = [];
          st.current = null;
          updateChartState(Number(port));
        }
        renderRows();
        for (const port in state.stats) updateRowStats(Number(port));
        if (currentRoute() === 'settings') renderSettings();
        updateHeaderStats();
        updateFooter();
        updateAggregate(state.stats, msg.meta);
        scheduleRaf();
        break;

      case 'config':
        state.config = msg.config;
        renderRows();
        for (const port in state.stats) updateRowStats(Number(port));
        if (currentRoute() === 'settings') renderSettings();
        updateHeaderStats();
        updateFooter();
        scheduleRaf();
        break;

      case 'stats':
        state.stats = msg.stats || {};
        for (const port in state.stats) updateRowStats(Number(port));
        updateHeaderStats();
        updateAggregate(state.stats, msg.meta);
        break;

      case 'packets':
        for (const p of msg.batch || []) {
          pushPacket(p.port, p);
        }
        scheduleRaf();
        break;

      case 'status':
        state.captureOk  = !!msg.captureOk;
        state.captureMsg = msg.message || '';
        setStatus();
        updateBanner();
        updateHeaderStats();
        updateFooter();
        break;
    }
  }

  function ensureSparkState(port) {
    let st = sparkState.get(port);
    if (!st) {
      st = {
        bars: [],
        queue: [],
        current: null,
        pulse: 0,
        pulseLastTick: 0
      };
      sparkState.set(port, st);
    }
    return st;
  }

  function pushPacket(port, p) {
    const st = ensureSparkState(port);
    // overflow control: if queue is too long, commit oldest queued
    // packets straight into the bar buffer without animating them
    while (st.queue.length >= MAX_QUEUE) {
      const drop = st.queue.shift();
      st.bars.push(drop);
      if (st.bars.length > MAX_BARS) st.bars.shift();
    }
    st.queue.push({ dir: p.dir, size: p.size, ts: p.ts });
    updateChartState(port);
  }

  function updateChartState(port) {
    const row = document.querySelector(`.row[data-port="${port}"]`);
    if (!row) return;
    const cell = row.querySelector('.cell-chart');
    if (!cell) return;
    const st = sparkState.get(port);
    const hasData = !!(st && (st.bars.length || st.queue.length || st.current));
    cell.classList.toggle('has-data', hasData);
  }

  // ── routing ─────────────────────────────────────────────────

  function currentRoute() {
    return location.hash.startsWith('#/settings') ? 'settings' : 'dashboard';
  }

  function applyRoute() {
    const r = currentRoute();
    document.getElementById('view-dashboard').hidden = r !== 'dashboard';
    document.getElementById('view-settings').hidden  = r !== 'settings';
    document.querySelectorAll('.tab').forEach((a) => {
      a.classList.toggle('active', a.dataset.route === r);
    });
    if (r === 'settings') renderSettings();
    else { scheduleRaf(); }
  }

  window.addEventListener('hashchange', applyRoute);

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'g')      location.hash = '#/';
    else if (e.key === 's') location.hash = '#/settings';
  });

  // ── status / banner / header / footer ───────────────────────

  function setStatus() {
    const root = document.getElementById('status');
    const txt  = document.getElementById('status-text');
    if (state.wsState === 'closed') {
      root.dataset.state = 'error';
      txt.textContent = 'disconnected';
      return;
    }
    if (state.wsState === 'connecting') {
      root.dataset.state = 'connecting';
      txt.textContent = 'connecting';
      return;
    }
    if (!state.captureOk) {
      root.dataset.state = 'error';
      txt.textContent = 'capture down';
      return;
    }
    root.dataset.state = 'ok';
    txt.textContent = 'capturing';
  }

  function updateBanner() {
    const banner = document.getElementById('banner');
    if (state.wsState === 'closed') {
      banner.hidden = false;
      banner.className = 'banner banner-warn';
      banner.textContent = 'connection lost — reconnecting…';
      return;
    }
    if (state.wsState === 'connecting') { banner.hidden = true; return; }
    if (!state.captureOk) {
      banner.hidden = false;
      banner.className = 'banner';
      banner.textContent = 'packet capture is not running — ' + (state.captureMsg || 'unknown error');
      return;
    }
    banner.hidden = true;
  }

  function inferIface() {
    const m = (state.captureMsg || '').match(/on\s+(\S+)/);
    if (m) return m[1];
    return (state.config && state.config.interface) || 'auto';
  }

  function updateHeaderStats() {
    document.getElementById('hs-iface').textContent = state.captureOk ? inferIface() : '—';
    document.getElementById('hs-ports').textContent = String(state.config.ports.length);
    let pps = 0;
    for (const k in state.stats) pps += state.stats[k].reqPerSec || 0;
    document.getElementById('hs-pps').textContent = formatRps(pps);
    document.getElementById('hs-uptime').textContent = formatUptime(Date.now() - state.bootAt);
  }

  function updateFooter() {
    const meta  = document.getElementById('ftr-meta');
    const n     = state.config.ports.length;
    const iface = state.captureOk ? inferIface() : 'no-capture';
    meta.textContent = `conduit/0.1 · ${iface} · ${n} port${n === 1 ? '' : 's'} · :${state.config.dashboardPort}`;
  }

  setInterval(updateHeaderStats, 1000);

  // ── row build / render ──────────────────────────────────────

  const DASH = '<span class="dash">—</span>';

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
        fillPortCell(el.querySelector('.cell-name'), p);
      }
      frag.appendChild(el);
    }
    rowsEl.appendChild(frag);

    if (state.config.ports.length === 0) {
      document.getElementById('empty').hidden = false;
      document.querySelector('.grid').style.display = 'none';
    } else {
      document.getElementById('empty').hidden = true;
      document.querySelector('.grid').style.display = '';
    }
    updateFooter();
  }

  function buildRow(p) {
    const el = document.createElement('div');
    el.className = 'row';
    el.dataset.port = String(p.port);
    el.innerHTML =
      `<div class="cell cell-name"></div>` +
      `<div class="cell cell-chart">` +
        `<canvas class="spark" width="${SPARK_W}" height="${SPARK_H}"></canvas>` +
        `<span class="chart-empty">no traffic</span>` +
      `</div>` +
      `<div class="cell cell-num js-in">${DASH}</div>` +
      `<div class="cell cell-num js-out">${DASH}</div>` +
      `<div class="cell cell-num js-rps">${DASH}</div>` +
      `<div class="cell cell-mono js-src">${DASH}</div>` +
      `<div class="cell cell-num js-total">${DASH}</div>` +
      `<div class="cell cell-last js-last">${DASH}</div>`;
    fillPortCell(el.querySelector('.cell-name'), p);
    initCanvas(el.querySelector('canvas'));
    return el;
  }

  function resolveIconSrc(p) {
    const custom = (p.icon || '').trim();
    if (custom) {
      // URL (http/https/protocol-relative/absolute path) → use as-is.
      // Otherwise treat as a Simple Icons slug and colorize muted.
      if (/^(https?:\/\/|\/\/|\/)/i.test(custom)) return custom;
      return `https://cdn.simpleicons.org/${encodeURIComponent(custom)}/8a8a8a`;
    }
    // No custom icon — auto-detect only if name is also auto
    if (isAutoName(p.port, p.name)) {
      const slug = PORT_ICONS[p.port];
      if (slug) return `https://cdn.simpleicons.org/${slug}/8a8a8a`;
    }
    return null;
  }

  function fillPortCell(cell, p) {
    const auto = isAutoName(p.port, p.name);
    const iconSrc = resolveIconSrc(p);
    cell.innerHTML = '';

    if (iconSrc) {
      const iconWrap = document.createElement('span');
      iconWrap.className = 'port-icon';
      const img = document.createElement('img');
      img.className = 'port-icon-img';
      img.alt = '';
      img.width = 18;
      img.height = 18;
      img.loading = 'lazy';
      img.src = iconSrc;
      img.onerror = () => { iconWrap.remove(); };
      iconWrap.appendChild(img);
      cell.appendChild(iconWrap);
    }

    if (!auto) {
      // custom name (with or without icon) — name on top, :port small below
      const text = document.createElement('div');
      text.className = 'port-text';
      const name = document.createElement('div');
      name.className = 'port-name';
      name.textContent = p.name;
      const portNum = document.createElement('div');
      portNum.className = 'port-num';
      portNum.textContent = ':' + p.port;
      text.appendChild(name);
      text.appendChild(portNum);
      cell.appendChild(text);
    } else if (iconSrc) {
      // auto name with icon — small :port next to icon
      const portNum = document.createElement('div');
      portNum.className = 'port-num';
      portNum.textContent = ':' + p.port;
      cell.appendChild(portNum);
    } else {
      // no icon, no custom name — just :port on its own
      const portMain = document.createElement('div');
      portMain.className = 'port-num-only';
      portMain.textContent = ':' + p.port;
      cell.appendChild(portMain);
    }
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

  // ── stat cell updates with flash & fade ─────────────────────

  function setNumCell(el, newHtml, prev, curr) {
    el.innerHTML = newHtml;
    if (typeof prev === 'number' && typeof curr === 'number' && prev > 0 && curr !== prev) {
      const cls = curr > prev ? 'flash-up' : 'flash-down';
      el.classList.remove('flash-up', 'flash-down');
      // force reflow so re-adding the class restarts the transition
      void el.offsetWidth;
      el.classList.add(cls);
      clearTimeout(el.__flashT);
      el.__flashT = setTimeout(() => el.classList.remove(cls), 120);
    }
  }

  function setSrcCell(el, newSrc) {
    const cur = el.dataset.src || '';
    if (cur === (newSrc || '')) return;
    if (cur) {
      el.classList.add('fading');
      clearTimeout(el.__srcT);
      el.__srcT = setTimeout(() => {
        el.innerHTML = newSrc ? escapeHtml(newSrc) : DASH;
        el.classList.remove('fading');
      }, 200);
    } else {
      el.innerHTML = newSrc ? escapeHtml(newSrc) : DASH;
    }
    el.dataset.src = newSrc || '';
  }

  function updateRowStats(port) {
    const row = document.querySelector(`.row[data-port="${port}"]`);
    if (!row) return;
    const s = state.stats[port];
    if (!s) return;

    const inEl  = row.querySelector('.js-in');
    const outEl = row.querySelector('.js-out');
    const rpsEl = row.querySelector('.js-rps');
    const totEl = row.querySelector('.js-total');
    const lastEl= row.querySelector('.js-last');

    const prevIn  = +(inEl.dataset.val  || 0);
    const prevOut = +(outEl.dataset.val || 0);
    const prevRps = +(rpsEl.dataset.val || 0);
    const prevTot = +(totEl.dataset.val || 0);

    const inHtml  = s.inAvg  > 0 ? formatInt(Math.round(s.inAvg))  : DASH;
    const outHtml = s.outAvg > 0 ? formatInt(Math.round(s.outAvg)) : DASH;
    const rpsHtml = s.reqPerSec > 0 ? formatRps(s.reqPerSec)       : DASH;
    const totHtml = s.total  > 0 ? formatInt(s.total)              : DASH;

    setNumCell(inEl,  inHtml,  prevIn,  s.inAvg  || 0);
    setNumCell(outEl, outHtml, prevOut, s.outAvg || 0);
    setNumCell(rpsEl, rpsHtml, prevRps, s.reqPerSec || 0);
    setNumCell(totEl, totHtml, prevTot, s.total || 0);

    inEl.dataset.val  = String(s.inAvg  || 0);
    outEl.dataset.val = String(s.outAvg || 0);
    rpsEl.dataset.val = String(s.reqPerSec || 0);
    totEl.dataset.val = String(s.total || 0);

    lastEl.innerHTML = s.lastSeen ? formatTime(s.lastSeen) : DASH;

    setSrcCell(row.querySelector('.js-src'), s.topSource || '');
  }

  // ── formatting ──────────────────────────────────────────────

  function formatRps(v) {
    if (v <= 0) return '0';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    if (v >= 100)  return Math.round(v).toString();
    if (v >= 10)   return v.toFixed(1);
    return v.toFixed(2);
  }

  function formatInt(n) {
    if (n < 1000) return String(n);
    // narrow-ish thousands separator — terminal-y look
    return n.toLocaleString('en-US').replace(/,/g, ' ');
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const pad = (x) => String(x).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
    if (m > 0) return `${m}m${String(r).padStart(2, '0')}s`;
    return `${r}s`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── sparkline render ────────────────────────────────────────

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function drawSpark(canvas, st) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, SPARK_W, SPARK_H);

    // always-visible baseline
    ctx.fillStyle = COL_BASELINE;
    ctx.fillRect(0, SPARK_H - 1, SPARK_W, 1);

    const bars = st.bars;
    const N = bars.length;
    if (!N && !st.current) return;

    // normalize across committed bars + the bar currently animating in
    let maxSize = FLOOR_SIZE;
    for (let i = 0; i < N; i++) if (bars[i].size > maxSize) maxSize = bars[i].size;
    if (st.current && st.current.packet.size > maxSize) maxSize = st.current.packet.size;
    const maxH = SPARK_H - 3;

    // existing bars: slide left during animation
    let slide = 0;
    if (st.current) slide = -STRIDE * easeOutCubic(st.current.t);

    for (let i = 0; i < N; i++) {
      const b = bars[i];
      // newest committed bar (i = N - 1) sits at the right edge;
      // older bars step left by STRIDE each
      const xBase = (SPARK_W - BAR_W) - (N - 1 - i) * STRIDE;
      const x = Math.round(xBase + slide);
      if (x + BAR_W < 0 || x > SPARK_W) continue;
      const ratio = Math.min(1, b.size / maxSize);
      const h = Math.max(1, Math.round(maxH * ratio));
      const y = SPARK_H - 1 - h;
      ctx.fillStyle = b.dir === 'in' ? COL_IN : COL_OUT;
      ctx.fillRect(x, y, BAR_W, h);
    }

    // newly animating bar — pinned to the right edge, height grows
    if (st.current) {
      const eased = easeOutCubic(st.current.t);
      const ratio = Math.min(1, st.current.packet.size / maxSize);
      const fullH = Math.max(1, Math.round(maxH * ratio));
      const h = Math.max(1, Math.round(fullH * eased));
      ctx.fillStyle = COL_NEW;
      ctx.fillRect(SPARK_W - BAR_W, SPARK_H - 1 - h, BAR_W, h);
    }
  }

  // ── master animation loop (rAF) ─────────────────────────────

  let rafId = 0;
  let lastTickAt = 0;

  function scheduleRaf() {
    if (rafId || document.hidden) return;
    rafId = requestAnimationFrame(rafTick);
  }

  function rafTick(now) {
    rafId = 0;
    const dt = lastTickAt ? now - lastTickAt : 0;
    lastTickAt = now;

    let stillActive = false;

    for (const [port, st] of sparkState) {
      const row = document.querySelector(`.row[data-port="${port}"]`);
      const canvas = row ? row.querySelector('.spark') : null;

      // advance current animation
      if (st.current) {
        const t = Math.min(1, (now - st.current.startTime) / st.current.animMs);
        st.current.t = t;
        if (t >= 1) {
          // commit packet to bars
          st.bars.push(st.current.packet);
          if (st.bars.length > MAX_BARS) st.bars.shift();
          st.current = null;
        }
      }

      // start next from queue if no current animation in flight
      if (!st.current && st.queue.length > 0) {
        const packet = st.queue.shift();
        // shorten animation when queue is backed up so we don't fall behind
        const animMs = st.queue.length > 0
          ? Math.max(40, ANIM_MS / Math.max(1, 0.5 + st.queue.length * 0.7))
          : ANIM_MS;
        st.current = { packet, startTime: now, animMs, t: 0 };
        // start a row-indicator pulse for this packet
        st.pulse = 1;
      }

      // decay pulse
      if (st.pulse > 0) {
        st.pulse = Math.max(0, st.pulse - dt / PULSE_MS);
        if (row) row.style.setProperty('--pulse', st.pulse.toFixed(3));
      }

      // redraw
      if (canvas) drawSpark(canvas, st);

      if (st.current || st.queue.length > 0 || st.pulse > 0) stillActive = true;
    }

    if (stillActive) rafId = requestAnimationFrame(rafTick);
    else             lastTickAt = 0;
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleRaf();
  });

  // ── aggregate summary ───────────────────────────────────────

  function updateAggregate(stats, meta) {
    let pps = 0;
    let totalPkts = 0;
    for (const k in stats) {
      pps += stats[k].reqPerSec || 0;
      totalPkts += stats[k].total || 0;
    }
    setText('ag-pps', formatRps(pps));
    setText('ag-packets', formatInt(totalPkts));
    setText('ag-sources', String((meta && meta.activeSourcesCount) || 0));

    aggHistory.push(pps);
    while (aggHistory.length > AGG_HISTORY_MAX) aggHistory.shift();

    renderTopSources(meta);
    drawAggSpark();
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function renderTopSources(meta) {
    const list = document.getElementById('sources-list');
    if (!list) return;
    const sources = (meta && meta.topSources) || [];
    if (!sources.length) {
      list.innerHTML = '<div class="sources-empty">no sources yet</div>';
      return;
    }
    list.innerHTML = sources.map((s) => {
      const ports = (s.ports || []);
      let portsHtml;
      if (ports.length <= 3) {
        portsHtml = ports.map((p) => `<span class="port-tag">:${p}</span>`).join(' ');
      } else {
        portsHtml = ports.slice(0, 2).map((p) => `<span class="port-tag">:${p}</span>`).join(' ')
                  + ` <span class="port-tag">+${ports.length - 2}</span>`;
      }
      return `<div class="src-row">` +
               `<span class="src-ip">${escapeHtml(s.ip)}</span>` +
               `<span class="src-count">${formatInt(s.count)}</span>` +
               `<span class="src-ports">${portsHtml}</span>` +
             `</div>`;
    }).join('');
  }

  function ensureAggCanvas() {
    const c = document.getElementById('agg-spark');
    if (!c) return null;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    const w = Math.max(200, Math.round(rect.width));
    const h = 72;
    const targetW = w * dpr;
    const targetH = h * dpr;
    if (c.width !== targetW || c.height !== targetH) {
      c.width = targetW;
      c.height = targetH;
      c.style.height = h + 'px';
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
    }
    c.__cssW = w;
    c.__cssH = h;
    return c;
  }

  function drawAggSpark() {
    const c = ensureAggCanvas();
    if (!c) return;
    const ctx = c.getContext('2d');
    const W = c.__cssW;
    const H = c.__cssH;
    ctx.clearRect(0, 0, W, H);

    // baseline rule
    ctx.fillStyle = COL_BASELINE;
    ctx.fillRect(0, H - 1, W, 1);

    const n = aggHistory.length;
    if (!n) return;

    // y-scale: normalize to current max with a floor so flat-zero still reads as a line
    let maxV = 5;
    for (let i = 0; i < n; i++) if (aggHistory[i] > maxV) maxV = aggHistory[i];
    const yScale = (H - 4) / maxV;       // 4px top + bottom padding

    // x-scale: spread the buffer across the canvas, right-anchored at "now"
    const stride = W / Math.max(n, AGG_HISTORY_MAX);
    const xOffset = W - n * stride;       // shift left until buffer fills the canvas

    // build filled area
    ctx.beginPath();
    ctx.moveTo(xOffset, H - 1);
    for (let i = 0; i < n; i++) {
      const x = xOffset + i * stride;
      const y = H - 1 - aggHistory[i] * yScale;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(xOffset + (n - 1) * stride, H - 1);
    ctx.closePath();
    ctx.fillStyle = withAlpha(COL_ACTIVITY, 0.18);
    ctx.fill();

    // stroke the top line — sharper edge on the leading sample
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xOffset + i * stride;
      const y = H - 1 - aggHistory[i] * yScale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = COL_ACTIVITY;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function withAlpha(hex, alpha) {
    // accepts #rrggbb — returns rgba()
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 0xff;
    const g = (n >> 8)  & 0xff;
    const b =  n        & 0xff;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // redraw on window resize so the agg-spark fills its column at the new width
  let aggResizeT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(aggResizeT);
    aggResizeT = setTimeout(() => drawAggSpark(), 150);
  });

  // ── settings page ───────────────────────────────────────────

  function renderSettings() {
    const list = document.getElementById('setlist');
    list.innerHTML = '';

    const countEl = document.getElementById('ports-count');
    if (countEl) countEl.textContent = String(state.config.ports.length);

    if (!state.config.ports.length) {
      const empty = document.createElement('div');
      empty.className = 'set-empty';
      empty.textContent = 'no ports configured yet — add one below';
      list.appendChild(empty);
    }

    state.config.ports.forEach((p, i) => {
      const auto = isAutoName(p.port, p.name);
      const row = document.createElement('div');
      row.className = 'setrow';
      row.innerHTML =
        `<span class="port-chip">${escapeHtml(String(p.port))}</span>` +
        `<input type="text" class="js-name" value="${auto ? '' : escapeHtml(p.name)}" placeholder="auto" maxlength="40" />` +
        `<input type="text" class="js-icon" value="${escapeHtml(p.icon || '')}" placeholder="slug or URL" maxlength="200" />` +
        `<span class="move">` +
          `<button class="icon-btn js-up"   ${i === 0 ? 'disabled' : ''} title="move up">↑</button>` +
          `<button class="icon-btn js-down" ${i === state.config.ports.length - 1 ? 'disabled' : ''} title="move down">↓</button>` +
        `</span>` +
        `<button class="icon-btn danger js-rm" title="remove">×</button>`;
      row.querySelector('.js-up').onclick   = () => move(i, -1);
      row.querySelector('.js-down').onclick = () => move(i, +1);
      row.querySelector('.js-rm').onclick   = () => removeAt(i);
      const nameInput = row.querySelector('.js-name');
      nameInput.onchange = () => renameAt(i, nameInput.value);
      const iconInput = row.querySelector('.js-icon');
      iconInput.onchange = () => setIconAt(i, iconInput.value);
      list.appendChild(row);
    });

    document.getElementById('dash-port').value = state.config.dashboardPort;
    document.getElementById('bind-host').value = state.config.bindHost || '0.0.0.0';
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
    const arr = state.config.ports.slice();
    arr[i] = { ...arr[i], name: (name || '').trim() };
    putConfig({ ports: arr });
  }

  function setIconAt(i, icon) {
    const arr = state.config.ports.slice();
    arr[i] = { ...arr[i], icon: (icon || '').trim() };
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
        updateHeaderStats();
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
    const iconInput = document.getElementById('add-icon');
    const port = Number(portInput.value);
    const name = (nameInput.value || '').trim();
    const icon = (iconInput.value || '').trim();
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setSaveHint('invalid port', 'fail'); return;
    }
    if (state.config.ports.some((p) => p.port === port)) {
      setSaveHint(`port ${port} already monitored`, 'fail'); return;
    }
    const arr = state.config.ports.slice();
    arr.push({ port, name, icon });
    putConfig({ ports: arr })
      .then(() => { portInput.value = ''; nameInput.value = ''; iconInput.value = ''; portInput.focus(); setSaveHint(`added :${port}`, 'ok'); })
      .catch((err) => setSaveHint(err.message, 'fail'));
  });

  document.getElementById('save-dash').addEventListener('click', () => {
    const dp    = Number(document.getElementById('dash-port').value);
    const host  = document.getElementById('bind-host').value.trim() || '0.0.0.0';
    const iface = document.getElementById('iface').value.trim();
    if (!Number.isInteger(dp) || dp < 1 || dp > 65535) {
      setSaveHint('invalid dashboard port', 'fail'); return;
    }
    putConfig({ dashboardPort: dp, bindHost: host, interface: iface || null })
      .then(() => setSaveHint('saved — restart for listener changes', 'ok'))
      .catch((err) => setSaveHint(err.message, 'fail'));
  });

  // ── boot ────────────────────────────────────────────────────

  requestAnimationFrame(() => {
    resolveColors();
    // initial paint for any rows that exist but have no spark state yet
    document.querySelectorAll('.row .spark').forEach((c) => {
      const port = Number(c.closest('.row').dataset.port);
      drawSpark(c, ensureSparkState(port));
    });
  });

  applyRoute();
  updateHeaderStats();
  updateFooter();
  connectWs();
})();
