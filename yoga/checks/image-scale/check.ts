// Images drawn no larger than their native size: an image whose box is wider
// or taller than its pixels is scaled up and looks blurry, whatever its
// resizeMode ('cover' scales by the larger of the two ratios, 'contain' and
// 'stretch' by each). Native sizes are in points, e.g. a @3x asset of 1125 ×
// 450 px is 375 × 150, and are knobs when the image comes from a server.
import type {Check, CheckClaim, Knob, Overlay, Scene, Version} from '../../check.ts'
import {add, subtract, type LayoutCircuit, type Num} from '../../circuit.ts'
import {tolerance} from '../../claims.ts'
import {amountOf, type Amount, type Layout, type Spec} from '../../yoga.ts'

// A box by name, with its position on the screen: the scene's place plus the
// offsets of every box above it.
export function place(c: LayoutCircuit, scene: Scene, name: string): {box: Layout, x: Num, y: Num} {
  const search = (box: Layout, x: Num, y: Num): {box: Layout, x: Num, y: Num} | undefined => {
    const left = add(c, x, box.left)
    const top = add(c, y, box.top)
    if (box.name === name) return {box, x: left, y: top}
    for (const child of box.children) {
      const found = search(child, left, top)
      if (found !== undefined) return found
    }
    return undefined
  }
  const found = search(scene.root, scene.x, scene.y)
  if (found === undefined) throw new Error(`no box ${name} in ${scene.name}`)
  return found
}

// An image: its box's name, its native size, and what it is in words, e.g.
// "The photo".
type Image = {name: string, width: Amount, height: Amount, says: string}

function scaleClaims(c: LayoutCircuit, scene: Scene, images: Image[]): CheckClaim[] {
  return images.flatMap(image => {
    const {box} = place(c, scene, image.name)
    return [
      {name: `${image.name} width <= native`, says: `${image.says} is never drawn wider than its native width`,
        wire: c.wireOf(subtract(c, box.width, amountOf(c, image.width))), minimum: -Infinity, maximum: tolerance},
      {name: `${image.name} height <= native`, says: `${image.says} is never drawn taller than its native height`,
        wire: c.wireOf(subtract(c, box.height, amountOf(c, image.height))), minimum: -Infinity, maximum: tolerance},
    ]
  })
}

function nativeOverlays(c: LayoutCircuit, scene: Scene, images: Image[]): Overlay[] {
  return images.map(image => {
    const {x, y} = place(c, scene, image.name)
    return {name: `${image.name} native`, role: 'native', label: 'Native size', rect: [x, y, amountOf(c, image.width), amountOf(c, image.height)]}
  })
}

const screenWidth: Knob = {name: 'W', label: 'Screen width', low: 320, high: 1366, grid: 1 / 64, base: 390}
const screenHeight: Knob = {name: 'H', label: 'Screen height', low: 480, high: 1366, grid: 1 / 64, base: 844}

// A photo sent in a chat, in a bubble as wide as its content, at most 280,
// with a caption under it. The photo's size comes with the message. As first
// written the photo takes the bubble's default alignItems, stretch, so a
// small photo with a long caption is stretched to the caption's width. Fixed:
// alignSelf: 'flex-start', so the photo is at most its native width, and
// narrower only when the bubble is.
function chatPhoto(fixed: boolean): Spec {
  return {
    name: 'screen', style: {padding: 16},
    children: [{
      name: 'bubble', style: {alignSelf: 'flex-start', maxWidth: 280, padding: 8, gap: 6},
      children: [
        {name: 'photo', ...(fixed ? {style: {alignSelf: 'flex-start'}} : {}), measure: {width: 'photoW', height: 'photoH'}},
        {name: 'caption', measure: {width: 'caption', height: 20}},
      ],
    }],
  }
}

const chatImages: Image[] = [{name: 'photo', width: 'photoW', height: 'photoH', says: 'The photo'}]

