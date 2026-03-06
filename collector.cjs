#!/usr/bin/env node
// LOCATE1 Indexer — JungleBus → SQLite + WebSocket + REST
//
// Stores every LOCATE1 attestation permanently in SQLite.
// Fans out live stream via WebSocket. Queryable via REST.
// No opinions, no derived data. Just raw attestations, stored and served.
//
// Usage: node collector.cjs [--port 3011] [--sub <subscription_id>] [--from <block_height>] [--db <path>]
//
// Env: JUNGLEBUS_SUB_ID, LOCATE1_PORT, LOCATE1_FROM_BLOCK, LOCATE1_DB

// Node 25 built-in localStorage broken in PM2 — force override via defineProperty
const _store = {}
const _ls = {
  getItem: k => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v) },
  removeItem: k => { delete _store[k] },
  clear: () => { for (const k in _store) delete _store[k] },
  get length () { return Object.keys(_store).length },
  key: i => Object.keys(_store)[i] ?? null
}
try { Object.defineProperty(globalThis, 'localStorage', { value: _ls, writable: true, configurable: true }) } catch { globalThis.localStorage = _ls }

const { JungleBusClient } = require('@gorillapool/js-junglebus')
const bsv = require('bsv')
const { WebSocketServer } = require('ws')
const http = require('http')
const Database = require('better-sqlite3')
const path = require('path')

// --- Config ---
const args = process.argv.slice(2)
function arg (name, envKey, fallback) {
  const i = args.indexOf('--' + name)
  if (i >= 0 && args[i + 1]) return args[i + 1]
  if (process.env[envKey]) return process.env[envKey]
  return fallback
}

const PORT = parseInt(arg('port', 'LOCATE1_PORT', '3011'), 10)
const SUB_ID = arg('sub', 'JUNGLEBUS_SUB_ID', '')
const FROM_BLOCK = parseInt(arg('from', 'LOCATE1_FROM_BLOCK', '0'), 10)
const DB_PATH = arg('db', 'LOCATE1_DB', path.join(__dirname, 'locate1.db'))

if (!SUB_ID) {
  console.error('Error: JungleBus subscription ID required.')
  console.error('  node collector.cjs --sub <id>  or  JUNGLEBUS_SUB_ID=<id>')
  console.error('')
  console.error('Create one at https://junglebus.gorillapool.io with output filter: 4c4f434154453101')
  process.exit(1)
}

