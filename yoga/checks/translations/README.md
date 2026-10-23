# Longer translations

Does the layout hold when every label is up to 1.5 times as long as in English, as in German or Finnish?

```sh
bun yoga/probe.ts 60 translations
bun test yoga/checks/translations   # about 10 s
```

## What is checked

Each label's width is its own input, from its English width to 1.5 times it, on the 1/64 px grid. The English widths are measured from the text at the stated size with the system font, e.g. "Cancel" at 17 pt is 53 px, so its input runs from 53 to 79.5 px. Because each label has its own input rather than sharing one translation factor, a proof covers every mix: one label translated long and its neighbour short, as well as all of them long. Line heights don't change. The screen is 320 to 430 px wide (iPhone SE to Pro Max) and 568 to 932 px tall.

The claims, for every screen size and every set of label widths:

- nothing sticks out of its parent and nothing overlaps its neighbour: [overflow](../overflow/check.ts)'s claims;
- every label that must be read in full is as wide as its text and as tall as its line, so it isn't cut off with an ellipsis. This is [font-scale](../font-scale/check.ts)'s `fullTextClaims`.

## Examples

- **A segmented control** to pick a calendar's range: Day, Week, Month and Year at 13 pt (27, 37, 43 and 31 px). As first written, the segments are of equal width (`flexGrow: 1, flexBasis: 0`), which is what iOS's segmented control does by default. Fixed, each segment starts at its label's width (`flexBasis` left at `auto`), and the segments share what is left.
- **A navigation bar** over a form: Cancel on the left, "Edit profile" in the middle, Save on the right, at 17 pt (53, 88 and 38 px). As first written, each button sits in a slot `width: 72`, so that the title stays centered. Fixed, the slots are `minWidth: 72`. The title may shrink and end in an ellipsis, as titles do, so it isn't claimed to be read in full; the buttons are.

## Results

`bun yoga/probe.ts 60 translations`, Apple M3 Pro under Bun:

| Example | Operations | Claims | Proven | Refuted | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| Segmented control, equal segments | 1,992 | 47 | 45 | **2** | 0 |
| Segmented control, segments sized by their labels | 8,659 | 47 | **47** | 0 | 0 |
| Navigation bar, slots `width: 72` | 196 | 30 | 29 | **1** | 0 |
| Navigation bar, slots `minWidth: 72` | 1,274 | 30 | **30** | 0 | 0 |

Every claim takes one box and a few milliseconds, swept. Every counterexample is confirmed by the real Yoga:

- **Equal segments** cut off "Month" at 1.49 times its English width on a 346 px screen, by 2.7 px, and "Week" at 1.49 times on a 320.6 px screen. Each label gets (W − 36) / 4 − 16 px, 55 px on the smallest phone, which "Month" passes at 1.28 times. From 358 px wide, every label fits, so a screenshot on the simulator's default phone doesn't show it.
- **Slots of `width: 72`** cut off "Cancel" from 1.36 times its English width (72 px), on every phone. German's "Abbrechen" is longer than that.

The fixed segmented control is proven because the labels at 1.5 times, with their padding, take at most 271 px, and the control has 284 px inside it on a 320 px screen. The fixed navigation bar is proven too; its title is no longer centered when the slots differ, which the claims don't ask about.

## Limits

- **1.5 times is a rule of thumb.** Short English labels often grow more than that: "Day" is "Päivä" in Finnish, and a one-word button can double. A proof covers the declared ranges, not the actual translations; to check the real strings, set each label's range to its widths in the shipped languages.
- **One line of text.** A label is one line that truncates. Wrapping, as some navigation bars and buttons allow, isn't modeled.
- **Left to right.** Arabic and Hebrew mirror the layout; the port has no right-to-left direction.
