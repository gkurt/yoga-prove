// Design rules: equal buttons stay equal, a centered title stays centered on
// the screen, and the values in a list share one left edge, for every screen
// size and text length. Each rule is an equality between two laid-out
// positions or sizes, allowed to differ by 2^-10 px of FP32 rounding.
import type {Check, CheckClaim, Knob, Overlay, Scene, Version} from '../../check.ts'
import {add, divide, subtract, type LayoutCircuit, type Num} from '../../circuit.ts'
import {tolerance} from '../../claims.ts'
import type {Layout, Spec} from '../../yoga.ts'

const screen: Knob[] = [
  {name: 'W', low: 320, high: 2560, grid: 1 / 64, base: 390, label: 'Screen width'},
  {name: 'H', low: 480, high: 1600, grid: 1 / 64, base: 844, label: 'Screen height'},
]

// A box by name, with its position on the screen: the sum of the offsets of
// it and every box above it, each relative to its parent.
export function locate(c: LayoutCircuit, scene: Scene, name: string): {box: Layout, left: Num, top: Num} {
  const visit = (box: Layout, left: Num, top: Num): {box: Layout, left: Num, top: Num} | undefined => {
    const here = {box, left: add(c, left, box.left), top: add(c, top, box.top)}
    if (box.name === name) return here
    for (const child of box.children) {
      const found = visit(child, here.left, here.top)
      if (found !== undefined) return found
    }
    return undefined
  }
  const found = visit(scene.root, scene.x, scene.y)
  if (found === undefined) throw new Error(`no box ${name} in ${scene.name}`)
  return found
}

// A claim that two values are equal, up to FP32 rounding.
const equal = (c: LayoutCircuit, name: string, says: string, a: Num, b: Num): CheckClaim =>
  ({name, says, wire: c.wireOf(subtract(c, a, b)), minimum: -tolerance, maximum: tolerance})

const scenes = (spec: Spec) => (c: LayoutCircuit) => [{name: 'screen', spec, width: c.input('W'), height: c.input('H')}]

// A bottom sheet asking to discard a draft, with two buttons side by side
// that the design says are equal. Each grows to fill the row; without
// flexBasis: 0 each starts from its label's width, so the one with the longer
// label stays wider by the difference.
function sheet(equalButtons: boolean): Spec {
  const button = (name: string): Spec => ({
    name, style: {flexGrow: 1, flexShrink: 1, ...(equalButtons ? {flexBasis: 0} : {}), padding: {left: 16, right: 16, top: 12, bottom: 12}},
    measure: {width: name, height: 20},
  })
  return {
    name: 'screen', style: {justifyContent: 'flex-end'},
    children: [{
      name: 'sheet', style: {padding: {left: 16, right: 16, top: 20, bottom: 32}, gap: 12},
      children: [
        {name: 'heading', measure: {width: 'heading', height: 24}},
        {name: 'message', measure: {width: 'message', height: 20}},
        {name: 'actions', style: {flexDirection: 'row', gap: 12, margin: {top: 8}}, children: [button('keep'), button('discard')]},
      ],
    }],
  }
}

