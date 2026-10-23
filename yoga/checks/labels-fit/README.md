# Labels are never cut off

Can a label that must be read in full, such as a form label, a price or a button's text, ever get cut off, for any screen size and any label up to its stated length?

```sh
bun yoga/probe.ts 60 labels-fit
```

## What is checked

A text in the port is a measured leaf: a single line that truncates. When Yoga gives it at most a width, it reports `min(available, content)`. So a text is cut off exactly when its laid-out width is less than its content width, which is an input. For each label that must fit, the claim is `width − content ≥ −2⁻¹⁰`. For a button, whose text sits inside its padding, it is `width − padding − content ≥ −2⁻¹⁰`.

How long a label can be is the range of its input, and the knob says it plainly, e.g. "Price text, up to 96 px". A proof covers every label up to that length and every screen from 320 to 2560 px wide and from 480 to 1600 px high, on the 1/64 px grid.

A label can always be kept whole by making something else stick out, so every version also makes the [overflow](../overflow) check's claims about every box: inside its parent, and not overlapping the one before it. The ranges are chosen so that the fixed layouts always fit, and the proofs show that they do.

## The examples

- **A form row**: a label and a 200 px text field. The developer gave the label `flexShrink: 1` (with `numberOfLines={1}`) so that a long label doesn't push the field off the screen. On a phone that leaves the label 76 px: "Email address" becomes "Email add…". The fix moves `flexShrink: 1` to the field and gives it `minWidth: 120`. With labels up to 150 px, the field never needs to go below 126 px: 320 − 2 × 16 − 12 − 150 = 126.
- **A product row** in a shopping list: a thumbnail, the product name, the price and an Add button. The name and the price share a text style with `flex: 1`, which in React Native is `flexGrow: 1, flexShrink: 1, flexBasis: 0`, so that a long name truncates. But `flex: 1` on both splits the free space between them in half, whatever their text, and the price is cut next to a short name that has room to spare. The fix takes `flex: 1` off the price, which then keeps its own width. On a 320 px screen the row has 288 px inside, the thumbnail and the three gaps take 84, and a price up to 96 px and a button text up to 72 px, plus its 32 px padding, leave the name at least 4 px.

## Results

`bun yoga/probe.ts 60 labels-fit`, 60 s per claim, Apple M3 Pro under Bun:

| Layout | Claims | Proven | Refuted | Unknown |
| --- | ---: | ---: | ---: | ---: |
| Form row, the label shrinks | 14 | 13 | **1** | 0 |
| Form row, the field shrinks | 14 | **14** | 0 | 0 |
| Product row, name and price both `flex: 1` | 25 | 24 | **1** | 0 |
| Product row, only the name `flex: 1` | 25 | **25** | 0 | 0 |

Each bug is found in one box, in milliseconds, and the real Yoga confirms the counterexample:

- **The form row.** At W = 383.5 px, with a 147.6 px label, the label gets 139.5 px and loses 8.1 px.
- **The product row.** At W = 336.2 px, with a 330 px name, a 75.5 px price and a 56.2 px button text, the name and the price get 66 px each, and the price loses 9.5 px. The name could have given up 264 px.

Every claim of both fixes is proven. Most take one box. The longest is the form field's right edge, 28,285 boxes in 3.3 s: the field shrinks, and Yoga clamps it at its minimum width.

My first fix for the product row was `flexShrink: 0` on the price, with the name and the price both `flexShrink: 1` in the bug. Both label claims were proven, but only 24 of the 25 claims: the one that the Add button stays inside the row on the right ran out of time, twice, at about 100,000 boxes each. That is the same claim as the toolbar's in the lab [README](../../README.md): a fixed button after a text that shrinks by Yoga's shrink step. With `flex: 1` on the name instead, its basis is 0. It only grows, never shrinks, and every claim takes one box. It is also the idiom React Native code uses.

## Limits

- **One line of text.** The port's text truncates and doesn't wrap. A label that is allowed to wrap onto two lines isn't cut off at the width this check finds, but it may then be cut by its height, which this check doesn't model.
- **Width in pixels, not characters.** The ranges are the text's rendered width. Fonts, font scaling and translations matter only through that width: "up to 96 px" means whatever text renders to at most 96 px.
- **The ranges are the promise.** The fixed form row fits only for labels up to 150 px. A 170 px label on a 320 px screen would push the field below its 120 px minimum, and the row would stick out. The proof says nothing about labels longer than the knob allows.
- **Shrinking, followed by a fixed element.** As above, a claim about the right edge of a fixed box after a text that shrinks can stay unknown. A layout written with `flexBasis: 0` and `flexGrow` instead proves.
