# Vitals

![Vitals](../docs/vitals.png)

The bar's own health, for when it misbehaves: Wi-Fi signal, an internet round trip, battery and uptime. Each page has an icon, the current reading, and a chart of the last 12 minutes (one bar per 30-second sample).

| Page | Reading | Chart | Green / yellow / red |
| --- | --- | --- | --- |
| Wi-Fi | Signal in dBm; `OFF` when disconnected | −90 to −30 dBm | ≥ −60 / ≥ −72 / below |
| Ping | Round trip to the check URL in ms; `FAIL` | Log scale, 10 ms to 3 s; a failure is a full red bar | < 150 / < 500 / slower |
| Battery | Charge %; `CHRG` while charging | 0–100% | > 50 / > 20 / below |
| Uptime | Minutes, hours or days since boot | | |

The Wi-Fi icon's bars fill with signal quality, the globe takes the last ping's color, and the battery fills to its charge with a bolt while charging. An uptime of a few minutes means the bar rebooted.

## Controls

| Input | Action |
| --- | --- |
| Wheel | Pick a page |
| OK | Cycle the pages every 5 seconds, or stop |
| Start | Check the internet now |
| Back | Quit |

## Settings

| Setting | Default | |
| --- | --- | --- |
| Internet check URL | `http://cp.cloudflare.com/generate_204` | Any URL that answers quickly. The round trip includes the DNS lookup, so DNS trouble shows up here. |

## Behavior

Wi-Fi, battery and uptime come from the bar's local API (`/api/wifi/status`, `/api/status/power`, `/api/status/system`). The internet check is one small `GET` every 30 seconds, never more than one at a time. The runtime's `fetch` cannot be cancelled, so a request still unanswered after 10 seconds is charted as a failure while it finishes.

## Build

See the [top-level README](../README.md#building-and-installing). App id `app.itstylerirl.vitals`.
