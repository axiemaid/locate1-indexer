# locate1-indexer

Agent-first REST API for the [LOCATE1](https://github.com/axiemaid/locate1) peer observation protocol on BSV.

Ingests LOCATE1 attestations from chain via [JungleBus](https://junglebus.gorillapool.io), stores them in SQLite, and serves query endpoints designed for interpretation layers — positioning, trust scoring, presence detection, trilateration.

No opinions. No derived data. Just raw attestations, stored and queryable.

**Live instance:** https://locate1.axiemaid.com

## API

### Endpoints

| Endpoint | Description |
|---|---|
| `GET /status` | Network stats — attestation count, observers, peers, scan progress |
| `GET /pubkey/:pub` | Full history — every attestation involving this key (as observer or peer) |
| `GET /pair/:pub1/:pub2` | Relationship — every attestation between two specific machines |
| `GET /blocks?from=N&to=M` | Time window — attestations in a block range (for trilateration) |
| `GET /observer/:pub` | One machine's worldview — everything it observed |
| `GET /peer/:pub` | Evidence of existence — everything observed about this key |
| `GET /method/:type` | By measurement type — `rssi`, `uwb`, or `ultrasonic` |
| `GET /latest/:pub` | Current presence — most recent attestation involving this key |
| `GET /active?from=N&to=M` | Attendance list — all pubkeys active in a block range |
| `GET /count/:pub` | Availability score — total attestation count for a pubkey |
| `ws://` | WebSocket — live attestations pushed as JSON on connect |

All list endpoints support cursor pagination with `?after=<cursor>&limit=<n>`.

### Example Response

`GET /pubkey/03a00f7cad1d90d958d9173d09af24d4f6458e7ea97253d77ca7cf6603d9a1f5ad?limit=1`

```json
{
  "data": [
    {
      "txid": "0ede320a18cad8e95fdc8114dbd9e4807e1b3c24773a62382fc28b452f323e27",
      "block": 938851,
      "ts": 1772605732,
      "observer": "03a00f7cad1d90d958d9173d09af24d4f6458e7ea97253d77ca7cf6603d9a1f5ad",
      "peer": "0303339885d442d21a9642057315827d02275da49e53e36c5882038a8010f06023",
      "method": "rssi",
      "value": -12,
      "sig": "928c5f65f923610776160799..."
    }
  ],
  "cursor": 3,
  "hasMore": true
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `txid` | string | Transaction ID on BSV |
| `block` | int \| null | Block height (`null` if unconfirmed) |
| `ts` | int \| null | Block timestamp (unix seconds) |
| `observer` | string | Compressed public key of the measuring device (hex) |
| `peer` | string | Compressed public key of the observed device (hex) |
| `method` | string | `rssi`, `uwb`, or `ultrasonic` |
| `value` | int | Measurement — dBm for RSSI, nanoseconds for UWB, microseconds for ultrasonic |
| `sig` | string | ECDSA signature over the attestation payload (hex) |

### Pagination

Pass `?after=<cursor>` to get the next page. `cursor` is an opaque token from the previous response. Poll with your last cursor to stream new attestations incrementally.

`?limit=` controls page size (default 100, max 1000).

### WebSocket

Connect to `ws://host:port` for real-time attestation push. Each message is one attestation — same fields as above, no pagination wrapper:

```json
{"txid":"...","block":null,"ts":1772774554,"observer":"03a00f7c...","peer":"03033398...","method":"rssi","value":-20,"sig":"..."}
```

REST and WebSocket speak the same attestation format. The only difference is delivery: pull vs push.

## Self-Hosting

```bash
npm install
node index.cjs --sub <junglebus_subscription_id> --from <block_height>
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--port` | 3011 | HTTP + WebSocket port |
| `--sub` | — | JungleBus subscription ID (required) |
| `--from` | 0 | Start block height |
| `--db` | `./locate1.db` | SQLite database path |

### JungleBus Subscription

Create a subscription at [junglebus.gorillapool.io](https://junglebus.gorillapool.io):

- **Output types:** `nulldata`
- **Contexts:** `LOCATE1`
- Everything else: leave blank

Copy the subscription ID for the `--sub` flag.

## Protocol

Each attestation is an on-chain OP_RETURN:

```
OP_FALSE OP_RETURN "LOCATE1" <version> <observer_pub> <peer_pub> <method> <measurement> <signature>
```

Spec: https://github.com/axiemaid/locate1

## License

MIT
