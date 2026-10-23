# Tap targets

Can any button get smaller than 44 × 44 px, Apple's minimum tap target, or end up closer than 8 px to its neighbour, at any screen size and label length?

```sh
bun yoga/probe.ts 60 tap-targets
bun test yoga/checks/tap-targets    # 5 tests, about 1 min
```

## What is checked

[check.ts](check.ts) names the buttons of each layout. For each button, the claims are:

- it is at least 44 px wide and at least 44 px tall;
- it ends before the right edge of the screen, because a button off the screen can't be tapped;
- it starts at least 8 px after the button before it, when both are in the same row.

The space between two buttons is computed as `next.left − (previous.left + previous.width)`, from their boxes, in FP32. Every claim allows 2⁻¹⁰ px, the lab's tolerance for rounding: with `gap: 8`, Yoga puts some neighbours 7.99998 px apart.

The inputs are the screen (W in 320..2560, H in 480..1600) and the width of every label, all on the 1/64 px grid.

## The examples

**Filter chips in an inbox.** A row of four chips, All, Unread, Flagged and With attachments, above the message list. Each chip is its label with 12 px of padding on every side, so 44 tall, and the row has 16 px of padding and an 8 px gap. Labels are 20 to 240 px wide. Translated labels can be several times the English width.

- **`flexShrink: 1`**, so that long labels truncate instead of pushing the last chip off a narrow phone. Yoga shrinks each chip in proportion to its natural width, so one long label squeezes the others too, and a short one ends up below 44 px. At W = 328 px, with a 237 px Flagged label, Unread is 26.7 px wide instead of its natural 50 px.
- **`flexShrink: 1` and `minWidth: 44`**: the obvious fix, and it doesn't work. Every chip stays at least 44 wide, but for some labels Yoga stops shrinking the row at all, and the chips run off the screen. At W = 321.6 px, with labels of 104, 143, 204 and 227 px, Flagged ends 233 px past the edge of the screen. At W = 320 with labels of 133, 240, 240 and 240 px, every chip keeps its natural width and the last one ends at 989 px. Without `minWidth`, the same chips fit. See below for why.
- **Equal chips, `flexGrow: 1, flexBasis: 0`**: the fix. Each chip gets a quarter of the row, at least 66 px on the narrowest screen, and a long label truncates inside its chip. This is the same fix as the equal buttons in the lab's centered dialog.

**An onboarding footer.** The last page of an onboarding flow: an illustration that fills the screen, then a footer with Skip on the left and Get started on the right, `justifyContent: 'space-between'`. Both are text buttons, at least 64 wide and 44 tall. Skip keeps its size, with a label of 16 to 120 px. Get started has `flexShrink: 1`, so a long label (16 to 400 px) truncates.

- **No gap.** The space between the two buttons is whatever the labels leave. A long Get started label leaves none: it shrinks until it touches Skip. At W = 336 px, with a 98 px Skip and a 316 px Get started label, they are 0 px apart. On a 390 px phone with the English labels they are 182 px apart, so a screenshot doesn't show it.
- **`gap: 8`**: the fix. `space-between` adds the gap to the free space it spreads, and shrinking leaves the gap alone.

## Why `minWidth: 44` stops the chips shrinking

Yoga distributes negative free space in two passes. The first pass looks for children whose shrunk size breaks their minimum, and takes them out of the share. For each child in turn it computes `basis + remaining / totalShrink × basis` (with `flexShrink: 1`), and if the minimum clamps that, it removes the child from `totalShrink` right away. But `remaining` stays what it was at the start of the loop until the loop ends. So once one chip clamps, the next one gets the same free space divided by a smaller total, and has to shrink by more than its share. It clamps too, and the next one shrinks even more.

With 133, 240, 240 and 240 px labels at W = 320, the chips are 157, 264, 264 and 264 px wide, the row has 264 px for them, and they have to lose 685 px:

