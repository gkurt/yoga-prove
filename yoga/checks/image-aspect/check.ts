// Images keep their shape: an image's box has the proportions of the image,
// for every screen size and text size. A box of another shape stretches the
// image with resizeMode 'stretch', crops it with 'cover' (React Native's
// default) and leaves bars with 'contain'.
//
// The claim is w × nh − h × nw = 0 for a box w × h and an image nw × nh, up
// to half a point. Its value is (w × nh − h × nw) / nh, how far the width is
// from what the height calls for, in points: within 1/2, and the height
// within 1/2 of what the width calls for, is |w × nh − h × nw| ≤ min(nh, nw)
// / 2. It multiplies and divides the box's wires by constants only, and FP32
// rounds each step by far less than that.
import type {Check, CheckClaim, Knob, Scene, Version} from '../../check.ts'
import {divide, multiply, subtract, type LayoutCircuit, type Num} from '../../circuit.ts'
import type {Layout, Spec, Style} from '../../yoga.ts'

function find(box: Layout, name: string): Layout | undefined {
  if (box.name === name) return box
  for (const child of box.children) {
    const found = find(child, name)
    if (found !== undefined) return found
  }
  return undefined
}

// An image: its box's name, its native proportions, and what it is in words.
type Image = {name: string, width: number, height: number, says: string, shape: string}

function aspectClaims(c: LayoutCircuit, scene: Scene, images: Image[]): CheckClaim[] {
  return images.map(image => {
    const box = find(scene.root, image.name)
    if (box === undefined) throw new Error(`no box ${image.name}`)
    // How far the width is from what the height calls for, in points.
    const off: Num = divide(c, subtract(c, multiply(c, box.width, image.height), multiply(c, box.height, image.width)), image.height)
    const allowed = Math.min(image.width, image.height) / image.height / 2
    return {
      name: `${image.name} keeps its aspect ratio`, says: `${image.says} keeps its ${image.shape} shape, give or take half a point`,
      wire: c.wireOf(off), minimum: -allowed, maximum: allowed,
    }
  })
}

const screenWidth: Knob = {name: 'W', label: 'Screen width', low: 320, high: 1366, grid: 1 / 64, base: 390}
const screenHeight: Knob = {name: 'H', label: 'Screen height', low: 480, high: 1366, grid: 1 / 64, base: 844}

// A row in a contact list: a round avatar beside a name and a status line.
// As first written the avatar has only a width, 40, and the row's default
// alignItems, stretch, gives it the row's height: 40 at the default text
// size, where the name and status are 20 + 2 + 18 high, so it looked right.
// With larger or smaller text the avatar becomes an oval. Fixed: height: 40,
// or aspectRatio: 1, which Yoga applies before stretch, so the avatar stays
// 40 × 40. With aspectRatio: 1 and no width, it is square and as tall as the
// row: it grows with the text.
function contactRow(avatar: Style): Spec {
  const text = (name: string, height: number): Spec => ({name, measure: {width: {times: [name, 'fontScale']}, height: {times: [height, 'fontScale']}}})
  return {
    name: 'screen',
    children: [{
      name: 'row', style: {flexDirection: 'row', padding: 12, gap: 12},
      children: [
        {name: 'avatar', style: avatar},
        {name: 'details', style: {flexShrink: 1, gap: 2}, children: [text('name', 20), text('status', 18)]},
      ],
    }],
  }
}

type Variant = {id: string, label: string, expect: 'proven' | 'refuted', style: Style}

function contactVersion({id, label, expect, style}: Variant): Version {
  const spec = contactRow(style)
  const images: Image[] = [{name: 'avatar', width: 1, height: 1, says: 'The avatar', shape: 'round'}]
  return {
    id, label, expect,
    knobs: [
      screenWidth, screenHeight,
      {name: 'fontScale', label: 'Text size', low: 0.8125, high: 2, grid: 1 / 64, base: 1},
      {name: 'name', label: 'Name text', low: 0, high: 600, grid: 1 / 64, base: 110},
      {name: 'status', label: 'Status text', low: 0, high: 600, grid: 1 / 64, base: 150},
    ],
    scenes: c => [{name: 'screen', spec, width: c.input('W'), height: c.input('H')}],
    claims: (c, scenes) => aspectClaims(c, scenes['screen']!, images),
    roles: {screen: 'screen', row: 'surface', avatar: 'image', details: 'container', name: 'text', status: 'text'},
    texts: {
      name: [
        'Ada', 'Ada L.', 'Lovelace', 'A. Lovelace', 'Ada Lovelace', 'Ada K. Lovelace', 'Lady Ada Lovelace', 'Augusta Ada Lovelace',
        'Lady Augusta Ada Lovelace', 'Ada King, Countess of Lovelace', 'Augusta Ada King, Countess of Lovelace',
        'The Rt Hon. Augusta Ada King, Countess of Lovelace', 'The Right Honourable Augusta Ada King, Countess of Lovelace',
        'The Right Honourable Augusta Ada King-Noel, Countess of Lovelace (née Byron)',
      ],
      status: [
        'Away', 'Back Mon', 'Back Monday', 'Back on Monday', 'Away until Monday', 'Away, back on Monday', 'On leave, back on Monday',
        'Out of office, back on Monday', 'Out of office, back on Monday 14 April', 'Out of office this week, back on Monday 14 April',
        'Out of office on holiday this week, back on Monday 14 April',
        'Out of office on holiday this week with no signal, back on Monday 14 April',
        'Out of office on holiday this week with patchy signal, back at my desk on Monday 14 April',
      ],
    },
  }
}

