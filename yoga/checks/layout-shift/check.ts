// Layout shift: does something that loads later, a photo, an ad or a promo
// banner, move what the user is about to tap or read? Each version lays out
// the same screen twice from the same inputs, while it loads and once it has
// loaded, and claims that the chosen elements are at the same place in both,
// for every screen size and every loaded size in range.
import {tolerance} from '../../claims.ts'
import type {Check, CheckClaim, Knob, Scene, Version} from '../../check.ts'
import {add, subtract, type LayoutCircuit, type Num} from '../../circuit.ts'
import type {Layout, Spec} from '../../yoga.ts'

// A box's left and top in its scene, the sum of its offsets from the root.
function place(c: LayoutCircuit, scene: Scene, name: string): {left: Num, top: Num} {
  const find = (box: Layout, left: Num, top: Num): {left: Num, top: Num} | null => {
    const here = {left: add(c, left, box.left), top: add(c, top, box.top)}
    if (box.name === name) return here
    for (const child of box.children) {
      const found = find(child, here.left, here.top)
      if (found !== null) return found
    }
    return null
  }
  const found = find(scene.root, 0, 0)
  if (found === null) throw new Error(`no box ${name} in ${scene.name}`)
  return found
}

// The element doesn't move between the two scenes: its left and its top
// differ by at most the rounding tolerance.
export function staysPut(c: LayoutCircuit, scenes: Record<string, Scene>, name: string, label: string, event: string): CheckClaim[] {
  const before = place(c, scenes['loading']!, name)
  const after = place(c, scenes['loaded']!, name)
  return [
    {name: `${name} left unchanged`, says: `${label} doesn't move sideways ${event}`, wire: c.wireOf(subtract(c, after.left, before.left)), minimum: -tolerance, maximum: tolerance},
    {name: `${name} top unchanged`, says: `${label} doesn't move up or down ${event}`, wire: c.wireOf(subtract(c, after.top, before.top)), minimum: -tolerance, maximum: tolerance},
  ]
}

const screenWidth: Knob = {name: 'W', label: 'Screen width', low: 320, high: 1024, grid: 1 / 64, base: 390}
const screenHeight: Knob = {name: 'H', label: 'Screen height', low: 480, high: 1366, grid: 1 / 64, base: 844}

// The two scenes, from the same inputs: loading and loaded, each on its own
// screen.
function twoScenes(c: LayoutCircuit, spec: (loaded: boolean) => Spec, height: Num) {
  return [
    {name: 'loading', label: 'Loading', frame: 'loading', spec: spec(false), width: c.input('W'), height},
    {name: 'loaded', label: 'Loaded', frame: 'loaded', spec: spec(true), width: c.input('W'), height},
  ]
}

// A product page: the photo, the name, the price and Add to cart. The photo
// comes from the network, and its height is known once it has loaded; the
// first version sizes it by that height, so until then it takes no space and
// the button sits where the photo will be. The fix reserves the photo's
// space with a fixed height, and the photo is cropped to fill it.
function product(reserved: boolean): Spec[] {
  return [false, true].map((loaded): Spec => ({
    name: 'screen',
    children: [
      reserved
        ? {name: 'photo', style: {height: 320}, measure: {width: 'W', height: loaded ? 'photo' : 0}}
        : {name: 'photo', measure: {width: 'W', height: loaded ? 'photo' : 0}},
      {name: 'details', style: {padding: 16, gap: 8}, children: [
        {name: 'name', measure: {width: 'name', height: 24}},
        {name: 'price', measure: {width: 64, height: 28}},
        {name: 'add', style: {alignItems: 'center', padding: {top: 14, bottom: 14, left: 24, right: 24}, margin: {top: 8}}, children: [
          {name: 'label', measure: {width: 96, height: 20}},
        ]},
      ]},
    ],
  }))
}

function productVersion(reserved: boolean): Version {
  const [loading, loaded] = product(reserved)
  return {
    id: reserved ? 'reserved-photo' : 'photo-sized-by-image',
    label: reserved ? 'Photo with a fixed height of 320' : 'Photo as tall as the image',
    expect: reserved ? 'proven' : 'refuted',
    knobs: [
      screenWidth, screenHeight,
      {name: 'photo', label: 'Photo height once loaded', low: 160, high: 640, grid: 1 / 64, base: 390},
      {name: 'name', label: 'Product name', low: 0, high: 600, grid: 1 / 64, base: 220},
    ],
    scenes: c => twoScenes(c, isLoaded => isLoaded ? loaded! : loading!, c.input('H')),
    claims: (c, scenes) => [
      ...staysPut(c, scenes, 'add', 'Add to cart', 'when the photo loads'),
      ...staysPut(c, scenes, 'name', 'The product name', 'when the photo loads'),
    ],
    roles: {screen: 'screen', photo: 'image', details: 'container', name: 'text', price: 'text', add: 'button', label: 'text'},
    texts: {
      name: [
        'Shoes',
        'Runners',
        'Run shoes',
        'Trail shoes',
        'Trail runners',
        'Waterproof shoes',
        'Trail shoes, waterproof',
        'Trail running shoes, waterproof',
        "Trail running shoes, waterproof, men's",
        "Trail running shoes, waterproof, men's size 10",
        "Trail running shoes, waterproof, men's size 10, slate grey",
        "Lightweight trail running shoes, waterproof, men's size 10, slate grey",
      ],
      price: '$129', label: 'Add to cart',
    },
  }
}