function sheetVersion(equalButtons: boolean): Version {
  return {
    id: equalButtons ? 'equal-buttons' : 'label-sized-buttons',
    label: equalButtons ? 'Buttons with flexBasis: 0' : 'Buttons that grow from their labels',
    expect: equalButtons ? 'proven' : 'refuted',
    knobs: [
      ...screen,
      {name: 'heading', low: 0, high: 600, grid: 1 / 64, base: 140, label: 'Heading text'},
      {name: 'message', low: 0, high: 1200, grid: 1 / 64, base: 300, label: 'Message text'},
      {name: 'keep', low: 0, high: 300, grid: 1 / 64, base: 96, label: 'Keep label'},
      {name: 'discard', low: 0, high: 300, grid: 1 / 64, base: 56, label: 'Discard label'},
    ],
    scenes: scenes(sheet(equalButtons)),
    claims: (c, {screen}) => {
      const keep = locate(c, screen!, 'keep').box
      const discard = locate(c, screen!, 'discard').box
      return [equal(c, 'keep width = discard width', 'The two buttons are always the same width', keep.width, discard.width)]
    },
    roles: {screen: 'screen', sheet: 'surface', heading: 'text', message: 'text', actions: 'container', keep: 'button', discard: 'button'},
    texts: {
      heading: [
        'Discard?', 'Discard it?', 'Discard draft?', 'Discard this draft?', 'Discard this draft now?', 'Discard your unsaved draft?',
        'Discard this unsaved draft for good?', 'Do you want to discard this unsaved draft?', 'Are you sure you want to discard this unsaved draft?',
        'Are you sure you want to discard this unsaved draft for good?', 'Are you sure you want to discard this unsaved draft of your message?',
      ],
      message: [
        'Edits lost.', 'Changes lost.', 'Changes get lost.', 'Changes will be lost.', 'Your changes will be lost.', 'Unsaved changes will be lost.',
        'Your unsaved changes will be lost.', 'Changes since your last save will be lost.', 'Your changes since the last save will be lost.',
        'All your changes since the last save will be lost for good.',
        'All the changes you made since the last save will be lost for good.',
        'All the changes you made since you last saved will be lost and cannot be recovered.',
        'All the changes you made to this message since you last saved it will be lost, and they cannot be recovered.',
        'All the changes you made to this message since you last saved it will be lost for good, and there is no way to recover them later.',
        'All the changes you made to this message since you last saved it a few minutes ago will be lost for good, and there is no way to recover them later.',
      ],
      keep: [
        'Keep', 'Go back', 'Keep draft', 'Keep editing', 'Continue editing', 'Keep editing the draft', 'No, keep editing the draft',
        'No, keep working on this draft', 'No, take me back so I can keep editing',
      ],
      discard: [
        'Delete', 'Discard', 'Discard it', 'Discard draft', 'Discard the draft', 'Yes, discard the draft', 'Yes, discard my unsaved draft',
        'Yes, discard the draft and my changes',
      ],
    },
  }
}

// A header with a back button, a title, and two action icons. The title is
// meant to sit in the middle of the screen. It is centered inside the space
// between the side slots, so that is only the middle of the screen when the
// two side slots are equally wide.
function header(equalSides: boolean): Spec {
  const iconButton = (name: string): Spec => ({name, style: {width: 44, height: 44}})
  return {
    name: 'screen',
    children: [{
      name: 'header', style: {flexDirection: 'row', alignItems: 'center', height: 56, padding: {left: 4, right: 4}},
      children: [
        {name: 'leading', style: {flexDirection: 'row', ...(equalSides ? {width: 88} : {})}, children: [iconButton('back')]},
        {name: 'middle', style: {flexGrow: 1, flexShrink: 1, flexBasis: 0, alignItems: 'center'}, children: [
          {name: 'title', measure: {width: 'title', height: 22}},
        ]},
        {name: 'trailing', style: {flexDirection: 'row', ...(equalSides ? {width: 88} : {})}, children: [iconButton('search'), iconButton('more')]},
      ],
    }],
  }
}

