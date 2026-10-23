// The safe-areas check: the controls and text of a screen stay clear of the
// bands the system draws over, for every size of those bands: the status bar
// and the notch or Dynamic Island at the top, the home indicator at the
// bottom, and in landscape the notch's side.
//
// Yoga doesn't know about the insets either. A SafeAreaView lays its content
// out in the screen less the insets, so each version's scene is the app laid
// out where the app puts it: the whole screen, or the safe area, at x = left
// inset and y = top inset, its size reduced by the insets. The claims compare
// the laid-out boxes with the bands' edges.
import {tolerance} from '../../claims.ts'
import type {Check, CheckClaim, Knob, Overlay, Scene, SceneSpec, Version} from '../../check.ts'
import {add, subtract, type LayoutCircuit, type Num} from '../../circuit.ts'
import type {Layout, Spec} from '../../yoga.ts'

// A box's edges on the screen: the scene's position plus each ancestor's
// offset, found by name.
function placed(c: LayoutCircuit, scene: Scene, name: string) {
  const visit = (box: Layout, x: Num, y: Num): {left: Num, top: Num, right: Num, bottom: Num} | undefined => {
    const left = add(c, x, box.left)
    const top = add(c, y, box.top)
    if (box.name === name) return {left, top, right: add(c, left, box.width), bottom: add(c, top, box.height)}
    for (const child of box.children) {
      const found = visit(child, left, top)
      if (found !== undefined) return found
    }
    return undefined
  }
  const found = visit(scene.root, scene.x, scene.y)
  if (found === undefined) throw new Error(`no box ${name} in ${scene.name}`)
  return found
}

type Side = 'top' | 'bottom' | 'left' | 'right'
// Each side's inset input; a side without one has no band.
type Insets = Partial<Record<Side, string>>

const bandWords: Record<Side, string> = {
  top: 'stays below the status bar and the notch',
  bottom: 'stays above the home indicator',
  left: 'stays clear of the notch on the left',
  right: 'stays clear of the notch on the right',
}

// That a box is clear of the band on one side: e.g. its top at or below the
// top inset, its bottom at or above the screen height less the bottom inset.
function clear(c: LayoutCircuit, scene: Scene, name: string, words: string, side: Side, insets: Insets): CheckClaim {
  const box = placed(c, scene, name)
  const inset = c.input(insets[side]!)
  const value = side === 'top' ? subtract(c, box.top, inset)
    : side === 'left' ? subtract(c, box.left, inset)
    : side === 'bottom' ? subtract(c, box.bottom, subtract(c, c.input('H'), inset))
    : subtract(c, box.right, subtract(c, c.input('W'), inset))
  const low = side === 'top' || side === 'left'
  return {name: `${name} clear of ${side}`, says: `${words} ${bandWords[side]}`, wire: c.wireOf(value), minimum: low ? -tolerance : -Infinity, maximum: low ? Infinity : tolerance}
}

// The bands, drawn over the screen.
function bands(c: LayoutCircuit, insets: Insets, labels: Partial<Record<Side, string>>): Overlay[] {
  const W = c.input('W')
  const H = c.input('H')
  const overlays: Overlay[] = []
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    if (insets[side] === undefined) continue
    const size = c.input(insets[side])
    const rect: [Num, Num, Num, Num] = side === 'top' ? [0, 0, W, size]
      : side === 'bottom' ? [0, subtract(c, H, size), W, size]
      : side === 'left' ? [0, 0, size, H]
      : [subtract(c, W, size), 0, size, H]
    overlays.push({name: `${side} inset`, role: 'inset', label: labels[side] ?? side, rect})
  }
  return overlays
}

// The app's scene, inside the given sides' insets, and the screen behind it.
function appScene(c: LayoutCircuit, spec: Spec, insets: Insets, inside: Side[], label: string): SceneSpec[] {
  const inset = (side: Side): Num => inside.includes(side) ? c.input(insets[side]!) : 0
  return [
    {name: 'device', label: 'Screen', frame: 'phone', spec: {name: 'device'}, width: c.input('W'), height: c.input('H')},
    {
      name: 'app', label, frame: 'phone', spec,
      x: inset('left'), y: inset('top'),
      width: subtract(c, subtract(c, c.input('W'), inset('left')), inset('right')),
      height: subtract(c, subtract(c, c.input('H'), inset('top')), inset('bottom')),
    },
  ]
}

