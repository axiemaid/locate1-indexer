# locate1-indexer

Agent-first REST API for the [LOCATE1](https://github.com/axiemaid/locate1) peer observation protocol on BSV.

Ingests LOCATE1 attestations from chain via [JungleBus](https://junglebus.gorillapool.io), stores them in SQLite, and serves nine query endpoints designed for interpretation layers — positioning, trust scoring, presence detection, trilateration.

No opinions. No derived data. Just raw attestations, stored and queryable.

**Live instance:** https://locate1.axiemaid.com

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /status` | Network stats — attestation count, observers, peers, scan progress |
| `GET /pubkey/:pub` | Full history — every attestation involving this key (as observer or peer) ¹ |
| `GET /pair/:pub1/:pub2` | Relationship — every attestation between two specific machines ¹ |
| `GET /blocks?from=N&to=M` | Time window — attestations in a block range (for trilateration) ¹ |
| `GET /observer/:pub` | One machine's worldview — everything it observed ¹ |
| `GET /peer/:pub` | Evidence of existence — everything observed about this key ¹ |
| `GET /method/:type` | By measurement type — `rssi`, `uwb`, or `ultrasonic` ¹ |
| `GET /latest/:pub` | Current presence — most recent attestation involving this key |
| `GET /active?from=N&to=M` | Attendance list — all pubkeys active in a block range |
| `GET /count/:pub` | Availability score — total attestation count for a pubkey |

¹ Supports cursor pagination (`?after=&limit=`)

All list endpoints return paginated responses:

```json
{ "data": [...], "cursor": 42, "hasMore": true }
```

Pass `?after=<cursor>` to get the next page. Poll with your last cursor to stream new attestations.

`?limit=` controls page size (default 100, max 1000).

## JungleBus Subscription

Create a subscription at [junglebus.gorillapool.io](https://junglebus.gorillapool.io):

- **Output types:** `nulldata`
- **Contexts:** `LOCATE1`
- Everything else: leave blank

Copy the subscription ID for the `--sub` flag.

To debug how JungleBus parses/classifies a specific transaction:
```
https://junglebus.gorillapool.io/v1/transaction/get/<txid>
```
Check that `output_types` includes `nulldata` and `contexts` includes `LOCATE1`.

## Usage

```bash
npm install
node index.cjs --sub <junglebus_subscription_id> --from <block_height>
```

Options:
- `--port` — HTTP port (default: 3011)
- `--sub` — JungleBus subscription ID (required)
- `--from` — Start block height (default: 0)
- `--db` — SQLite database path (default: `./locate1.db`)

## LOCATE1 Protocol

Each attestation is an on-chain OP_RETURN:

```
OP_FALSE OP_RETURN "LOCATE1" <version> <observer_pub> <peer_pub> <method> <measurement> <signature>
```

Spec: https://github.com/axiemaid/locate1

## License

MIT
