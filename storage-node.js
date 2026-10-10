'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
}

const nodeId = getArg('--id', 'node-1');
const port = parseInt(getArg('--port', '5001'), 10);
const host = getArg('--host', '0.0.0.0');
const dataDir = path.resolve(getArg('--dir', `./data/${nodeId}`));
const zone = getArg('--zone', 'zone-a');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Startup Cleanup: Clean up any leftover temporary files from interrupted writes
function cleanupOrphanedTempFiles() {
  try {
    const files = fs.readdirSync(dataDir);
    let cleaned = 0;
    for (const f of files) {
      if (f.endsWith('.tmp') || f.startsWith('temp_')) {
        fs.unlinkSync(path.join(dataDir, f));
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[${nodeId}] Purged ${cleaned} leftover .tmp files from previous interrupted writes.`);
    }
  } catch (err) {
    console.error(`[${nodeId}] Error cleaning temp files:`, err.message);
  }
}
cleanupOrphanedTempFiles();

function countStoredChunks() {
  try {
    return fs.readdirSync(dataDir).filter(f => f.endsWith('.dat')).length;
  } catch {
    return 0;
  }
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Liveness / Heartbeat endpoint
  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, {
      status: 'UP',
      id: nodeId,
      port,
      zone,
      uptimeSec: Math.floor(process.uptime()),
      chunksCount: countStoredChunks()
    });
  }

  // List all stored chunks on this node
  if (req.method === 'GET' && pathname === '/chunks') {
    try {
      const files = fs.readdirSync(dataDir)
        .filter(f => f.endsWith('.dat'))
        .map(f => f.replace(/\.dat$/, ''));
      return sendJson(res, 200, { id: nodeId, chunks: files });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // PUT /chunk/:hash -> Safe Write (write to temp -> fsync -> hash check -> atomic rename)
  const putMatch = pathname.match(/^\/chunk\/([a-f0-9]{64})$/);
  if (req.method === 'PUT' && putMatch) {
    const expectedHash = putMatch[1];
    const tempFileName = `temp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.tmp`;
    const tempPath = path.join(dataDir, tempFileName);
    const finalPath = path.join(dataDir, `${expectedHash}.dat`);

    const writeStream = fs.createWriteStream(tempPath);
    const hashStream = crypto.createHash('sha256');
    let bytesReceived = 0;

    req.on('data', chunk => {
      bytesReceived += chunk.length;
      hashStream.update(chunk);
      writeStream.write(chunk);
    });

    req.on('end', () => {
      writeStream.end(() => {
        // fsync to flush kernel write buffers to physical disk
        try {
          const fd = fs.openSync(tempPath, 'r+');
          fs.fsyncSync(fd);
          fs.closeSync(fd);
        } catch (syncErr) {
          console.error(`[${nodeId}] fsync error:`, syncErr.message);
        }

        const actualHash = hashStream.digest('hex');

        if (actualHash !== expectedHash) {
          // Checksum mismatch -> Delete temp file immediately, fail safe
          try { fs.unlinkSync(tempPath); } catch {}
          console.warn(`[${nodeId}] Corrupt upload rejected! Expected ${expectedHash.slice(0, 8)}, got ${actualHash.slice(0, 8)}`);
          return sendJson(res, 400, {
            error: 'Checksum mismatch',
            expected: expectedHash,
            actual: actualHash
          });
        }

        // Atomic Rename: drop into the live mailbox
        try {
          fs.renameSync(tempPath, finalPath);
          console.log(`[${nodeId}] Safely committed chunk ${expectedHash.slice(0, 8)} (${bytesReceived} bytes)`);
          return sendJson(res, 200, {
            ok: true,
            hash: expectedHash,
            bytes: bytesReceived
          });
        } catch (renameErr) {
          try { fs.unlinkSync(tempPath); } catch {}
          return sendJson(res, 500, { error: 'Failed to commit chunk file', details: renameErr.message });
        }
      });
    });

    req.on('error', err => {
      try { fs.unlinkSync(tempPath); } catch {}
      sendJson(res, 500, { error: err.message });
    });
    return;
  }

  // GET /chunk/:hash -> Stream chunk content
  const getMatch = pathname.match(/^\/chunk\/([a-f0-9]{64})$/);
  if (req.method === 'GET' && getMatch) {
    const hash = getMatch[1];
    const filePath = path.join(dataDir, `${hash}.dat`);

    if (!fs.existsSync(filePath)) {
      return sendJson(res, 404, { error: 'Chunk not found on this node', hash });
    }

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'X-Chunk-Hash': hash,
      'Access-Control-Allow-Origin': '*'
    });
    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
    return;
  }

  // POST /verify/:hash -> Verify checksum of stored chunk
  const verifyMatch = pathname.match(/^\/verify\/([a-f0-9]{64})$/);
  if (req.method === 'POST' && verifyMatch) {
    const hash = verifyMatch[1];
    const filePath = path.join(dataDir, `${hash}.dat`);

    if (!fs.existsSync(filePath)) {
      return sendJson(res, 404, { exists: false, match: false, hash });
    }

    try {
      const buffer = fs.readFileSync(filePath);
      const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
      const isMatch = (actualHash === hash);
      return sendJson(res, 200, {
        exists: true,
        match: isMatch,
        expectedHash: hash,
        actualHash,
        sizeBytes: buffer.length
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // DELETE /chunk/:hash -> Remove chunk
  const delMatch = pathname.match(/^\/chunk\/([a-f0-9]{64})$/);
  if (req.method === 'DELETE' && delMatch) {
    const hash = delMatch[1];
    const filePath = path.join(dataDir, `${hash}.dat`);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        return sendJson(res, 200, { ok: true, deleted: hash });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }
    return sendJson(res, 404, { error: 'Chunk not found' });
  }

  // POST /corrupt/:hash -> Chaos Endpoint (Tamper with disk bytes for testing)
  const corruptMatch = pathname.match(/^\/corrupt\/([a-f0-9]{64})$/);
  if (req.method === 'POST' && corruptMatch) {
    const hash = corruptMatch[1];
    const filePath = path.join(dataDir, `${hash}.dat`);

    if (!fs.existsSync(filePath)) {
      return sendJson(res, 404, { error: 'Chunk not found to corrupt' });
    }

    try {
      const buffer = fs.readFileSync(filePath);
      if (buffer.length > 0) {
        // Flip bits in the middle of the chunk
        const targetByte = Math.floor(buffer.length / 2);
        buffer[targetByte] = buffer[targetByte] ^ 0xFF;
      } else {
        // If empty, append garbage byte
        buffer = Buffer.from([0xDE, 0xAD]);
      }
      fs.writeFileSync(filePath, buffer);
      console.warn(`[${nodeId}] [CHAOS] Corrupted bytes inside chunk ${hash.slice(0, 8)}`);
      return sendJson(res, 200, { ok: true, corrupted: hash, nodeId });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // POST /corrupt-random -> Pick any stored chunk and tamper with it
  if (req.method === 'POST' && pathname === '/corrupt-random') {
    try {
      const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.dat'));
      if (!files.length) {
        return sendJson(res, 400, { error: 'No chunks available on this node to corrupt' });
      }
      const randomFile = files[Math.floor(Math.random() * files.length)];
      const hash = randomFile.replace(/\.dat$/, '');
      const filePath = path.join(dataDir, randomFile);
      const buffer = fs.readFileSync(filePath);
      if (buffer.length > 0) {
        buffer[0] = buffer[0] ^ 0xFF;
      }
      fs.writeFileSync(filePath, buffer);
      console.warn(`[${nodeId}] [CHAOS] Randomly corrupted ${hash.slice(0, 8)}`);
      return sendJson(res, 200, { ok: true, corrupted: hash, nodeId });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // POST /shutdown -> Chaos / Graceful shutdown endpoint
  if (req.method === 'POST' && pathname === '/shutdown') {
    console.log(`[${nodeId}] Received shutdown command.`);
    sendJson(res, 200, { ok: true, stopped: nodeId });
    setTimeout(() => process.exit(0), 100);
    return;
  }

  return sendJson(res, 404, { error: 'Endpoint not found' });
});

server.listen(port, host, () => {
  console.log(`[${nodeId}] Storage Node active on ${host}:${port} (Zone: ${zone}, Dir: ${dataDir})`);
});