// Phones in portrait: 320 to 430 wide, 568 to 932 tall. The top inset is 20
// on phones with a plain status bar, 44 to 50 under a notch and 54 to 59
// under the Dynamic Island; on Android, 24 to about 52. The bottom inset is 0
// on phones with a home button and 34 above the home indicator; Android's
// gesture bar is 16 to 24.
const portrait: Knob[] = [
  {name: 'W', low: 320, high: 430, grid: 1 / 64, base: 393, label: 'Screen width'},
  {name: 'H', low: 568, high: 932, grid: 1 / 64, base: 852, label: 'Screen height'},
  {name: 'T', low: 20, high: 59, grid: 1 / 64, base: 59, label: 'Top inset'},
  {name: 'B', low: 0, high: 34, grid: 1 / 64, base: 34, label: 'Bottom inset'},
]
const portraitInsets: Insets = {top: 'T', bottom: 'B'}
const portraitLabels = {top: 'Status bar and notch', bottom: 'Home indicator'}

// A header: back, a title that takes the rest (`flex: 1`), and an action. As
// first written, it leaves room for the status bar with paddingTop: 20 and a
// height of 64, which is right on iPhones before the iPhone X, and the app
// isn't in a SafeAreaView. Fixed, the app is in one and the header is 44
// tall without the padding.
function header(fixed: boolean): Spec {
  return {
    name: 'app',
    children: [
      {name: 'header', style: {flexDirection: 'row', alignItems: 'center', height: fixed ? 44 : 64, padding: {top: fixed ? 0 : 20, left: 8, right: 8}, gap: 8}, children: [
        {name: 'back', style: {width: 44, height: 44}},
        {name: 'title', style: {flexGrow: 1, flexShrink: 1, flexBasis: 0}, measure: {width: 'title', height: 22}},
        {name: 'action', style: {padding: 12}, measure: {width: 'action', height: 20}},
      ]},
      {name: 'content', style: {flexGrow: 1, flexShrink: 1, flexBasis: 0, padding: 16}, children: [
        {name: 'summary', measure: {width: 'summary', height: 20}},
      ]},
    ],
  }
}

function headerVersion(fixed: boolean): Version {
  return {
    id: fixed ? 'safe-area-view' : 'padding-top-20',
    label: fixed ? 'In a SafeAreaView' : 'paddingTop: 20 for the status bar',
    expect: fixed ? 'proven' : 'refuted',
    knobs: [
      ...portrait,
      {name: 'title', low: 0, high: 600, grid: 1 / 64, base: 140, label: 'Title text'},
      {name: 'action', low: 0, high: 120, grid: 1 / 64, base: 34, label: 'Action label'},
      {name: 'summary', low: 0, high: 1000, grid: 1 / 64, base: 300, label: 'Summary text'},
    ],
    scenes: c => appScene(c, header(fixed), portraitInsets, fixed ? ['top', 'bottom'] : [], fixed ? 'Safe area' : 'Whole screen'),
    claims: (c, scenes) => {
      const app = scenes['app']!
      return [
        clear(c, app, 'back', 'The back button', 'top', portraitInsets),
        clear(c, app, 'title', 'The title', 'top', portraitInsets),
        clear(c, app, 'action', 'The Edit button', 'top', portraitInsets),
        clear(c, app, 'summary', 'The first line of the page', 'top', portraitInsets),
      ]
    },
    overlays: c => bands(c, portraitInsets, portraitLabels),
    roles: {device: 'screen', app: 'surface', header: 'surface', back: 'icon', title: 'text', action: 'button', content: 'container', summary: 'text'},
    texts: {
      title: [
        'Album',
        'Our album',
        'Shared album',
        'Our shared album',
        'Shared family album',
        'Shared album: Lisbon trip',
        'Shared album: Lisbon trip 2025',
        'Shared album: Lisbon trip, June 2025',
        'Shared album: Lisbon trip, 9 to 16 June 2025',
        'Shared album: Lisbon trip with the family, June 2025',
        'Shared album: Lisbon trip with Ana, Ben and the kids, June 2025',
        'Shared album: Lisbon trip with Ana, Ben, Chloe and the kids, 9 to 16 June 2025',
      ],
      action: ['Edit', 'Manage', 'Edit album', 'Edit this album', 'Edit album details'],
      summary: [
        '133 items',
        '133 shared items',
        '124 photos, 9 videos',
        '124 photos and 9 videos',
        '124 photos, 9 videos, 4 people',
        '124 photos and 9 videos, 4 people',
        '124 photos and 9 videos, shared with 4 people',
        '124 photos and 9 videos, shared with Ana, Ben, Chloe and you',
        '124 photos and 9 videos from Lisbon, shared with Ana, Ben, Chloe and you',
        '124 photos and 9 videos from the Lisbon trip, shared with Ana, Ben, Chloe and you',
        '124 photos and 9 videos from the Lisbon trip, shared with Ana, Ben, Chloe and you since 14 June 2025',
        '124 photos and 9 videos from the Lisbon trip, shared with Ana, Ben, Chloe and you since 14 June 2025, last added to by Ben yesterday',
      ],
    },
  }
}

