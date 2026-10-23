# Clear of the notch

Do buttons and text stay clear of the notch, the status bar and the home indicator, for any size of them?

```sh
bun yoga/probe.ts 60 safe-areas
```

## What is checked

The system draws over the edges of the screen: the status bar and the notch or Dynamic Island at the top, the home indicator at the bottom, and in landscape the notch on one side. Their sizes, the safe-area insets, differ from phone to phone, so they are inputs. Yoga doesn't know about them. A `SafeAreaView` lays its content out in the screen less the insets, so each version lays the app out where the app puts it: on the whole screen, or in the safe area, at x = left inset and y = top inset, its width and height reduced by the insets. The claims say that each button and each line of text lies outside the bands: its top at or below the top inset, its bottom at or above the screen height less the bottom inset, and in landscape its left and right edges inside the side insets.

The inputs, in portrait: screens 320 to 430 px wide and 568 to 932 px tall; a top inset of 20 to 59 px (20 with a plain status bar, 44 to 50 under a notch, 54 to 59 under the Dynamic Island, about 24 to 52 on Android); and a bottom inset of 0 to 34 px (34 above the home indicator, 16 to 24 for Android's gesture bar). In landscape: screens 568 to 932 px wide and 320 to 430 px tall, each side's inset 0 to 59 px, and a bottom inset of 0 to 21 px. Text widths are inputs too. Each inset is an input of its own, so the ranges cover every combination, including some no phone has.

## Examples

- **A header**: back, a title that takes the rest (`flex: 1`), and an Edit button, above the page. The bug leaves room for the status bar with `paddingTop: 20` and a height of 64, which is right on iPhones before the iPhone X. The fix puts the app in a `SafeAreaView` and makes the header 44 tall without the padding.
- **A tab bar** under a feed: four tabs of equal width, each an icon over a label. The bug is a `SafeAreaView` with `edges={['top']}`: the notch was handled, the home indicator forgotten. The fix adds the bottom edge.
- **Video controls in landscape**: play, the elapsed time, the scrubber, the time remaining and full screen, along the bottom of a full-screen video, 12 px from the edges. The bug lays the controls out over the whole screen. The fix puts them in a `SafeAreaView`; the video still fills the screen behind them.

## Results

`bun yoga/probe.ts 60 safe-areas`, Apple M3 Pro under Bun. The whole check runs in about 30 s.

| Example | Version | Claims | Proven | Refuted |
| --- | --- | ---: | ---: | ---: |
| Header | `paddingTop: 20` | 4 | 1 | **3** |
| Header | SafeAreaView | 4 | **4** | 0 |
| Tab bar | `edges={['top']}` | 9 | 1 | **8** |
| Tab bar | Top and bottom edges | 9 | **9** | 0 |
| Video controls | Whole screen | 8 | 0 | **8** |
| Video controls | SafeAreaView | 8 | **8** | 0 |

Every claim takes one box, and the real Yoga agrees with every counterexample:

- **The header.** With a 39.5 px top inset, the back and Edit buttons start 19.5 px inside the band and the title 8.5 px. Any inset over 20 px puts the buttons under it, and any over 31 the title. The page below the header stays clear: it starts at 80 px.
- **The tab bar.** With a 17 px bottom inset, every tab reaches 17 px into the home indicator's band, and with more than 6 px, every label does.
- **The video controls.** With a 29.5 px left inset, the play button starts 17.5 px inside it; the elapsed time is under the notch above a 56 px inset; the buttons reach into the home indicator's band above 8 px and the times above 16 px.

The fixes hold for every screen, inset and text width in the ranges.

## Limits

- **Insets as padding.** The usual fix with `react-native-safe-area-context` is `paddingTop: insets.top` on the header, so that its background still fills the band. The port supports only constant padding, so the check models the `SafeAreaView` that moves and shrinks the whole app instead. What the claims are about, where the buttons and text end up, is the same.
- **Backgrounds.** The check says nothing about what fills the bands, e.g. whether the header's color reaches the top of the screen.
- **Rounded corners and the notch's shape.** The bands are rectangles the size of the insets, as the system reports them.
- **Independent ranges.** A phone with a 20 px top inset has no home indicator, and landscape insets are equal on both sides on iPhones. The ranges cover each combination, which is more than happens.
