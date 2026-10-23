# Layout shift

Can content that loads later, such as a photo, an ad or a promo banner, push what the user is about to tap or read? Users tap where a button was a moment ago, and a shift under the finger sends the tap elsewhere. Web vitals call it layout shift.

```sh
bun yoga/probe.ts 60 layout-shift
```

## What is checked

Each version lays out the same screen twice in one circuit, from the same inputs: "Loading", with the late content at its placeholder size (an image with no size yet is 0 tall in React Native), and "Loaded", with its real size as an input. The claims say that each chosen element, e.g. Add to cart, has the same left and the same top in both, within 2⁻¹⁰ px, for every screen size, every text length and every loaded size in range. A position is the sum of the offsets from the screen down to the element, in FP32, as the layout computes them.

## Examples

- **A product page.** A photo, the name, the price and Add to cart. The photo is as tall as the loaded image (160 to 640), and 0 while it loads, so the whole page below it jumps down when it arrives. The fix gives the photo a fixed height of 320, cropping the image to fill it.
- **An article with an ad.** A headline, a byline, an ad slot, the story and Read more. The ad network fills the slot with a banner 50 to 250 tall after the page shows. The slot as tall as its ad is empty while loading. The fix gives the slot `minHeight: 250`, the tallest ad it can get.
- **A checkout with Pay at the bottom.** The order (a title, three items, the delivery address and a promo banner from the server, 48 to 160 tall) and Pay below it. The first version pins Pay to the bottom by giving the order `flexGrow: 1`. On a tall phone that holds: the order grows to fill the space, and the banner only takes some of that growth. On a short one the order is taller than the space, and since Yoga doesn't shrink by default, it keeps its height and the banner pushes Pay down. The fix adds `flexBasis: 0`, which is what React Native's `flex: 1` sets: the order then takes exactly the space above Pay, and scrolls, whatever it holds.

The first two bugs are plain to see on any screen. The third isn't: on an 844 px tall phone Pay doesn't move. It moves only when the screen is less than 488 px plus the banner's height tall, e.g. a small phone less its navigation bar, or any phone with a 160 px banner below 648 px.

## Results

`bun yoga/probe.ts 60 layout-shift`, 60 s per claim, Apple M3 Pro under Bun:

| Example | Version | Claims | Proven | Refuted | Unknown |
| --- | --- | ---: | ---: | ---: | ---: |
| Product page | Photo as tall as the image | 4 | 2 | **2** | 0 |
| Product page | Photo with a fixed height of 320 | 4 | **4** | 0 | 0 |
| Article | Ad slot as tall as the ad | 4 | 2 | **2** | 0 |
| Article | Ad slot with `minHeight: 250` | 4 | **4** | 0 | 0 |
| Checkout | Order with `flexGrow: 1` | 2 | 1 | **1** | 0 |
| Checkout | Order with `flexGrow: 1, flexBasis: 0` | 2 | **2** | 0 | 0 |

Every claim takes one box, and every counterexample is confirmed by the real Yoga laying out both scenes at the same inputs:

- **Product page**: at the base inputs, a 400 px photo moves Add to cart and the product name down by 400 px. Nothing moves sideways.
- **Article**: at the base inputs, a 150 px ad moves the story and Read more down by 150 px.
- **Checkout**: on a 517.8 px tall screen with a 95.9 px banner, Pay moves down by 66 px. Here the prover had to find a short screen, which the base inputs, a 844 px phone, aren't.

The proofs of the fixed versions are short because the fix cuts the late content off from the claimed elements: the photo's and the order's heights are fixed or given by the screen, so both scenes compute the claimed positions from the same wires and the difference is 0. The ad slot takes a step more: its height is the larger of 250 and the ad's, and the ad is at most 250.

## Limits

- The loaded sizes are ranges. The ad slot is proven for ads up to 250 tall, and an ad of 600 would push the story down by 350. The photo's fixed height crops a tall photo.
- No aspect ratio in the subset, so the photo can't reserve its space as `aspectRatio: 4 / 3` would, which is the usual fix on the web.
- A shift is measured within one screen, as positions relative to its top. Scrolling isn't modeled: in the fixed checkout, the order's contents run past the order's own box, which a scroll view would clip and scroll.
- These are easy proofs. They show the check catches the shift, and that the fix holds for every input, not that the prover is needed for it.
