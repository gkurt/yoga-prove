// Labels that must be read in full: a form label, a price, a button's text.
// A measured leaf is a line of text that truncates: Yoga gives it at most a
// width, and it reports min(available, content). So it is cut off exactly
// when its laid-out width is less than its content width, the input. Each
// must-fit label gets the claim width - content >= 0, up to the tolerance,
// for every screen size and every label up to its stated length.
//
// Each version also makes the overflow check's claims about every box: a fix
// that keeps a label whole by pushing something else off the screen is no
// fix. (They also make the claims read every box that is drawn, which
// check.test.ts assumes when it numbers the exported claims.)
import {tolerance} from '../../claims.ts'
import type {Check, CheckClaim, Knob, Scene, Version} from '../../check.ts'
import {subtract, type LayoutCircuit, type Num} from '../../circuit.ts'
import type {Layout, Spec} from '../../yoga.ts'
import {overflowClaims} from '../overflow/check.ts'

const screen: Knob[] = [
  {name: 'W', label: 'Screen width', low: 320, high: 2560, grid: 1 / 64, base: 390},
  {name: 'H', label: 'Screen height', low: 480, high: 1600, grid: 1 / 64, base: 844},
]

// The box of that name, anywhere in the tree.
function find(box: Layout, name: string): Layout | undefined {
  if (box.name === name) return box
  for (const child of box.children) {
    const found = find(child, name)
    if (found !== undefined) return found
  }
  return undefined
}

function boxOf(scene: Scene, name: string): Layout {
  const box = find(scene.root, name)
  if (box === undefined) throw new Error(`no box ${name}`)
  return box
}

// The text is cut off when the space it gets, its width less its horizontal
// padding, is less than the text's own width.
function fits(c: LayoutCircuit, box: Layout, content: string, padding: number, says: string): CheckClaim {
  const space: Num = padding === 0 ? box.width : subtract(c, box.width, padding)
  return {name: `${box.name} fits its text`, wire: c.wireOf(subtract(c, space, c.input(content))), minimum: -tolerance, maximum: Infinity, says}
}


// A form row: a label and a 200 px text field. The developer gave the label
// flexShrink: 1 (with numberOfLines={1}) so that a long label doesn't push
// the field off the screen. On a phone that leaves the label 76 px, and
// "Email address" is cut to "Email add…". The fix moves flexShrink to the
// field, which may shrink to 120 px: with labels up to 150 px the row always
// fits, since 320 - 2 × 16 - 12 - 150 = 126.
function formRow(fixed: boolean): Spec {
  return {
    name: 'screen', style: {padding: 16},
    children: [{
      name: 'row', style: {flexDirection: 'row', alignItems: 'center', gap: 12},
      children: [
        {name: 'label', style: fixed ? {} : {flexShrink: 1}, measure: {width: 'label', height: 20}},
        {name: 'field', style: {width: 200, height: 44, ...(fixed ? {flexShrink: 1, minWidth: 120} : {})}},
      ],
    }],
  }
}

function formVersion(fixed: boolean): Version {
  return {
    id: fixed ? 'field-shrinks' : 'label-shrinks',
    label: fixed ? 'The field shrinks (flexShrink: 1, minWidth: 120)' : 'The label shrinks (flexShrink: 1)',
    expect: fixed ? 'proven' : 'refuted',
    knobs: [...screen, {name: 'label', label: 'Label text, up to 150 px', low: 0, high: 150, grid: 1 / 64, base: 104}],
    scenes: c => [{name: 'screen', spec: formRow(fixed), width: c.input('W'), height: c.input('H')}],
    claims: (c, scenes) => {
      const scene = scenes['screen']!
      return [
        fits(c, boxOf(scene, 'label'), 'label', 0, 'The field label is never cut off.'),
        ...overflowClaims(c, formRow(fixed), scene.root),
      ]
    },
    roles: {screen: 'screen', row: 'container', label: 'text', field: 'field'},
    texts: {
      label: ['Email', 'Email ID', 'Your email', 'Email address', 'Your email address'],
      field: 'name@example.com',
    },
  }
}