function headerVersion(equalSides: boolean): Version {
  return {
    id: equalSides ? 'equal-side-slots' : 'unequal-side-slots',
    label: equalSides ? 'Side slots both 88 px wide' : 'Side slots as wide as their icons',
    expect: equalSides ? 'proven' : 'refuted',
    knobs: [...screen, {name: 'title', low: 0, high: 1200, grid: 1 / 64, base: 120, label: 'Title text'}],
    scenes: scenes(header(equalSides)),
    claims: (c, {screen}) => {
      const title = locate(c, screen!, 'title')
      const middle = add(c, title.left, divide(c, title.box.width, 2))
      return [equal(c, 'title center = screen center', 'The title is always centered on the screen', middle, divide(c, screen!.width, 2))]
    },
    overlays: (c, {screen}): Overlay[] => [
      {name: 'center', role: 'guide', label: 'Screen center', rect: [divide(c, screen!.width, 2), 0, 0, screen!.height]},
    ],
    roles: {screen: 'screen', header: 'surface', leading: 'container', back: 'icon', middle: 'container', title: 'text', trailing: 'container', search: 'icon', more: 'icon'},
    texts: {
      title: [
        'Messages', 'All messages', 'Recent messages', 'Messages with Sam', 'Messages with the team', 'Messages with the design team',
        'Messages with Sam and the design team', 'Messages with Sam Rivera and the design team',
        'Messages with Sam Rivera, Ada Lovelace and the design team',
        'Messages with Sam Rivera, Ada Lovelace, Grace Hopper and the design team',
        'Messages with Sam Rivera, Ada Lovelace, Grace Hopper, Alan Turing and the product design team',
        'Messages with Sam Rivera, Ada Lovelace, Grace Hopper, Alan Turing, Katherine Johnson and the whole product design team',
        'Messages with Sam Rivera, Ada Lovelace, Grace Hopper, Alan Turing, Katherine Johnson, Margaret Hamilton and the whole product design team',
      ],
    },
  }
}

// Order details: rows of a label and a value. The values are meant to line
// up in one column. With each label as wide as its text, each value starts
// where its own label ends.
// Each row's label and value in wordings from shortest to longest, for the
// visualizer to pick the one that fits; `label` is the one the knobs start at.
const rows = [
  {
    key: 'order', label: 'Order',
    labels: ['No.', 'Order', 'Order #', 'Order no.', 'Order number', 'Order reference', 'Your order number', 'Your order reference', 'Your order reference number', 'Reference number for your order'],
    values: [
      '#48213', 'No. 48213', '#48213 (paid)', '#48213 · 3 items', '#48213, 3 items, paid', '#48213, placed on 12 March', '#48213, placed on 12 March, 3 items',
      '#48213, placed on Thursday 12 March, 3 items', '#48213, placed on Thursday 12 March 2026, 3 items, paid',
      '#48213, placed on Thursday 12 March 2026 at 3:41 pm, 3 items, paid in full',
      '#48213, placed on Thursday 12 March 2026 at 3:41 pm from the website, 3 items, paid in full by card',
      '#48213, placed on Thursday 12 March 2026 at 3:41 pm from the website, 3 items in 2 parcels, paid in full by card, ready to ship',
      '#48213, placed on Thursday 12 March 2026 at 3:41 pm from the website, 3 items in 2 parcels, paid in full by card, packed and ready to ship from our London warehouse',
    ],
  },
  {
    key: 'ship', label: 'Shipping to',
    labels: ['Ship to', 'Deliver to', 'Shipping to', 'Delivering to', 'Shipping address', 'Your shipping address', 'Address we\'re shipping to', 'Shipping and delivery address', 'Address we\'ll ship your order to'],
    values: [
      'London', 'Baker St', '221 Baker St', '221 Baker Street', '221 Baker St, London', '221 Baker Street, London', '221 Baker Street, London NW1',
      '221 Baker Street, London NW1 6XE', 'Flat 2, 221 Baker Street, London NW1 6XE', 'Flat 2, 221 Baker Street, Marylebone, London NW1 6XE',
      'Sam Rivera, Flat 2, 221 Baker Street, Marylebone, London NW1 6XE',
      'Sam Rivera, Flat 2, 221 Baker Street, Marylebone, London NW1 6XE, United Kingdom',
      'Sam Rivera, Flat 2, second floor, 221 Baker Street, Marylebone, London NW1 6XE, United Kingdom',
      'Sam Rivera, Flat 2, second floor (ring the top bell), 221 Baker Street, Marylebone, London NW1 6XE, United Kingdom',
      'Sam Rivera, Flat 2, second floor (ring the top bell or leave it with the concierge), 221 Baker Street, Marylebone, London NW1 6XE, United Kingdom',
    ],
  },
  {
    key: 'pay', label: 'Payment',
    labels: ['Card', 'Payment', 'Paid with', 'How you paid', 'Payment method', 'Payment method used', 'Card used for payment', 'Your saved payment method', 'Payment method for this order', 'Payment method used for the order'],
    values: [
      'Visa', '•• 4242', 'Visa 4242', 'Visa •• 4242', 'Visa ending 4242', 'Visa ending in 4242', 'Visa debit ending in 4242', 'Visa debit card ending in 4242',
      'Visa debit ending in 4242, exp. 08/28', 'Visa debit card ending in 4242, expires 08/28',
      'Visa debit card ending in 4242, expires 08/28, charged $129.97',
      'Visa debit card ending in 4242 (Sam Rivera), expires 08/28, charged $129.97',
      'Visa debit card ending in 4242 (Sam Rivera), expires 08/28, charged $129.97 on 12 March 2026',
      'Visa debit card ending in 4242 (Sam Rivera), expires 08/28, charged $129.97 on 12 March 2026, billed to 221 Baker Street',
      'Visa debit card ending in 4242 (Sam Rivera), expires 08/28, charged $129.97 on 12 March 2026 at 3:41 pm, billed to 221 Baker Street, London NW1 6XE',
    ],
  },
]

