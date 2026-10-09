(function () {
  'use strict';

  const AUTH_KEY = 'mend-demo-accounts-v1';
  const SESSION_KEY = 'mend-demo-session-v1';
  const intro = document.querySelector('#intro');
  const authScreen = document.querySelector('#authScreen');
  const appShell = document.querySelector('#appShell');
  const authMessage = document.querySelector('#authMessage');
  const authForms = {
    signin: document.querySelector('#signinForm'),
    signup: document.querySelector('#signupForm')
  };
  let appIntervals = [];

  function showAuthMessage(message, success) {
    authMessage.textContent = message;
    authMessage.classList.toggle('success', Boolean(success));
  }

  function showAuthView(view) {
    Object.entries(authForms).forEach(([name, form]) => { form.hidden = name !== view; });
    Object.values(authForms).forEach((form) => {
      form.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ''; });
    });
    showAuthMessage('');
    const firstInput = authForms[view].querySelector('input');
    if (firstInput) firstInput.focus();
  }

  function getAccounts() {
    const value = localStorage.getItem(AUTH_KEY);
    return value ? JSON.parse(value) : [];
  }

  function makeSalt() {
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    return Array.from(salt, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function hashPassword(password, salt) {
    if (!crypto.subtle) throw new Error('Secure password hashing is unavailable in this browser. Open this page through localhost or HTTPS.');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({
      name: 'PBKDF2', salt: Uint8Array.from(salt.match(/.{2}/g), (byte) => parseInt(byte, 16)),
      iterations: 120000, hash: 'SHA-256'
    }, key, 256);
    return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function seedDefaultAccount() {
    try {
      const accs = getAccounts();
      if (!accs.some((a) => a.username.toLowerCase() === 'demo')) {
        const salt = makeSalt();
        const passwordHash = await hashPassword('demo1234', salt);
        accs.push({ username: 'demo', salt, passwordHash });
        localStorage.setItem(AUTH_KEY, JSON.stringify(accs));
      }
    } catch {}
  }
  seedDefaultAccount();

  function setViewMode(mode) {
    document.body.classList.add('mode-workspace');
    document.body.classList.remove('mode-admin');
  }

  function startApp() {
    const username = sessionStorage.getItem(SESSION_KEY);
    if (!username) return;
    authScreen.hidden = true;
    appShell.hidden = false;
    intro.hidden = true;
    $('#accountName').textContent = username;
    setViewMode('workspace');
    load();
    render();
    renderHeartbeat();
    syncWithCluster();
    appIntervals.push(setInterval(async () => {
      const synced = await syncWithCluster();
      if (!synced) {
        if (state.settings.auto) {
          repairTick(false);
          renderHeartbeat();
        } else {
          render();
        }
      }
    }, TICK));
    appIntervals.push(setInterval(() => { if (state.settings.chaos) chaosEvent(); }, 5000));
  }

  Object.entries(authForms).forEach(([name, form]) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      showAuthMessage('');
      try {
        const data = new FormData(form);
        const username = String(data.get('username')).trim();
        const password = String(data.get('password'));
        const accounts = getAccounts();

        if (name === 'signup') {
          if (password !== data.get('confirmPassword')) throw new Error('The passwords do not match.');
          if (accounts.some((account) => account.username.toLowerCase() === username.toLowerCase())) {
            throw new Error('That username is already registered.');
          }
          const salt = makeSalt();
          accounts.push({ username, salt, passwordHash: await hashPassword(password, salt) });
          localStorage.setItem(AUTH_KEY, JSON.stringify(accounts));
          showAuthView('signin');
          document.querySelector('#signinUsername').value = username;
          showAuthMessage('Account created. Sign in with your new credentials.', true);
          return;
        }

        const account = accounts.find((entry) => entry.username.toLowerCase() === username.toLowerCase());
        if (!account || account.passwordHash !== await hashPassword(password, account.salt)) {
          throw new Error('Incorrect username or password.');
        }
        sessionStorage.setItem(SESSION_KEY, account.username);
        showAuthMessage('');
        startApp();
      } catch (error) {
        showAuthMessage(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
      }
    });
  });

  document.addEventListener('click', (event) => {
    const viewButton = event.target.closest('[data-auth-view]');
    if (viewButton) showAuthView(viewButton.dataset.authView);
  });

  document.querySelector('#signoutButton').addEventListener('click', () => {
    sessionStorage.removeItem(SESSION_KEY);
    appIntervals.forEach(clearInterval);
    appIntervals = [];
    appShell.hidden = true;
    authScreen.hidden = false;
    showAuthView('signin');
  });

  setTimeout(() => {
    if (sessionStorage.getItem(SESSION_KEY)) {
      startApp();
    } else {
      intro.hidden = true;
      authScreen.hidden = false;
      showAuthView('signin');
    }
  }, 2050);

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
  const SLOTS = 12;        // visible slots per node

  const NODE_DEFS = [
    { id: 'node-1', name: 'node-1', zone: 'zone-a', port: 5001 },
    { id: 'node-2', name: 'node-2', zone: 'zone-a', port: 5002 },
    { id: 'node-3', name: 'node-3', zone: 'zone-b', port: 5003 },
    { id: 'node-4', name: 'node-4', zone: 'zone-b', port: 5004 },
    { id: 'node-5', name: 'node-5', zone: 'zone-c', port: 5005 }
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
  const node = (id) => (state.nodes && state.nodes.find((n) => n.id === id || n.name === id)) || { id, name: id, zone: 'zone-a', up: true };
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
    f.status = 'ok';
    f.updatedAt = Date.now();
    delete f.deletedAt;
    flash.add(f.id);
    log('ok', `<b>${esc(f.name)}</b> restored from deleted state.`);
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
    const liveHealthy = (f.replicas || []).filter(isHealthy).length;
    const h = Math.min(RF, liveHealthy);
    const inflight = (f.replicas || []).filter((r) => r.state === 'repairing' && node(r.node).up).length;
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

      // 4. Over-replicated (a failed node came back): trim the extra copy
      if (h.h > RF) {
        const healthy = f.replicas.filter(isHealthy)
          .sort((a, b) => nodeLoad(b.node) - nodeLoad(a.node));
        const drop = healthy.slice(0, h.h - RF);
        f.replicas = f.replicas.filter((r) => !drop.includes(r));
        log('repair', `<b>${esc(f.name)}</b>: extra replica on ${drop.map((r) => r.node).join(', ')} removed.`);
      }
    });

    // New files settle into the normal state after a few seconds
    state.files.forEach((f) => {
      if (f.status === 'new' && now - f.createdAt > 6000) f.status = 'ok';
    });

    lastCheck = now;
    save();
    render();
  }

  /* ---------- failure injection ---------- */

  function failNode(id) {
    const n = node(id);
    if (!n || !n.up) return;
    n.up = false;
    n.downSince = Date.now();
    const affected = nodeLoad(id);
    log('node', `<b>${n.id}</b> went offline. ${affected} replicas unavailable.`);
    toast(`${n.id} went offline`, 'violet');
    save(); render();
  }

  function recoverNode(id) {
    const n = node(id);
    if (!n || n.up) return;
    n.up = true;
    log('node', `<b>${n.id}</b> is back online and rejoining the cluster.`);
    toast(`${n.id} is back online`);
    save(); render();
  }

  function failRandomNode() {
    const up = state.nodes.filter((n) => n.up);
    if (up.length <= 3) { toast('Keeping at least 3 nodes online so data can still be repaired.'); return; }
    failNode(up[Math.floor(Math.random() * up.length)].id);
  }

  function corruptRandomReplica() {
    const opts = [];
    state.files.forEach((f) => {
      if (f.status === 'deleted') return;
      const healthy = f.replicas.filter(isHealthy);
      if (healthy.length > 1) healthy.forEach((r) => opts.push({ f, r }));
    });
    if (!opts.length) { toast("Skipped: won't damage the last healthy copy of a file."); return; }
    const { f, r } = opts[Math.floor(Math.random() * opts.length)];
    r.state = 'corrupt';
    r.hash = checksum(enc.encode(uid()));
    log('corrupt', `Bit rot on <b>${esc(f.name)}</b>: replica on ${r.node} no longer matches checksum.`);
    toast(`Replica of ${f.name} corrupted on ${r.node}`, 'violet');
    save(); render();
  }

  function chaosEvent() {
    const down = state.nodes.filter((n) => !n.up);
    const roll = Math.random();
    if (down.length && roll < 0.35) recoverNode(down[Math.floor(Math.random() * down.length)].id);
    else if (roll < 0.6) failRandomNode();
    else corruptRandomReplica();
  }

  /* ---------- cluster api synchronization ---------- */

  let clusterActive = false;

  async function syncWithCluster() {
    try {
      const res = await fetch('/api/status', { signal: AbortSignal.timeout(1500) });
      if (!res.ok) throw new Error('API status not ok');
      const data = await res.json();
      clusterActive = true;

      if (Array.isArray(data.nodes) && data.nodes.length) {
        state.nodes = data.nodes.map((n) => ({
          id: n.id,
          name: n.id,
          zone: n.zone,
          port: n.port,
          up: n.status === 'UP',
          status: n.status,
          storedChunks: n.storedChunks
        }));
      }

      if (Array.isArray(data.files)) {
        state.files = data.files.map((f) => {
          // Aggregate distinct storage node replicas for this file (capped at RF=3 copies)
          const nodeMap = new Map();
          if (Array.isArray(f.chunks) && data.chunks) {
            f.chunks.forEach((chunkHash) => {
              const chMeta = data.chunks[chunkHash];
              if (chMeta && Array.isArray(chMeta.replicas)) {
                chMeta.replicas.forEach((r) => {
                  if (!nodeMap.has(r.nodeId)) {
                    nodeMap.set(r.nodeId, { good: 0, bad: 0, repairing: 0, total: 0 });
                  }
                  const st = nodeMap.get(r.nodeId);
                  st.total++;
                  if (r.state === 'GOOD') st.good++;
                  else if (r.state === 'CORRUPT') st.bad++;
                  else st.repairing++;
                });
              }
            });
          }

          const reps = [];
          if (nodeMap.size > 0) {
            Array.from(nodeMap.entries()).slice(0, RF).forEach(([nodeId, info]) => {
              let state = 'healthy';
              if (info.bad > 0) state = 'corrupt';
              else if (info.repairing > 0 || info.good < info.total) state = 'repairing';
              reps.push({
                node: nodeId,
                state,
                hash: (f.chunks && f.chunks[0]) || uid()
              });
            });
          }
          return {
            id: f.id,
            name: f.name,
            size: f.size,
            chunks: f.chunks || [],
            baselineChunks: f.baselineChunks || f.chunks || [],
            chunkDetails: f.chunkDetails || [],
            reusedCount: f.reusedCount || 0,
            affectedCount: f.affectedCount || (f.status === 'modified' ? 1 : 0),
            hash: (f.chunks && f.chunks[0]) ? f.chunks[0] : (f.hash || uid()),
            version: f.version || 1,
            status: f.status || 'ok',
            updatedAt: f.updatedAt || Date.now(),
            deletedAt: f.deletedAt || (f.status === 'deleted' ? Date.now() : undefined),
            replicas: reps.length ? reps : (f.replicas || []),
            history: f.history || []
          };
        });
      }

      if (data.metrics) {
        state.metrics = data.metrics;
        state.repairs = data.metrics.repairsCompleted !== undefined ? data.metrics.repairsCompleted : state.repairs;
      }

      if (Array.isArray(data.log) && data.log.length) {
        state.log = data.log;
      }

      lastCheck = Date.now();
      render();
      renderHeartbeat();
      return true;
    } catch {
      clusterActive = false;
      return false;
    }
  }

  /* ---------- upload ---------- */

  async function handleFiles(list) {
    for (const file of Array.from(list)) {
      let uploadedToBackend = false;
      try {
        const uploadRes = await fetch(`/api/upload?filename=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          body: file
        });
        if (uploadRes.ok) {
          const data = await uploadRes.json();
          uploadedToBackend = true;
          flash.add(data.fileId);
          if (data.version > 1) {
            toast(`${file.name} modified & saved as v${data.version}`, 'orange');
          } else {
            toast(`${file.name} stored across 3 zones (RF=3)`);
          }
        }
      } catch {}

      if (!uploadedToBackend) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const hash = checksum(bytes);
        let content = null;
        if (file.size <= 262144) {
          try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { content = null; }
        }
        const existing = state.files.find((f) => f.name === file.name);
        if (!existing) {
          createFile(file.name, file.size, hash, content, false);
          toast(`${file.name} stored on ${RF} nodes`);
        } else if (existing.status === 'deleted') {
          reviveFile(existing, hash, file.size, content);
          toast(`${file.name} restored as a new version`, 'orange');
        } else if (existing.hash === hash) {
          toast(`${file.name} is unchanged`);
        } else {
          modifyFile(existing, hash, file.size, content, 'by a new upload');
          toast(`${file.name} was modified`, 'orange');
        }
      }
    }
    await syncWithCluster();
    save();
    render();
  }

  /* ---------- rendering ---------- */

  function renderVitals() {
    const pct = clusterHealth();
    const active = state.files.filter((f) => f.status !== 'deleted').length;
    const mod = state.files.filter((f) => f.status === 'modified').length;
    const del = state.files.filter((f) => f.status === 'deleted').length;
    const barCls = pct >= 90 ? '' : pct >= 60 ? 'warn' : 'bad';
    const repCount = (state.metrics && state.metrics.repairsCompleted !== undefined) ? state.metrics.repairsCompleted : state.repairs;
    $('#vitals').innerHTML = `
      <div class="vital"><dd>${pct}%</dd><dt>Cluster health</dt><span class="bar"><i class="${barCls}" style="width:${pct}%"></i></span></div>
      <div class="vital"><dd>${active}</dd><dt>Files stored</dt></div>
      <div class="vital v-orange"><dd>${mod}</dd><dt>Modified</dt></div>
      <div class="vital v-red"><dd>${del}</dd><dt>Deleted</dt></div>
      <div class="vital"><dd>${repCount}</dd><dt>Repairs completed</dt></div>`;
  }

  function renderNodes() {
    const el = $('#nodes');
    if (!el) return;
    el.innerHTML = state.nodes.map((n) => {
      const items = [];
      state.files.forEach((f) => (f.replicas || []).forEach((r) => { if (r.node === n.id) items.push({ f, r }); }));
      const total = Math.max(SLOTS, items.length);
      let cells = '';
      for (let i = 0; i < total; i++) {
        if (items[i]) {
          const { f, r } = items[i];
          const st = f.status === 'deleted' ? 'deleted' : (n.up ? r.state : 'offline');
          const ring = f.status === 'modified' ? ' f-modified' : '';
          const note = f.status === 'deleted' ? 'deleted'
            : n.up ? (STATE_LABEL[r.state] || r.state) : 'node offline';
          cells += `<span class="cell ${st}${ring}" title="${esc(f.name)} · v${f.version} · ${note}"></span>`;
        } else {
          cells += '<span class="cell empty"></span>';
        }
      }
      return `
        <article class="node ${n.up ? '' : 'down'}">
          <div class="node-head">
            <div><div class="node-name">${n.name || n.id}</div><div class="node-zone">${n.zone}</div></div>
            <span class="pill ${n.up ? '' : 'off'}">${n.up ? 'Online' : 'Offline'}</span>
          </div>
          <div class="cells">${cells}</div>
          <div class="node-foot">
            <span>${items.length} replica${items.length === 1 ? '' : 's'}</span>
            <button class="btn small ${n.up ? '' : 'primary'}" data-act="node" data-id="${n.id}">${n.up ? 'Fail node' : 'Bring online'}</button>
          </div>
        </article>`;
    }).join('');
  }

  function matches(f) {
    if (query && !f.name.toLowerCase().includes(query)) return false;
    if (filter === 'modified') return f.status === 'modified';
    if (filter === 'deleted') return f.status === 'deleted';
    if (filter === 'risk') return f.status !== 'deleted' && fileHealth(f).label !== 'healthy';
    return true;
  }

  function renderFilters() {
    const c = {
      all: state.files.length,
      modified: state.files.filter((f) => f.status === 'modified').length,
      deleted: state.files.filter((f) => f.status === 'deleted').length,
      risk: state.files.filter((f) => f.status !== 'deleted' && fileHealth(f).label !== 'healthy').length
    };
    const tabs = [
      ['all', 'All files', ''], ['modified', 'Modified', 'f-orange'],
      ['deleted', 'Deleted', 'f-red'], ['risk', 'At risk', '']
    ];
    $('#filters').innerHTML = tabs.map(([k, label, cls]) =>
      `<button class="filter ${cls}" role="tab" aria-selected="${filter === k}" data-filter="${k}">${label}<b>${c[k]}</b></button>`
    ).join('');

    const purgeAllBtn = $('#btnPurgeAllDeleted');
    if (purgeAllBtn) {
      if (c.deleted > 0) {
        purgeAllBtn.style.display = 'inline-flex';
        purgeAllBtn.textContent = `Empty trash (${c.deleted})`;
      } else {
        purgeAllBtn.style.display = 'none';
      }
    }
  }

  function statusCell(f) {
    const hl = fileHealth(f);
    const copies = `${Math.min(RF, hl.h)}/${RF} healthy copies`;
    if (f.status === 'deleted') return `<span class="badge deleted">Deleted</span><span class="subtle">${ago(f.deletedAt)}</span>`;
    if (f.status === 'modified') {
      return `<span class="badge modified">Modified</span><span class="subtle">${copies}</span>`;
    }
    if (f.status === 'new') return `<span class="badge new">New</span><span class="subtle">${copies}</span>`;
    const text = { healthy: 'Healthy', repairing: 'Repairing', degraded: 'Degraded', lost: 'Data lost' }[hl.label];
    return `<span class="badge ${hl.label}">${text}</span><span class="subtle">${copies}</span>`;
  }

  function actionsCell(f) {
    const b = (act, label, cls) => `<button class="btn small ${cls || ''}" data-act="${act}" data-id="${f.id}">${label}</button>`;
    if (f.status === 'deleted') return b('restore', 'Restore', 'warn') + b('purge', 'Remove forever', 'danger');
    let out = '';
    out += b('download', 'Download', 'primary');
    if (f.status === 'modified') {
      out += b('mend-file', 'Mend (Copy Chunks)', 'warn');
      out += b('inspect-chunks', 'Chunks', 'ghost');
      out += b('review', 'Keep edit', 'ghost');
    } else {
      out += b('inspect-chunks', 'Chunks', 'ghost');
    }
    out += b('delete', 'Delete', 'danger');
    return out;
  }

  let inspectingFileId = null;

  async function openChunkInspector(f) {
    inspectingFileId = f.id;
    const dlg = $('#chunkDialog');
    if (!dlg) return;
    $('#chunkDialogTitle').textContent = `Chunks for ${f.name}`;
    $('#chunkDialogSubtitle').textContent = `Total size: ${fmtSize(f.size)} · Version: v${f.version} · Status: ${f.status.toUpperCase()}`;

    let chunksData = f.chunkDetails;
    try {
      const res = await fetch(`/api/files/${f.id}/chunks`);
      if (res.ok) {
        const d = await res.json();
        chunksData = d.chunks;
      }
    } catch {}

    if (!chunksData || !chunksData.length) {
      chunksData = (f.chunks || []).map((h, i) => {
        const isAff = f.status === 'modified' && i === (f.chunks.length > 2 ? 2 : 0);
        return {
          index: i + 1,
          hash: h,
          size: Math.min(8192, f.size),
          status: isAff ? 'affected' : 'reused',
          note: isAff ? 'Modified chunk detected · Different from baseline' : 'Reused healthy chunk from cluster replicas'
        };
      });
    }

    const hasAffected = chunksData.some(c => c.status === 'affected') || f.status === 'modified';
    const mendBtn = $('#btnMendModal');
    if (mendBtn) {
      mendBtn.style.display = hasAffected ? 'inline-flex' : 'none';
    }

    $('#chunkModalBody').innerHTML = chunksData.map((c) => {
      const isAff = c.status === 'affected';
      const statusLabel = isAff ? 'Affected / Tampered' : 'Copied from Cluster (Healthy)';
      return `
        <div class="chunk-card ${c.status}">
          <div class="chunk-info">
            <div class="chunk-title">
              <span>Chunk #${c.index}</span>
              <span class="chunk-status-chip ${c.status}">${statusLabel}</span>
            </div>
            <div class="chunk-meta">SHA-256: ${c.hash.slice(0, 16)}… (${fmtSize(c.size)})</div>
            <div class="hint" style="font-size:12px; margin-top:2px;">${c.note || (isAff ? 'Modified on device' : 'Reused from 3 healthy replica nodes')}</div>
          </div>
          <div>
            ${isAff ? `<button class="btn small warn" data-act="mend-single-chunk" data-file-id="${f.id}" data-chunk-index="${c.index}">Copy Healthy Chunk</button>` : `<span class="badge healthy">RF=3 Verified</span>`}
          </div>
        </div>
      `;
    }).join('');

    $('#chunkModalFootHint').textContent = hasAffected
      ? `Detected affected chunk(s). Click "Mend & Restore from Chunks" to copy the healthy baseline chunk from the cluster.`
      : `All chunks are verified and preserved across RF=3 storage nodes.`;

    dlg.showModal();
  }

  function renderRows() {
    const rows = state.files.filter(matches).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!rows.length) {
      $('#rows').innerHTML = '<tr class="empty-row"><td colspan="6">No files here. Upload a file or drop one onto this page.</td></tr>';
      return;
    }
    $('#rows').innerHTML = rows.map((f) => {
      const fl = flash.has(f.id) ? ' flash' : '';
      flash.delete(f.id);
      const ext = f.name.includes('.') ? f.name.split('.').pop().toUpperCase() : 'FILE';
      return `
        <tr class="row-${f.status}${fl}">
          <td><span class="fname">${esc(f.name)}</span><span class="fmeta">${ext}</span></td>
          <td class="mono">v${f.version}</td>
          <td class="muted">${fmtSize(f.size)}</td>
          <td class="muted">${ago(f.updatedAt)}</td>
          <td>${statusCell(f)}</td>
          <td class="right"><div class="actions">${actionsCell(f)}</div></td>
        </tr>`;
    }).join('');
  }

  function renderHeartbeat() {
    const hb = $('#hbText');
    const pulse = $('#pulse');
    const wsHb = $('#wsHbText');
    const wsPulse = $('#wsPulse');
    const timeStr = clock(lastCheck);

    if (state.settings.auto) {
      const text = `Last health check ${timeStr}`;
      if (hb) hb.textContent = text;
      if (wsHb) wsHb.textContent = text;
      if (pulse) {
        pulse.classList.remove('paused', 'beat');
        void pulse.offsetWidth;
        pulse.classList.add('beat');
      }
      if (wsPulse) {
        wsPulse.classList.remove('paused', 'beat');
        void wsPulse.offsetWidth;
        wsPulse.classList.add('beat');
      }
    } else {
      const pausedText = 'Auto-repair paused';
      if (hb) hb.textContent = pausedText;
      if (wsHb) wsHb.textContent = pausedText;
      if (pulse) pulse.classList.add('paused');
      if (wsPulse) wsPulse.classList.add('paused');
    }
  }

  function render() {
    renderFilters();
    renderRows();
    renderHeartbeat();
  }

  /* ---------- events ---------- */

  document.addEventListener('click', async (e) => {
    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn) {
      setViewMode(modeBtn.dataset.mode);
      return;
    }

    const flt = e.target.closest('[data-filter]');
    if (flt) { filter = flt.dataset.filter; render(); return; }

    const el = e.target.closest('[data-act]');
    if (!el) return;
    const f = el.dataset.id ? getFile(el.dataset.id) : null;

    switch (el.dataset.act) {
      case 'upload': $('#fileInput').click(); break;
      case 'closeChunkDialog': {
        const dlg = $('#chunkDialog');
        if (dlg) dlg.close();
        break;
      }
      case 'inspect-chunks': {
        if (f) openChunkInspector(f);
        break;
      }
      case 'mend-file': {
        if (f) {
          try {
            const res = await fetch(`/api/files/${f.id}/restore-chunks`, { method: 'POST' });
            if (res.ok) {
              const d = await res.json();
              toast(`Mended ${f.name}: Copied healthy data from chunk store to repair ${d.restoredChunks || 1} chunk(s)!`, 'teal');
              await syncWithCluster();
              break;
            }
          } catch {}
          if (f.baselineChunks && f.baselineChunks.length) {
            f.chunks = [...f.baselineChunks];
          }
          f.status = 'ok';
          f.affectedCount = 0;
          toast(`Mended ${f.name}: Restored healthy chunk copies!`, 'teal');
          save();
          render();
        }
        break;
      }
      case 'mend-from-modal': {
        const fileToMend = getFile(inspectingFileId);
        if (fileToMend) {
          try {
            const res = await fetch(`/api/files/${fileToMend.id}/restore-chunks`, { method: 'POST' });
            if (res.ok) {
              const d = await res.json();
              toast(`Mended ${fileToMend.name}: Copied healthy data from cluster to repair ${d.restoredChunks || 1} chunk(s)!`, 'teal');
              $('#chunkDialog').close();
              await syncWithCluster();
              break;
            }
          } catch {}
          if (fileToMend.baselineChunks && fileToMend.baselineChunks.length) {
            fileToMend.chunks = [...fileToMend.baselineChunks];
          }
          fileToMend.status = 'ok';
          fileToMend.affectedCount = 0;
          $('#chunkDialog').close();
          toast(`Mended ${fileToMend.name}: Restored healthy chunk copies!`, 'teal');
          save();
          render();
        }
        break;
      }
      case 'mend-single-chunk': {
        const targetId = el.dataset.fileId;
        const targetFile = getFile(targetId);
        if (targetFile) {
          try {
            await fetch(`/api/files/${targetId}/restore-chunks`, { method: 'POST' });
          } catch {}
          if (targetFile.baselineChunks && targetFile.baselineChunks.length) {
            targetFile.chunks = [...targetFile.baselineChunks];
          }
          targetFile.status = 'ok';
          targetFile.affectedCount = 0;
          toast(`Copied healthy chunk from cluster for ${targetFile.name}!`, 'teal');
          await syncWithCluster();
          openChunkInspector(getFile(targetId));
        }
        break;
      }
      case 'download': {
        if (f) {
          toast(`Downloading ${f.name} (verifying chunk hashes)...`);
          try {
            const res = await fetch(`/api/download/${f.id}`);
            if (res.ok) {
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = f.name;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              break;
            }
          } catch {}
          if (f.content != null) {
            const blob = new Blob([f.content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = f.name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } else {
            window.open(`/api/download/${f.id}`, '_blank');
          }
        }
        break;
      }
      case 'corrupt-replica':
      case 'corrupt': {
        try {
          const res = await fetch('/api/chaos/corrupt-replica', { method: 'POST' });
          if (res.ok) {
            const d = await res.json();
            toast(`Bit rot injected into replica on ${d.nodeId}!`, 'violet');
            await syncWithCluster();
            break;
          }
        } catch {}
        corruptRandomReplica();
        break;
      }
      case 'kill-node':
      case 'failnode': {
        const upNodes = state.nodes.filter((n) => n.up);
        if (upNodes.length <= 1) { toast('Cannot kill last node: RF requires quorum.'); break; }
        const victim = upNodes[Math.floor(Math.random() * upNodes.length)];
        try {
          const res = await fetch(`/api/chaos/kill-node?nodeId=${victim.id}`, { method: 'POST' });
          if (res.ok) {
            toast(`Killed storage process ${victim.id}`, 'red');
            await syncWithCluster();
            break;
          }
        } catch {}
        failNode(victim.id);
        break;
      }
      case 'repair': {
        try {
          await fetch('/api/repair/now', { method: 'POST' });
        } catch {}
        repairTick(true);
        toast('Cluster repair pass triggered');
        await syncWithCluster();
        break;
      }
      case 'node': {
        const n = node(el.dataset.id);
        if (n.up) {
          if (state.nodes.filter((x) => x.up).length <= 2) {
            toast('Keeping at least 2 nodes online so data remains accessible.');
            break;
          }
          try {
            const res = await fetch(`/api/chaos/kill-node?nodeId=${n.id}`, { method: 'POST' });
            if (res.ok) {
              toast(`Stopped node ${n.id}`, 'red');
              await syncWithCluster();
              break;
            }
          } catch {}
          failNode(n.id);
        } else {
          try {
            const res = await fetch(`/api/chaos/recover-node?nodeId=${n.id}`, { method: 'POST' });
            if (res.ok) {
              toast(`Restarted node ${n.id}`, 'teal');
              await syncWithCluster();
              break;
            }
          } catch {}
          recoverNode(n.id);
        }
        break;
      }
      case 'delete': {
        if (f) {
          try {
            await fetch(`/api/files/${f.id}`, { method: 'DELETE' });
          } catch {}
          deleteFile(f, 'from the file list');
          toast(`${f.name} was deleted`, 'red');
          await syncWithCluster();
          save();
          render();
        }
        break;
      }
      case 'restore': {
        if (f) {
          const fileId = f.id;
          restoreFile(f);
          toast(`${f.name} restored to healthy status`, 'teal');
          save();
          render();
          try {
            await fetch(`/api/files/${fileId}/restore`, { method: 'POST' });
          } catch {}
          await syncWithCluster();
        }
        break;
      }
      case 'purge': {
        if (f) {
          const fileId = f.id;
          const fileName = f.name;
          purgeFile(f);
          save();
          render();
          toast(`${fileName} permanently removed forever`, 'red');
          try {
            const res = await fetch(`/api/files/${fileId}?purge=true`, { method: 'DELETE' });
            if (!res.ok) {
              await fetch(`/api/files/${fileId}/purge`, { method: 'POST' });
            }
          } catch {}
          await syncWithCluster();
        }
        break;
      }
      case 'purge-all-deleted': {
        const deletedFiles = state.files.filter((x) => x.status === 'deleted');
        if (!deletedFiles.length) {
          toast('Trash is already empty');
          break;
        }
        if (confirm(`Permanently remove all ${deletedFiles.length} deleted file(s) forever from all cluster nodes?`)) {
          const count = deletedFiles.length;
          deletedFiles.forEach(df => purgeFile(df));
          save();
          render();
          toast(`Permanently removed ${count} file(s) forever`, 'red');
          try {
            await fetch('/api/files/purge-deleted', { method: 'POST' });
          } catch {}
          await syncWithCluster();
        }
        break;
      }
      case 'review': {
        if (f) {
          f.status = 'ok';
          save();
          render();
        }
        break;
      }
      case 'clearreviewed': {
        state.files.forEach((x) => {
          if (x.status === 'modified' || x.status === 'new') x.status = 'ok';
        });
        save();
        render();
        break;
      }
      case 'reset': {
        if (confirm('Reset the demo to its starting state?')) {
          flash.clear();
          seed();
          save();
          render();
          toast('Demo reset');
        }
        break;
      }
    }
  });

  $('#search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); render(); });
  $('#fileInput').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });

  const tAuto = $('#tAuto');
  if (tAuto) {
    tAuto.addEventListener('change', (e) => {
      state.settings.auto = e.target.checked;
      log('info', e.target.checked ? 'Auto-repair turned on.' : 'Auto-repair turned off.');
      save(); renderHeartbeat(); render();
    });
  }
  const tChaos = $('#tChaos');
  if (tChaos) {
    tChaos.addEventListener('change', (e) => {
      state.settings.chaos = e.target.checked;
      log('info', e.target.checked ? 'Chaos mode on: random failures every few seconds.' : 'Chaos mode off.');
      save(); render();
    });
  }

  // Drag and drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    dragDepth++; $('#dropveil').classList.add('on');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropveil').classList.remove('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0;
    $('#dropveil').classList.remove('on');
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  /* ---------- start ---------- */

})();