// An article with an ad between the headline and the story. The ad network
// fills the slot after the page shows, with a banner 50 to 250 tall. The
// first version lets the slot be as tall as the ad, so it is empty while
// loading and the story jumps down when the ad arrives. The fix gives the
// slot a minimum height of the tallest ad it may get.
function article(reserved: boolean, loaded: boolean): Spec {
  return {
    name: 'screen', style: {padding: 16, gap: 12},
    children: [
      {name: 'headline', measure: {width: 'headline', height: 32}},
      {name: 'byline', measure: {width: 180, height: 18}},
      {name: 'slot', style: {alignItems: 'center', ...(reserved ? {minHeight: 250} : {})}, children: [
        {name: 'ad', measure: {width: 300, height: loaded ? 'ad' : 0}},
      ]},
      {name: 'story', measure: {width: 'story', height: 22}},
      {name: 'more', style: {alignSelf: 'flex-start', padding: {top: 10, bottom: 10, left: 16, right: 16}}, measure: {width: 120, height: 20}},
    ],
  }
}

function articleVersion(reserved: boolean): Version {
  return {
    id: reserved ? 'reserved-slot' : 'slot-sized-by-ad',
    label: reserved ? 'Ad slot with minHeight: 250' : 'Ad slot as tall as the ad',
    expect: reserved ? 'proven' : 'refuted',
    knobs: [
      screenWidth, screenHeight,
      {name: 'ad', label: 'Ad height', low: 50, high: 250, grid: 1 / 64, base: 100},
      {name: 'headline', label: 'Headline', low: 0, high: 900, grid: 1 / 64, base: 300},
      {name: 'story', label: 'First line of the story', low: 0, high: 900, grid: 1 / 64, base: 340},
    ],
    scenes: c => twoScenes(c, loaded => article(reserved, loaded), c.input('H')),
    claims: (c, scenes) => [
      ...staysPut(c, scenes, 'story', 'The story', 'when the ad loads'),
      ...staysPut(c, scenes, 'more', 'Read more', 'when the ad loads'),
    ],
    roles: {screen: 'screen', headline: 'text', byline: 'text', slot: 'container', ad: 'image', story: 'text', more: 'button'},
    texts: {
      headline: [
        "Park OK'd",
        'Park approved',
        'Council OKs park',
        'Council approves park',
        'Council approves new park',
        'Council approves riverside park',
        'City council approves riverside park',
        'City council approves the new riverside park',
        'City council votes to approve the new riverside park',
        'City council approves the new riverside park on the old freight yard site',
      ],
      byline: 'By Dana Ortiz, 2 hours ago',
      story: [
        'The plan',
        'The plan turns',
        'The plan turns the',
        'The plan turns the old',
        'The plan turns the old freight',
        'The plan turns the old freight yard into',
        'The plan turns the old freight yard into eleven acres',
        'The plan turns the old freight yard into eleven acres of lawns,',
        'The plan turns the old freight yard into eleven acres of lawns, wetlands',
        'The plan turns the old freight yard into eleven acres of lawns, wetlands and play areas,',
        'The plan turns the old freight yard into eleven acres of lawns, wetlands and play areas, opening in the spring of 2028.',
      ],
      more: 'Read more',
    },
  }
}

// A checkout screen: the order, a promo banner that arrives from the server,
// and Pay pinned to the bottom. The first version pins Pay by letting the
// order grow (flexGrow: 1). That holds while the order fits; on a short
// screen the order is taller than the space, doesn't shrink, and the banner
// pushes Pay down. The fix gives the order flexBasis: 0, which is what
// `flex: 1` sets in React Native: the order takes exactly the space above
// Pay and scrolls, whatever it holds.
function checkout(fixed: boolean, loaded: boolean): Spec {
  const item = (name: string): Spec => ({name, style: {flexDirection: 'row', alignItems: 'center', height: 72, gap: 12}, children: [
    {name: `${name} photo`, style: {width: 56, height: 56}},
    {name: `${name} title`, style: {flexGrow: 1, flexShrink: 1}, measure: {width: `${name}`, height: 20}},
    {name: `${name} price`, measure: {width: 56, height: 20}},
  ]})
  return {
    name: 'screen', style: {padding: 16, gap: 12},
    children: [
      {name: 'order', style: {flexGrow: 1, ...(fixed ? {flexBasis: 0} : {}), gap: 12}, children: [
        {name: 'title', measure: {width: 120, height: 32}},
        item('first'), item('second'), item('third'),
        {name: 'delivery', style: {padding: 12, gap: 4}, children: [
          {name: 'delivery title', measure: {width: 140, height: 20}},
          {name: 'address', measure: {width: 'address', height: 40}},
        ]},
        {name: 'banner', measure: {width: 'W', height: loaded ? 'banner' : 0}},
      ]},
      {name: 'pay', style: {alignItems: 'center', padding: 14}, children: [
        {name: 'total', measure: {width: 140, height: 20}},
      ]},
    ],
  }
}

