# Joulo OCPP Proxy

This app sits between your EV chargers and their backend (CSMS). Every charger
keeps talking to its usual backend — the **primary** — while the proxy sends a
copy of the charger's traffic to one or more extra backends — the
**secondaries**. Use it to feed your own monitoring or energy management
system, or to try a new platform before switching over, without touching the
charger's contract with its current backend.

Only the primary controls the charger. Secondaries see what the charger
reports (boot, status, meter values, start/stop of charging) ; anything they
send back is ignored. If a secondary is
down, the charger and the primary are not affected.

## Setup

1. Fill in the **Configuration** tab (see below). Only **Primary CSMS URL** is
   required.
2. Click **Start**. On the **Info** tab, enable **Start on boot** and
   **Watchdog**.
3. Open the **Log** tab and check for `proxy listening`.
4. In each charger's settings (its app or web page), change the OCPP backend
   URL to point at Home Assistant:

   ```
   Before: wss://your-csms.example.com/ocpp/CHARGER-001
   After:  ws://<home-assistant-ip>:9000/CHARGER-001
   ```

   Keep the charger ID at the end of the URL exactly as it was. The proxy
   uses it to connect to the backends on the charger's behalf.

The charger connects over plain `ws://` inside your network; the proxy uses
whatever the backend URLs say (usually `wss://`) for the connection out.
Give Home Assistant a fixed IP address so your chargers don't lose it.

## Configuration

### Primary CSMS URL

The backend your chargers were connected to before, without the charger ID at
the end:

```yaml
primary_csms_url: "wss://your-csms.example.com/ocpp"
```

The proxy adds `/<charger ID>` itself, so a charger connecting as
`CHARGER-001` reaches `wss://your-csms.example.com/ocpp/CHARGER-001`. If the
charger sends a username and password, they are passed on to the primary
unchanged.

### Add charger ID to primary URL

On by default. Turn it off when the backend gave you one complete URL per
charger, e.g. `wss://fixed-csms.example.com/XXXXXXXX`, and enter that full URL
as **Primary CSMS URL**. With it off, every charger connected to the proxy
reaches that same URL, so use it with a single charger.

### Mirror to backends

Backends that receive a copy of the traffic from **every** charger connected
to the proxy, under the charger's own ID and with the charger's own username
and password:

```yaml
secondary_csms:
  - url: "wss://analytics.example.com/ocpp"
```

Chargers are connected to the primary only unless mirrors are listed here.

### Add charger ID to mirror URLs

On by default: the proxy adds `/<charger ID>` to every mirror URL, so
`wss://analytics.example.com/ocpp` becomes
`wss://analytics.example.com/ocpp/CHARGER-001`. Turn it off when your mirror
URLs already identify the charger. It applies to all mirrors at once.

### Log level

`info` (default) logs connections and errors. Set `debug` to see every OCPP
message in the **Log** tab — useful when a backend doesn't show the data you
expect. Switch back to `info` afterwards; debug logging is verbose.

### Debug message length limit

How many characters of each OCPP message are shown in debug logs. The default
is 120. Set `0` to show complete messages, e.g. to see full meter values.

## What secondaries can do

Secondaries receive every message the charger sends. Their replies, and any
commands they send, are logged and ignored, so they can never control the
charger.

While a secondary is unreachable, the proxy keeps the most recent 100 messages
for it, reconnects every 10 seconds and sends them in order once it's back.

## Troubleshooting

**The app stops right after starting.** Check the log. The most common cause
is an empty **Primary CSMS URL**.

**The charger doesn't connect.**
- The charger URL must start with `ws://`, not `wss://`, and use port `9000`.
- Check the charger can reach Home Assistant's IP address (same network, no
  firewall blocking port 9000).
- The log shows `session started` with the charger ID when a charger connects.

**The primary works, but a secondary doesn't get data.**
- Look for `secondary error` or `secondary disconnected` lines with the
  secondary's URL. Set **Log level** to `debug` to also see the messages sent
  to it.
- Check whether the backend expects the charger ID at the end of its URL, and
  set **Add charger ID to mirror URLs** to match.
- `Unexpected server response: 401` (or `403`) means the backend refused the
  charger's username and password.

## Support

Report problems at
[github.com/tomakava/joulo-ocpp-proxy/issues](https://github.com/tomakava/joulo-ocpp-proxy/issues).
Set **Log level** to `debug` and include the relevant log lines — remove
passwords first.