// --- SQLite ---
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS attestations (
    txid        TEXT NOT NULL,
    block       INTEGER,
    ts          INTEGER,
    observer    TEXT NOT NULL,
    peer        TEXT NOT NULL,
    method      TEXT NOT NULL,
    value       INTEGER NOT NULL,
    sig         TEXT NOT NULL,
    PRIMARY KEY (txid, observer, peer)
  );
  CREATE INDEX IF NOT EXISTS idx_peer ON attestations(peer, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_observer ON attestations(observer, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_ts ON attestations(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_block ON attestations(block);
`)

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO attestations (txid, block, ts, observer, peer, method, value, sig)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)

const startCount = db.prepare('SELECT COUNT(*) as c FROM attestations').get().c
console.log(`[db] ${DB_PATH} — ${startCount} attestations stored`)

// --- LOCATE1 parser ---
const PREFIX = Buffer.from('LOCATE1', 'utf8')
const METHODS = { 1: 'rssi', 2: 'uwb', 3: 'ultrasonic' }

function decodeMeasurement (method, buf) {
  if (method === 1) return buf.readInt8(0)
  return buf.readUInt32LE(0)
}

function parseOutputs (tx) {
  const results = []
  for (const output of tx.outputs) {
    const chunks = output.script.chunks
    let i = 0
    while (i < chunks.length) {
      if (chunks[i].buf && chunks[i].buf.equals(PREFIX)) break
      i++
    }
    if (i >= chunks.length || i + 6 >= chunks.length) continue

    // Version may be OP_1 (opcode 0x51, no buf) or a data push of 0x01
    const vChunk = chunks[i + 1]
    const version = vChunk.buf ? vChunk.buf[0] : vChunk.opcodenum - 0x50  // OP_1=0x51 → 1
    if (version !== 1) continue

    const observerPub = chunks[i + 2].buf?.toString('hex')
    const peerPub = chunks[i + 3].buf?.toString('hex')
    // Method may also be OP_1/OP_2/OP_3 small-number encoding
    const mChunk = chunks[i + 4]
    const method = mChunk.buf ? mChunk.buf[0] : mChunk.opcodenum - 0x50
    const measBuf = chunks[i + 5].buf
    const sig = chunks[i + 6].buf

    if (!observerPub || !peerPub || !method || !measBuf || !sig) continue

    results.push({
      version,
      observer: observerPub,
      peer: peerPub,
      method: METHODS[method] || method,
      value: decodeMeasurement(method, measBuf),
      sig: sig.toString('hex')
    })
  }
  return results
}

// --- HTTP server (REST + WebSocket upgrade) ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const p = url.pathname

  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')

  try {
    if (p === '/' || p === '/status') {
      const total = db.prepare('SELECT COUNT(*) as c FROM attestations').get().c
      const observers = db.prepare('SELECT COUNT(DISTINCT observer) as c FROM attestations').get().c
      const peers = db.prepare('SELECT COUNT(DISTINCT peer) as c FROM attestations').get().c
      const latest = db.prepare('SELECT MAX(block) as b FROM attestations').get().b
      res.end(JSON.stringify({
        service: 'locate1-indexer',
        attestations: total,
        observers,
        peers,
        latestBlock: latest,
        scanBlock: lastBlock,
        wsClients: clients.size,
        uptime: process.uptime() | 0
      }))

    } else if (p === '/attestations') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500)
      const since = url.searchParams.get('since') // unix timestamp
      const block = url.searchParams.get('block')
      let rows
      if (since) {
        rows = db.prepare('SELECT * FROM attestations WHERE ts >= ? ORDER BY ts DESC LIMIT ?').all(parseInt(since), limit)
      } else if (block) {
        rows = db.prepare('SELECT * FROM attestations WHERE block >= ? ORDER BY block DESC, ts DESC LIMIT ?').all(parseInt(block), limit)
      } else {
        rows = db.prepare('SELECT * FROM attestations ORDER BY ts DESC, rowid DESC LIMIT ?').all(limit)
      }
      res.end(JSON.stringify(rows))

    } else if (p.startsWith('/peer/')) {
      const peerPub = p.slice(6)
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500)
      const rows = db.prepare('SELECT * FROM attestations WHERE peer = ? ORDER BY ts DESC LIMIT ?').all(peerPub, limit)
      res.end(JSON.stringify(rows))

    } else if (p.startsWith('/observer/')) {
      const obsPub = p.slice(10)
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500)
      const rows = db.prepare('SELECT * FROM attestations WHERE observer = ? ORDER BY ts DESC LIMIT ?').all(obsPub, limit)
      res.end(JSON.stringify(rows))

    } else if (p === '/peers') {
      const rows = db.prepare(`
        SELECT peer, COUNT(*) as attestations, MAX(ts) as last_seen,
               COUNT(DISTINCT observer) as observer_count
        FROM attestations GROUP BY peer ORDER BY last_seen DESC
      `).all()
      res.end(JSON.stringify(rows))

    } else if (p === '/observers') {
      const rows = db.prepare(`
        SELECT observer, COUNT(*) as attestations, MAX(ts) as last_seen,
               COUNT(DISTINCT peer) as peer_count
        FROM attestations GROUP BY observer ORDER BY last_seen DESC
      `).all()
      res.end(JSON.stringify(rows))

    } else {
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not found', endpoints: ['/', '/attestations', '/peers', '/observers', '/peer/:pub', '/observer/:pub'] }))
    }
  } catch (e) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: e.message }))
  }
})

// --- WebSocket server (shares HTTP server) ---
const wss = new WebSocketServer({ server })
const clients = new Set()

wss.on('connection', (ws, req) => {
  const addr = req.socket.remoteAddress
  clients.add(ws)
  console.log(`[ws] +connect (${clients.size} clients) from ${addr}`)

  ws.on('close', () => {
    clients.delete(ws)
    console.log(`[ws] -disconnect (${clients.size} clients)`)
  })

  ws.on('error', () => {
    clients.delete(ws)
  })
})

function wsBroadcast (msg) {
  const json = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(json)
  }
}

// --- Stats ---
let txCount = 0
let attestCount = 0
let lastBlock = FROM_BLOCK

// --- JungleBus ---
const jungle = new JungleBusClient('junglebus.gorillapool.io', {
  onConnected (ctx) { console.log(`[junglebus] connected`, ctx) },
  onConnecting () { console.log(`[junglebus] connecting...`) },
  onDisconnected (ctx) { console.log(`[junglebus] disconnected`, ctx) },
  onError (ctx) { console.error(`[junglebus] error:`, ctx) }
})

function onPublish (tx) {
  txCount++
  try {
    const parsed = new bsv.Transaction(Buffer.from(tx.transaction, 'hex'))
    const attestations = parseOutputs(parsed)
    if (attestations.length === 0) return

    for (const a of attestations) {
      const row = {
        txid: tx.id,
        block: tx.block_height || null,
        ts: tx.block_time || null,
        ...a
      }

      // Store
      insertStmt.run(row.txid, row.block, row.ts, row.observer, row.peer, row.method, row.value, row.sig)
      attestCount++

      // Fan out
      wsBroadcast(row)
    }
  } catch (e) {
    // unparseable tx — skip
  }
}

function onStatus (ctx) {
  if (ctx.statusCode === 200) {
    lastBlock = ctx.block || lastBlock
  }
}

function onError (ctx) {
  console.error('[junglebus] stream error:', ctx)
}

function onMempool (tx) {
  onPublish(tx)
}

// --- Start ---
async function main () {
  server.listen(PORT, () => {
    console.log('LOCATE1 Indexer')
    console.log(`  HTTP:      http://localhost:${PORT}`)
    console.log(`  WebSocket: ws://localhost:${PORT}`)
    console.log(`  Database:  ${DB_PATH}`)
    console.log(`  JungleBus: ${SUB_ID}`)
    console.log(`  From block: ${FROM_BLOCK}`)
    console.log('')
  })

  await jungle.Subscribe(SUB_ID, FROM_BLOCK, onPublish, onStatus, onError, onMempool)

  setInterval(() => {
    const total = db.prepare('SELECT COUNT(*) as c FROM attestations').get().c
    console.log(`[stats] txs=${txCount} stored=${total} clients=${clients.size} lastBlock=${lastBlock}`)
  }, 60_000)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
