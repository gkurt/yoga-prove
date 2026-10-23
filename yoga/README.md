# Yoga

Can a layout be proven free of overflow and overlap for every viewport size and every text length? The checker in [../prove](../prove) was first built for [Handwired](https://github.com/chenglou/handwired), where it proves that HandwiredOS's windows stay inside the workspace (that experiment needs Handwired's source and isn't in this repo). Browser CSS is too big to try that on first. Yoga, the flexbox engine behind React Native, is a small and well-specified subset of it. This compiles Yoga's layout algorithm into circuits, checks them bit for bit against the real Yoga, and runs the prover on two everyday layouts and their bugs.

```sh
bun yoga/probe.ts 60         # every claim of every check, writing viz/data/ for the visualizer
bun yoga/probe.ts 60 overflow dialog   # one check, one example
bun test                             # 34 tests, about 4 min
bunx tsc --noEmit -p .
```

## Checks

A check asks one question of example layouts, e.g. "can any element stick out of its parent?". [check.ts](check.ts) says what one is: each check lives in `checks/<id>/check.ts` and exports `check`, with examples, each in versions, e.g. as first written and as fixed. A version declares its inputs as knobs (each with a range, a grid and a label), its scenes (trees laid out at a size that may depend on the inputs, e.g. the screen less the keyboard), its claims about the laid-out boxes, each with what it says in words, and how to draw each box: its role (screen, surface, text, button, image, icon, field) and its text. Overlays, e.g. the keyboard or an image's native size, are drawn over the scenes.

[probe.ts](probe.ts) finds every check, proves every claim, confirms each counterexample by laying out every scene with the real Yoga at the same inputs, and writes `viz/data/<id>.json`: each version's circuit, compacted to the wires the drawing and the claims read, the scenes as trees of wires, and the outcomes. The visualizer runs the circuit in the browser with a copy of `evaluateCompact`. [check.test.ts](check.test.ts) checks every version of every check without proving anything: at random inputs, every scene is Yoga's, box for box, and the compact circuit computes what the circuit does.

To add a check, add `checks/<id>/check.ts`; nothing else needs to list it.

**Visualizer.** [viz/index.html](viz/index.html) shows every check that probe.ts has written to `viz/data/`: a slider per knob, a device preview of every scene and overlay laid out by the in-browser `evaluateCompact`, each claim held or broken at the current inputs, and the prover's answer for the whole range, with "Find a case that breaks": for a version that breaks, the knobs wander, then land on the counterexample; for one that doesn't, they sweep their whole ranges, every frame checked, and then fill as checked for every size. A text is drawn as large as its line height and as long as its measured width: a version can give a text its wordings from shortest to longest, e.g. "Email", "Email address", "Your email address", and the preview shows the longest that fits, spaced to the width, so it shows cut off only where its box is narrower. Each example and version has a link, `#check.example.version`. It needs no build; serve the folder, e.g. `bun yoga/probe.ts 60 && cd yoga/viz && python3 -m http.server 8000`, and open http://localhost:8000. The data names the boxes each claim reads past the layout, which the preview marks when the claim breaks; a claim about boxes at fixed places falls back to the box names in its name.

### The checks

Each has its own README with its examples, results and limits. `bun yoga/probe.ts 60`, as in Results below: a buggy version counts when a claim is refuted and the real Yoga lays out the counterexample the same way, a fixed one when every claim is proven.

| Check | Examples | Bugs found | Fixes proven | Claims | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| Nothing sticks out (overflow, below) | 2 | 2 of 2 | 1 of 2 | 100 | 4 |
| [Big enough to tap](checks/tap-targets/README.md) | 2 | 3 of 3 | 1 of 2 | 59 | 13 |
| [Labels are never cut off](checks/labels-fit/README.md) | 2 | 2 of 2 | 2 of 2 | 78 | 0 |
| [Large text](checks/font-scale/README.md) | 2 | 2 of 2 | 2 of 2 | 108 | 0 |
| [Longer translations](checks/translations/README.md) | 2 | 2 of 2 | 2 of 2 | 154 | 0 |
| [Images stay sharp](checks/image-scale/README.md) | 2 | 2 of 2 | 2 of 2 | 8 | 0 |
| [Images keep their shape](checks/image-aspect/README.md) | 2 | 2 of 2 | 5 of 5 | 13 | 0 |
| [Nothing moves when content loads](checks/layout-shift/README.md) | 3 | 3 of 3 | 3 of 3 | 20 | 0 |
| [Nothing jumps](checks/resize-jumps/README.md) | 2 | 2 of 2 | 2 of 2 | 14 | 2 |
| [Above the keyboard](checks/keyboard/README.md) | 2 | 2 of 2 | 2 of 2 | 28 | 0 |
| [Clear of the notch](checks/safe-areas/README.md) | 3 | 3 of 3 | 3 of 3 | 42 | 0 |
| [The design holds](checks/design-rules/README.md) | 3 | 3 of 3 | 3 of 3 | 8 | 0 |
| [Lines stay readable](checks/line-length/README.md) | 2 | 2 of 2 | 2 of 2 | 8 | 0 |

The fixes not proven each keep one claim that holds on 100,000 random samples and that the prover doesn't finish: the toolbar's button (Limits) and the onboarding footer's Get started, both about where a box ends in a row where something shrinks. The other unknowns are in buggy versions, beside the claims refuted.

Two checks found the same Yoga behavior from different layouts. In the first shrinking pass, an item that hits its `minWidth` leaves the total shrink factor at once, but the space still to remove is updated only after the loop, so the next item takes the whole overflow and clamps too. When every item clamps, the space left is positive and the row doesn't shrink at all. A row of filter chips with `flexShrink: 1, minWidth: 44` keeps its natural widths and runs 246 px off a 341 px screen; an inbox row's time label jumps 476 px to the left when the window grows 6 px. Real Yoga 3.2.1 lays out both the same, to the bit.

## The port

[yoga.ts](yoga.ts) is Yoga 3.2.1's `calculateLayoutInternal`, statement by statement, over a [LayoutCircuit](circuit.ts). Every value that depends on an input, such as the viewport width or a label's measured width, is a wire. Every other value is an FP32 constant, folded while building. A sum rounds once, like C++ `a + b`. A branch on style or on whether a value is defined stays a JavaScript branch. A branch on a computed value becomes a comparison bit and a select, e.g. `std::min(a, b)` is `(b < a) ? b : a`. The port models these too:

- the measurement cache: 8 slots with wraparound, Yoga's `inexactEquals` tolerance of 0.0001, and the layout entry;
- the flex basis that is set once;
- the clamped flex lines;
- both passes that distribute free space;
- justify, align and the root's sizing.

Pixel rounding is off (`pointScaleFactor` 0), because rounding to device pixels is a floor and ceiling the circuits don't have.

It is exact. [yoga.test.ts](yoga.test.ts) lays out 300 random trees at 20 random inputs each, compares the port with constants and the evaluated circuit against `yoga-layout` 3.2.1, and requires bit-for-bit equality. While building it, 400,000 samples over 80,000 random trees agreed bit for bit. The fuzz ([fuzz.ts](fuzz.ts)) covers trees of up to 4 levels, using:

- rows and columns, every justify and align value;
- grow, shrink, basis, fixed sizes, minimum and maximum sizes, aspect ratio;
- margins, padding and gaps;
- measured leaves.

The subset leaves out percentages, absolute positioning, auto margins, borders, wrapping, `display: none`, scrolling and reversed directions; the port throws at build time if a spec uses them. A measured leaf is a label that truncates: it reports `min(available, content)` when Yoga gives it at most a width. Wrapping text, whose height depends on its width, is not modeled. A circuit is usually about 3,000 operations. Operations that are identical become one wire, which makes the toolbar 1,719 operations instead of 5,781.

## What gets proven

[claims.ts](claims.ts) states, for a laid-out tree:

- every box inside its parent: `left ≥ 0`, `top ≥ 0`, `left + width ≤ parent width`, `top + height ≤ parent height`;
- in a row or a column, every child after the previous one along the main axis: no overlap.

Each claim is a wire computed in FP32 from the layout's own wires. "Overflow" allows 2⁻¹⁰ px (about 0.001 px). Yoga computes in FP32, and a row that its children fill exactly can end 3 × 10⁻⁵ px past its edge, which the prover found (see below). No screen shows that, and pixel rounding removes it.

The free inputs are the viewport (W in 320..2560, H in 480..1600) and every label's width (0..2000 for the toolbar's title, 0..120 for its button, 0..1000 or 0..400 for the card's), all on the 1/64 px grid. A proof covers every combination.

[layouts.ts](layouts.ts) has two layouts, each with a bug:

- **Toolbar**: an icon, a title, a spacer that takes the rest, and a button. The title has `flexShrink: 1`. The bug is the title without it: Yoga's default `flexShrink` is 0, unlike CSS, so a long title pushes the button off the screen. This is the classic React Native bug.
- **Card**: centered in the viewport, at most 480 wide, with a heading, a body and two buttons sharing a row. The buttons are equal width (`flexBasis: 0, flexGrow: 1, flexShrink: 1`). The variant with each button as wide as its label (`flexBasis: auto`) looks just as safe.

## Results

`bun yoga/probe.ts 60`, 60 s per claim, Apple M3 Pro under Bun. Each claim runs on the swept circuit (below) for half the time, then on the circuit as built:

| Layout | Claims | Proven | Refuted | Unknown |
| --- | ---: | ---: | ---: | ---: |
| Toolbar | 23 | **22** | 0 | 1 |
| Toolbar, title without `flexShrink` | 23 | 20 | **3** | 0 |
| Card, equal buttons | 27 | **27** | 0 | 0 |
| Card, buttons as wide as their labels | 27 | 22 | **2** | 3 |

Most claims about fixed sizes take one box, and swept, so does every claim of the card. Some of the toolbar's take real work on the circuit as built, for example:

- **The title stays inside the toolbar for every viewport and title length.** 503 boxes, 13 s. The title shrinks, and Yoga computes its size as `basis + remaining / total × scaled`.
- The spacer's right edge: 3,687 boxes, 29 s.
- The order of spacer and title, and of button and spacer.

**Every bug is found in one box, in milliseconds, and the real Yoga confirms each counterexample:**

- **The title without `flexShrink`.** For example, at W = 636.6 px and a 601.7 px title, Yoga puts the title 5 px past the toolbar's edge and the button 126 px past it.
- **The card with buttons as wide as their labels.** For example, at W = 402 px, with a 328 px confirm label, Yoga makes the card 469 px wide, so it sits 34 px off both sides of the viewport. I wrote this one as a correct layout. A centered card's width is its content's, and Yoga measures the row of buttons as one label clamped to the card's width, *plus* the other button's padding and the gap. With a 300 px label the card is always `available + gap + 32` wide, 40 px more than fits. CSS would make the card fit, and with equal buttons it fits. Sampling found it too, once I looked, but nothing in the spec suggests it.
- **The 3 × 10⁻⁵ px overrun**, before the tolerance: the shrunk buttons of that card can end 3.05 × 10⁻⁵ px past their row, because each child's size rounds separately. That is real Yoga behavior, and it is why the claims allow 2⁻¹⁰ px.

The one unknown of the correct layouts is a claim that holds: 100,000 random samples give the toolbar's button 8 px of margin. The prover doesn't finish it in 60 s, nor in 5 minutes. Why is under Limits.

## What it took

Layout circuits are unlike HandwiredOS's. They divide, they multiply two inputs, and they branch on computed values. Yoga computes the same quantities more than once, so one input decision shows up as many bits. Each change below is general, in [../prove](../prove). When they were made, the HandwiredOS results were unchanged by them: 629 contracts and all 3 workspace properties were still proven, and the properties took 6 s each instead of 12.

- **Quotients.** A quotient by a constant scales its dividend's forms, and stays exact for a power of two, e.g. a centering offset `remaining / 2`. A quotient by a value of one sign is `a × 1/b`, with `1/b` between its chord and its tangent, then McCormick's planes.
- **The ratio rule.** `f(f(a / b) × s)` where `s` is close to `k × b` is `k × a`, up to two roundings and `a × (s − k b) / b`. This is Yoga's shrink step, `remaining / totalScaledShrink × scaledShrink`: with one shrinking child, the free space goes exactly to it. Back-substitution uses it too, as it does quotients by constants.
- **Copies and `x − x`.** A sum's terms merge by the wire they copy, in this box: `f(0 + x)`, `f(x + y)` with `y` always 0, and a decided select all copy a wire. A sum `x − x` of two copies is then exactly +0. Without this, `total − scaled`, which is 0 for a single shrinking child, came out as ±446 px, and `max(base, 0) == base` stayed undecided over ±10⁻¹⁰.
- **Splitting at a threshold.** An undecided `x < t`, where `x` is computed, splits `x`'s range at `t` into the FP32 values on each side, so every comparison of `x` with `t` decides. An example is Yoga's free space `< 0` and `> 0`, which choose between shrinking and growing.
- **Merging equal wires** ([sweep.ts](sweep.ts)). Yoga measures a node, then lays it out, and computes the same values in both passes from different wires, e.g. the available width from the owner one way and from the measured size the other. A box can't say that two wires are equal, so the search paid for combinations that never happen, e.g. shrinking in one pass and growing in the other. The sweep finds equal wires and merges them, as hardware equivalence checkers do (FRAIG): 64 random tables group wires by their values, and in program order each wire whose group has an earlier member is a candidate, which the prover itself checks by claiming their difference is 0 for every table. A refuted pair's table joins the tables. The circuit is rebuilt as it goes, so an operation whose operands merged is its twin and merges by itself, and folds what merging leaves: a select of a decided bit, a sum with a 0 term, a quotient by a constant wire, which the prover scales only when the divisor is a constant. A merge must change no value, and +0 and -0 differ under division, so only wires that can't be -0 merge. The card's 3,664 operations become 343, in 8 s, and its claims take one box each. The sweep also marks the selects the port writes out as `std::min` and `std::max`, e.g. a label's `(available < content) ? available : content`, so back-substitution bounds them by either operand; the circuit as built leaves them unmarked, where the mark costs the toolbar's spacer its proof. Sweeping can hide what a proof used, too: merged, the toolbar's title claim reads the measurement cache's tolerance test on the very wire it shrinks. So each claim tries both circuits.
- **Choosing what to split.** While a bound is infinite, the search follows the chain of unbounded wires back to its source. That source is a quotient whose divisor can be 0 only where its branch isn't taken, so the decisions along the chain are what can end it. The undecided selects whose union adds the most slack are tried too. So are the selects that back-substitution has to take whole ranges of, and the comparisons their bits are made of. With few inputs, each input's halves are tried as well, because an undecided select hides from the smear how much a range matters. A try is ranked first by how many infinite sides it leaves, then by how many unbounded wires.

## Soundness

[prove.test.ts](prove.test.ts) checks the prover's interval, symbolic and back-substituted bounds on 60 random Yoga trees. For every wire in each claim's cone, every value at random points in random boxes must lie inside the bounds. The test found the first three of these bugs in the prover, and tracing slow claims found the other two. All are fixed, and the test run six times wider finds no more:

- `max(a, b) ≥ b` was used when `a` may be NaN, Yoga's undefined; then `max` returns NaN, and a "defined" check decided wrong.
- The grid of NaN was 2¹⁰²³, so `−2 × NaN` had the grid of 0 and the range 0..0.
- `0 × x` was taken as 0 even where `x` may be NaN or infinite.
- Back-substitution could return NaN, from Infinity − Infinity, and a claim with an open side measured its excess as Infinity − Infinity. That second one only cost proofs: `spacer after title` took 24,000 boxes before the fix and 17 after.

None of them changed a HandwiredOS result, whose circuits have no NaN. The tests also prove the toolbar's title claim, and check both bugs' counterexamples against `yoga-layout`. A merge is only as sound as the prover that proved it, so the tests sweep 16 random trees, half of them with 4 tables, which group many wires that differ, and require every claim's value after sweeping to equal its value before, -0 and NaN included, at 200 random points each.

## Limits

- **Relations the boxes can't hold.** Sweeping merges the wires that are equal, but a decided comparison still bounds only its bit, not the difference it compared, e.g. that the measurement cache's tolerance test passed says nothing a box keeps about the two sizes it tested. The toolbar's button claim runs out of time there, swept or not. The fix is β-CROWN's split constraints inside back-substitution, which this prototype doesn't do.
- **Time.** About 10 ms per box on the toolbar and 20 ms on the card, and 85% of it goes to trying split candidates. Each claim also spends 10% of its time limit on the attack before splitting, which is why many claims take 6 s.
- **Subset.** No wrapping text, percentages or absolute positioning. Pixel rounding is off.
- **Inputs are ranges.** A proof covers every viewport and label width in the declared ranges, not fonts or content beyond them.

The answer to the question: yes, for a flexbox engine the size of Yoga. It is exact, and the bugs that matter are found in milliseconds with a confirmed counterexample, including one I didn't plant and didn't expect. Proving a layout correct works for the card, every claim, and for all but one claim of the toolbar, which needs the relational step above. Browser CSS has the same kind of algorithm, many times larger.
