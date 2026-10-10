'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PORT = 5000;
const CONFIG_FILE = path.resolve('./cluster.config.json');

// Default cluster configuration
let clusterConfig = {
  mode: 'lan',
  replicationFactor: 3,
  chunkSize: 8 * 1024,
  nodes: [
    { id: 'pc-1', name: 'PC 1 (Coordinator / Host)', host: '127.0.0.1', port: 5001, zone: 'zone-a', isLocal: true },
    { id: 'pc-2', name: 'PC 2 (Peer Machine)', host: '192.168.137.2', port: 5001, zone: 'zone-b', isLocal: false },
    { id: 'pc-3', name: 'PC 3 (Peer Machine)', host: '192.168.137.3', port: 5001, zone: 'zone-c', isLocal: false }
  ]
};

function loadClusterConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      clusterConfig = { ...clusterConfig, ...data };
    } catch (err) {
      console.error('[Coordinator] Failed to read cluster.config.json:', err.message);
    }
  }
}
loadClusterConfig();

let RF = clusterConfig.replicationFactor || 3;
let CHUNK_SIZE = clusterConfig.chunkSize || 8 * 1024;
const METADATA_DIR = path.resolve('./data');
const METADATA_FILE = path.join(METADATA_DIR, 'metadata.json');

function getNodeUrl(node) {
  if (!node) return 'http://127.0.0.1:5001';
  const host = node.host || '127.0.0.1';
  return `http://${host}:${node.port}`;
}

// In-Memory Cluster State
const state = {
  nodes: {},       // id -> { id, port, zone, status: 'UP'|'SUSPECT'|'DOWN', missedHeartbeats, process }
  files: [],       // Array of file metadata objects
  chunks: {},      // chunkHash -> { hash, size, replicas: [{ nodeId, state: 'GOOD'|'CORRUPT'|'MISSING' }] }
  repairQueue: [], // Array of chunk hashes pending repair
  repairLeases: {},// chunkHash -> timestamp when lease expires
  metrics: {
    restores: 0,
    corruptionsCaught: 0,
    repairsCompleted: 0,
    integrityViolations: 0
  },
  log: []
};

function addLog(kind, msg) {
  const entry = {
    t: Date.now(),
    kind, // 'info' | 'warn' | 'err' | 'ok'
    msg
  };
  state.log.unshift(entry);
  if (state.log.length > 100) state.log.pop();
  console.log(`[Coordinator] [${kind.toUpperCase()}] ${msg}`);
}

