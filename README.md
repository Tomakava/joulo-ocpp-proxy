# joulo-ocpp-proxy

A lightweight **OCPP WebSocket proxy** that sits between your EV chargers and one or more CSMS backends. It forwards all traffic to a **primary CSMS** and optionally mirrors it to **secondary backends** — perfect for monitoring, analytics, or migrating between platforms without reconfiguring your chargers.

Built with Node.js and TypeScript. Supports OCPP 1.6 and 2.0.1.

## How it works

```mermaid
graph LR
    Charger["⚡ Charger"]
    Proxy["OCPP Proxy"]
    Primary["Primary CSMS"]
    S1["Secondary CSMS 1"]
    S2["Secondary CSMS 2"]
    SN["Secondary CSMS N"]

    Charger <-->|"OCPP (WS)"| Proxy
    Proxy <-->|"full bidirectional"| Primary
    Proxy -->|"mirror"| S1
    Proxy -->|"mirror"| S2
    Proxy -.->|"mirror"| SN
```

| Direction | Primary CSMS | Secondary CSMS (×N) |
|---|---|---|
| Charger → CSMS | ✅ Forwarded | ✅ CALLs mirrored |
| CSMS → Charger | ✅ Forwarded | ⚠️ Selected commands only |

The **primary CSMS** has full control — it can send any command back to the charger. Secondary backends receive a mirrored copy of all charger messages (boot notifications, meter values, start/stop transactions, etc.). Most secondary responses are discarded, but a small set of diagnostic commands (`TriggerMessage`, `GetConfiguration`) are forwarded to the charger so a secondary can still inspect charger state. Secondary connections are best-effort — if one fails, it never affects the charger or the primary link.

#### Secondary commands forwarded to the charger

| Command | Behaviour |
|---|---|
| `TriggerMessage` | Forwarded to charger; response returned to that secondary |
| `GetConfiguration` | Forwarded to charger; response returned to that secondary |
| `RemoteStartTransaction` | Acknowledged locally with `Accepted`; idTag saved and substituted into the next `StartTransaction` sent to that secondary |
| All others | Rejected locally with a `NotSupported` CallError; charger never sees them |

### Secondary reliability

Because charger sessions can stay open for days or weeks, secondaries get a few extras so a brief network blip doesn't silently break your mirror for the rest of the session:

- **Auto-reconnect** — if a secondary disconnects, the proxy reconnects after 10s and keeps retrying until the charger session ends.
- **Keepalive ping** — the proxy sends a WebSocket ping to each secondary every 30s so idle connections aren't dropped by load balancers or CSMS timeouts.
- **Bounded queue** — while a secondary is reconnecting, up to 100 messages per secondary are buffered and replayed once it's back. Older messages are dropped first if the buffer fills.

A secondary failure never affects the charger or the primary link.

## Quick start

### Home Assistant App

The easiest way to run the proxy on a Home Assistant installation.

**1. Add the repository**

In Home Assistant, go to **Settings → Apps → Install app**, then open the three-dot menu in the top right → **Repositories**, and add:

```
https://github.com/tomakava/joulo-ocpp-proxy
```

**2. Install**

After the repository loads, find **Joulo OCPP Proxy** in the store and click **Install**.

**3. Configure**

Go to the app's **Configuration** tab and fill in your settings:

```yaml
primary_csms_url: "wss://your-primary-csms.example.com/ocpp"
secondary_csms:
  - url: "wss://analytics.example.com/ocpp"
  - url: "wss://other-backend.example.com/ocpp"
    charger_map:
      - charger_id: CHARGER-001
        mapped_charger_id: ext-CHARGER-001
        password: secret123
        id_tag: HARDCODED-TAG
log_level: info
```

All fields except `primary_csms_url` are optional. `charger_map` inside a secondary entry is only needed when that backend expects a different charger ID, password, or `id_tag` than the primary.

**4. Start**

Click **Start**. The proxy will listen on port 9000. Enable **Start on boot** and **Watchdog** on the Info tab so it restarts automatically.

**5. Point your chargers at the proxy**

Change each charger's OCPP backend URL from the primary CSMS to the proxy's address:

```
Before: wss://your-csms.example.com/ocpp/CHARGER-001
After:  ws://<homeassistant-ip>:9000/CHARGER-001
```

---

### Using Docker (recommended)

A pre-built image is published automatically to GitHub Container Registry on every push to `main`.

```bash
docker run -d \
  -p 9000:9000 \
  -e PRIMARY_CSMS_URL=wss://your-primary-csms.example.com/ocpp \
  -e SECONDARY_CSMS_URLS=wss://analytics.example.com/ocpp \
  ghcr.io/joulo-nl/joulo-ocpp-proxy:main
```

### Using Docker Compose

```bash
git clone https://github.com/joulo-nl/joulo-ocpp-proxy.git
cd joulo-ocpp-proxy
mkdir -p data
cp config.example.json data/config.json
# Edit data/config.json with your CSMS URLs
# The container runs as the node user (UID 1000) — make data/ writable:
sudo chown -R 1000:1000 data
docker compose up -d
```

