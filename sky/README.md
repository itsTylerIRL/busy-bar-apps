# Sky

![Sky](../docs/sky.png)

Weather for now and the next 7 days, from [Open-Meteo](https://open-meteo.com) (free, no key).

- **Left:** a 12px pixel-art icon for the conditions: sun or moon, partly cloudy, cloudy, fog, drizzle, rain, snow or storm.
- **Middle:** the temperature. Day screens show the high, the low beside it, and the day's name, with the chance of rain in blue when it is 20% or more.
- **Right:** a 24-hour chart. The temperature line is amber, night hours are shaded navy, and the chance of rain is drawn as blue bars along the bottom. Today's chart marks the current hour with a dotted line.

## Controls

| Input | Action |
| --- | --- |
| Wheel | Now → today → the next six days |
| OK | Back to Now |
| Start | °F ⇄ °C (remembered) |
| Back | Quit |

After 45 seconds without input it goes back to Now.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Location | blank | `lat,lon`. Blank looks up an approximate location from your IP address with [ip-api.com](https://ip-api.com) once and remembers it on the bar. |
| Temperature | Fahrenheit | Start overrides it once pressed. |

## Behavior

It refreshes every 15 minutes. A failed fetch shows `OFFLN` and retries after 1 minute, doubling up to 15. The screen redraws only the elements that changed.

The icons are composed in `src/icons.ts` from a few sprites (sun, moon, cloud, rain, snow, bolt) and sent as XPM2.

## Build

See the [top-level README](../README.md#building-and-installing). App id `app.itstylerirl.sky`.
