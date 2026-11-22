# The Canton node (Railway)

One Canton node shared by the bond registry and Omni-Stance, in its own Railway project. It runs
a participant (the ledger both apps use) with its own sequencer and mediator, everything stored in
Postgres, so contracts survive restarts and redeploys. Until it joins a shared network (DevNet,
then MainNet), it is its own private synchronizer.

- `Dockerfile`: Canton from the Daml SDK 3.4.0-rc2 image, the release the contracts are tested with.
- `node.conf`: the three parts, each with its own database (`canton_participant`,
  `canton_sequencer`, `canton_sequencer_driver`, `canton_mediator`, created on first start).
- `node.canton`: run on every start; sets up the synchronizer and connects the participant the
  first time only.

Settings (Railway variables): `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` from the
project's Postgres; `JAVA_OPTS` for memory; `CANTON_BIND` only to listen on IPv4 locally.

Ports: ledger API 6865 (gRPC), JSON API 7575, admin API 6866. None is public yet: the apps get
access through the next step (each with its own login, acting only for its own parties).

Tested locally (Nov 22, 2026): started against Postgres, both apps' packages uploaded, a receivable
created, the container restarted: the contract was still there and the node reconnected on its own.

Locally: `docker build -t canton-node . && docker run --network host -e CANTON_BIND=0.0.0.0 -e PGHOST=… canton-node`