// A row of three square photo thumbnails, from 336 × 336 px @3x assets, i.e.
// 112 × 112. As first written each is flex: 1 (flexGrow: 1, flexShrink: 1,
// flexBasis: 0), to share the row, and 114 high, which makes them square on
// the 390 wide phone it was designed on: (390 − 2 × 16 − 2 × 8) / 3 = 114.
// They are stretched on every wider screen and squashed on every narrower
// one. Fixed: 88 × 88, which fits three to a row on a 320 wide phone, spread
// with justifyContent: 'space-between', or, filling the row, flex: 1 with
// aspectRatio: 1 instead of the height.
function photoGrid(thumbStyle: Style, gridStyle: Style = {}): Spec {
  const thumb = (name: string): Spec => ({name, style: thumbStyle})
  return {
    name: 'screen',
    children: [
      {name: 'heading', style: {margin: {left: 16, top: 16}}, measure: {width: 'heading', height: 24}},
      {name: 'grid', style: {flexDirection: 'row', padding: 16, gap: 8, ...gridStyle},
        children: [thumb('photo1'), thumb('photo2'), thumb('photo3')]},
    ],
  }
}

function gridVersion({id, label, expect, style}: Variant, gridStyle?: Style): Version {
  const spec = photoGrid(style, gridStyle)
  const images: Image[] = ['photo1', 'photo2', 'photo3'].map((name, index) => ({name, width: 112, height: 112, says: `Photo ${index + 1}`, shape: 'square'}))
  return {
    id, label, expect,
    knobs: [
      screenWidth, screenHeight,
      {name: 'heading', label: 'Heading text', low: 0, high: 600, grid: 1 / 64, base: 120},
    ],
    scenes: c => [{name: 'screen', spec, width: c.input('W'), height: c.input('H')}],
    claims: (c, scenes) => aspectClaims(c, scenes['screen']!, images),
    roles: {screen: 'screen', heading: 'text', grid: 'container', photo1: 'image', photo2: 'image', photo3: 'image'},
    texts: {
      heading: [
        'Photos', 'New photos', 'Recent photos', 'My recent photos', 'Recently added photos', 'Your recently added photos',
        'Recent photos from your camera roll', 'Your recent photos from the last few days', 'Recent photos from your camera roll this past week',
        'Your most recent photos from your camera roll over the past week',
      ],
    },
  }
}

// React Native's flex: 1, with a fixed height or with aspectRatio: 1.
const flexOne = (height?: number): Style => ({flexGrow: 1, flexShrink: 1, flexBasis: 0, ...(height === undefined ? {aspectRatio: 1} : {height})})

export const check: Check = {
  id: 'image-aspect',
  title: 'Images keep their shape',
  question: 'Can an image ever be stretched or squashed out of its aspect ratio?',
  examples: [
    {id: 'contact-row', title: 'An avatar in a contact list', versions: [
      contactVersion({id: 'width-only', label: 'Avatar with width: 40 only', expect: 'refuted', style: {width: 40}}),
      contactVersion({id: 'fixed-height', label: 'Avatar with width: 40, height: 40', expect: 'proven', style: {width: 40, height: 40}}),
      contactVersion({id: 'aspect-ratio', label: 'Avatar with width: 40, aspectRatio: 1', expect: 'proven', style: {width: 40, aspectRatio: 1}}),
      contactVersion({id: 'aspect-ratio-grows', label: 'Avatar with aspectRatio: 1 only, growing with the text', expect: 'proven', style: {aspectRatio: 1}}),
    ]},
    {id: 'photo-grid', title: 'A row of photo thumbnails', versions: [
      gridVersion({id: 'flex-one', label: 'Thumbnails with flex: 1 and height: 114', expect: 'refuted', style: flexOne(114)}),
      gridVersion({id: 'fixed-size', label: 'Thumbnails 88 × 88', expect: 'proven', style: {width: 88, height: 88}}, {justifyContent: 'space-between'}),
      gridVersion({id: 'aspect-ratio', label: 'Thumbnails with flex: 1 and aspectRatio: 1', expect: 'proven', style: flexOne()}),
    ]},
  ],
}
