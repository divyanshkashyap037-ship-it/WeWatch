# WeWatchy — go live online

One service serves everything: the React app, the API, Socket.io, uploads.
Deploy it, share `https://your-app/r/abc123`, friends join from anywhere.

Why each piece matters:

- **HTTPS is required for cameras.** Browsers block `getUserMedia` on plain
  `http://` (except `localhost`). Render / Fly / Railway all give you HTTPS
  for free — use it.
- **TURN is required for video across networks.** Two laptops on the same WiFi
  connect directly (STUN only). Across homes/mobile networks, NATs block
  direct paths and faces stay black without a TURN relay.

## Option A — Render (easiest, free)

1. Push `D:\WeWatchy` to GitHub.
2. Render dashboard → New → Blueprint → select the repo.
   `render.yaml` creates the web service (Docker, free plan).
3. Add TURN env vars (see below) → Deploy.
4. Open `https://<your-app>.onrender.com/api/health` → `{"ok":true,...}`.
5. Open `https://<your-app>.onrender.com/api/config` → `"turnConfigured":true`.

Note: free Render sleeps after inactivity — first load takes ~1 min to wake.

## Option B — Fly.io

```
fly launch --dockerfile Dockerfile --no-deploy
fly volumes create uploads_data --size 1   # keeps uploaded files across restarts
fly deploy
```

With a volume, mount it at `/app/uploads` (`fly.toml` `[[mounts]]`).
Without a volume, uploads vanish on each deploy (YouTube links are unaffected).

## TURN setup (do this regardless of host)

**Quick (free, no signup):** Metered Open Relay —
https://www.metered.ca/tools/openrelay/
Copy the current TURN urls + username + credential into env vars:

```
TURN_URLS=turn:<host>:80,turn:<host>:443?transport=tcp
TURN_USERNAME=<username>
TURN_CREDENTIAL=<credential>
```

**Production (your own relay):** run coturn on any VPS with a public IP:

```
docker run -d --restart always \
  -p 3478:3478 -p 3478:3478/udp \
  -p 49152-65535:49152-65535/udp \
  coturn/coturn \
  -n --log-file stdout \
  --external-ip=<PUBLIC_IP> \
  --user=wewatchy:<STRONG_PASSWORD> \
  --realm=wewatchy
```

then `TURN_URLS=turn:<PUBLIC_IP>:3478` + that user/password.

Verify relay works: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
paste your TURN url + credentials → you should see `relay` candidates.

## Env reference

| Var | Default | What |
| --- | ------- | ---- |
| `PORT` | 3000 | HTTP port (hosts inject their own) |
| `MAX_UPLOAD_MB` | 1024 | Max video upload size |
| `TURN_URLS` | — | Comma-separated `turn:` urls |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | — | Static TURN credentials |

## After deploy checklist

1. `/api/health` → ok.
2. `/api/config` → `turnConfigured: true`.
3. Two phones on mobile data: create room, join, faces appear (TURN works),
   paste YouTube link, both play in sync.
4. Camera asks permission → means HTTPS is good.
