# Images stay sharp

Can an image ever be drawn larger than its native size, so it looks blurry? An image's native size is its pixels in points, e.g. a @3x asset of 1125 × 450 px is 375 × 150. If its box is wider or taller than that, the image is scaled up: `resizeMode: 'cover'`, React Native's default, scales by the larger of the two ratios, and `'contain'` and `'stretch'` scale by each. So the check claims, for every image, that:

- its box is no wider than its native width;
- its box is no taller than its native height.

Each claim is the box's size less the native size, at most 2⁻¹⁰ px, the same tolerance as [the overflow check's](../../claims.ts). The native size is a constant for a bundled asset, and a knob for an image whose size comes with the data. Each version draws the native size as an overlay at the image's position, so the visualizer shows how far it is scaled up.

```sh
bun yoga/probe.ts 60 image-scale
```

## Examples

**A photo in a chat bubble.** The bubble sits at the start of the screen, at most 280 wide, with 8 of padding, the photo and a caption under it. The photo is a measured leaf whose content size is its native size, which comes with the message: any width and height from 16 to 2000. As first written, the photo takes the bubble's default `alignItems: 'stretch'`, so it is as wide as the bubble, and the bubble is as wide as its widest child. A small photo with a long caption is stretched to the caption's width. The fix is `alignSelf: 'flex-start'` on the photo: Yoga then measures it with at most the bubble's width, so it is its native width, or narrower when the bubble is.

**A banner at the top of a screen.** A full-width banner 150 high, from a 375 × 150 asset, above a title and a body. It fills the 375 wide iPhone it was designed on. Stretched across the screen by the column's default `alignItems: 'stretch'`, it is scaled up on every wider phone, and 3.6 times on a 1366 wide tablet. The fix is `maxWidth: 375`.

The knobs are the screen (W in 320..1366, H in 480..1366) and every text's width, on the 1/64 px grid.

## Results

`bun yoga/probe.ts 60 image-scale`, Apple M3 Pro under Bun:

| Example | Claims | Proven | Refuted | Unknown |
| --- | ---: | ---: | ---: | ---: |
| Chat photo, stretched to the bubble | 2 | 1 | **1** | 0 |
| Chat photo, `alignSelf: 'flex-start'` | 2 | **2** | 0 | 0 |
| Banner as wide as the screen | 2 | 1 | **1** | 0 |
| Banner, `maxWidth: 375` | 2 | **2** | 0 | 0 |

Every claim takes one box and milliseconds. The real Yoga confirms both counterexamples:

- **The stretched photo.** At W = 390, a photo 21.4 wide and a caption 981 wide, Yoga draws the photo 264 wide, the bubble's 280 less its padding: 12 times its native width. The height claim holds for this layout, since a column gives its child its content height.
- **The full-width banner.** At W = 843 the banner is 843 wide, 468 more than its 375.

The fixed photo's width is Yoga's `min(available, native)` for a leaf measured with at most the available width, and the prover shows it never exceeds the native width for every bubble width, caption and photo size. The fixed banner's width is the stretched width clamped to 375.

## Limits

- **Pixels, not points.** The claims compare points with the asset's size in points. An image a server sends at one resolution for every screen is sharp only if its pixels cover the box at the device's pixel ratio, which is an input this check doesn't have.
- **The fixed banner sits at the left.** `maxWidth` clamps the stretched width, and on a wide screen the banner keeps to the left edge. Centring it with `alignSelf: 'center'` would make it 0 wide, since it has no content; a wrapper with `alignItems: 'center'` and a fixed width would do.
- **Shape.** Neither claim says the box has the image's shape: the fixed banner is 320 × 150 on a 320 wide phone, and the fixed photo keeps its native height when the bubble makes it narrower, so `'cover'` crops both. [image-aspect](../image-aspect) asks that.
- **Subset.** No percentages or absolute positioning (see the [lab README](../../README.md)).
