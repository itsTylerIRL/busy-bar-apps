# Luna

![Luna](../docs/luna.png)

The moon's phase and the day's sun times, worked out on the bar itself. There is no data service: the bar's clock gives the time, and its time zone setting gives the local offset.

- **Left:** the moon as it looks tonight, lit to the current phase, with its dark plains (maria) and a faint unlit side. South of the equator it is drawn upside down, the way it appears there. For the sun readouts it becomes the day's arc over the horizon, with the sun where it is now, or below the horizon at night.
- **Right:** a readout that switches every 5 seconds:

| Readout | Example |
| --- | --- |
| Phase | `WAX GIB` · `83% LIT` |
| Next full moon | `FULL 16D` · `NOV 24` |
| Next new moon | `NEW 6H` · `NOV 9` |
| Sunrise | `6:31 AM` |
| Sunset | `4:37 PM` |
| Daylight | `10H06` |

## Accuracy

`src/astro.ts` computes the moon's longitude from the main terms of its orbit (Meeus, *Astronomical Algorithms*, ch. 47, truncated) and the sun's from its mean anomaly. Phase times come out within about 20 minutes of published ones, which is plenty for a date. Sunrise and sunset use the standard sunrise equation, with 0.833° for refraction and the sun's radius, and land within a minute or two of published tables. Polar day and night are handled.

## Controls

| Input | Action |
| --- | --- |
| Wheel | Pick a readout (stops the rotation) |
| OK | Resume the rotation |
| Start | 12 ⇄ 24-hour clock (remembered) |
| Back | Quit |

## Settings

| Setting | Default | |
| --- | --- | --- |
| Location | blank | `lat,lon`, needed only for the sun. Blank looks up an approximate location from your IP address with [ip-api.com](https://ip-api.com) once and remembers it on the bar. Until then the sun readouts show `NO LOC`, and the lookup retries with a growing wait. |
| Clock | 12-hour | |

## Behavior

It recomputes on the minute and sends only the elements that changed. The time zone offset is read from `GET /api/time` once an hour, so daylight saving time is picked up.

## Build

See the [top-level README](../README.md#building-and-installing). App id `app.itstylerirl.luna`.
