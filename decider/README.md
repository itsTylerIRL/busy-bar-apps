# Decider

![Decider](../docs/decider.png)

An oracle, a coin and dice for the small decisions: lunch, who goes first, whether to send that email. Pick a mode with the wheel, press OK, and it shuffles for half a second before landing with a click.

| Mode | Picture | Lands on |
| --- | --- | --- |
| Oracle | A crystal ball whose swirl takes the answer's color | One of 18 answers: yes in green (`DO IT`, `ABSOLUTELY`…), maybe in yellow (`ASK LATER`, `SLEEP ON IT`…), no in red (`NOPE`, `BAD IDEA`…) |
| Coin | A gold coin showing H or T, flipping on its edge while it spins | `HEADS` / `TAILS` |
| D6 | A die face with its pips | 1–6 |
| D20 | A d20 that glows gold on a 1 or a 20 | 1–20; a 20 shows in green, a 1 in red |

Answers too long for the screen scroll with the bar's native text scrolling. It runs offline and draws only while rolling and when the result lands.

## Controls

| Input | Action |
| --- | --- |
| Wheel | Mode (remembered) |
| OK / Start | Roll |
| Back | Quit |

## Settings

| Setting | Default |
| --- | --- |
| Click when the roll lands | on |

## Build

See the [top-level README](../README.md#building-and-installing). App id `app.itstylerirl.decider`.