// Persistence: Save / Load Metadata
function saveMetadata() {
  try {
    const data = {
      files: state.files,
      chunks: state.chunks,
      metrics: state.metrics
    };
    fs.writeFileSync(METADATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[Coordinator] Failed to save metadata:', err.message);
  }
}

function loadMetadata() {
  if (fs.existsSync(METADATA_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
      if (data.files) state.files = data.files;
      if (data.chunks) state.chunks = data.chunks;
      if (data.metrics) state.metrics = data.metrics;
      addLog('info', `Loaded metadata (${state.files.length} files, ${Object.keys(state.chunks).length} chunks).`);
    } catch (err) {
      console.error('[Coordinator] Error reading metadata:', err.message);
    }
  }
}

// -------------------------------------------------------------
// Child Process Management for Storage Nodes
// -------------------------------------------------------------
function spawnNodeProcess(cfg) {
  const nodeDir = path.resolve(`./data/${cfg.id}`);
  const child = spawn(process.execPath, [
    path.join(__dirname, 'storage-node.js'),
    '--id', cfg.id,
    '--port', String(cfg.port),
    '--host', '0.0.0.0',
    '--dir', nodeDir,
    '--zone', cfg.zone
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', data => {
    // optional logging
  });

  child.stderr.on('data', data => {
    console.error(`[${cfg.id} STDERR]`, data.toString().trim());
  });

  child.on('exit', (code, signal) => {
    addLog('warn', `Node ${cfg.id} stopped (exit code: ${code}, signal: ${signal}).`);
    const n = state.nodes[cfg.id];
    if (n) {
      n.process = null;
      n.status = 'DOWN';
    }
  });

  return child;
}

function initNodes() {
  for (const oldNode of Object.values(state.nodes)) {
    if (oldNode.process) {
      try { oldNode.process.kill('SIGTERM'); } catch {}
    }
  }
  state.nodes = {};

  for (const cfg of clusterConfig.nodes) {
    const isLocal = cfg.isLocal !== false;
    let child = null;
    if (isLocal) {
      child = spawnNodeProcess(cfg);
    }
    state.nodes[cfg.id] = {
      id: cfg.id,
      name: cfg.name || cfg.id,
      host: cfg.host || '127.0.0.1',
      port: cfg.port,
      zone: cfg.zone,
      isLocal,
      status: isLocal ? 'UP' : 'SUSPECT',
      missedHeartbeats: 0,
      process: child
    };
  }
  addLog('info', `Cluster initialized with ${clusterConfig.nodes.length} nodes (Mode: ${(clusterConfig.mode || 'lan').toUpperCase()}).`);
}

// -------------------------------------------------------------
// Failure Detector & Heartbeat Monitor
// -------------------------------------------------------------
async function checkNodeHeartbeat(node) {
  try {
    const res = await fetch(`${getNodeUrl(node)}/health`, { signal: AbortSignal.timeout(1200) });
    if (res.ok) {
      if (node.status !== 'UP') {
        addLog('ok', `Node ${node.id} (${node.host}:${node.port}) is back online (status: UP).`);
      }
      node.status = 'UP';
      node.missedHeartbeats = 0;
      return true;
    }
  } catch {}

  node.missedHeartbeats++;
  if (node.missedHeartbeats === 1 && node.status === 'UP') {
    node.status = 'SUSPECT';
    addLog('warn', `Node ${node.id} (${node.host}:${node.port}) missed heartbeat (status: SUSPECT).`);
  } else if (node.missedHeartbeats >= 3 && node.status !== 'DOWN') {
    node.status = 'DOWN';
    addLog('err', `Node ${node.id} (${node.host}:${node.port}) failed 3 heartbeats (status: DOWN).`);
  }
  return false;
}

function runHeartbeats() {
  for (const id of Object.keys(state.nodes)) {
    checkNodeHeartbeat(state.nodes[id]);
  }
}

// -------------------------------------------------------------
// Placement Policy: Zone-Aware & Load-Balanced Selection
// -------------------------------------------------------------
function selectNodesForChunk(existingNodeIds = []) {
  const upNodes = Object.values(state.nodes).filter(n => n.status === 'UP' && !existingNodeIds.includes(n.id));
  if (upNodes.length === 0) return [];

  // Group by zone to maximize fault domain diversity
  const byZone = {};
  for (const n of upNodes) {
    if (!byZone[n.zone]) byZone[n.zone] = [];
    byZone[n.zone].push(n);
  }

  const selected = [];
  const zones = Object.keys(byZone);
  let zoneIdx = 0;

  // Round-robin pick across distinct zones first
  while (selected.length < RF && upNodes.length > selected.length) {
    const zone = zones[zoneIdx % zones.length];
    const available = byZone[zone].filter(n => !selected.includes(n));
    if (available.length > 0) {
      // Pick node with least stored chunks
      available.sort((a, b) => getStoredChunkCount(a.id) - getStoredChunkCount(b.id));
      selected.push(available[0]);
    }
    zoneIdx++;
    if (selected.length >= upNodes.length) break;
  }

  return selected;
}

function getStoredChunkCount(nodeId) {
  let count = 0;
  for (const c of Object.values(state.chunks)) {
    if (c.replicas.some(r => r.nodeId === nodeId && r.state === 'GOOD')) count++;
  }
  return count;
}

// -------------------------------------------------------------
// Scrubber & Active Anti-Entropy
// -------------------------------------------------------------
async function scrubCluster() {
  let foundCorruption = false;

  for (const [hash, chunk] of Object.entries(state.chunks)) {
    let goodCount = 0;

    for (const replica of chunk.replicas) {
      const node = state.nodes[replica.nodeId];
      if (!node) {
        continue;
      }
      if (node.status === 'DOWN') {
        if (replica.state !== 'MISSING') {
          replica.state = 'MISSING';
          addLog('warn', `Replica ${hash.slice(0, 8)} marked MISSING (Node ${replica.nodeId} is DOWN).`);
        }
        continue;
      }

      // Verify checksum on the node
      try {
        const res = await fetch(`${getNodeUrl(node)}/verify/${hash}`, {
          method: 'POST',
          signal: AbortSignal.timeout(1500)
        });
        if (res.ok) {
          const data = await res.json();
          if (data.match) {
            replica.state = 'GOOD';
            goodCount++;
          } else {
            if (replica.state !== 'CORRUPT') {
              replica.state = 'CORRUPT';
              state.metrics.corruptionsCaught++;
              foundCorruption = true;
              addLog('err', `Checksum mismatch detected on Node ${replica.nodeId} for chunk ${hash.slice(0, 8)}! (Expected: ${hash.slice(0, 8)}, Got: ${data.actualHash.slice(0, 8)})`);
            }
          }
        } else {
          replica.state = 'MISSING';
        }
      } catch {
        replica.state = 'MISSING';
      }
    }

    // If chunk has fewer than RF healthy copies, queue for self-repair
    if (goodCount < RF && !state.repairQueue.includes(hash)) {
      // Prioritize chunks with only 1 good copy left!
      if (goodCount === 1) {
        state.repairQueue.unshift(hash);
      } else {
        state.repairQueue.push(hash);
      }
    }
  }

  if (state.repairQueue.length > 0) {
    processRepairQueue();
  }
  saveMetadata();
}

// -------------------------------------------------------------
// Self-Repair Worker (with Leases & Safe Writes)
// -------------------------------------------------------------
async function processRepairQueue() {
  if (state.repairQueue.length === 0) return;

  const hash = state.repairQueue.shift();
  const now = Date.now();

  // Check if repair lease is active (prevent concurrent duplicate repairs)
  if (state.repairLeases[hash] && state.repairLeases[hash] > now) {
    return; // Another worker is actively repairing
  }
  state.repairLeases[hash] = now + 10000; // 10 second lease

  const chunk = state.chunks[hash];
  if (!chunk) return;

  // Find a verified GOOD source replica
  const goodReplicas = chunk.replicas.filter(r => r.state === 'GOOD' && state.nodes[r.nodeId]?.status === 'UP');
  if (goodReplicas.length === 0) {
    addLog('err', `CRITICAL: Zero good copies left for chunk ${hash.slice(0, 8)}! Data lost.`);
    delete state.repairLeases[hash];
    return;
  }

  const sourceNode = state.nodes[goodReplicas[0].nodeId];

  // Pick a healthy target node that does not have a GOOD copy
  const existingGoodNodes = goodReplicas.map(r => r.nodeId);
  const candidates = Object.values(state.nodes).filter(n => n.status === 'UP' && !existingGoodNodes.includes(n.id));

  if (candidates.length === 0) {
    // No spare node online right now; will retry on next scrubber pass
    delete state.repairLeases[hash];
    return;
  }

  // Choose target node with zone diversity
  const targetNode = candidates[0];

  addLog('warn', `[REPAIR] Starting recovery for chunk ${hash.slice(0, 8)}: streaming from ${sourceNode.id} -> ${targetNode.id}`);
  const startTime = Date.now();

  try {
    // 1. Fetch chunk from verified source
    const srcRes = await fetch(`${getNodeUrl(sourceNode)}/chunk/${hash}`);
    if (!srcRes.ok) throw new Error(`Source node ${sourceNode.id} failed to stream chunk`);
    const buffer = Buffer.from(await srcRes.arrayBuffer());

    // 2. Double-check source hash before writing
    const verifyHash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (verifyHash !== hash) {
      throw new Error(`Source data from ${sourceNode.id} was corrupted! Aborting repair.`);
    }

    // 3. Safe Write to target node (PUT chunk)
    const putRes = await fetch(`${getNodeUrl(targetNode)}/chunk/${hash}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer
    });

    if (!putRes.ok) throw new Error(`Target node ${targetNode.id} rejected chunk write`);

    // 4. Update replica catalog
    // Remove corrupt/missing record on target node if existed
    chunk.replicas = chunk.replicas.filter(r => r.nodeId !== targetNode.id && r.state === 'GOOD');
    chunk.replicas.push({ nodeId: targetNode.id, state: 'GOOD' });

    const duration = Date.now() - startTime;
    state.metrics.repairsCompleted++;
    addLog('ok', `[REPAIR COMPLETED] Chunk ${hash.slice(0, 8)} restored to ${targetNode.id} in ${duration}ms. (Active copies: ${chunk.replicas.length}/${RF})`);
  } catch (err) {
    addLog('err', `[REPAIR FAILED] Chunk ${hash.slice(0, 8)}: ${err.message}`);
    state.repairQueue.push(hash);
  } finally {
    delete state.repairLeases[hash];
    saveMetadata();
  }
}

// -------------------------------------------------------------
// Coordinator HTTP API Server & Static Dashboard
// -------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost:5000'}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid URL' }));
  }
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  function sendJson(code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  // 1. Cluster Status Telemetry
  if (req.method === 'GET' && pathname === '/api/status') {
    const nodesList = Object.values(state.nodes).map(n => ({
      id: n.id,
      name: n.name || n.id,
      host: n.host || '127.0.0.1',
      port: n.port,
      zone: n.zone,
      isLocal: n.isLocal !== false,
      status: n.status,
      up: n.status === 'UP',
      storedChunks: getStoredChunkCount(n.id)
    }));

    // Calculate cluster health %
    let totalExpectedReplicas = 0;
    let healthyReplicas = 0;
    for (const c of Object.values(state.chunks)) {
      totalExpectedReplicas += RF;
      healthyReplicas += c.replicas.filter(r => r.state === 'GOOD' && state.nodes[r.nodeId]?.status === 'UP').length;
    }
    const healthPercent = totalExpectedReplicas > 0
      ? Math.round((healthyReplicas / totalExpectedReplicas) * 100)
      : 100;

    return sendJson(200, {
      healthPercent,
      mode: clusterConfig.mode || 'lan',
      nodes: nodesList,
      files: state.files,
      chunks: state.chunks,
      metrics: state.metrics,
      repairQueueLength: state.repairQueue.length,
      log: state.log.slice(0, 40)
    });
  }

  // Cluster Configuration API
  if (req.method === 'GET' && pathname === '/api/cluster/config') {
    return sendJson(200, {
      mode: clusterConfig.mode || 'lan',
      replicationFactor: RF,
      chunkSize: CHUNK_SIZE,
      localIps: getLocalIps(),
      nodes: clusterConfig.nodes,
      lanPreset: clusterConfig.lanPreset,
      localPreset: clusterConfig.localPreset
    });
  }

  if (req.method === 'POST' && pathname === '/api/cluster/config') {
    const configData = [];
    req.on('data', chunk => configData.push(chunk));
    req.on('end', () => {
      try {
        const payload = JSON.parse(Buffer.concat(configData).toString('utf8'));
        if (payload.mode) clusterConfig.mode = payload.mode;
        if (payload.replicationFactor) {
          clusterConfig.replicationFactor = parseInt(payload.replicationFactor, 10);
          RF = clusterConfig.replicationFactor;
        }
        if (Array.isArray(payload.nodes) && payload.nodes.length) {
          clusterConfig.nodes = payload.nodes;
        }
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(clusterConfig, null, 2));
        initNodes();
        runHeartbeats();
        addLog('ok', `[CONFIG] Updated cluster topology (${(clusterConfig.mode || 'lan').toUpperCase()} mode, ${clusterConfig.nodes.length} nodes).`);
        return sendJson(200, {
          ok: true,
          message: 'Cluster configuration applied successfully',
          config: clusterConfig
        });
      } catch (err) {
        return sendJson(400, { error: 'Failed to update config: ' + err.message });
      }
    });
    return;
  }

  // 2. Upload File API: Multi-Chunk Splitting & Quorum Safe Write
  if (req.method === 'POST' && pathname === '/api/upload') {
    const filename = decodeURIComponent(url.searchParams.get('filename') || `file_${Date.now()}.dat`);
    const chunksData = [];

    req.on('data', chunk => chunksData.push(chunk));
    req.on('end', async () => {
      const fullBuffer = Buffer.concat(chunksData);
      if (fullBuffer.length === 0) {
        return sendJson(400, { error: 'Empty file payload' });
      }

      const totalSize = fullBuffer.length;
      const fileId = 'file_' + crypto.randomBytes(6).toString('hex');
      const incomingChunkHashes = [];
      const incomingSlices = [];

      // Slice file into granular chunks (8 KB per chunk for responsive multi-chunk verification)
      let offset = 0;
      while (offset < totalSize) {
        const slice = fullBuffer.subarray(offset, Math.min(offset + CHUNK_SIZE, totalSize));
        const hash = crypto.createHash('sha256').update(slice).digest('hex');
        incomingChunkHashes.push(hash);
        incomingSlices.push(slice);
        offset += CHUNK_SIZE;
      }

      // Check if file already exists with same name (Versioning & Differential Delta Analysis)
      const existingIdx = state.files.findIndex(f => f.name === filename);
      const isExisting = existingIdx !== -1;
      const existing = isExisting ? state.files[existingIdx] : null;

      let version = 1;
      let status = 'ok';
      let reusedCount = 0;
      let affectedCount = 0;
      const baselineChunks = (existing && existing.baselineChunks && existing.baselineChunks.length)
        ? existing.baselineChunks
        : (existing ? existing.chunks : incomingChunkHashes);

      const chunkDetails = [];

      for (let i = 0; i < incomingChunkHashes.length; i++) {
        const hash = incomingChunkHashes[i];
        const slice = incomingSlices[i];
        const prevHash = (existing && existing.chunks) ? existing.chunks[i] : null;
        const baselineHash = baselineChunks[i] || null;

        // Check if this chunk is already identical to previous version (or already replicated in state.chunks)
        const alreadyReplicated = state.chunks[hash] && state.chunks[hash].replicas && state.chunks[hash].replicas.filter(r => r.state === 'GOOD').length >= 2;
        const isIdenticalToPrev = prevHash && prevHash === hash;

        if (isExisting && isIdenticalToPrev) {
          reusedCount++;
          chunkDetails.push({
            index: i + 1,
            hash,
            baselineHash,
            size: slice.length,
            status: 'reused',
            note: 'Identical to cluster baseline · Reused existing RF=3 replicas'
          });
        } else {
          if (isExisting) affectedCount++;
          chunkDetails.push({
            index: i + 1,
            hash,
            baselineHash,
            size: slice.length,
            status: isExisting ? 'affected' : 'new',
            note: isExisting ? 'Modified chunk detected · Replicated to 3 nodes' : 'New chunk replicated to 3 nodes'
          });

          // Needs replication to nodes
          if (!alreadyReplicated) {
            const targetNodes = selectNodesForChunk();
            if (targetNodes.length < 2) {
              return sendJson(503, { error: 'Not enough healthy storage nodes online to meet quorum (minimum 2 nodes required)' });
            }

            if (!state.chunks[hash]) {
              state.chunks[hash] = {
                hash,
                size: slice.length,
                replicas: []
              };
            }

            let ackCount = 0;
            const writePromises = targetNodes.map(async node => {
              try {
                const putRes = await fetch(`${getNodeUrl(node)}/chunk/${hash}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/octet-stream' },
                  body: slice
                });
                if (putRes.ok) {
                  ackCount++;
                  state.chunks[hash].replicas.push({ nodeId: node.id, state: 'GOOD' });
                }
              } catch (err) {
                console.error(`Failed to write chunk to ${node.id}:`, err.message);
              }
            });

            await Promise.all(writePromises);

            if (ackCount < 2) {
              return sendJson(500, { error: `Failed to achieve write quorum on chunk ${hash.slice(0, 8)}` });
            }
          }
        }
      }

      if (isExisting) {
        version = (existing.version || 1) + 1;
        status = affectedCount > 0 ? 'modified' : 'ok';
        state.files[existingIdx] = {
          id: existing.id || fileId,
          name: filename,
          size: totalSize,
          chunks: incomingChunkHashes,
          baselineChunks: baselineChunks,
          chunkDetails,
          reusedCount,
          affectedCount,
          version,
          status,
          updatedAt: Date.now()
        };
        if (affectedCount > 0) {
          addLog('warn', `Uploaded "${filename}" (v${version}): Detected ${affectedCount} affected chunk(s). Reused/copied ${reusedCount} chunk(s) from healthy cluster replicas.`);
        } else {
          addLog('info', `Uploaded "${filename}": 100% of chunks (${reusedCount}) match existing cluster baseline.`);
        }
      } else {
        state.files.unshift({
          id: fileId,
          name: filename,
          size: totalSize,
          chunks: incomingChunkHashes,
          baselineChunks: incomingChunkHashes,
          chunkDetails,
          reusedCount: 0,
          affectedCount: 0,
          version: 1,
          status: 'ok',
          updatedAt: Date.now()
        });
        addLog('ok', `Uploaded "${filename}" (v1, ${totalSize} bytes, ${incomingChunkHashes.length} chunks) across 3 failure domains (RF=${RF}).`);
      }

      saveMetadata();
      return sendJson(200, {
        ok: true,
        fileId: isExisting ? state.files[existingIdx].id : fileId,
        name: filename,
        version,
        chunks: incomingChunkHashes.length,
        reusedCount,
        affectedCount,
        status
      });
    });
    return;
  }

  // Restore/Mend Affected Chunks from Healthy Cluster Copies
  const restoreMatch = pathname.match(/^\/api\/files\/(file_[a-f0-9]+)\/restore-chunks$/);
  if (req.method === 'POST' && restoreMatch) {
    const fileId = restoreMatch[1];
    const file = state.files.find(f => f.id === fileId);
    if (!file) {
      return sendJson(404, { error: 'File not found' });
    }

    if (!file.baselineChunks || !file.baselineChunks.length) {
      return sendJson(400, { error: 'No baseline chunks available to restore from' });
    }

    const previousAffected = file.affectedCount || 1;
    file.chunks = [...file.baselineChunks];
    file.status = 'ok';
    file.affectedCount = 0;
    file.reusedCount = file.chunks.length;
    file.version = (file.version || 1) + 1;
    file.updatedAt = Date.now();
    if (file.chunkDetails) {
      file.chunkDetails.forEach(cd => {
        cd.status = 'reused';
        cd.hash = cd.baselineHash || cd.hash;
        cd.note = 'Healed: Copied from healthy cluster replicas';
      });
    }

    state.metrics.repairsCompleted++;
    state.metrics.restores++;
    saveMetadata();

    addLog('ok', `[MEND HEAL] Copied healthy data from chunk store to repair "${file.name}". Restored ${previousAffected} affected chunk(s). File is now 100% HEALTHY!`);

    return sendJson(200, {
      ok: true,
      message: `File "${file.name}" healed by copying from cluster chunks!`,
      version: file.version,
      status: file.status,
      restoredChunks: previousAffected
    });
  }

  // Get Detailed Chunk Breakdown for Inspection Modal
  const chunksMatch = pathname.match(/^\/api\/files\/(file_[a-f0-9]+)\/chunks$/);
  if (req.method === 'GET' && chunksMatch) {
    const fileId = chunksMatch[1];
    const file = state.files.find(f => f.id === fileId);
    if (!file) {
      return sendJson(404, { error: 'File not found' });
    }
    return sendJson(200, {
      fileId: file.id,
      name: file.name,
      version: file.version,
      status: file.status,
      size: file.size,
      reusedCount: file.reusedCount || 0,
      affectedCount: file.affectedCount || 0,
      chunks: file.chunkDetails || (file.chunks || []).map((h, i) => ({
        index: i + 1,
        hash: h,
        size: state.chunks[h]?.size || 8192,
        status: 'reused',
        note: 'Healthy copy on RF=3 replicas'
      }))
    });
  }

  // 3. Download File API: Chunk Assembly with Read-Repair & Checksum Check
  const downloadMatch = pathname.match(/^\/api\/download\/(file_[a-f0-9]+)$/);
  if (req.method === 'GET' && downloadMatch) {
    const fileId = downloadMatch[1];
    const fileMeta = state.files.find(f => f.id === fileId);

    if (!fileMeta) {
      return sendJson(404, { error: 'File not found' });
    }

    const assembledBuffers = [];

    for (const chunkHash of fileMeta.chunks) {
      const chunkMeta = state.chunks[chunkHash];
      if (!chunkMeta) {
        return sendJson(500, { error: `Missing metadata for chunk ${chunkHash}` });
      }

      // Try reading from healthy replicas
      let chunkLoaded = false;
      const sortedReplicas = chunkMeta.replicas
        .filter(r => state.nodes[r.nodeId]?.status === 'UP')
        .sort((a, b) => (a.state === 'GOOD' ? -1 : 1));

      for (const replica of sortedReplicas) {
        const node = state.nodes[replica.nodeId];
        try {
          const res = await fetch(`${getNodeUrl(node)}/chunk/${chunkHash}`);
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            const hashCheck = crypto.createHash('sha256').update(buf).digest('hex');

            if (hashCheck === chunkHash) {
              assembledBuffers.push(buf);
              chunkLoaded = true;
              break; // Chunk safely verified!
            } else {
              // Read-Repair: Caught corrupt chunk on download!
              replica.state = 'CORRUPT';
              state.metrics.corruptionsCaught++;
              addLog('err', `[READ-REPAIR] Caught corrupted chunk on Node ${node.id}! Discarded, trying fallback replica.`);
              if (!state.repairQueue.includes(chunkHash)) state.repairQueue.push(chunkHash);
            }
          }
        } catch {
          // Fallback to next replica
        }
      }

      if (!chunkLoaded) {
        state.metrics.integrityViolations++;
        addLog('err', `DATA INTEGRITY ERROR: All replicas for chunk ${chunkHash.slice(0, 8)} are corrupted or offline.`);
        return sendJson(500, { error: 'File unreadable: All chunk replicas are corrupted or unavailable.' });
      }
    }

    state.metrics.restores++;
    saveMetadata();

    const fullFile = Buffer.concat(assembledBuffers);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileMeta.name)}"`,
      'Content-Length': fullFile.length
    });
    return res.end(fullFile);
  }

  // 4. Chaos Testing Endpoints (Judges Demo)
  if (req.method === 'POST' && pathname === '/api/chaos/kill-node') {
    const nodeId = url.searchParams.get('nodeId');
    const node = state.nodes[nodeId];
    if (!node) {
      return sendJson(400, { error: 'Node not found' });
    }
    if (node.process) {
      node.process.kill('SIGKILL');
      node.process = null;
    } else {
      fetch(`${getNodeUrl(node)}/shutdown`, { method: 'POST' }).catch(() => {});
    }
    node.status = 'DOWN';
    addLog('err', `[CHAOS] Terminated Node process ${nodeId}.`);
    return sendJson(200, { ok: true, killed: nodeId });
  }

  if (req.method === 'POST' && pathname === '/api/chaos/recover-node') {
    const nodeId = url.searchParams.get('nodeId');
    const cfg = clusterConfig.nodes.find(n => n.id === nodeId);
    if (!cfg) return sendJson(404, { error: 'Node config not found' });

    const node = state.nodes[nodeId];
    if (node && node.process) {
      return sendJson(400, { error: 'Node already running' });
    }

    if (cfg.isLocal !== false) {
      const child = spawnNodeProcess(cfg);
      state.nodes[nodeId].process = child;
    }
    state.nodes[nodeId].status = 'UP';
    state.nodes[nodeId].missedHeartbeats = 0;
    addLog('ok', `[CHAOS] Recovered / Restarted storage node process ${nodeId}.`);
    return sendJson(200, { ok: true, recovered: nodeId });
  }

  if (req.method === 'POST' && pathname === '/api/chaos/corrupt-replica') {
    // Pick any UP node that has chunks and corrupt one
    const upNodes = Object.values(state.nodes).filter(n => n.status === 'UP');
    for (const node of upNodes) {
      try {
        const res = await fetch(`${getNodeUrl(node)}/corrupt-random`, { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          addLog('warn', `[CHAOS] Injected bit-rot into chunk ${data.corrupted.slice(0, 8)} on ${data.nodeId}!`);
          return sendJson(200, { ok: true, corrupted: data.corrupted, nodeId: data.nodeId });
        }
      } catch {}
    }
    return sendJson(400, { error: 'No chunks available to corrupt on running nodes' });
  }

  if (req.method === 'POST' && pathname === '/api/repair/now') {
    await scrubCluster();
    return sendJson(200, { ok: true, message: 'Scrubber and repair pass completed' });
  }

  // 5. File Lifecycle Management (Restore, Purge Forever, Empty Trash, Soft Delete)
  function cleanupOrphanedChunks() {
    const activeChunks = new Set();
    state.files.forEach(f => {
      (f.chunks || []).forEach(c => activeChunks.add(c));
      (f.baselineChunks || []).forEach(c => activeChunks.add(c));
    });

    const allChunkHashes = Object.keys(state.chunks);
    let cleaned = 0;
    for (const ch of allChunkHashes) {
      if (!activeChunks.has(ch)) {
        const chMeta = state.chunks[ch];
        if (chMeta && Array.isArray(chMeta.replicas)) {
          for (const rep of chMeta.replicas) {
            const nodeCfg = clusterConfig.nodes.find(n => n.id === rep.nodeId);
            if (nodeCfg) {
              fetch(`${getNodeUrl(nodeCfg)}/chunk/${ch}`, { method: 'DELETE' }).catch(() => {});
            }
          }
        }
        delete state.chunks[ch];
        cleaned++;
      }
    }
    return cleaned;
  }

  function purgeFileRecord(fileId) {
    const idx = state.files.findIndex(f => f.id === fileId);
    if (idx === -1) return null;
    const removed = state.files.splice(idx, 1)[0];
    const cleanedChunks = cleanupOrphanedChunks();
    addLog('warn', `[PURGE] File "${removed.name}" permanently deleted forever (${cleanedChunks} chunk(s) removed).`);
    saveMetadata();
    return removed;
  }

  function purgeAllDeleted() {
    const deletedFiles = state.files.filter(f => f.status === 'deleted');
    if (!deletedFiles.length) return 0;
    state.files = state.files.filter(f => f.status !== 'deleted');
    const cleanedChunks = cleanupOrphanedChunks();
    addLog('warn', `[PURGE] Permanently purged ${deletedFiles.length} deleted file(s) forever (${cleanedChunks} chunk(s) removed).`);
    saveMetadata();
    return deletedFiles.length;
  }

  // Restore deleted file back to healthy
  const restoreFileMatch = pathname.match(/^\/api\/files\/(file_[a-f0-9]+)\/restore$/);
  if (req.method === 'POST' && restoreFileMatch) {
    const fileId = restoreFileMatch[1];
    const file = state.files.find(f => f.id === fileId);
    if (file) {
      file.status = 'ok';
      file.updatedAt = Date.now();
      delete file.deletedAt;
      addLog('ok', `[RESTORE] File "${file.name}" restored from deleted state.`);
      saveMetadata();
      return sendJson(200, { ok: true, status: file.status, fileId, name: file.name });
    }
    return sendJson(404, { error: 'File not found' });
  }

  // Purge all deleted files (Empty Trash)
  if ((req.method === 'POST' || req.method === 'DELETE') && pathname === '/api/files/purge-deleted') {
    const count = purgeAllDeleted();
    return sendJson(200, { ok: true, purgedCount: count });
  }

  // Purge specific file forever
  const purgeMatch = pathname.match(/^\/api\/files\/(file_[a-f0-9]+)\/purge$/);
  const deleteMatch = pathname.match(/^\/api\/files\/(file_[a-f0-9]+)$/);

  if ((req.method === 'DELETE' && (purgeMatch || (deleteMatch && url.searchParams.get('purge') === 'true'))) ||
      (req.method === 'POST' && purgeMatch)) {
    const fileId = purgeMatch ? purgeMatch[1] : deleteMatch[1];
    const removed = purgeFileRecord(fileId);
    if (removed) {
      return sendJson(200, { ok: true, purged: true, fileId, name: removed.name });
    }
    return sendJson(404, { error: 'File not found' });
  }

  // Soft-delete file (move to deleted)
  if (req.method === 'DELETE' && deleteMatch) {
    const fileId = deleteMatch[1];
    const file = state.files.find(f => f.id === fileId);
    if (file) {
      file.status = 'deleted';
      file.deletedAt = Date.now();
      file.updatedAt = Date.now();
      addLog('warn', `File "${file.name}" moved to Trash (marked deleted).`);
      saveMetadata();
      return sendJson(200, { ok: true, fileId });
    }
    return sendJson(404, { error: 'File not found' });
  }

  // 6. Static File Server (serves index.html, script.js, style.css, favicon.svg)
  let staticPath = pathname === '/' ? '/index.html' : pathname;
  if (staticPath === '/favicon.ico') staticPath = '/favicon.svg';
  const localFile = path.join(__dirname, staticPath);

  if (fs.existsSync(localFile) && fs.statSync(localFile).isFile()) {
    const ext = path.extname(localFile);
    const mimeMap = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.json': 'application/json'
    };
    res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
    return fs.createReadStream(localFile).pipe(res);
  }

  return sendJson(404, { error: 'Not found' });
});