function details(labelColumn: boolean): Spec {
  return {
    name: 'screen', style: {padding: 16},
    children: [{
      name: 'card', style: {padding: {left: 16, right: 16, top: 4, bottom: 4}},
      children: rows.map(({key}) => ({
        name: `${key}Row`, style: {flexDirection: 'row', gap: 16, padding: {top: 12, bottom: 12}},
        children: [
          {name: `${key}Label`, ...(labelColumn ? {style: {width: 112}} : {}), measure: {width: `${key}Label`, height: 20}},
          {name: `${key}Value`, style: {flexShrink: 1}, measure: {width: `${key}Value`, height: 20}},
        ],
      })),
    }],
  }
}

function detailsVersion(labelColumn: boolean): Version {
  const roles: Version['roles'] = {screen: 'screen', card: 'surface'}
  const texts: Record<string, string[]> = {}
  for (const {key, labels, values} of rows) {
    roles[`${key}Row`] = 'container'
    roles[`${key}Label`] = 'text'
    roles[`${key}Value`] = 'text'
    texts[`${key}Label`] = labels
    texts[`${key}Value`] = values
  }
  return {
    id: labelColumn ? 'label-column' : 'label-sized',
    label: labelColumn ? 'Labels 112 px wide' : 'Labels as wide as their text',
    expect: labelColumn ? 'proven' : 'refuted',
    knobs: [
      ...screen,
      ...rows.flatMap(({key, label}): Knob[] => [
        {name: `${key}Label`, low: 0, high: 240, grid: 1 / 64, base: 8 * label.length, label: `${label} label`},
        {name: `${key}Value`, low: 0, high: 1200, grid: 1 / 64, base: 160, label: `${label} value`},
      ]),
    ],
    scenes: scenes(details(labelColumn)),
    claims: (c, {screen}) => {
      const first = locate(c, screen!, 'orderValue').left
      return rows.slice(1).map(({key, label}) => equal(
        c, `${key}Value left = orderValue left`, `The "${label}" value lines up with the order number`,
        locate(c, screen!, `${key}Value`).left, first,
      ))
    },
    overlays: (c, {screen}): Overlay[] => {
      const value = locate(c, screen!, 'orderValue')
      return [{name: 'values', role: 'guide', label: 'Left edge of the values', rect: [value.left, 0, 0, screen!.height]}]
    },
    roles, texts,
  }
}

export const check: Check = {
  id: 'design-rules',
  title: 'The design holds',
  question: "Do the design's rules hold at every size: equal buttons stay equal, a centered title stays centered, items in a list share one left edge?",
  examples: [
    {id: 'sheet', title: 'Two equal buttons', versions: [sheetVersion(false), sheetVersion(true)]},
    {id: 'header', title: 'A centered title', versions: [headerVersion(false), headerVersion(true)]},
    {id: 'details', title: 'Values in one column', versions: [detailsVersion(false), detailsVersion(true)]},
  ],
}
