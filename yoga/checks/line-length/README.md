# Line length

Do text columns stay readable: never squeezed below about 15 characters, never stretched past about 80?

Typographers put a comfortable line at about 45 to 75 characters. A column that the screen squeezes to a few words a line, or a page that runs one line across a 2560 px monitor, are both hard to read, and both are easy to miss when the layout is checked on one phone and one laptop.

The check assumes 16 px body text at **8 px per character**, about the average for a sans-serif face. So 15 characters are 120 px and 80 characters are 640 px, and every claim says that a paragraph is 120 px to 640 px wide, allowing 2⁻¹⁰ px for rounding. A paragraph that wraps fills its column, so its width is the length of its longest lines. The port has no wrapping text, so a paragraph here is a line of 4,000 px, longer than any column, stretched across it.

```sh
bun yoga/probe.ts 60 line-length
```

## Examples

The screen is 320 to 2560 px wide and 480 to 1600 px tall, on the 1/64 px grid.

- **An article**: a title, a lead and a body. As first written the article fills the screen less 16 px on each side, which is right on a phone and gives a 2528 px line, about 300 characters, on a wide monitor. The fix makes the screen a row that centers its child (`flexDirection: 'row', justifyContent: 'center'`) and the article `width: 640, flexShrink: 1`: 640 px when there is room, and the screen less its padding when there isn't.
- **Sidebar and text**: a docs page with a 280 px navigation sidebar and the page, whose text is at most 640 px wide (`maxWidth: 640`) inside a column with 24 px padding. As first written the sidebar is always 280 px, so on a 320 px phone the text column gets 40 px, less than its own padding, and the text gets nothing. The fix lets the sidebar shrink (`flexShrink: 1`) and gives the text column `minWidth: 168`, 120 px of text and its padding. The sidebar's three labels are inputs of 0 to 400 px.

Both layouts fit the whole range of screens once fixed: the article is at least 320 − 32 = 288 px, and the sidebar gives up width until the text has 120 px, which a 320 px screen still allows with a 152 px sidebar.

## Results

`bun yoga/probe.ts 60 line-length`, 60 s per claim:

| Example | Version | Claims | Proven | Refuted | Unknown |
| --- | --- | ---: | ---: | ---: | ---: |
| An article | As wide as the screen | 2 | 1 | **1** | 0 |
| | At most 640 px wide, centered | 2 | **2** | 0 | 0 |
| Sidebar and text | Sidebar always 280 px | 2 | 1 | **1** | 0 |
| | Sidebar shrinks, text keeps 168 px | 2 | **2** | 0 | 0 |

Each bug is found in one box and the real Yoga agrees:

- **The article** at W = 1440 px is 1408 px wide, 176 characters a line.
- **The docs page** at W = 326.1 px gives its text 0 px.

Each bug breaks only one side of the rule. The full-width article is never too narrow, and the docs text never too wide, because its `maxWidth` was right from the start. Every proof takes at most 3 boxes and 3 s; the claims that are not listed by the probe take one box.

## Limits

- **Characters are an average.** 8 px a character is a rule of thumb for 16 px text. A different font or size moves both bounds; the check doesn't measure glyphs, and the port doesn't wrap text, so it can't count the characters on a line.
- **`flex: 1` with `maxWidth: 640` isn't proven.** It is the more common way to write the article's fix, and the real Yoga lays it out the same, 288 to 640 px over 100,000 random widths. The prover proves its upper bound but not the lower one: it runs out of boxes (100,000 on each circuit) in Yoga's loop that freezes the article at its maximum and hands out the space again, which divides by a total flex factor that is 0 in the branch not taken. The article as proven uses `width: 640, flexShrink: 1`, which computes the same widths through Yoga's shrinking step instead of its growing step with a maximum.
- **Only the column is checked.** A paragraph with little text has short lines in any column, which is not a readability problem, so the check is about the room the column gives, not the text in it.