function chatVersion(fixed: boolean): Version {
  const spec = chatPhoto(fixed)
  return {
    id: fixed ? 'align-start' : 'stretched',
    label: fixed ? "Photo with alignSelf: 'flex-start'" : 'Photo stretched to the bubble (default alignItems)',
    expect: fixed ? 'proven' : 'refuted',
    knobs: [
      screenWidth, screenHeight,
      {name: 'photoW', label: 'Photo width', low: 16, high: 2000, grid: 1 / 64, base: 240},
      {name: 'photoH', label: 'Photo height', low: 16, high: 2000, grid: 1 / 64, base: 180},
      {name: 'caption', label: 'Caption text', low: 0, high: 1000, grid: 1 / 64, base: 120},
    ],
    scenes: c => [{name: 'screen', spec, width: c.input('W'), height: c.input('H')}],
    claims: (c, scenes) => scaleClaims(c, scenes['screen']!, chatImages),
    overlays: (c, scenes) => nativeOverlays(c, scenes['screen']!, chatImages),
    roles: {screen: 'screen', bubble: 'surface', photo: 'image', caption: 'text'},
    texts: {
      caption: [
        'Swimming!', 'First swim!', 'She can swim!', 'Learned to swim!', 'Look who can swim now', 'Look who learned to swim', 'Look who learned to swim at last',
        'Look who learned to swim this weekend', 'Look who learned to swim this weekend at the lake',
        'Look who learned to swim this weekend at the lake, without armbands',
        'Look who learned to swim this weekend at the lake with Grandpa, without any armbands',
        'Look who learned to swim this weekend at the lake with Grandpa, without any armbands, and didn\'t want to get out',
        'Look who learned to swim this weekend at the lake with Grandpa, without any armbands, and then didn\'t want to get out of the water',
      ],
    },
  }
}

// A full-width banner at the top of a screen, 150 high, from a @3x asset of
// 1125 × 450 px, i.e. 375 × 150. It fills the iPhone it was designed on;
// stretched across the screen's width, it is scaled up on every wider phone
// and 3.6 times on a 1366 wide tablet. Fixed: maxWidth: 375.
const banner = {width: 375, height: 150}

function bannerScreen(fixed: boolean): Spec {
  return {
    name: 'screen',
    children: [
      {name: 'banner', style: {height: banner.height, ...(fixed ? {maxWidth: banner.width} : {})}},
      {name: 'content', style: {padding: 16, gap: 8}, children: [
        {name: 'title', measure: {width: 'title', height: 28}},
        {name: 'body', measure: {width: 'body', height: 60}},
      ]},
    ],
  }
}

const bannerImages: Image[] = [{name: 'banner', ...banner, says: 'The banner'}]

function bannerVersion(fixed: boolean): Version {
  const spec = bannerScreen(fixed)
  return {
    id: fixed ? 'max-width' : 'full-width',
    label: fixed ? 'Banner with maxWidth: 375' : 'Banner as wide as the screen',
    expect: fixed ? 'proven' : 'refuted',
    knobs: [
      screenWidth, screenHeight,
      {name: 'title', label: 'Title text', low: 0, high: 1000, grid: 1 / 64, base: 220},
      {name: 'body', label: 'Body text', low: 0, high: 1000, grid: 1 / 64, base: 300},
    ],
    scenes: c => [{name: 'screen', spec, width: c.input('W'), height: c.input('H')}],
    claims: (c, scenes) => scaleClaims(c, scenes['screen']!, bannerImages),
    overlays: (c, scenes) => nativeOverlays(c, scenes['screen']!, bannerImages),
    roles: {screen: 'screen', banner: 'image', content: 'container', title: 'text', body: 'text'},
    texts: {
      title: [
        'Sale', 'Sale!', 'Big sale', 'Summer sale', 'Our summer sale', 'Summer sale now on', 'Summer sale is now on', 'The summer sale is now on', 'Our big summer sale is now on',
        'The big summer sale is on until Sunday', 'Our big summer sale is on now until Sunday night',
        'Our big summer sale is on now, with deals until Sunday night',
        'Our big summer sale is on now, with deals across the store until Sunday night',
        'Our big summer sale is on now, with deals across the whole store and online until Sunday night',
      ],
      body: [
        '30% off', 'Now 30% off', 'Outdoor 30% off', '30% off outdoor gear', '30% off all outdoor gear', 'Outdoor range 30% off till Sunday',
        'The outdoor range is 30% off until Sunday', 'Everything in the outdoor range, 30% off until Sunday.',
      ],
    },
  }
}

export const check: Check = {
  id: 'image-scale',
  title: 'Images stay sharp',
  question: 'Can an image ever be drawn larger than its native size, so it looks blurry?',
  examples: [
    {id: 'chat-photo', title: 'A photo in a chat bubble', versions: [chatVersion(false), chatVersion(true)]},
    {id: 'banner', title: 'A banner at the top of a screen', versions: [bannerVersion(false), bannerVersion(true)]},
  ],
}