// A product row in a shopping list: a thumbnail, the product name, the
// price and an Add button. The name and the price share a text style with
// flex: 1 (in React Native, flexGrow: 1, flexShrink: 1, flexBasis: 0), so
// that a long name truncates instead of pushing the button off the screen.
// But flex: 1 on both splits the row's free space between them in half,
// whatever their text: on a phone, "$1,249.99" becomes "$1,2…" next to a
// short name with room to spare. The fix takes flex: 1 off the price, which
// then keeps its own width. On a 320 px screen the row has 320 - 2 × 16 =
// 288 px inside, the thumbnail and gaps take 84, so a price up to 96 px and
// a button text up to 72 px (plus its 32 px padding) leave the name at
// least 4 px.
function productRow(fixed: boolean): Spec {
  const flex1 = {flexGrow: 1, flexShrink: 1, flexBasis: 0}
  return {
    name: 'screen',
    children: [{
      name: 'row', style: {flexDirection: 'row', alignItems: 'center', padding: {left: 16, right: 16, top: 12, bottom: 12}, gap: 12},
      children: [
        {name: 'thumbnail', style: {width: 48, height: 48}},
        {name: 'name', style: flex1, measure: {width: 'name', height: 22}},
        {name: 'price', style: fixed ? {} : flex1, measure: {width: 'price', height: 22}},
        {name: 'add', style: {padding: {left: 16, right: 16, top: 10, bottom: 10}}, measure: {width: 'add', height: 20}},
      ],
    }],
  }
}

function productVersion(fixed: boolean): Version {
  return {
    id: fixed ? 'only-name-flexes' : 'name-and-price-flex',
    label: fixed ? 'Only the name has flex: 1' : 'Name and price both have flex: 1',
    expect: fixed ? 'proven' : 'refuted',
    knobs: [
      ...screen,
      {name: 'name', label: 'Product name, up to 1000 px', low: 0, high: 1000, grid: 1 / 64, base: 330},
      {name: 'price', label: 'Price text, up to 96 px', low: 0, high: 96, grid: 1 / 64, base: 68},
      {name: 'add', label: 'Button text, up to 72 px', low: 0, high: 72, grid: 1 / 64, base: 70},
    ],
    scenes: c => [{name: 'screen', spec: productRow(fixed), width: c.input('W'), height: c.input('H')}],
    claims: (c, scenes) => {
      const scene = scenes['screen']!
      return [
        fits(c, boxOf(scene, 'price'), 'price', 0, 'The price is never cut off.'),
        fits(c, boxOf(scene, 'add'), 'add', 32, 'The text on the Add button is never cut off.'),
        ...overflowClaims(c, productRow(fixed), scene.root),
      ]
    },
    roles: {screen: 'screen', row: 'surface', thumbnail: 'image', name: 'text', price: 'text', add: 'button'},
    texts: {
      name: [
        'Headset',
        'Headphones',
        'ANC headphones',
        'Wireless headphones',
        'Wireless ANC headphones',
        'Noise-cancelling headphones',
        'Wireless noise-cancelling headphones',
        'Wireless noise-cancelling headphones, blue',
        'Wireless noise-cancelling headphones, midnight blue',
        'Wireless noise-cancelling over-ear headphones, midnight blue',
        'Wireless noise-cancelling over-ear headphones, midnight blue, with carry case',
        'Wireless noise-cancelling over-ear headphones, 30-hour battery, midnight blue, with carry case',
        'Wireless noise-cancelling over-ear headphones with Bluetooth 5.3, 30-hour battery, midnight blue, with carry case',
      ],
      price: ['$9', '$49', '$129', '$9.99', '$49.99', '$249.99', '$1,249.99', '$12,499.99'],
      add: ['Add', '+ Add', 'Add item', 'Add to cart'],
    },
  }
}

export const check: Check = {
  id: 'labels-fit',
  title: 'Labels are never cut off',
  question: 'Can a label that must be read in full, such as a form label, a price or a button, ever get cut off, at any screen size and any label up to its stated length?',
  examples: [
    {id: 'form-row', title: 'A form row', versions: [formVersion(false), formVersion(true)]},
    {id: 'product-row', title: 'A product row', versions: [productVersion(false), productVersion(true)]},
  ],
}