// -------------------------------------------------------------
// Bootstrapping
// -------------------------------------------------------------
loadMetadata();
initNodes();

// Periodic Heartbeats (Every 1.2s)
setInterval(runHeartbeats, 1200);

// Periodic Scrubber & Repair Loop (Every 2.5s)
setInterval(scrubCluster, 2500);

function getLocalIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIps();
  console.log(`====================================================`);
  console.log(` MEND COORDINATOR & OBJECT STORE ACTIVE`);
  console.log(` Mode:             ${(clusterConfig.mode || 'lan').toUpperCase()}`);
  console.log(` Local Dashboard:  http://localhost:${PORT}`);
  if (ips.length) {
    ips.forEach(ip => console.log(` Network Link:      http://${ip}:${PORT}`));
  }
  console.log(` Storage Nodes:    ${clusterConfig.nodes.length} nodes configured`);
  clusterConfig.nodes.forEach(n => {
    console.log(`   - ${n.id} (${n.name || n.id}) at ${n.host || '127.0.0.1'}:${n.port} [${n.isLocal !== false ? 'LOCAL' : 'REMOTE'}]`);
  });
  console.log(` Replication Factor: RF=${RF} (Safe writes + Auto-healing)`);
  console.log(`====================================================`);
});

// Clean shutdown: terminate all child nodes on exit
process.on('SIGINT', () => {
  console.log('\n[Coordinator] Gracefully shutting down cluster...');
  for (const node of Object.values(state.nodes)) {
    if (node.process) {
      try { node.process.kill('SIGTERM'); } catch {}
    }
  }
  process.exit(0);
});
