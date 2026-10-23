# Design rules

Do the design's rules hold at every size: equal buttons stay equal, a centered title stays centered, items in a list share one left edge?

A mockup shows one screen size and one set of texts. The rules a designer drew into it, "these two buttons are the same width" or "the title is in the middle", are easy to break with a style that looks the same in the mockup. Each rule here is an equality between two laid-out values, positions on the screen or widths, and holds when they differ by at most 2⁻¹⁰ px, the same FP32 allowance as the overflow check. A position on the screen is the sum of the offsets of the box and every box above it, each relative to its parent.

```sh
bun yoga/probe.ts 60 design-rules
```

## Examples

The screen is 320 to 2560 px wide and 480 to 1600 px tall, and every label's width is an input, all on the 1/64 px grid.

- **Two equal buttons.** A bottom sheet, "Discard this draft?", with "Keep editing" and "Discard" side by side. Both buttons have `flexGrow: 1, flexShrink: 1`. As first written they have no `flexBasis`, so each grows from its label's width and the button with the longer label stays wider by the difference. The fix is `flexBasis: 0`, which React Native's `flex: 1` sets too. Labels are 0 to 300 px.
- **A centered title.** A header with a back button on the left, a title, and two icon buttons on the right. The title is centered in the space between the two sides, which is the middle of the screen only when both sides are equally wide. As first written each side is as wide as its icons, 44 px on the left and 88 px on the right, so the title sits 22 px left of the middle at every width. The fix gives both side slots `width: 88`. The title is 0 to 1200 px and truncates.
- **Values in one column.** Order details: rows of a label ("Order", "Shipping to", "Payment") and a value, with a 16 px gap between them. As first written each label is as wide as its text, so each value starts where its own label ends. The fix gives every label `width: 112`. Labels are 0 to 240 px, values 0 to 1200 px. A label longer than 112 px now truncates, the price of the column.

## Results

`bun yoga/probe.ts 60 design-rules`, 60 s per claim:

| Example | Version | Claims | Proven | Refuted | Unknown |
| --- | --- | ---: | ---: | ---: | ---: |
| Two equal buttons | Buttons that grow from their labels | 1 | 0 | **1** | 0 |
| | Buttons with `flexBasis: 0` | 1 | **1** | 0 | 0 |
| A centered title | Side slots as wide as their icons | 1 | 0 | **1** | 0 |
| | Side slots both 88 px wide | 1 | **1** | 0 | 0 |
| Values in one column | Labels as wide as their text | 2 | 0 | **2** | 0 |
| | Labels 112 px wide | 2 | **2** | 0 | 0 |

Every claim takes one box, and the real Yoga agrees with every counterexample:

- **Buttons.** At W = 1724.6 px, with a 0.8 px "Keep editing" label and a 158.2 px "Discard" label, the Discard button is 157.4 px wider than Keep editing, exactly the difference of the labels.
- **Title.** At W = 1440 px with a 600 px title, the title's middle is 22 px left of the screen's.
- **Values.** With a 0.7 px "Order" label and a 235.5 px "Shipping to" label, the shipping address starts 234.8 px right of the order number. The same for "Payment".

The fixed versions are proven for every input, and quickly, because the fixes make the rules hold by construction. With `flexBasis: 0` both buttons start at their padding and get the same share of the row, so Yoga computes their widths with the same operations on the same values, and the port's circuit has one wire for both. With equal side slots the title's middle is `92 + (slot − title) / 2 + title / 2`, which the prover's linear forms reduce to half the screen; every value is on a fine grid, so no rounding is left over. With a label column every value starts at 160 px, a constant.

## Limits

- **A rule holds or doesn't; how much it matters is not measured.** A title 22 px off center and a button 157 px wider fail alike. A tolerance larger than rounding, e.g. "within 1 px", is one number in the claim.
- **The rules are written by hand.** Nothing reads them from a design file. Each is a difference of two values from the laid-out boxes.
- **Truncation is the fix's cost.** A fixed label column or equal buttons keep the rule by cutting long text short. The overflow check and a minimum-width check would say whether that is acceptable.
- **No wrapping.** Text is a single line that truncates, as everywhere in the port.
