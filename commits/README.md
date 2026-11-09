# Commits

![Commits](../docs/commits.png)

A GitHub contribution graph, from [github-contributions-api.jogruber.de](https://github.com/grubersjoe/github-contributions-api) (free, no key, public contributions only).

- **Graph** (left): weeks as columns, Sunday on top, the current week on the right, in GitHub's dark-theme greens. The half-year view uses 2×2 cells; the full-year view fits all 53 weeks at 1px wide.
- **Stat** (right): today, this week, the current streak, or the year total. Today turns green once you have contributed, and the streak turns green at 7 days.

The front LED flashes green when today's count goes up between refreshes.

## Controls

| Input | Action |
| --- | --- |
| Wheel | Today → week → streak → year |
| OK | Half year ⇄ full year (remembered) |
| Start | Refresh now |
| Back | Quit |

## Settings

| Setting | Default |
| --- | --- |
| GitHub username | `itsTylerIRL` |

## Behavior

It refreshes every 30 minutes. A failed fetch shows `OFFLN`, or `USER?` for an unknown name, and retries after 1 minute, doubling up to 30. The API may run a little behind github.com, and only counts public contributions unless private ones are shown on the profile.

## Build

See the [top-level README](../README.md#building-and-installing). App id `app.itstylerirl.commits`.
