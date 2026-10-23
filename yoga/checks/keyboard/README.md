# Above the keyboard

With the on-screen keyboard open at any height, do the field being typed in and its button stay visible above it?

```sh
bun yoga/probe.ts 60 keyboard
```

## What is checked

Yoga doesn't know about the keyboard. The keyboard covers the bottom K px of the screen, and what the app does about it decides where the form is laid out. Without a `KeyboardAvoidingView`, the form keeps the whole screen, H px tall, and the keyboard is drawn over it. In a `KeyboardAvoidingView` with `behavior="height"`, the form is laid out in the H − K px above the keyboard. So each version lays out its form at the height the app gives it, and the claims compare the laid-out boxes with the keyboard's top edge, H − K:

- the focused field and the button that submits it end at or above the keyboard's top;
- they start at or below the top of the screen;
- in the form, the parts don't overlap: the button stays after the fields, the comment box after the comments, the comments after the header, and the Post button to the right of the comment box.

The inputs are phones in portrait, 320 to 430 px wide and 640 to 932 px tall, and the keyboard from 0 to 360 px. The iPhone keyboard is 216 to 336 px with its suggestion bar, and Android keyboards with a number row reach about 360. Every height in between happens while the keyboard slides in, and with a floating keyboard. The text widths are inputs too: the heading, what is typed in each field, and the button labels. The smallest space left above the keyboard is 640 − 360 = 280 px, and both forms are made to fit in it.

## Examples

- **A sign-in form.** A heading, email and password fields, and a Sign in button pinned to the bottom with `justifyContent: 'space-between'`, the way designs put the main action within the thumb's reach. The password field has the focus. Its content is 250 px tall.
- **A comment box.** A header, the comments, which take the rest of the height, and a row at the bottom with the comment box (`flex: 1`) and a Post button. The header and the row take 112 px.

Each has two versions: laid out over the whole screen, which is the bug, and in a `KeyboardAvoidingView`, which is the fix.

## Results

`bun yoga/probe.ts 60 keyboard`, Apple M3 Pro under Bun. The whole check runs in about 3 s.

| Example | Version | Claims | Proven | Refuted |
| --- | --- | ---: | ---: | ---: |
| Sign-in form | Whole screen | 6 | 5 | **1** |
| Sign-in form | KeyboardAvoidingView | 6 | **6** | 0 |
| Comment box | Whole screen | 8 | 6 | **2** |
| Comment box | KeyboardAvoidingView | 8 | **8** | 0 |

Every claim takes one box. Each bug is found at once, and the real Yoga agrees:

- **The Sign in button under the keyboard.** At a 390 × 786 screen with a 180 px keyboard, the button ends 156 px below the keyboard's top. The password field stays visible at every input, because the fields sit at the top. That is how this bug ships: the field you type in is fine, and the button you need next is hidden.
- **The comment box and Post under the keyboard.** At the same screen and keyboard, both end 172 px below the keyboard's top. Any keyboard taller than 0 covers them.

The fixes hold for every screen, keyboard height and text width in the ranges, including that nothing overlaps in the smallest space.

## Limits

- **The minimum space.** The fix holds because the form fits in the smallest space above the keyboard. On a 4-inch phone, 568 px tall, the space can be 568 − 360 = 208 px. With H down to 568, the prover refutes the sign-in fix: at H = 578.3 and K = 354.3, the Sign in button ends 2 px below the keyboard's top. The form's content is 250 px tall: once the space is smaller, the button moves into the form's 24 px bottom padding, and below 226 px it passes the keyboard's top. A `KeyboardAvoidingView` alone isn't enough there; the form needs to scroll, which the port doesn't model. The comment box holds at H = 568 too, since it needs only 112 px.
- **Other behaviors.** `behavior="padding"` and `"position"`, and Android's `adjustResize`, which resizes the window itself, all place the form differently. The check models the one that resizes the form to the space above the keyboard; the others would be other scenes.
- **No scrolling and no wrapping text.** The comments are one box that takes the rest of the height. A line of text truncates rather than wraps.
- **The keyboard's height is an input on its own.** Real keyboards are taller on taller screens; the ranges are independent, which covers more than happens.
