#!/usr/bin/env node
// LOCATE1 Indexer — agent-first REST API
//
// Nine query endpoints over accumulated LOCATE1 attestations.
// JungleBus ingestion, SQLite storage, no opinions.
//
// Usage: node index.cjs [--port 3011] [--sub <id>] [--from <block>] [--db <path>]

// Node 25 localStorage broken in PM2 — force override
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
const http = require('http')
const { WebSocketServer } = require('ws')
const Database = require('better-sqlite3')
const path = require('path')

// --- Config ---
const args = process.argv.slice(2)
function arg (name, env, fallback) {
  const i = args.indexOf('--' + name)
  if (i >= 0 && args[i + 1]) return args[i + 1]
  if (process.env[env]) return process.env[env]
  return fallback
}

const PORT = parseInt(arg('port', 'LOCATE1_PORT', '3011'), 10)
const SUB_ID = arg('sub', 'JUNGLEBUS_SUB_ID', '')
const FROM_BLOCK = parseInt(arg('from', 'LOCATE1_FROM_BLOCK', '0'), 10)
const DB_PATH = arg('db', 'LOCATE1_DB', path.join(__dirname, 'locate1.db'))

if (!SUB_ID) {
  console.error('Usage: node index.cjs --sub <junglebus_subscription_id>')
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
  CREATE INDEX IF NOT EXISTS idx_observer ON attestations(observer);
  CREATE INDEX IF NOT EXISTS idx_peer ON attestations(peer);
  CREATE INDEX IF NOT EXISTS idx_block ON attestations(block);
  CREATE INDEX IF NOT EXISTS idx_method ON attestations(method);
  CREATE INDEX IF NOT EXISTS idx_obs_peer ON attestations(observer, peer);

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`)

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO attestations (txid, block, ts, observer, peer, method, value, sig)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)

// --- LOCATE1 parser ---
const PREFIX = Buffer.from('LOCATE1', 'utf8')
const METHODS = { 1: 'rssi', 2: 'uwb', 3: 'ultrasonic' }

function opcodeToNum (chunk) {
  if (chunk.buf) return chunk.buf[0]
  // OP_1..OP_16 = 0x51..0x60
  if (chunk.opcodenum >= 0x51 && chunk.opcodenum <= 0x60) return chunk.opcodenum - 0x50
  return null
}

function decodeMeasurement (method, buf) {
  if (method === 1) {
    if (buf.length < 1) return null
    return buf.readInt8(0)
  }
  if (buf.length < 4) return null
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

    const version = opcodeToNum(chunks[i + 1])
    if (version !== 1) continue

    const observerPub = chunks[i + 2].buf?.toString('hex')
    const peerPub = chunks[i + 3].buf?.toString('hex')
    const method = opcodeToNum(chunks[i + 4])
    const measBuf = chunks[i + 5].buf
    const sig = chunks[i + 6].buf

    if (!observerPub || !peerPub || !method || !measBuf || !sig) continue

    const value = decodeMeasurement(method, measBuf)
    if (value === null) continue

    // Verify ECDSA signature: sig covers prefix‖version‖observer‖peer‖method‖measurement
    try {
      const versionBuf = Buffer.from([version])
      const methodBuf = Buffer.from([method])
      const payload = Buffer.concat([
        chunks[i].buf,       // "LOCATE1"
        versionBuf,
        chunks[i + 2].buf,   // observer pubkey
        chunks[i + 3].buf,   // peer pubkey
        methodBuf,
        measBuf
      ])
      const hash = bsv.crypto.Hash.sha256(payload)
      const r = bsv.crypto.BN.fromBuffer(sig.slice(0, 32))
      const s = bsv.crypto.BN.fromBuffer(sig.slice(32, 64))
      const sigObj = new bsv.crypto.Signature({ r, s })
      const pubKey = bsv.PublicKey.fromString(observerPub)
      const verified = bsv.crypto.ECDSA.verify(hash, sigObj, pubKey)
      if (!verified) {
        console.log(`[sig] REJECTED txid=${tx?.hash?.slice(0,16)} observer=${observerPub.slice(0,12)}`)
        continue
      }
    } catch (e) {
      console.log(`[sig] ERROR ${e.message}`)
      continue
    }

    results.push({
      observer: observerPub,
      peer: peerPub,
      method: METHODS[method] || String(method),
      value,
      sig: sig.toString('hex')
    })
  }
  return results
}

// --- High-water mark ---
const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?')
const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')

function getWatermark () {
  const row = getMeta.get('lastBlock')
  return row ? parseInt(row.value) : null
}

function setWatermark (block) {
  setMeta.run('lastBlock', String(block))
}

// --- JungleBus ingestion ---
const savedBlock = getWatermark()
let startBlock = savedBlock !== null ? savedBlock : FROM_BLOCK
let lastBlock = startBlock
let txCount = 0

const jungle = new JungleBusClient('junglebus.gorillapool.io', {
  onConnected (ctx) { console.log('[junglebus] connected') },
  onConnecting () { console.log('[junglebus] connecting...') },
  onDisconnected () { console.log('[junglebus] disconnected') },
  onError (ctx) { console.error('[junglebus] error:', ctx) }
})

function ingest (tx) {
  txCount++
  try {
    const parsed = new bsv.Transaction(Buffer.from(tx.transaction, 'hex'))
    const attestations = parseOutputs(parsed)
    for (const a of attestations) {
      insertStmt.run(tx.id, tx.block_height || null, tx.block_time || null, a.observer, a.peer, a.method, a.value, a.sig)
      // Live fan-out to WebSocket clients
      wsBroadcast({ txid: tx.id, block: tx.block_height || null, ts: tx.block_time || null, ...a })
    }
  } catch (e) {
    console.log(`[ingest] ERROR tx=${tx.id} ${e.message}`)
  }
}

function onStatus (ctx) {
  if (ctx.statusCode === 200 && ctx.block) {
    lastBlock = ctx.block
    setWatermark(lastBlock)
  }
}

// --- WebSocket ---
const clients = new Set()

function wsBroadcast (msg) {
  const json = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(json)
  }
}

// --- Pagination helper ---
// Cursor = rowid. All list endpoints return { data, cursor, hasMore }.
// Pass ?after=<cursor> to get next page. Forward-only, stable under inserts.
function paginate (res, rows, limit) {
  const hasMore = rows.length === limit
  const cursor = rows.length ? rows[rows.length - 1]._rowid : null
  // Strip internal _rowid from response
  const data = rows.map(({ _rowid, ...rest }) => rest)
  return json(res, { data, cursor, hasMore })
}

// --- HTTP server ---
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')

  const url = new URL(req.url, `http://localhost:${PORT}`)
  const p = url.pathname
  const q = url.searchParams

  const limit = Math.min(parseInt(q.get('limit') || '100'), 1000)
  const after = q.get('after') ? parseInt(q.get('after')) : 0

  try {
    // 1. Status
    if (p === '/status') {
      const total = db.prepare('SELECT COUNT(*) as c FROM attestations').get().c
      const observers = db.prepare('SELECT COUNT(DISTINCT observer) as c FROM attestations').get().c
      const peers = db.prepare('SELECT COUNT(DISTINCT peer) as c FROM attestations').get().c
      const latest = db.prepare('SELECT MAX(block) as b FROM attestations').get().b
      return json(res, { attestations: total, observers, peers, latestBlock: latest, scanBlock: lastBlock, wsClients: clients.size, uptime: process.uptime() | 0 })
    }

    // 2. By pubkey — everything involving this key (as observer OR peer)
    if (p.startsWith('/pubkey/') && p.split('/').length === 3) {
      const pub = p.split('/')[2]
      const rows = db.prepare('SELECT rowid AS _rowid, * FROM attestations WHERE (observer = ? OR peer = ?) AND rowid > ? ORDER BY rowid ASC LIMIT ?').all(pub, pub, after, limit)
      return paginate(res, rows, limit)
    }

    // 3. By pubkey pair — everything between A and B
    if (p.startsWith('/pair/') && p.split('/').length === 4) {
      const [, , a, b] = p.split('/')
      const rows = db.prepare('SELECT rowid AS _rowid, * FROM attestations WHERE ((observer = ? AND peer = ?) OR (observer = ? AND peer = ?)) AND rowid > ? ORDER BY rowid ASC LIMIT ?').all(a, b, b, a, after, limit)
      return paginate(res, rows, limit)
    }

    // 4. By block range — between block N and M
    if (p === '/blocks') {
      const from = parseInt(q.get('from') || '0')
      const to = parseInt(q.get('to') || '999999999')
      const rows = db.prepare('SELECT rowid AS _rowid, * FROM attestations WHERE block >= ? AND block <= ? AND rowid > ? ORDER BY rowid ASC LIMIT ?').all(from, to, after, limit)
      return paginate(res, rows, limit)
    }

    // 5. By observer — one machine's view of the world
    if (p.startsWith('/observer/') && p.split('/').length === 3) {
      const pub = p.split('/')[2]
      const rows = db.prepare('SELECT rowid AS _rowid, * FROM attestations WHERE observer = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?').all(pub, after, limit)
      return paginate(res, rows, limit)
    }

    // 6. By peer — everything observed about this key
    if (p.startsWith('/peer/') && p.split('/').length === 3) {
      const pub = p.split('/')[2]
      const rows = db.prepare('SELECT rowid AS _rowid, * FROM attestations WHERE peer = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?').all(pub, after, limit)
      return paginate(res, rows, limit)
    }

    // 7. By method — all attestations of a given type
    if (p.startsWith('/method/') && p.split('/').length === 3) {
      const method = p.split('/')[2]
      const rows = db.prepare('SELECT rowid AS _rowid, * FROM attestations WHERE method = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?').all(method, after, limit)
      return paginate(res, rows, limit)
    }

    // 8. Latest by pubkey — most recent attestation involving this key
    if (p.startsWith('/latest/') && p.split('/').length === 3) {
      const pub = p.split('/')[2]
      const row = db.prepare('SELECT * FROM attestations WHERE observer = ? OR peer = ? ORDER BY rowid DESC LIMIT 1').get(pub, pub)
      return json(res, row || null)
    }

    // 9. Active pubkeys in block range
    if (p === '/active') {
      const from = parseInt(q.get('from') || '0')
      const to = parseInt(q.get('to') || '999999999')
      const rows = db.prepare(`
        SELECT DISTINCT pubkey FROM (
          SELECT observer AS pubkey FROM attestations WHERE block >= ? AND block <= ?
          UNION
          SELECT peer AS pubkey FROM attestations WHERE block >= ? AND block <= ?
        ) ORDER BY pubkey
      `).all(from, to, from, to)
      return json(res, rows.map(r => r.pubkey))
    }

    // 10. Count by pubkey
    if (p.startsWith('/count/') && p.split('/').length === 3) {
      const pub = p.split('/')[2]
      const c = db.prepare('SELECT COUNT(*) as c FROM attestations WHERE observer = ? OR peer = ?').get(pub, pub)
      return json(res, { pubkey: pub, count: c.c })
    }

    // 404
    res.statusCode = 404
    return json(res, {
      error: 'not found',
      endpoints: [
        'GET /status',
        'GET /pubkey/:pub?after=&limit=',
        'GET /pair/:pub1/:pub2?after=&limit=',
        'GET /blocks?from=N&to=M&after=&limit=',
        'GET /observer/:pub?after=&limit=',
        'GET /peer/:pub?after=&limit=',
        'GET /method/:type?after=&limit=',
        'GET /latest/:pub',
        'GET /active?from=N&to=M',
        'GET /count/:pub'
      ]
    })
  } catch (e) {
    res.statusCode = 500
    return json(res, { error: e.message })
  }
})

function json (res, data) {
  res.end(JSON.stringify(data))
}

// --- Start ---
async function main () {
  const startCount = db.prepare('SELECT COUNT(*) as c FROM attestations').get().c
  console.log(`LOCATE1 Indexer — ${startCount} attestations in db`)
  console.log(`  http://localhost:${PORT}`)
  console.log(`  JungleBus: ${SUB_ID}`)
  console.log(`  Resuming from block ${startBlock}${savedBlock !== null ? ' (persisted)' : ' (--from flag)'}`)

  // WebSocket upgrades on the same port
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })

  server.listen(PORT)
  await jungle.Subscribe(SUB_ID, startBlock, ingest, onStatus, console.error, ingest)

  setInterval(() => {
    const total = db.prepare('SELECT COUNT(*) as c FROM attestations').get().c
    console.log(`[stats] stored=${total} txs=${txCount} block=${lastBlock}`)
  }, 60_000)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