// A tab bar under a feed: four tabs of equal width (`flex: 1`), each an icon
// over a label. As first written, the app is in a SafeAreaView with
// edges={['top']}: the notch was handled, the home indicator forgotten. Fixed,
// the bottom edge is in the safe area too.
const tabs = ['home', 'search', 'inbox', 'profile'] as const
const tabBar: Spec = {
  name: 'app',
  children: [
    {name: 'feed', style: {flexGrow: 1, flexShrink: 1, flexBasis: 0, padding: 16}, children: [
      {name: 'headline', measure: {width: 'headline', height: 28}},
    ]},
    {name: 'tabs', style: {flexDirection: 'row'}, children: tabs.map((tab): Spec => ({
      name: tab, style: {flexGrow: 1, flexShrink: 1, flexBasis: 0, alignItems: 'center', padding: {top: 6, bottom: 6}, gap: 2},
      children: [
        {name: `${tab} icon`, style: {width: 24, height: 24}},
        {name: `${tab} label`, measure: {width: tab, height: 14}},
      ],
    }))},
  ],
}
const tabWords = {home: 'Home', search: 'Search', inbox: 'Inbox', profile: 'Profile'}
// Each label from its shortest wording to its longest.
const tabTexts = {
  home: ['Home', 'My home', 'Home feed', 'Your home feed', 'Home feed and news', 'Your home feed and news'],
  search: ['Find', 'Search', 'Search all', 'Search posts', 'Search everything', 'Search posts and people'],
  inbox: ['Inbox', 'My inbox', 'Your inbox', 'Your messages', 'Your message inbox', 'Your inbox and messages'],
  profile: ['Profile', 'My profile', 'Your profile', 'Profile & settings', 'Your profile and settings'],
}

function tabBarVersion(fixed: boolean): Version {
  return {
    id: fixed ? 'top-and-bottom' : 'top-edge-only',
    label: fixed ? 'SafeAreaView with the top and bottom edges' : 'SafeAreaView with edges={[\'top\']}',
    expect: fixed ? 'proven' : 'refuted',
    knobs: [
      ...portrait,
      {name: 'headline', low: 0, high: 1000, grid: 1 / 64, base: 160, label: 'Headline text'},
      ...tabs.map((tab): Knob => ({name: tab, low: 0, high: 120, grid: 1 / 64, base: 40, label: `${tabWords[tab]} label`})),
    ],
    scenes: c => appScene(c, tabBar, portraitInsets, fixed ? ['top', 'bottom'] : ['top'], fixed ? 'Safe area' : 'Below the top inset'),
    claims: (c, scenes) => {
      const app = scenes['app']!
      return [
        clear(c, app, 'headline', 'The headline', 'top', portraitInsets),
        ...tabs.flatMap(tab => [
          clear(c, app, tab, `The ${tabWords[tab]} tab`, 'bottom', portraitInsets),
          clear(c, app, `${tab} label`, `The ${tabWords[tab]} label`, 'bottom', portraitInsets),
        ]),
      ]
    },
    overlays: c => bands(c, portraitInsets, portraitLabels),
    roles: {
      device: 'screen', app: 'surface', feed: 'container', headline: 'text', tabs: 'surface',
      ...Object.fromEntries(tabs.flatMap(tab => [[tab, 'button'], [`${tab} icon`, 'icon'], [`${tab} label`, 'text']])),
    },
    texts: {headline: [
      'Morning',
      'Good morning',
      'Good morning, Ana',
      'Good morning, Ana Silva',
      'Good morning, Ana. Welcome back',
      'Good morning, Ana. Here\'s what\'s new today',
      'Good morning, Ana. Here\'s what\'s new in your feed today',
      'Good morning, Ana. Here\'s what\'s new in your feed since yesterday evening',
      'Good morning, Ana. Here are 12 new posts and 3 messages from people you follow since last night',
    ], ...Object.fromEntries(tabs.map(tab => [`${tab} label`, tabTexts[tab]]))},
  }
}

