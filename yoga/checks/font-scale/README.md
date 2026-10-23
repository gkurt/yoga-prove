# Large text

Does the layout hold at every system text size, from 100% to the largest accessibility size?

```sh
bun yoga/probe.ts 60 font-scale
bun test yoga/checks/font-scale     # about 10 s
```

## What is checked

iOS's Dynamic Type and Android's font scale make every label wider and taller by the same factor. The largest iOS accessibility size is about 310% of the default. The check has one input for it, the font scale, from 1 to 3.125 on a grid of 1/64. That grid is about 1.6%, finer than the system's own steps, and FP32 holds every value of it exactly, which the prover's grid reasoning needs; 1/100 isn't exact in FP32. 3.1 isn't on the grid, so the range ends at 3.125. The other inputs are the screen, 320 to 430 px wide (iPhone SE to Pro Max) and 568 to 932 px tall, on the 1/64 px grid.

Each label is a measured leaf whose width and line height are its English text's at 100%, measured at the stated size with the system font, times the scale, e.g. `{width: {times: [53, 'scale']}, height: {times: [22, 'scale']}}` for "Sounds" at 17 pt. Icons keep their size.

The claims, for every scale and screen size:

- nothing sticks out of its parent and nothing overlaps its neighbour: [overflow](../overflow/check.ts)'s claims;
- every label that must be read in full is as wide as its text and as tall as its line, so it isn't cut off with an ellipsis or clipped at the top or bottom.

The second kind matters most here. Yoga gives a label at most the room its parent has, so a label that doesn't fit is cut, not pushed out: both bugs below pass every overflow claim.

## Examples

- **A Settings row**: an icon, "Sounds" and a chevron, in an inset grouped list. As first written, the row has `height: 44`, Apple's minimum touch height. Fixed, it has `minHeight: 44` and 11 px of padding above and below, which is the same 44 px at 100% and grows with the text.
- **A mailbox row with an unread count**: an icon, "Inbox", and a pill with "12" at 13 pt. As first written, the pill is `width: 24, height: 20`. Fixed, it is `minWidth: 24, minHeight: 20` with 4 px of padding on the sides and 2 px above and below, which is still 24 × 20 at 100%.

## Results

`bun yoga/probe.ts 60 font-scale`, Apple M3 Pro under Bun:

| Example | Operations | Claims | Proven | Refuted | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| Settings row, `height: 44` | 307 | 24 | 23 | **1** | 0 |
| Settings row, `minHeight: 44` and padding | 1,416 | 24 | **24** | 0 | 0 |
| Mailbox row, pill `width: 24, height: 20` | 1,560 | 30 | 28 | **2** | 0 |
| Mailbox row, pill with `minWidth`, `minHeight` and padding | 6,497 | 30 | **30** | 0 | 0 |

Every claim takes one box and a few milliseconds, swept. Every counterexample is confirmed by the real Yoga:

- **The row with `height: 44`** cuts off "Sounds" past 200%: at 206%, its line is 45.4 px and the row gives it 44.
- **The fixed-size pill** cuts off "12" at 206% too: the text needs 30.9 × 33 px, and the pill gives it 24 × 20. It is cut sideways from about 160% and at the top and bottom from 125%.

Both fixes are proven for every scale up to 312.5% on every phone size in the range.

## Limits

- **One line of text.** A measured leaf is one line that truncates. At accessibility sizes, iOS and Android wrap labels onto more lines instead, which the port doesn't model, so a long label can't be proven: "Notifications" (98 px at 17 pt) is 306 px at 312.5%, wider than a row on a 320 px screen has. The examples use short labels for that reason.
- **Linear text.** Real text doesn't scale exactly linearly, because fonts use different optical sizes and spacing at different sizes. The widths here are close, not exact.
- **Icons are fixed.** SF Symbols next to text scale with it; these don't.