function checkoutVersion(fixed: boolean): Version {
  return {
    id: fixed ? 'order-flex-basis-0' : 'order-grows',
    label: fixed ? 'Order with flexGrow: 1 and flexBasis: 0' : 'Order with flexGrow: 1',
    expect: fixed ? 'proven' : 'refuted',
    knobs: [
      screenWidth, screenHeight,
      {name: 'banner', label: 'Promo banner height', low: 48, high: 160, grid: 1 / 64, base: 96},
      {name: 'first', label: 'First item name', low: 0, high: 400, grid: 1 / 64, base: 180},
      {name: 'second', label: 'Second item name', low: 0, high: 400, grid: 1 / 64, base: 140},
      {name: 'third', label: 'Third item name', low: 0, high: 400, grid: 1 / 64, base: 200},
      {name: 'address', label: 'Delivery address', low: 0, high: 600, grid: 1 / 64, base: 260},
    ],
    scenes: c => twoScenes(c, loaded => checkout(fixed, loaded), c.input('H')),
    claims: (c, scenes) => staysPut(c, scenes, 'pay', 'Pay', 'when the promo banner loads'),
    roles: {
      'screen': 'screen', 'order': 'container', 'title': 'text', 'banner': 'image', 'pay': 'button', 'total': 'text',
      'first': 'container', 'first photo': 'image', 'first title': 'text', 'first price': 'text',
      'second': 'container', 'second photo': 'image', 'second title': 'text', 'second price': 'text',
      'third': 'container', 'third photo': 'image', 'third title': 'text', 'third price': 'text',
      'delivery': 'surface', 'delivery title': 'text', 'address': 'text',
    },
    texts: {
      'title': 'Your order', 'total': 'Pay $86.40',
      'delivery title': 'Deliver to', 'address': [
        'Harbour St',
        '14 Harbour St',
        '14 Harbour St, 3B',
        '14 Harbour Street, 3B',
        '14 Harbour Street, Apt 3B',
        '14 Harbour Street, Apartment 3B',
        '14 Harbour Street, Apartment 3B, Bristol',
      ],
      'first title': [
        'Milk',
        'Oat milk',
        'Oat milk 1L',
        'Oat milk, 1 l',
        'Oat milk, 1 litre',
        'Oat milk, 1 litre carton',
        'Barista oat milk, 1 litre carton',
        'Barista oat milk, unsweetened, 1 litre carton',
        'Barista oat milk, unsweetened, 1 litre carton, chilled',
      ],
      'first price': '$3.20',
      'second title': [
        'Bread',
        'Sourdough',
        'Sourdough loaf',
        'Sourdough, 800 g',
        'Sourdough loaf, 800 g',
        'Sourdough loaf, sliced, 800 g',
        'White sourdough loaf, sliced, 800 g',
        'Stone-baked white sourdough loaf, sliced, 800 g',
        'Stone-baked white sourdough loaf, thick sliced, 800 g',
      ],
      'second price': '$6.50',
      'third title': [
        'Coffee',
        'Coffee beans',
        'Coffee beans, 250 g',
        'Coffee beans, medium roast',
        'Coffee beans, medium roast, 250 g',
        'Colombian coffee beans, medium roast, 250 g',
        'Colombian whole coffee beans, medium roast, 250 g bag',
      ],
      'third price': '$14.90',
    },
  }
}

export const check: Check = {
  id: 'layout-shift',
  title: 'Nothing moves when content loads',
  question: 'Can content that loads later, such as a photo, an ad or a banner, push what the user is about to tap or read?',
  examples: [
    {id: 'product', title: 'A product page with a photo', versions: [productVersion(false), productVersion(true)]},
    {id: 'article', title: 'An article with an ad', versions: [articleVersion(false), articleVersion(true)]},
    {id: 'checkout', title: 'A checkout with Pay at the bottom', versions: [checkoutVersion(false), checkoutVersion(true)]},
  ],
}