// Phones in landscape: 568 to 932 wide, 320 to 430 tall. The notch's side
// has an inset of 44 to 59 and iOS insets the other side as much; phones
// without a notch have none, so each side is 0 to 59. The home indicator's
// inset is 21 in landscape, 0 without one.
const landscape: Knob[] = [
  {name: 'W', low: 568, high: 932, grid: 1 / 64, base: 852, label: 'Screen width'},
  {name: 'H', low: 320, high: 430, grid: 1 / 64, base: 393, label: 'Screen height'},
  {name: 'L', low: 0, high: 59, grid: 1 / 64, base: 59, label: 'Left inset'},
  {name: 'R', low: 0, high: 59, grid: 1 / 64, base: 59, label: 'Right inset'},
  {name: 'B', low: 0, high: 21, grid: 1 / 64, base: 21, label: 'Bottom inset'},
  {name: 'elapsed', low: 0, high: 60, grid: 1 / 64, base: 30, label: 'Elapsed time text'},
  {name: 'remaining', low: 0, high: 60, grid: 1 / 64, base: 36, label: 'Remaining time text'},
]
const landscapeInsets: Insets = {left: 'L', right: 'R', bottom: 'B'}

// A video player's controls along the bottom of the video: play, the
// elapsed time, the scrubber, which takes the rest (`flex: 1`), the time
// remaining, and full screen. As first written, the player fills the screen
// with its controls 12 px from the edges. Fixed, the controls are in a
// SafeAreaView; the video can still fill the screen behind them.
const player: Spec = {
  name: 'app', style: {justifyContent: 'flex-end'},
  children: [
    {name: 'controls', style: {flexDirection: 'row', alignItems: 'center', height: 48, padding: {left: 12, right: 12}, gap: 12}, children: [
      {name: 'play', style: {width: 32, height: 32}},
      {name: 'elapsed', measure: {width: 'elapsed', height: 16}},
      {name: 'scrubber', style: {flexGrow: 1, flexShrink: 1, flexBasis: 0, height: 4}},
      {name: 'remaining', measure: {width: 'remaining', height: 16}},
      {name: 'fullscreen', style: {width: 32, height: 32}},
    ]},
  ],
}

function playerVersion(fixed: boolean): Version {
  return {
    id: fixed ? 'safe-area-view' : 'whole-screen',
    label: fixed ? 'Controls in a SafeAreaView' : 'Controls over the whole screen',
    expect: fixed ? 'proven' : 'refuted',
    knobs: landscape,
    scenes: c => {
      const [device, app] = appScene(c, player, landscapeInsets, fixed ? ['left', 'right', 'bottom'] : [], fixed ? 'Safe area' : 'Whole screen')
      return [device!, {name: 'video', label: 'Video', frame: 'phone', spec: {name: 'video'}, width: c.input('W'), height: c.input('H')}, app!]
    },
    claims: (c, scenes) => {
      const app = scenes['app']!
      return [
        clear(c, app, 'play', 'The play button', 'left', landscapeInsets),
        clear(c, app, 'play', 'The play button', 'bottom', landscapeInsets),
        clear(c, app, 'elapsed', 'The elapsed time', 'left', landscapeInsets),
        clear(c, app, 'elapsed', 'The elapsed time', 'bottom', landscapeInsets),
        clear(c, app, 'remaining', 'The time remaining', 'right', landscapeInsets),
        clear(c, app, 'remaining', 'The time remaining', 'bottom', landscapeInsets),
        clear(c, app, 'fullscreen', 'The full-screen button', 'right', landscapeInsets),
        clear(c, app, 'fullscreen', 'The full-screen button', 'bottom', landscapeInsets),
      ]
    },
    overlays: c => bands(c, landscapeInsets, {left: 'Notch side', right: 'Notch side', bottom: 'Home indicator'}),
    roles: {device: 'screen', video: 'image', app: 'container', controls: 'surface', play: 'button', elapsed: 'text', scrubber: 'surface', remaining: 'text', fullscreen: 'button'},
    texts: {elapsed: ['4:05', '12:04', '1:12:04', '11:12:04'], remaining: ['-5:56', '-31:56', '-1:31:56', '-11:31:56']},
  }
}

export const check: Check = {
  id: 'safe-areas',
  title: 'Clear of the notch',
  question: 'Do buttons and text stay clear of the notch, the status bar and the home indicator, for any size of them?',
  examples: [
    {id: 'header', title: 'A header', versions: [headerVersion(false), headerVersion(true)]},
    {id: 'tab-bar', title: 'A tab bar', versions: [tabBarVersion(false), tabBarVersion(true)]},
    {id: 'player', title: 'Video controls in landscape', versions: [playerVersion(false), playerVersion(true)]},
  ],
}
