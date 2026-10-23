# Formal verification for UI layout

Tests check a layout at a few screen sizes with a few texts. This repo checks it at every screen size and every text length in a range at once, and either proves that nothing breaks or finds an exact case that does.

The idea comes from Cheng Lou's [Handwired](https://github.com/chenglou/handwired), which compiles programs into plain neural networks. If a UI is a network, the techniques used to verify neural networks can check it: bound every value over a whole range of inputs, and split the range where the bounds aren't tight enough. The checker here was first built for Handwired's circuits. This repo applies it to [Yoga](https://github.com/facebook/yoga), the flexbox engine behind React Native: Yoga 3.2.1's layout algorithm, translated into the same kind of circuit, and 13 checks on top of it.

It is a research prototype: a subset of Yoga, layouts written as trees in TypeScript, and checks written by hand.

## What's here

- [prove/](prove): the checker. Interval and symbolic bounds, back-substitution, and a branch-and-bound search over the inputs, in the style of α,β-CROWN, extended for the division, products and branches that layout needs.
- [yoga/](yoga): Yoga's `calculateLayoutInternal`, statement by statement, as a circuit, exact to the bit against the real `yoga-layout`; the checks; and a visualizer. [yoga/README.md](yoga/README.md) explains how it works and what it took.
- [yoga/checks/](yoga/checks): one folder per check, each with its examples, results and limits.
- [yoga/viz/](yoga/viz): an HTML page that shows every check with sliders for its inputs, a device preview laid out by the circuit, and the checker's answer for the whole range.

## Running it

Needs [Bun](https://bun.sh) and Python 3 (only to serve the visualizer).

```sh
bun install
bun test                     # the circuit against real Yoga, the checker's soundness, the checks
bun run typecheck
bun run lint
bun yoga/probe.ts 60         # prove every claim of every check, 60 s per claim; writes yoga/viz/data/
bun run viz                  # then open http://localhost:8000
```

The visualizer's data is committed, so `bun run viz` works without running the probe first. The full probe takes a while; `bun yoga/probe.ts 60 overflow dialog` runs one check on one example.

## Results

Each check asks one question of example layouts, each in a buggy and a fixed version. The inputs are the screen's width and height and the width of every text, on a 1/64 px grid. A bug counts as found when a claim is refuted and the real Yoga lays out the counterexample the same way; a fix counts as proven when every claim is proven for every input in range.

| Check | Examples | Bugs found | Fixes proven | Claims | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| Nothing sticks out (overflow) | 2 | 2 of 2 | 1 of 2 | 100 | 4 |
| [Big enough to tap](yoga/checks/tap-targets/README.md) | 2 | 3 of 3 | 1 of 2 | 59 | 13 |
| [Labels are never cut off](yoga/checks/labels-fit/README.md) | 2 | 2 of 2 | 2 of 2 | 78 | 0 |
| [Large text](yoga/checks/font-scale/README.md) | 2 | 2 of 2 | 2 of 2 | 108 | 0 |
| [Longer translations](yoga/checks/translations/README.md) | 2 | 2 of 2 | 2 of 2 | 154 | 0 |
| [Images stay sharp](yoga/checks/image-scale/README.md) | 2 | 2 of 2 | 2 of 2 | 8 | 0 |
| [Images keep their shape](yoga/checks/image-aspect/README.md) | 2 | 2 of 2 | 5 of 5 | 13 | 0 |
| [Nothing moves when content loads](yoga/checks/layout-shift/README.md) | 3 | 3 of 3 | 3 of 3 | 20 | 0 |
| [Nothing jumps](yoga/checks/resize-jumps/README.md) | 2 | 2 of 2 | 2 of 2 | 14 | 2 |
| [Above the keyboard](yoga/checks/keyboard/README.md) | 2 | 2 of 2 | 2 of 2 | 28 | 0 |
| [Clear of the notch](yoga/checks/safe-areas/README.md) | 3 | 3 of 3 | 3 of 3 | 42 | 0 |
| [The design holds](yoga/checks/design-rules/README.md) | 3 | 3 of 3 | 3 of 3 | 8 | 0 |
| [Lines stay readable](yoga/checks/line-length/README.md) | 2 | 2 of 2 | 2 of 2 | 8 | 0 |

The two fixes not proven each keep one claim that holds on 100,000 random samples and that the checker doesn't finish; [yoga/README.md](yoga/README.md) says why. The other unknowns are in buggy versions, beside the claims refuted.

One find wasn't planted. In Yoga's first shrinking pass, an item that hits its `minWidth` leaves the total shrink factor at once, but the space still to remove is updated only after the loop, so when every item clamps, the row doesn't shrink at all. A row of filter chips with `flexShrink: 1, minWidth: 44` keeps its natural widths and runs 246 px off a 341 px screen. Real Yoga 3.2.1 lays it out the same way.

## Limits

- **A subset of Yoga.** No percentages, absolute positioning, auto margins, borders, wrapping, `display: none`, scrolling or reversed directions; the port throws if a layout uses them. Pixel rounding is off.
- **Text is a measured width.** A text is a single line that truncates, and its width is an input over a declared range. Wrapping text, whose height depends on its width, isn't modeled.
- **Inputs are ranges.** A proof covers every combination of inputs inside the declared ranges, nothing beyond them.
- **Layouts are written by hand,** as trees in TypeScript, not read from React Native code.
- **Time.** Bugs are found in milliseconds. Some proofs take seconds to minutes, and a few don't finish.

## Credits and license

The circuit format and the idea are [Handwired](https://github.com/chenglou/handwired)'s, by Cheng Lou. The checker began as a lab in Handwired's repository; [prove/wire.ts](prove/wire.ts) is adapted from Handwired's runtime. The layout algorithm is [Yoga](https://github.com/facebook/yoga)'s, by Meta. Both are MIT licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This repo is MIT licensed; see [LICENSE](LICENSE).
