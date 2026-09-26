# OCPP Mirror Proxy

This app sits between your EV chargers and their backend (CSMS). Every charger
keeps talking to its usual backend — the **primary** — while the proxy sends a
copy of the charger's traffic to one or more extra backends — the
**secondaries**. Use it to feed your own monitoring or energy management
system, or to try a new platform before switching over, without touching the
charger's contract with its current backend.

Only the primary controls the charger. Secondaries see what the charger
reports (boot, status, meter values, start/stop of charging) and may read
diagnostics, but anything they try to control is refused. If a secondary is
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

### Mirror to backends (all chargers)

Backends that receive a copy of the traffic from **every** charger connected
to the proxy, under the charger's own ID and with the charger's own username
and password:

```yaml
secondary_csms:
  - url: "wss://analytics.example.com/ocpp"
```

### Mirror to backends (per charger)

Mirror **one** charger to a backend. Add one entry per charger and backend
pair; the same backend can appear in several entries for different chargers.

```yaml
charger_mappings:
  - charger_id: CHARGER-001
    secondary_url: "wss://analytics.example.com/ocpp"
  - charger_id: CHARGER-001
    secondary_url: "wss://other-backend.example.com/ocpp"
    mapped_charger_id: ext-CHARGER-001
    password: secret123
    id_tag: HARDCODED-TAG
```

| Option | Required | What it does |
|---|---|---|
| **Charger ID** (`charger_id`) | Yes | ID the charger connects to the proxy with — the last part of its URL. Must match exactly. |
| **Backend URL** (`secondary_url`) | Yes | Backend to mirror this charger to, without a charger ID at the end. |
| **Charger ID on this backend** (`mapped_charger_id`) | No | Use when the backend has registered this charger under a different ID. The proxy connects with this ID and uses it in the charger's boot message. |
| **Backend password** (`password`) | No | Password this backend expects. The username sent is the charger ID on this backend. When empty, the charger's own username and password are reused. |
| **RFID tag on this backend** (`id_tag`) | No | Replaces the RFID tag in every charging session sent to this backend. Useful when the backend only accepts tags it knows. |

A charger with no entries here, and nothing under *all chargers*, is
connected to the primary only. If the same backend URL is listed twice for a
charger with the same charger ID (for example under *all chargers* and again
here without **Charger ID on this backend**), the proxy connects once and logs
a warning.

### Add charger ID to mirror URLs

On by default: the proxy adds `/<charger ID>` to every mirror URL, using
**Charger ID on this backend** for per-charger mirrors when it's set. For
example, `wss://analytics.example.com/ocpp` becomes
`wss://analytics.example.com/ocpp/ext-CHARGER-001`.

Turn it off when your mirror URLs already identify the charger. It applies to
all mirrors at once, both *all chargers* and *per charger*.

> **OCPP 1.6 only:** *RFID tag on this backend* and the charger ID in the boot
> message only take effect for chargers using OCPP 1.6. For OCPP 2.0.1
> chargers the backend is still reached under its mapped ID and password, but
> the messages are passed on unchanged.

### Log level

`info` (default) logs connections and errors. Set `debug` to see every OCPP
message in the **Log** tab — useful when a backend doesn't show the data you
expect. Switch back to `info` afterwards; debug logging is verbose.

### Debug message length limit

How many characters of each OCPP message are shown in debug logs. The default
is 120. Set `0` to show complete messages, e.g. to see full meter values.

## What secondaries can do

| Command from a secondary | Result |
|---|---|
| `TriggerMessage`, `GetConfiguration` | Passed to the charger; the answer goes back to that secondary |
| Commands that control the charger (`RemoteStartTransaction`, `Reset`, …) | Refused by the proxy; the charger never sees them |
| Anything else | Answered with `NotSupported` |

A charger handles one backend request at a time. When the primary is waiting
for an answer, a secondary's `TriggerMessage` or `GetConfiguration` waits
until the charger has replied, and the primary's requests always go first. If
the charger can't be reached or doesn't answer within 30 seconds, the secondary
gets an error reply instead.

Each secondary must reply to the messages it receives, as a normal backend
does. The proxy waits for each reply before sending the next message, resends
an unanswered message after 2 minutes, and skips it after a second timeout.
While a secondary is unreachable, the proxy keeps the most recent 100 messages
for it, reconnects every 10 seconds and sends them in order once it's back.

For OCPP 1.6 chargers, each backend gives out its own transaction numbers. The
proxy translates them so that meter values and stop messages reach each
secondary with the number that secondary gave. These translations are saved
in the app's data folder, so a restart in the middle of a charging session
doesn't break them. They are included in Home Assistant backups.

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
- For *per charger* mirrors, check that **Charger ID** matches the ID in the
  `session started` log line exactly.
- Check whether the backend expects the charger ID at the end of its URL, and
  set **Add charger ID to mirror URLs** to match.
- `Unexpected server response: 401` (or `403`) means the backend refused the
  credentials. Check **Charger ID on this backend** and **Backend password**.

**A secondary shows charging sessions twice.** When a start-of-charging
message goes unanswered, it is resent. OCPP 1.6 gives the backend no ID to
tell the copy from a new session, so some backends record it twice. Check
that the backend answers promptly.

## Support

Report problems at
[github.com/tomakava/joulo-ocpp-proxy/issues](https://github.com/tomakava/joulo-ocpp-proxy/issues).
Set **Log level** to `debug` and include the relevant log lines — remove
passwords first.
