# Changelog

## Unreleased

- New option **Primary routes**: chargers can be sent to different primaries
  depending on the path in their URL, e.g. `ws://<ip>:9000/site-a/CHARGER-001`
  uses the primary configured for `site-a`. **Primary CSMS URL** may be left
  empty when routes are set; chargers on an unknown path are then refused.

## 1.0.23

- Every option in the Configuration tab now has a readable name and a
  description.
- New **Documentation** tab: setup, every option with examples, and
  troubleshooting.
- New options **Add charger ID to primary URL** and **Add charger ID to mirror
  URLs**, for backends that give you a complete URL per charger. Both are on by
  default, so existing setups behave as before.
- **Debug message length limit** accepts `0` to show complete messages.
- **Backend password** is masked in the Configuration tab.
- The app has its own icon instead of the puzzle piece.
- Home Assistant now restarts the app when it stops accepting charger
  connections, not only when it stops running.

Fixes:

- A secondary's `TriggerMessage` or `GetConfiguration` no longer reaches the
  charger while it is still answering the primary. OCPP allows only one open
  request at a time; the secondary's now waits, and the primary's always go
  first. If the charger doesn't answer within 30 seconds, or isn't connected,
  the secondary gets an error reply instead of none.
- Commands a secondary isn't allowed to send are refused with an answer that is
  valid for that command. `ClearChargingProfile`, `UnlockConnector`,
  `GetDiagnostics`, `SendLocalList`, `GetLocalListVersion` and `UpdateFirmware`
  used to get an answer their OCPP 1.6 schema doesn't allow.
- Two per-charger mirrors to the same backend URL with different **Charger ID
  on this backend** no longer overwrite each other's saved transaction numbers.
  A mirror listed twice with the same URL and charger ID is connected once.
- Saved transaction numbers are written to disk safely, so a power cut can't
  leave an empty file.
- The app no longer fails to start with `Cannot read package config
  /app/package.json: permission denied`, which stopped 1.0.22 from running
  with Protection mode on.

## 1.0.21

- Mirrored messages stay queued until the secondary answers them. Before, a
  message sent over a connection that had silently died was lost; now it's
  resent once the secondary reconnects, in order.
- A message a secondary doesn't answer is resent after 2 minutes and skipped
  after a second timeout, so one unanswered message can't stall the mirror.

## 1.0.20

- **Mirror to backends (all chargers)** (`secondary_csms`) is back, alongside
  the per-charger mirrors.
- The charger's replies to commands from the primary are no longer mirrored to
  secondaries, which never sent those commands.
- `log_max_message_length` is renamed to `log_debug_message_max_length`. The old
  name keeps working.

## 1.0.19

- Per-charger mirrors (`charger_mappings`): mirror one charger to a backend,
  optionally under a different charger ID, password and RFID tag.
- Transaction numbers are translated for each secondary (OCPP 1.6) and saved,
  so a restart in the middle of a charging session doesn't break them.
- Secondaries can use `TriggerMessage` and `GetConfiguration`; other commands
  from secondaries are refused.
- The length of logged debug messages is configurable.
