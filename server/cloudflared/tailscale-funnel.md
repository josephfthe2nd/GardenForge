# No domain? Tailscale Funnel (or private Tailscale Serve)

> **Status: not yet executed. Verify on first install.** Tailscale's `serve`/`funnel` command
> syntax has changed between versions; the commands below use the form introduced around
> Tailscale 1.52 (`--bg`, `--set-path`). Check `tailscale funnel --help` on your server and
> <https://tailscale.com/kb/1223/funnel> before running them. Whether path mounts strip the mount
> prefix, and which proxy headers Funnel adds, are **UNVERIFIED** here; the smoke test is how you
> find out.

Two ways to use Tailscale:

| | Tailscale **Funnel** (public) | Tailscale **Serve** (private) |
| --- | --- | --- |
| Who can reach the server | anyone on the internet, at `https://<machine>.<tailnet>.ts.net` | only your own devices signed in to your tailnet |
| What the phone needs | nothing extra | the Tailscale app, connected whenever the garden app syncs |
| Exposure | the app's API paths are public (sign-in protected) | nothing is public at all |

If you are happy to keep the Tailscale app connected on the iPhone and the PC, **Serve** is the
safer choice: replace `funnel` with `serve` in the commands below.

## Steps

1. **Install Tailscale** on the server with Tailscale's own instructions
   (<https://tailscale.com/download/linux>), then `sudo tailscale up` and sign in.

2. In the Tailscale **admin console**: enable **MagicDNS** and **HTTPS certificates**, and allow
   **Funnel** for this machine (the tailnet policy needs the `funnel` node attribute; the CLI prints
   a link to the right page if it is missing).

3. **Expose only the app's paths**, one mount per path prefix (keep this list in step with
   `TUNNEL_PATHS` in `server/pb_hooks/gardenforge_lib.js`):

   ```bash
   T=http://127.0.0.1:8090
   sudo tailscale funnel --bg --set-path /api/health        $T/api/health
   sudo tailscale funnel --bg --set-path /api/gf/sync       $T/api/gf/sync
   sudo tailscale funnel --bg --set-path /api/collections/users/auth-with-password $T/api/collections/users/auth-with-password
   sudo tailscale funnel --bg --set-path /api/collections/users/auth-refresh       $T/api/collections/users/auth-refresh
   sudo tailscale funnel --bg --set-path /api/collections/gf_records   $T/api/collections/gf_records
   sudo tailscale funnel --bg --set-path /api/collections/gf_conflicts $T/api/collections/gf_conflicts
   sudo tailscale funnel --bg --set-path /api/collections/gf_photos    $T/api/collections/gf_photos
   sudo tailscale funnel --bg --set-path /api/files/token     $T/api/files/token
   sudo tailscale funnel --bg --set-path /api/files/gf_photos $T/api/files/gf_photos
   tailscale funnel status
   ```

   These mounts are prefixes, so they are a little broader than the Cloudflare rule (for example
   `/api/collections/gf_records/anything`); that is acceptable because those collections are
   owner-only, and PocketBase's own allowlist still applies.
   Expected behaviour (UNVERIFIED): a request for `<mount>/<rest>` is forwarded to
   `<target>/<rest>`. If Tailscale instead forwards the full path, every request returns 404:
   it fails closed, and the smoke test shows it.

4. **Run the smoke test** on the server:

   ```bash
   /opt/gardenforge/scripts/smoke.sh --public https://<machine>.<tailnet>.ts.net --origin https://YOUR-SITE.vercel.app
   ```

   If `/_/` or the superuser sign-in path answer anything other than 404, run
   `sudo tailscale funnel reset` and fix the mounts before going further.

5. **Real visitor IPs in PocketBase** (Settings > Application > "User IP proxy headers"): try
   `X-Forwarded-For`, then confirm in Dashboard > Logs that requests from the phone show its
   public IP rather than `127.0.0.1`. That Funnel sets this header is UNVERIFIED.

## Limitation if your Tailscale version cannot mount paths

The only remaining option would be to funnel the whole port (`sudo tailscale funnel --bg 8090`).
Then the admin UI is blocked only by PocketBase's in-process allowlist
(`server/pb_hooks/gardenforge_sync.pb.js`), which recognises tunnel traffic by proxy headers such
as `X-Forwarded-For` or `Tailscale-Funnel-Request`. Whether Funnel sends one of them is
UNVERIFIED. Run the smoke test: **if `/_/` answers 200 through the public address, do not use this
setup**; use Tailscale Serve (private) instead, or a domain with the Cloudflare tunnel.

## Other notes

- Funnel serves only on ports 443, 8443 and 10000; the hostname stays the same as long as the
  machine's Tailscale name does.
- `tailscale funnel reset` removes every mount; `tailscale funnel status` lists them.
