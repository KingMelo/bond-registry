# The Canton node on Unraid

The node the bond registry and Omni-Stance share, on your own server instead of Railway. Same
containers as before (`canton/node`, `canton/gateway`), plus Postgres 17 and a Cloudflare Tunnel.

```
 Railway apps ──HTTPS──▶ Cloudflare ──tunnel──▶ gateway ──▶ canton (node) ──▶ postgres
                                                  │
                         your LAN ──http :8686──▶ /dashboard
```

Only the gateway is reachable from outside, and only through the tunnel: no port is opened on
your router. The node and the database have no published ports at all.

## Set up

1. **Compose:** install the *Docker Compose Manager* plugin (Apps tab), or use `docker compose`
   from the terminal. Copy `docker-compose.yml` and `.env.example` to a folder on the server,
   e.g. `/mnt/user/appdata/canton-node/compose/`, and rename `.env.example` to `.env`.
2. **Secrets:** fill in `.env`. Make each with `openssl rand -base64 24`:
   - `POSTGRES_PASSWORD`;
   - `KEY_BOND_REGISTRY` and `KEY_OMNI_STANCE`: each app's key (it goes on that app on Railway);
   - `DASHBOARD_PASSWORD`: your sign-in for the dashboard.
3. **Tunnel:** in Cloudflare (free plan is fine) go to *Zero Trust → Networks → Tunnels → Create
   a tunnel* (Cloudflared). Copy the token from the install command into `CLOUDFLARE_TUNNEL_TOKEN`.
   Add a *public hostname*, e.g. `canton.yourdomain.com`, with service `http://gateway:8080`.
4. **Start:** `docker compose up -d --build`. The first build downloads the Daml SDK image
   (about 1 GB) and takes a few minutes. The node is ready when its log says
   `Canton node is ready` (`docker compose logs -f canton`).
5. **Check:** `https://canton.yourdomain.com/healthz` answers `{"ok":true}`. On your LAN,
   `http://<unraid-ip>:8686/dashboard` opens the dashboard.
6. **Connect the apps** (when you're ready to switch the mirrors on): on Railway, give each app
   `CANTON_JSON_URL=https://canton.yourdomain.com` and its `CANTON_API_KEY`.

## Keep it safe

- **Back up** `APPDATA` (the `postgres` folder holds every contract; nobody else has a copy).
  The *Appdata Backup* plugin works; stop the stack while it copies, or add a nightly
  `docker compose exec postgres pg_dumpall -U canton > canton-$(date +%F).sql`.
- **Memory:** the node takes up to 3 GB (`CANTON_MEMORY`).
- **Updates:** `docker compose up -d --build` rebuilds from the branch in `SOURCE`.
- **DevNet later** needs a fixed outbound IP the network's operators approve. A home connection's
  IP usually changes, so that step needs a static IP from your ISP or a small relay.