### From source

```bash
git clone https://github.com/joulo-nl/joulo-ocpp-proxy.git
cd joulo-ocpp-proxy
npm install
npm run build
PRIMARY_CSMS_URL=wss://your-csms.example.com/ocpp npm start
```

## Configuration

### Config file (recommended)

Create a `config.json` file (see `config.example.json`) and point the container at it with `CONFIG_FILE`:

```json
{
  "primary_csms_url": "wss://your-primary-csms.example.com/ocpp",
  "secondary_csms": [
    {
      "url": "wss://analytics.example.com/ocpp"
    },
    {
      "url": "wss://other-backend.example.com/ocpp",
      "charger_map": [
        {
          "charger_id": "CHARGER-001",
          "mapped_charger_id": "ext-CHARGER-001",
          "password": "secret123",
          "id_tag": "HARDCODED-TAG"
        }
      ]
    }
  ],
  "log_level": "info"
}
```

`charger_map` inside a secondary entry is only needed when that backend expects a different charger ID, password, or `id_tag` than the primary.

### Environment variables

For simple deployments without charger ID remapping, environment variables are sufficient:

| Variable | Required | Default | Description |
|---|---|---|---|
| `CONFIG_FILE` | No | `/data/options.json` | Path to the JSON config file |
| `PORT` | No | `9000` | Port the proxy listens on |
| `PRIMARY_CSMS_URL` | No* | — | WebSocket URL of your primary CSMS |
| `SECONDARY_CSMS_URLS` | No | — | Comma-separated list of secondary CSMS URLs |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error` |
| `LOG_MAX_MESSAGE_LENGTH` | No | `120` | Max chars of an OCPP message body shown in `debug` logs before truncation |

\* Required if not set in the config file. Environment variables take precedence over the config file.

## Charger setup

Point your charger's OCPP backend URL to the proxy instead of the CSMS directly:

```
Before:  wss://your-csms.example.com/ocpp/CHARGER-001
After:   ws://proxy-host:9000/CHARGER-001
```

The proxy appends the charge point ID from the incoming URL to each upstream CSMS URL automatically. If your charger connects to `ws://proxy:9000/CHARGER-001`, the proxy connects to:

- `wss://your-primary-csms.example.com/ocpp/CHARGER-001`
- `wss://analytics.example.com/ocpp/CHARGER-001`

### URL patterns

The proxy accepts any of these URL patterns and extracts the last path segment as the charge point ID:

```
ws://proxy:9000/CHARGER-001
ws://proxy:9000/ocpp/CHARGER-001
ws://proxy:9000/ws/CHARGER-001
```

### Authentication

If the charger sends HTTP Basic Auth credentials, the proxy forwards the `Authorization` header to all upstream CSMS backends as-is.

### Sub-protocol negotiation

The proxy negotiates OCPP sub-protocols (`ocpp1.6`, `ocpp2.0`, `ocpp2.0.1`) between the charger and the upstream backends automatically.

## Use cases

### Multi-backend monitoring

Run your chargers against your primary platform while mirroring data to your own analytics or energy management system.

### Platform migration

During a CSMS migration, mirror traffic to the new platform and verify it processes messages correctly before switching over.

### Development & debugging

Mirror production charger traffic to a local development CSMS for testing without affecting the live system.

### Compliance & auditing

Send a copy of all OCPP messages to an audit system for regulatory compliance.

## Logging

Logs are structured JSON written to stdout/stderr:

```json
{"time":"2026-04-07T10:00:00.000Z","level":"info","tag":"proxy","msg":"proxy listening","port":9000,"primary":"wss://csms.example.com/ocpp","secondaries":[]}
{"time":"2026-04-07T10:00:01.000Z","level":"info","tag":"CHARGER-001","msg":"session started","primary":"wss://csms.example.com/ocpp","secondaries":[],"protocol":"ocpp1.6"}
{"time":"2026-04-07T10:00:01.500Z","level":"debug","tag":"CHARGER-001","msg":"charger → proxy","message":"[CALL] BootNotification (abc123)"}
```

Set `LOG_LEVEL=debug` to see individual OCPP messages.

## Building the Docker image

```bash
docker build -t joulo-ocpp-proxy .
```

The image uses a multi-stage build. The Home Assistant add-on runs it as root (per the add-on contract); the bundled `docker-compose.yml` sets `user: node` so plain Docker deployments run unprivileged.

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push to your branch
5. Open a Pull Request

## About

This project is maintained by [Joulo](https://joulo.nl) — a Dutch platform that helps EV owners earn rewards for charging at home with green energy. We built this proxy to solve a real-world need: connecting chargers to multiple backends without vendor lock-in.

If you're interested in smart EV charging and renewable energy, check us out at [joulo.nl](https://joulo.nl).

## License

[MIT](LICENSE) — use it however you like.