| Chip | Natural width | `totalShrink` it sees | Shrunk size | Clamped to 44 |
| --- | ---: | ---: | ---: | --- |
| All | 157 | 949 | 43.7 | yes |
| Unread | 264 | 792 | 35.7 | yes |
| Flagged | 264 | 528 | −78.5 | yes |
| With attachments | 264 | 264 | −421 | yes |

All misses 44 by 0.3 px, and that starts the cascade. Every chip clamps, and the pass adds what the clamps gave back, 773 px, to the free space, which becomes +88 px. The second pass sees positive free space, so nothing shrinks, nothing grows, and every chip keeps its natural width. Without `minWidth`, nothing clamps and the chips share the 685 px.

The port follows Yoga statement by statement, so the circuit has this too, and the real `yoga-layout` 3.2.1 lays the chips out the same way, bit for bit. When the first clamp doesn't cascade, e.g. with 20, 100, 100 and 100 px labels, All clamps to 44 and the others share the rest, as they should. CSS resolves flexible lengths in a loop until nothing new clamps, and fits the chips.

## Results

`bun yoga/probe.ts 60 tap-targets`, 60 s per claim, Apple M3 Pro under Bun, while other proofs ran on the same machine.

| Layout | Claims | Proven | Refuted | Unknown |
| --- | ---: | ---: | ---: | ---: |
| Chips, `flexShrink: 1` | 15 | 4 | **4** | 7 |
| Chips, `flexShrink: 1` and `minWidth: 44` | 15 | 8 | **3** | 4 |
| Chips, equal | 15 | **15** | 0 | 0 |
| Footer, no gap | 7 | 5 | **1** | 1 |
| Footer, `gap: 8` | 7 | **6** | 0 | 1 |

**Every bug is found in one box, in under 2 s, and the real Yoga confirms each counterexample:**

- **Chips that shrink**: each of the four chips is narrower than 44 px somewhere, e.g. Unread at 26.7 px, above.
- **Chips with `minWidth: 44`**: every chip is proven at least 44 px wide, and three of them end past the screen's edge. Unread by 12 px, at W = 328 and labels of 106, 162, 216 and 238 px. Flagged by 233 px and With attachments by 246 px.
- **The footer without a gap**: Get started touches Skip, 0 px apart, at W = 336 with a 98 px Skip and a 316 px Get started label.

**The equal chips are proven, every claim in one box**: 44 × 44 or larger, on the screen, and 8 px apart, for every screen width and every label.

**The footer with `gap: 8` is proven to keep both buttons 44 × 44 and 8 px apart**, the space in 11,279 boxes and 4 s. One claim is unknown: that Get started ends before the right edge of the screen. It runs out of time in two runs of 60 s, at about 110,000 boxes. 100,000 random samples with the real Yoga never put it past the edge. Why is under Limits.

The unknowns of the buggy versions are of the same kind: the right edges of chips that shrink, and the spaces between them.

## Limits

- **The relation between two shrunk sizes.** The prover proves "ends before the right edge of the screen" for a button that doesn't shrink, and for the equal chips, whose sizes follow from the screen width alone. A button that shrinks ends where its position plus its shrunk size put it, and the prover has to know that those two add up to no more than the row has. They are computed from the same free space along different paths, and the boxes don't keep the relation between them (the lab README's first limit). That is why the footer's Get started is unknown with `gap: 8`, even though sampling never puts it past the edge. The same goes for the space between chips that shrink in proportion to their labels. A first footer, where both buttons shrank, left even the space between them unknown, with a bound as loose as 0 px. With only Get started shrinking, the space is proven.
- **What a tap target is.** The claims read the button's box. A button with a larger hit area (`hitSlop` in React Native) or a smaller visible part than its box is not modeled.
- **Rows only.** The on-screen claim checks the right edge. A column of buttons that runs off the bottom of the screen isn't checked, and none of the examples has one.
- **Subset.** No wrapping, so chips that wrap onto a second line, the usual web layout, can't be checked. No horizontal scrolling either, which is how most apps show more chips than fit.
