# Images keep their shape

Can an image ever be stretched or squashed out of its aspect ratio? A box of another shape than its image stretches the image with `resizeMode: 'stretch'`, crops it with `'cover'`, React Native's default, and leaves bars with `'contain'`. So the check claims, for every image, that its box has the image's proportions.

For a box w × h and an image nw × nh, that is w × nh − h × nw = 0. The claim's value is (w × nh − h × nw) / nh: how far the width is from what the height calls for, in points. It allows half a point either way, and for an image wider than it is tall, less, so that the height is within half a point of what the width calls for, too. The value multiplies and divides the box's wires by constants only, and FP32 rounds each step by far less than half a point.

```sh
bun yoga/probe.ts 60 image-aspect
```

## Examples

**An avatar in a contact list.** A row with 12 of padding and gap, a round avatar and a column with the name and a status line, each a measured leaf whose width and height scale with the system's text size (0.8125..2). As first written the avatar has only `width: 40`, and the row's default `alignItems: 'stretch'` gives it the row's height. At the default text size the name and status are 20 + 2 + 18 high, so the avatar is 40 × 40 and looked right. At any other text size it is an oval. Three versions keep it round. `height: 40`, which stretch doesn't override. `width: 40, aspectRatio: 1`: Yoga sizes a child with an aspect ratio from its other side before it stretches it, so stretch doesn't win and the avatar stays 40 × 40. And `aspectRatio: 1` alone, a different design: the avatar is as tall as the row and as wide as it is tall, so it grows with the text, 32.9 at the smallest size and 78 at the largest.

**A row of photo thumbnails.** Three square thumbnails from 336 × 336 px assets at @3x, in a row with 16 of padding and 8 of gap, under a heading. As first written each is `flex: 1` (`flexGrow: 1, flexShrink: 1, flexBasis: 0`), to share the row, and 114 high, which makes them square on the 390 wide phone they were designed on: (390 − 2 × 16 − 2 × 8) / 3 = 114. They are stretched on every wider screen and squashed on every narrower one. Two versions keep them square. A fixed 88 × 88, which fits three to a row on a 320 wide phone, spread with `justifyContent: 'space-between'`, and leaves room on a wide screen. And `flex: 1` with `aspectRatio: 1` instead of the height, which fills the row: each thumbnail is (W − 48) / 3 square, from 90.7 at W = 320 to 439.3 at W = 1366.

The knobs are the screen (W in 320..1366, H in 480..1366), the text size, and every text's width, on the 1/64 grid.

## Results

`bun yoga/probe.ts 60 image-aspect`, Apple M3 Pro under Bun:

| Example | Claims | Proven | Refuted | Unknown |
| --- | ---: | ---: | ---: | ---: |
| Avatar with `width: 40` only | 1 | 0 | **1** | 0 |
| Avatar with `width: 40, height: 40` | 1 | **1** | 0 | 0 |
| Avatar with `width: 40, aspectRatio: 1` | 1 | **1** | 0 | 0 |
| Avatar with `aspectRatio: 1` only, growing with the text | 1 | **1** | 0 | 0 |
| Thumbnails with `flex: 1` and `height: 114` | 3 | 0 | **3** | 0 |
| Thumbnails 88 × 88 | 3 | **3** | 0 | 0 |
| Thumbnails with `flex: 1` and `aspectRatio: 1` | 3 | **3** | 0 | 0 |

Every claim takes one box and milliseconds. The real Yoga confirms every counterexample:

- **The avatar.** At text size 1.40625 the row is 55.4 high inside its padding, and so is the avatar: 40 × 55.4, 15.4 points narrower than its height calls for.
- **The thumbnails.** At W = 843 each is 265 × 114, 151 points too wide. On a 320 wide phone each is 90.7 × 114, squashed the other way.

The fixed sizes make their claims constants, which prove without a search. The `aspectRatio` versions don't: as built, each claim reads 200 to 1,900 operations, e.g. the thumbnail's width from the shared free space and its height as that width divided by 1. The sweep ([sweep.ts](../../sweep.ts)) does the work before the search. It finds that the width and the height are the same wire, has the prover check that for every input, and merges them, so the thumbnails' and the fixed-width avatar's claims become the constant 0. The growing avatar's claim keeps 7 operations after the sweep and proves in one box. So these proofs are the sweep's proofs that two of Yoga's wires are equal.

## Limits

- **Only the shape.** The check says nothing about where the images end up. The thumbnails that fill the row grow with the screen: at W = 1366 the row ends 511.3 from the top, so a 1366 × 480 screen, inside the knobs' ranges but not a real device, would cut them off. [overflow](../overflow) asks that question; this check doesn't repeat it.
- **Native sizes are constants.** In the port a style is a constant, `aspectRatio` too. An image whose size comes with the data, e.g. a photo in a chat, needs its ratio set from the data, which this check can't model.
- **Subset.** No percentages or absolute positioning (see the [lab README](../../README.md)).
