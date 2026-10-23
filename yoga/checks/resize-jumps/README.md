# Resize jumps

Does anything jump when the window is resized a little, or move the wrong way when a text gets longer? A layout that is right at every width can still be wrong between two of them: an element that leaps as you drag the window's edge, or a button that moves left when its label grows.

```sh
bun yoga/probe.ts 60 resize-jumps
```

## What is checked

Each version lays out one row twice in one circuit. In the first example, the row is laid out at width W and at W + δ, with δ from 0 to 8 px, and the claims are that the time at the end of the row and the subject's width never go back, and move by at most δ. In the second, the row is laid out at the same width with the subject as is and up to an eighth longer, and the claims are that the time doesn't move and the subject doesn't get narrower. All within 2⁻¹⁰ px, for every width from 320 to 1280 and every text length in range.

## Looking for a jump

Flexbox looks continuous: a clamp, a share of free space, centering and the switch between growing and shrinking all agree where they meet. Before writing examples I looked for a real jump, first in theory, then by sampling the real Yoga:

- Yoga's content sizing (step 5 of its algorithm), where a container measured to fit takes its minimum or its content, is continuous: where the content passes the minimum, the two agree. So is `justifyContent` falling back from `space-between` to `flex-start` when the row overflows, because the free space is 0 there.
- The measurement cache's tolerance of 0.0001 changes results by less than 0.0001 px.
- Random trees from [../../fuzz.ts](../../fuzz.ts), with one input moved and the interval halved down to 1/64 px wherever an edge moved more than 4 times as far: 60,000 comparisons of layouts that don't overflow found no jump. Allowing the layout after the step to overflow found one, and in trees that already overflowed there were many, some of them by 10⁹ px.

The one it found is Yoga's first pass of shrinking. It takes the items in order, and when an item would shrink below its minimum, it freezes the item and takes its share out of the total shrink factor, but not out of the space still to remove. The next item is then shrunk by all the overflow, as if the frozen one still took its share. If that drives it below its own minimum, it freezes too, and the space left over turns positive. So the second pass grows instead of shrinking: the frozen items get their full widths back, and the one that grows gets more than its own.

## Examples

Both examples are an inbox row: the sender's name, the subject, which grows to take the rest, and the time, at the right edge. Both names truncate.

- **The sender shrinks, but not below 120** (`flexShrink: 1, minWidth: 120`), so that it stays readable, and the subject shrinks too. This is the layout above. On a narrow screen, for some lengths of the sender's name and a long subject, the sender is frozen at 120, the subject is shrunk to nothing, and the second pass grows the row past the screen. A pixel wider, it is right again.
- **The fix caps the sender at 140** (`maxWidth: 140`) and doesn't shrink it. Only the subject shrinks, and one item that shrinks can't be frozen out of turn. Capping the sender column is also what most mail apps do.

The first example resizes the row; the second makes the subject longer, which runs into the same bug from the other side.

## Results

`bun yoga/probe.ts 60 resize-jumps`, 60 s per claim, Apple M3 Pro under Bun:

| Example | Version | Claims | Proven | Refuted | Unknown |
| --- | --- | ---: | ---: | ---: | ---: |
| Resized | Sender shrinks, `minWidth: 120` | 4 | 0 | **4** | 0 |
| Resized | Sender capped, `maxWidth: 140` | 4 | **4** | 0 | 0 |
| Longer subject | Sender shrinks, `minWidth: 120` | 3 | 0 | **1** | 2 |
| Longer subject | Sender capped, `maxWidth: 140` | 3 | **3** | 0 | 0 |

Every refutation takes one box, and the real Yoga confirms each counterexample:

- **The window 6 px wider, and the time 476 px to the left.** At W = 333.2 px, with a 399 px sender name, a 301.6 px subject and a 48.8 px time, Yoga draws the sender 301 px wide, the subject 418 px wide and the time at x = 751, far past the screen's edge. At W + 6.05 px it draws the sender at 122, the subject at 120 and the time at x = 274, where it belongs.
- **The time moving twice as fast as the window.** At W = 344.3 px, inside the region where the row is wrong, 0.7 px more width moves the time 1.4 px: the subject there is laid out as twice the available width less a constant.
- **A longer subject pushing the time right.** At W = 326 px, with a 364 px sender name and a 243.8 px subject made an eighth longer, the time moves 30.5 px to the right, past the screen.

The capped sender is proven for every input, every claim in one box. With one item that shrinks, Yoga gives it all the overflow, as `basis + remaining / total × scaled`, which the prover's ratio rule (see the lab's README) reads as `basis + remaining`, so the time sits at the screen's edge less its padding at both widths.

The two unknowns of the bug version are claims that 400,000 random samples say hold: a longer subject never moves the time left, nor makes the subject narrower. The bug only ever pushes the time right. The prover doesn't finish them in 60 s, with 60,000 and 105,000 boxes: they need the relation between the subject and its longer copy, a product of two inputs, through both passes of shrinking.

## Limits

- The jump needs two items that shrink, one of them with a minimum, and an overflow large enough to freeze the first. That is why sampling rarely finds it: in the inbox row it takes a sender name about as wide as the screen's free space, on a screen narrower than about 375 px. Screenshots at 390 px never show it.
- One kind of row, laid out at two widths that differ by up to 8 px. A jump bigger than 8 px elsewhere in the range is found as a move of more than δ, but the claims don't say anything about the shape between the two widths.
- The longer subject is the subject times 1 to 1.125, an input times an input. Two of the bug version's claims are unknown within the time limit, see Results.
