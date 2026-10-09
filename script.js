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
  const SLOTS = 12;        // visible slots per node

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

  /* ---------- upload ---------- */

  async function handleFiles(list) {
    for (const file of Array.from(list)) {
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
    save(); render();
  }

  /* ---------- editor ---------- */

  function openEdit(id) {
    const f = getFile(id);
    if (!f) return;
    editingId = id;
    $('#edTitle').textContent = 'Edit ' + f.name;
    const ta = $('#edText');
    ta.value = f.content == null ? '' : f.content;
    ta.disabled = f.content == null;
    $('#edHint').textContent = f.content == null
      ? 'Binary file. Upload a new copy to change it.'
      : 'Saving creates a new version and syncs it to every replica.';
    $('#edReplicas').innerHTML = f.replicas.map((r) => {
      const st = node(r.node).up ? r.state : 'offline';
      return `<span class="rchip ${st}" title="${esc(STATE_LABEL[r.state] || st)}">${r.node}</span>`;
    }).join('');
    const hist = [{ v: f.version, hash: f.hash, at: f.updatedAt }].concat(f.history.slice().reverse());
    $('#edHistory').innerHTML = hist.map((h, i) =>
      `<li><span>v${h.v}${i === 0 ? ' (current)' : ''}</span><span class="mono muted">${h.hash.slice(0, 8)}</span></li>`
    ).join('');
    $('#editor').showModal();
  }

  function saveEdit() {
    const f = getFile(editingId);
    if (!f || f.content == null) { $('#editor').close(); return; }
    const text = $('#edText').value;
    const bytes = enc.encode(text);
    const hash = checksum(bytes);
    if (hash === f.hash) { toast('No changes to save'); return; }
    modifyFile(f, hash, bytes.length, text, 'in the editor');
    $('#editor').close();
    toast(`${f.name} saved as v${f.version}`, 'orange');
    save(); render();
  }

  /* ---------- simulated watcher events ---------- */

  function simulateChange() {
    const live = state.files.filter((f) => f.status !== 'deleted');
    if (!live.length) { toast('No files to change. Upload one first.'); return; }
    const f = live[Math.floor(Math.random() * live.length)];
    if (f.content != null) {
      const text = f.content + `\n# changed by another process at ${clock(Date.now())}`;
      const bytes = enc.encode(text);
      modifyFile(f, checksum(bytes), bytes.length, text, 'by an outside process');
    } else {
      modifyFile(f, checksum(enc.encode(uid())), f.size + 512, undefined, 'by an outside process');
    }
    toast(`${f.name} was modified`, 'orange');
    save(); render();
  }

  function simulateDelete() {
    const live = state.files.filter((f) => f.status !== 'deleted');
    if (!live.length) { toast('No files to delete.'); return; }
    const f = live[Math.floor(Math.random() * live.length)];
    deleteFile(f, 'by an outside process');
    toast(`${f.name} was deleted`, 'red');
    save(); render();
  }

  /* ---------- rendering ---------- */

  function renderVitals() {
    const pct = clusterHealth();
    const active = state.files.filter((f) => f.status !== 'deleted').length;
    const mod = state.files.filter((f) => f.status === 'modified').length;
    const del = state.files.filter((f) => f.status === 'deleted').length;
    const barCls = pct >= 90 ? '' : pct >= 60 ? 'warn' : 'bad';
    $('#vitals').innerHTML = `
      <div class="vital"><dd>${pct}%</dd><dt>Cluster health</dt><span class="bar"><i class="${barCls}" style="width:${pct}%"></i></span></div>
      <div class="vital"><dd>${active}</dd><dt>Files stored</dt></div>
      <div class="vital v-orange"><dd>${mod}</dd><dt>Modified</dt></div>
      <div class="vital v-red"><dd>${del}</dd><dt>Deleted</dt></div>
      <div class="vital"><dd>${state.repairs}</dd><dt>Repairs completed</dt></div>`;
  }

  function renderNodes() {
    const el = $('#nodes');
    if (!el) return;
    el.innerHTML = state.nodes.map((n) => {
      const items = [];
      state.files.forEach((f) => f.replicas.forEach((r) => { if (r.node === n.id) items.push({ f, r }); }));
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
            <div><div class="node-name">${n.name}</div><div class="node-zone">${n.zone}</div></div>
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
  }

  function statusCell(f) {
    const hl = fileHealth(f);
    const copies = `${hl.h}/${RF} healthy copies`;
    if (f.status === 'deleted') return `<span class="badge deleted">Deleted</span><span class="subtle">${ago(f.deletedAt)}</span>`;
    if (f.status === 'modified') return `<span class="badge modified">Modified</span><span class="subtle">${copies}</span>`;
    if (f.status === 'new') return `<span class="badge new">New</span><span class="subtle">${copies}</span>`;
    const text = { healthy: 'Healthy', repairing: 'Repairing', degraded: 'Degraded', lost: 'Data lost' }[hl.label];
    return `<span class="badge ${hl.label}">${text}</span><span class="subtle">${copies}</span>`;
  }

  function actionsCell(f) {
    const b = (act, label, cls) => `<button class="btn small ${cls || ''}" data-act="${act}" data-id="${f.id}">${label}</button>`;
    if (f.status === 'deleted') return b('restore', 'Restore', 'warn') + b('purge', 'Remove forever', 'danger');
    let out = '';
    if (f.status === 'modified' || f.status === 'new') out += b('review', 'Mark reviewed', 'warn');
    if (f.content != null) out += b('edit', 'Edit');
    out += b('delete', 'Delete', 'danger');
    return out;
  }

  function renderRows() {
    const rows = state.files.filter(matches).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!rows.length) {
      $('#rows').innerHTML = '<tr class="empty-row"><td colspan="8">No files here. Upload a file or drop one onto this page.</td></tr>';
      return;
    }
    $('#rows').innerHTML = rows.map((f) => {
      const fl = flash.has(f.id) ? ' flash' : '';
      flash.delete(f.id);
      const ext = f.name.includes('.') ? f.name.split('.').pop().toUpperCase() : 'FILE';
      const chips = f.replicas.map((r) => {
        const st = f.status === 'deleted' ? 'tomb' : (node(r.node).up ? r.state : 'offline');
        return `<span class="rchip ${st}" title="${r.node}: ${f.status === 'deleted' ? 'marked for removal' : (STATE_LABEL[r.state] || r.state)}">${r.node}</span>`;
      }).join('');
      return `
        <tr class="row-${f.status}${fl}">
          <td><span class="fname">${esc(f.name)}</span><span class="fmeta">${ext}</span></td>
          <td><div class="rchips">${chips}</div></td>
          <td class="mono">v${f.version}</td>
          <td class="muted">${fmtSize(f.size)}</td>
          <td class="mono muted">${f.hash.slice(0, 8)}</td>
          <td class="muted">${ago(f.updatedAt)}</td>
          <td>${statusCell(f)}</td>
          <td class="right"><div class="actions">${actionsCell(f)}</div></td>
        </tr>`;
    }).join('');
  }

  function renderLog() {
    $('#log').innerHTML = state.log.map((e) =>
      `<li class="k-${e.kind}"><span class="dot"></span><div><time>${clock(e.t)}</time>${e.msg}</div></li>`
    ).join('');
  }

  function renderHeartbeat() {
    const hb = $('#hbText');
    const pulse = $('#pulse');
    if (state.settings.auto) {
      hb.textContent = `Last health check ${clock(lastCheck)}`;
      pulse.classList.remove('paused');
      pulse.classList.remove('beat');
      void pulse.offsetWidth;
      pulse.classList.add('beat');
    } else {
      hb.textContent = 'Auto-repair paused. Damage will not be fixed until you run repair.';
      pulse.classList.add('paused');
    }
  }

  function render() {
    renderVitals();
    renderNodes();
    renderFilters();
    renderRows();
    renderLog();
  }

  /* ---------- events ---------- */

  document.addEventListener('click', (e) => {
    const flt = e.target.closest('[data-filter]');
    if (flt) { filter = flt.dataset.filter; render(); return; }

    const el = e.target.closest('[data-act]');
    if (!el) return;
    const f = el.dataset.id ? getFile(el.dataset.id) : null;

    switch (el.dataset.act) {
      case 'upload': $('#fileInput').click(); break;
      case 'corrupt': corruptRandomReplica(); break;
      case 'failnode': failRandomNode(); break;
      case 'repair': repairTick(true); toast('Repair pass finished'); break;
      case 'node': {
        const n = node(el.dataset.id);
        if (n.up) {
          if (state.nodes.filter((x) => x.up).length <= 3) { toast('Keeping at least 3 nodes online so data can still be repaired.'); break; }
          failNode(n.id);
        } else recoverNode(n.id);
        break;
      }
      case 'edit': if (f) openEdit(f.id); break;
      case 'delete': if (f) { deleteFile(f, 'from the file list'); toast(`${f.name} was deleted`, 'red'); save(); render(); } break;
      case 'restore': if (f) { restoreFile(f); toast(`${f.name} restored`, 'orange'); save(); render(); } break;
      case 'purge': if (f) { purgeFile(f); save(); render(); } break;
      case 'review': if (f) { f.status = 'ok'; save(); render(); } break;
      case 'clearreviewed':
        state.files.forEach((x) => { if (x.status === 'modified' || x.status === 'new') x.status = 'ok'; });
        save(); render(); break;
      case 'simchange': simulateChange(); break;
      case 'simdelete': simulateDelete(); break;
      case 'saveEditor': saveEdit(); break;
      case 'closeEditor': $('#editor').close(); break;
      case 'reset':
        if (confirm('Reset the demo to its starting state?')) {
          flash.clear(); seed(); save(); render(); toast('Demo reset');
        }
        break;
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

  load();
  if (tAuto) tAuto.checked = state.settings.auto;
  if (tChaos) tChaos.checked = state.settings.chaos;
  render();
  renderHeartbeat();

  setInterval(() => {
    if (state.settings.auto) {
      repairTick(false);
      renderHeartbeat();
    } else {
      render();
    }
  }, TICK);

  setInterval(() => { if (state.settings.chaos) chaosEvent(); }, 5000);
})();
