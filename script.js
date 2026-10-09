(function () {
  'use strict';

  /* ------------------------------------------------------------------
     Mend: self-repairing replicated file store (front-end simulation)
     - Every file lives on RF nodes, placed zone-aware
     - A background "scrubber" checks checksums and node heartbeats
     - Corrupt / stale / missing replicas are repaired from a healthy copy
     - Modified files show ORANGE, deleted files show RED
  ------------------------------------------------------------------ */

  const KEY = 'mend-store-v1';
  const RF = 3;            // replication factor
  const GRACE = 3000;      // ms to wait before re-replicating off a dead node
  const TICK = 1200;       // scrubber interval

  const NODE_DEFS = [
    { id: 'N1', name: 'node-1', zone: 'zone-a' },
    { id: 'N2', name: 'node-2', zone: 'zone-a' },
    { id: 'N3', name: 'node-3', zone: 'zone-b' },
    { id: 'N4', name: 'node-4', zone: 'zone-b' },
    { id: 'N5', name: 'node-5', zone: 'zone-c' }
  ];

  const STATE_LABEL = {
    healthy: 'healthy',
    repairing: 'syncing',
    corrupt: 'checksum mismatch',
    stale: 'out of date'
  };

  let state;
  let filter = 'all';
  let query = '';
  let editingId = null;
  let lastCheck = Date.now();
  const flash = new Set();

  const $ = (s) => document.querySelector(s);
  const enc = new TextEncoder();
  const uid = () => Math.random().toString(36).slice(2, 9);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /* ---------- helpers ---------- */

  // Fast 64-bit style checksum (demo). Swap for SHA-256 in a real backend.
  function checksum(bytes) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < bytes.length; i++) {
      const ch = bytes[i];
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }

  function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }

  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });
  const node = (id) => state.nodes.find((n) => n.id === id);
  const getFile = (id) => state.files.find((f) => f.id === id);
  const isHealthy = (r) => r.state === 'healthy' && node(r.node).up;

  function toast(msg, tone) {
    const el = document.createElement('div');
    el.className = 'toast ' + (tone || '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  function log(kind, msg) {
    state.log.unshift({ t: Date.now(), kind, msg });
    if (state.log.length > 100) state.log.pop();
  }

  /* ---------- persistence ---------- */

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage full or blocked */ }
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.nodes && s.files) {
        state = s;
        state.files.forEach((f) => f.replicas.forEach((r) => {
          if (r.state === 'repairing') r.state = 'stale';
        }));
        return;
      }
    } catch (e) { /* fall through to seed */ }
    seed();
  }

  function seed() {
    state = {
      nodes: NODE_DEFS.map((n) => ({ ...n, up: true, downSince: 0 })),
      files: [],
      log: [],
      repairs: 0,
      settings: { auto: true, chaos: false }
    };
    const samples = [
      ['config.yaml', 'replicas: 3\nscrub_interval: 30s\nplacement: zone-aware\n'],
      ['report-q3.md', '# Q3 report\n\nUptime held at 99.98% across all zones.\n'],
      ['users.csv', 'id,name,plan\n1,Asha,pro\n2,Ravi,free\n3,Meena,pro\n'],
      ['deploy-notes.txt', 'Rollout order: zone-a, zone-b, zone-c.\nRoll back if 3 heartbeats are missed.\n'],
      ['backup-0914.sql', '-- snapshot\nCREATE TABLE files (id int, name text);\n']
    ];
    samples.forEach(([name, text]) => {
      const bytes = enc.encode(text);
      createFile(name, bytes.length, checksum(bytes), text, true);
    });
    createFile('logo.png', 48213, checksum(enc.encode('logo.png-binary')), null, true);
    log('info', 'Cluster ready: 5 nodes, 3 copies of every file, zone-aware placement.');
  }

  /* ---------- placement ---------- */

  function nodeLoad(id) {
    let c = 0;
    state.files.forEach((f) => f.replicas.forEach((r) => { if (r.node === id) c++; }));
    return c;
  }

  // Pick `count` online nodes, preferring zones the file is not in yet, then least loaded.
  function pickNodes(count, excludeIds) {
    const cand = state.nodes.filter((n) => n.up && !excludeIds.includes(n.id));
    const used = new Set(excludeIds.map((id) => node(id).zone));
    const chosen = [];
    while (chosen.length < count && cand.length) {
      cand.sort((a, b) =>
        (used.has(a.zone) - used.has(b.zone)) ||
        (nodeLoad(a.id) - nodeLoad(b.id)) ||
        (Math.random() - 0.5));
      const n = cand.shift();
      chosen.push(n);
      used.add(n.zone);
    }
    return chosen;
  }

  /* ---------- file operations ---------- */

  function createFile(name, size, hash, content, instant) {
    const f = {
      id: uid(), name, size, hash, content,
      version: 1, status: instant ? 'ok' : 'new',
      createdAt: Date.now(), updatedAt: Date.now(),
      history: [], replicas: []
    };
    const targets = pickNodes(RF, []);
    f.replicas = targets.map((n) => ({ node: n.id, state: instant ? 'healthy' : 'repairing', hash }));
    state.files.push(f);
    if (!instant) {
      flash.add(f.id);
      f.replicas.forEach((r) => scheduleHeal(f.id, r.node, 900 + Math.random() * 700, null));
      log('new', `<b>${esc(name)}</b> stored on ${targets.map((n) => n.id).join(', ')}.`);
    }
    return f;
  }

  function modifyFile(f, hash, size, content, source) {
    f.history.push({ v: f.version, hash: f.hash, at: f.updatedAt });
    const from = f.version;
    f.version++;
    f.hash = hash;
    f.size = size;
    if (content !== undefined) f.content = content;
    f.status = 'modified';
    f.updatedAt = Date.now();
    f.lost = false;
    f.replicas.forEach((r) => {
      if (node(r.node).up) {
        r.state = 'repairing';
        scheduleHeal(f.id, r.node, 900 + Math.random() * 700, null);
      } else {
        r.state = 'stale';
      }
    });
    flash.add(f.id);
    log('modified', `<b>${esc(f.name)}</b> modified (v${from} to v${f.version}) ${esc(source)}.`);
  }

  function deleteFile(f, source) {
    f.status = 'deleted';
    f.deletedAt = Date.now();
    f.updatedAt = Date.now();
    flash.add(f.id);
    log('deleted', `<b>${esc(f.name)}</b> deleted ${esc(source)}. Replicas on ${f.replicas.map((r) => r.node).join(', ')} are marked for removal.`);
  }

  function restoreFile(f) {
    f.status = 'modified';
    f.updatedAt = Date.now();
    flash.add(f.id);
    log('modified', `<b>${esc(f.name)}</b> restored from deleted.`);
  }

  function purgeFile(f) {
    state.files = state.files.filter((x) => x.id !== f.id);
    log('info', `<b>${esc(f.name)}</b> permanently removed from all nodes.`);
  }

  function reviveFile(f, hash, size, content) {
    f.replicas = [];
    f.hash = hash; f.size = size; f.content = content;
    f.version++;
    f.status = 'modified';
    f.updatedAt = Date.now();
    const targets = pickNodes(RF, []);
    f.replicas = targets.map((n) => ({ node: n.id, state: 'repairing', hash }));
    f.replicas.forEach((r) => scheduleHeal(f.id, r.node, 900 + Math.random() * 700, null));
    flash.add(f.id);
    log('modified', `<b>${esc(f.name)}</b> uploaded again after deletion (v${f.version}).`);
  }

  function scheduleHeal(fid, nid, delay, msg) {
    setTimeout(() => {
      const f = getFile(fid);
      if (!f) return;
      const r = f.replicas.find((x) => x.node === nid);
      if (!r || r.state !== 'repairing') return;
      if (!node(nid).up) { r.state = 'stale'; render(); return; }
      r.state = 'healthy';
      r.hash = f.hash;
      if (msg) { state.repairs++; log('repair', msg); }
      save();
      render();
    }, delay);
  }

  /* ---------- health ---------- */

  function fileHealth(f) {
    const h = f.replicas.filter(isHealthy).length;
    const inflight = f.replicas.filter((r) => r.state === 'repairing' && node(r.node).up).length;
    let label = 'healthy';
    if (h === 0 && inflight === 0) label = 'lost';
    else if (h >= RF) label = 'healthy';
    else if (inflight > 0) label = 'repairing';
    else label = 'degraded';
    return { h, inflight, label };
  }

  function clusterHealth() {
    const live = state.files.filter((f) => f.status !== 'deleted');
    if (!live.length) return 100;
    const sum = live.reduce((a, f) => a + Math.min(fileHealth(f).h / RF, 1), 0);
    return Math.round((sum / live.length) * 100);
  }

  /* ---------- self-repair engine ---------- */

  function repairTick(force) {
    const now = Date.now();
    state.files.forEach((f) => {
      if (f.status === 'deleted') return;

      // 1. Fix corrupt or out-of-date replicas on nodes that are online
      f.replicas.forEach((r) => {
        if (!node(r.node).up) return;
        if (r.state !== 'corrupt' && r.state !== 'stale') return;
        const source = f.replicas.find((x) => x !== r && isHealthy(x));
        if (!source) return;
        const why = r.state === 'corrupt' ? 'checksum mismatch' : 'out-of-date copy';
        r.state = 'repairing';
        scheduleHeal(f.id, r.node, 1100, `<b>${esc(f.name)}</b>: ${why} on ${r.node} fixed from ${source.node}.`);
      });

      // 2. Count what is left
      const h = fileHealth(f);
      if (h.h === 0 && h.inflight === 0) {
        if (!f.lost) {
          f.lost = true;
          log('lost', `<b>${esc(f.name)}</b> has no healthy replica. It cannot be repaired until a node with a good copy returns.`);
        }
        return;
      }
      f.lost = false;

      // 3. Under-replicated: copy to a new node (after a grace period for flaky nodes)
      if (h.h + h.inflight < RF && h.h > 0) {
        const waiting = !force && f.replicas.some((r) => {
          const n = node(r.node);
          return !n.up && now - n.downSince < GRACE;
        });
        if (!waiting) {
          const targets = pickNodes(RF - h.h - h.inflight, f.replicas.map((r) => r.node));
          const src = f.replicas.find(isHealthy);
          targets.forEach((n) => {
            f.replicas.push({ node: n.id, state: 'repairing', hash: f.hash });
            scheduleHeal(f.id, n.id, 1300, `<b>${esc(f.name)}</b>: new replica created on ${n.id} from ${src.node}.`);
          });
        }
      }

      // 4. Over-replicated (a failed node came back): trim the extra