# doimus-ariston-heater

Doimus native plugin for Ariston Velis / Lydos water heaters via the Ariston NET cloud API.

## Features

- Temperature monitoring (current and target)
- Target temperature adjustment
- Power on/off
- Water heater operating mode controls (iMemory, Green, Scheduled/Program, Boost — variant dependent)
- Available-showers readout (when reported by the device)
- Plugin-driven device-detail UI (`metadata.ui`) — the app renders the controls the plugin declares
- **Adaptive polling**: fast when heating, slow when idle — no aggressive fixed-interval polling
- Configurable poll intervals and cooldown behavior
- Auto-discovery of plant ID (or manual override)
- Debug logging (set `debug: true` to dump the raw plant data + settings for API field verification)

## Adaptive Polling

The plugin automatically adjusts its poll rate based on the heater's state:

| Mode | When | Default interval |
|------|------|-----------------|
| **Fast** | Heater is actively heating | 120s (2 min) |
| **Cooldown** | 3 cycles after heating stops | 120s (2 min) |
| **Slow** | Heater is idle/off | 1800s (30 min) |

This means you see near-real-time temperature updates during heating (when it matters),
without hammering the Ariston cloud API when nothing is happening. The cooldown period
catches the thermal inertia after the element switches off.

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | `Ariston Heater` | Display name |
| `username` | string | — | Ariston NET account email |
| `password` | string | — | Ariston NET account password |
| `gateway` | string | — | Plant ID (auto-discovered if empty) |
| `pollInterval` | number | `1800` | Idle poll interval in seconds (min 300) |
| `fastPollInterval` | number | `120` | Heating poll interval in seconds (min 30) |
| `cooldownCycles` | number | `3` | Fast-poll cycles after heating stops (1-10) |
| `minTemp` | number | `40` | Minimum target temperature (°C) |
| `maxTemp` | number | `65` | Maximum target temperature (°C) |
| `debug` | boolean | `false` | Enable debug logging |

## Device Capabilities

| Capability | Type | Description |
|------------|------|-------------|
| `power` | boolean | Heater on/off (writable) |
| `target_temp` | number (°C) | Target temperature setpoint (writable) |
| `mode` | number | Operating mode: iMemory/Green/Program/Boost (writable) |
| `boost` | boolean | Boost mode active (writable) |
| `imemory` | boolean | iMemory mode active (writable) |
| `scheduled` | boolean | Scheduled/Program mode active (writable) |
| `green` | boolean | Green mode active (writable) |
| `heating_state` | number | 1 = heating, 0 = idle |
| `heating_mode` | number | 1 = on, 0 = off |
| `temperature` | number (°C) | Current water temperature (read-only) |
| `available_showers` | number | Showers available now (read-only, when reported) |
| `max_showers` | number | Total shower capacity (read-only, when reported) |
| `min_target_temp` / `max_target_temp` | number | Setpoint bounds used by the stepper UI |

Mode toggles (Boost/iMemory/Scheduled/Green) are mutually exclusive operating
modes on the device: turning one on switches the mode; turning the active one off
falls back to the previous mode. Not every mode is available on every variant —
the plugin only exposes the modes the discovered API variant supports.

## License

MIT
