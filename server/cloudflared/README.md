# Cloudflare named tunnel (for owners with a domain on Cloudflare)

> **Status: not yet executed. Verify on first install.** The commands follow Cloudflare's
> `cloudflared` documentation as known at the time of writing; Cloudflare changes its CLI and
> dashboard from time to time, so check each step against
> <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/> if something
> differs.

A named tunnel makes an outbound connection from the server to Cloudflare. Nothing is opened on
your router, PocketBase keeps listening on `127.0.0.1` only, and visitors reach
`https://api.YOUR-DOMAIN` with a certificate managed by Cloudflare. The tunnel forwards **only the
paths the app uses** and answers 404 for everything else, including the PocketBase admin UI
(`/_/`) and the superuser API.

**You need:** a domain whose DNS is managed by Cloudflare (the free plan is enough), the
GardenForge server installed and healthy (`server/install.sh`), and a shell on the server.
Below, `api.example.com` stands for the hostname you choose.

## Steps

1. **Install `cloudflared`** on the server using Cloudflare's own instructions for your OS
   (Debian/Ubuntu/Raspberry Pi OS: Cloudflare's apt repository or `.deb` package). This repository
   does not script it, so that third-party software comes straight from Cloudflare.
   Check: `cloudflared --version`.

2. **Log in** (once): `cloudflared tunnel login`. It prints a URL; open it on any computer, sign in
   to Cloudflare and pick your domain. This stores `~/.cloudflared/cert.pem`.

3. **Create the tunnel**: `cloudflared tunnel create gardenforge`. Note the tunnel id (a UUID). It
   writes `~/.cloudflared/<UUID>.json`, the tunnel's credentials: treat it like a password.

4. **Point a hostname at it**: `cloudflared tunnel route dns gardenforge api.example.com`
   (creates the DNS record in Cloudflare).

5. **Install the configuration**:

   ```bash
   sudo mkdir -p /etc/cloudflared
   sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/
   sudo chmod 600 /etc/cloudflared/<UUID>.json
   sudo cp server/cloudflared/config.yml.example /etc/cloudflared/config.yml
   sudo nano /etc/cloudflared/config.yml   # put the UUID in both places, set your hostname
   ```

6. **Check the rules before going live**:

   ```bash
   sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
   # Which rule does each URL hit? The first two must hit the 127.0.0.1:8090 rule,
   # the others the final http_status:404 rule.
   sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://api.example.com/api/gf/sync/push
   sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://api.example.com/api/files/gf_photos/abc123/photo_x.jpg
   sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://api.example.com/_/
   sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://api.example.com/api/collections/_superusers/auth-with-password
   ```

7. **Try it in the foreground**: `sudo cloudflared tunnel --config /etc/cloudflared/config.yml run gardenforge`.
   From the phone **on cellular data** (not home Wi-Fi), open
   `https://api.example.com/api/health` (expect a short JSON "API is healthy" reply) and
   `https://api.example.com/_/` (expect a 404 page). Stop with Ctrl+C.

8. **Run it as a service** (starts at boot):

   ```bash
   sudo cloudflared service install      # uses /etc/cloudflared/config.yml
   sudo systemctl enable --now cloudflared
   systemctl status cloudflared
   ```

9. **Run the smoke test** on the server:

   ```bash
   /opt/gardenforge/scripts/smoke.sh --public https://api.example.com --origin https://YOUR-SITE.vercel.app
   ```

   Every line must say PASS.

10. **Let PocketBase see the visitor's IP.** In the admin UI (server/README.md, "Admin UI"):
    Settings > Application > "User IP proxy headers" = `CF-Connecting-IP`. Without it, the logs and
    the rate limiter see every visitor as `127.0.0.1` (cloudflared). This is safe here because
    PocketBase listens only on `127.0.0.1`, so every outside request passes through cloudflared,
    and Cloudflare sets that header itself at its edge.

## Keeping it right

- The `path:` regular expression in `/etc/cloudflared/config.yml` must stay identical to
  `TUNNEL_PATHS` in `server/pb_hooks/gardenforge_lib.js`. When the app needs a new server path,
  change both, restart `cloudflared` and PocketBase, and re-run the smoke test.
- Do not replace the explicit list with `^/api/`: that would also expose superuser sign-in,
  backups and settings, which live under `/api/` too.
- Cloudflare limits request bodies (100 MB on the free plan, at the time of writing) and waits
  about 100 seconds for a response; GardenForge's photo uploads (at most 25 MB) and pushes are
  far below both.
- To remove the tunnel: `sudo systemctl disable --now cloudflared`, then
  `cloudflared tunnel delete gardenforge` and delete the DNS record.
