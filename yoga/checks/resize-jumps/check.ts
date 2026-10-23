// Resize jumps: when the window gets a little wider, or a text a little
// longer, does anything jump, or move the wrong way? Each version lays out
// the same row twice in one circuit, e.g. at width W and at W + δ, and claims
// that the chosen edges move the right way and by no more than the change.
//
// The examples are an inbox row, which Yoga lays out wrong on some narrow
// screens: its first pass of shrinking freezes the sender at its minimum,
// then shrinks the subject by the whole overflow as if the sender still took
// its share, and freezes the subject at 0 too. The free space left over is
// then positive, so the second pass grows instead of shrinking: the sender
// keeps its full width, the subject gets more than its own, and the time
// lands past the edge of the screen. A pixel wider, the row is right. The
// README has the details.
import {tolerance} from '../../claims.ts'
import type {Check, CheckClaim, Knob, Scene, Version} from '../../check.ts'
import {add, subtract, type LayoutCircuit, type Num} from '../../circuit.ts'
import type {Layout, Spec, Style} from '../../yoga.ts'

// A box's left in its scene, and its width.
function measureBox(c: LayoutCircuit, scene: Scene, name: string): {left: Num, width: Num} {
  const find = (box: Layout, left: Num): {left: Num, width: Num} | null => {
    const here = add(c, left, box.left)
    if (box.name === name) return {left: here, width: box.width}
    for (const child of box.children) {
      const found = find(child, here)
      if (found !== null) return found
    }
    return null
  }
  const found = find(scene.root, 0)
  if (found === null) throw new Error(`no box ${name} in ${scene.name}`)
  return found
}

// Moving right by between nothing and `most`: two claims, one for each side.
function movesRightBy(c: LayoutCircuit, name: string, before: Num, after: Num, most: Num, says: [string, string]): CheckClaim[] {
  const moved = subtract(c, after, before)
  return [
    {name: `${name} doesn't move back`, says: says[0], wire: c.wireOf(moved), minimum: -tolerance, maximum: Infinity},
    {name: `${name} moves at most the change`, says: says[1], wire: c.wireOf(subtract(c, moved, most)), minimum: -Infinity, maximum: tolerance},
  ]
}

// An inbox row: the sender's name, the subject, which takes the rest, and
// the time, at the right edge. Both names truncate. The first version lets
// the sender shrink, but not below 120, so that it stays readable. The fix
// caps the sender at 140 instead and doesn't shrink it, so that only the
// subject shrinks: one item that shrinks can't be frozen out of turn.
function inbox(sender: Style): (width: string | {times: [string, string]}) => Spec {
  return subject => ({
    name: 'screen',
    children: [{
      name: 'row', style: {flexDirection: 'row', alignItems: 'center', padding: 16, gap: 8},
      children: [
        {name: 'sender', style: sender, measure: {width: 'sender', height: 20}},
        {name: 'subject', style: {flexGrow: 1, flexShrink: 1}, measure: {width: subject, height: 20}},
        {name: 'time', measure: {width: 'time', height: 20}},
      ],
    }],
  })
}

const shrinkingSender: Style = {flexShrink: 1, minWidth: 120}
const cappedSender: Style = {maxWidth: 140}

const roles: Version['roles'] = {screen: 'screen', row: 'surface', sender: 'text', subject: 'text', time: 'text'}
// Each text from its shortest wording to its longest, to fit the width its
// knob gives it.
const texts = {
  sender: [
    'Northwind',
    'Northwind Help',
    'Northwind Support',
    'Northwind Travel Help',
    'Northwind Travel Support',
    'Northwind Travel Support Team',
    'Northwind Travel Customer Support',
    'Northwind Travel Customer Support Team',
    'Northwind Travel Customer Support and Bookings Team',
  ],
  subject: [
    'Confirmed',
    'Trip confirmed',
    'Booking confirmed',
    'Booking is confirmed',
    'Your booking is confirmed',
    'Booking confirmed: flight details',
    'Your booking is confirmed: flight details',
    'Your booking is confirmed: flight details inside',
    'Your booking is confirmed: flight details and receipt inside',
    'Your booking is confirmed: flight details, seats and receipt inside',
    'Your booking to Lisbon is confirmed: flight details, seat numbers and receipt inside',
    'Your booking to Lisbon is confirmed: flight details, seat numbers, baggage allowance and receipt inside',
    'Your booking to Lisbon on 14 June is confirmed: flight details, seat numbers, baggage allowance, check-in times and receipt inside',
  ],
  time: ['Mon', 'Yest.', 'Monday', 'Mon 9:41', 'Yesterday'],
}

const textKnobs: Knob[] = [
  {name: 'sender', label: 'Sender name', low: 0, high: 400, grid: 1 / 64, base: 190},
  {name: 'subject', label: 'Subject', low: 0, high: 1000, grid: 1 / 64, base: 420},
  {name: 'time', label: 'Time', low: 24, high: 72, grid: 1 / 64, base: 64},
]

// The row at width W and at W + δ, one above the other.
function resizeVersion(fixed: boolean): Version {
  const spec = inbox(fixed ? cappedSender : shrinkingSender)('subject')
  return {
    id: fixed ? 'capped-sender' : 'shrinking-sender',
    label: fixed ? 'Sender capped at maxWidth: 140' : 'Sender shrinks, minWidth: 120',
    expect: fixed ? 'proven' : 'refuted',
    knobs: [
      {name: 'W', label: 'Window width', low: 320, high: 1280, grid: 1 / 64, base: 390},
      {name: 'delta', label: 'Wider by', low: 0, high: 8, grid: 1 / 64, base: 4},
      ...textKnobs,
    ],
    scenes: c => [
      {name: 'before', label: 'Width W', spec, width: c.input('W'), height: 52},
      {name: 'after', label: 'Width W + δ', spec, width: add(c, c.input('W'), c.input('delta')), height: 52, y: 76},
    ],
    claims: (c, scenes) => {
      const delta = c.input('delta')
      const [time, timeAfter] = ['before', 'after'].map(name => measureBox(c, scenes[name]!, 'time'))
      const [subject, subjectAfter] = ['before', 'after'].map(name => measureBox(c, scenes[name]!, 'subject'))
      return [
        ...movesRightBy(c, 'time', time!.left, timeAfter!.left, delta,
          ['The time never moves left when the window gets wider', 'The time moves right by no more than the window grew']),
        ...movesRightBy(c, 'subject width', subject!.width, subjectAfter!.width, delta,
          ['The subject never gets narrower when the window gets wider', 'The subject gets wider by no more than the window grew']),
      ]
    },
    roles, texts,
  }
}

// The same row at the same width, with the subject a little longer: up to
// an eighth longer, as when a reply adds "Re: ".
function longerVersion(fixed: boolean): Version {
  const row = inbox(fixed ? cappedSender : shrinkingSender)
  return {
    id: fixed ? 'capped-sender-longer-subject' : 'shrinking-sender-longer-subject',
    label: fixed ? 'Sender capped at maxWidth: 140' : 'Sender shrinks, minWidth: 120',
    expect: fixed ? 'proven' : 'refuted',
    knobs: [
      {name: 'W', label: 'Window width', low: 320, high: 1280, grid: 1 / 64, base: 390},
      ...textKnobs,
      {name: 'longer', label: 'Subject longer by (times)', low: 1, high: 1.125, grid: 1 / 64, base: 1.0625},
    ],
    scenes: c => [
      {name: 'before', label: 'Subject', spec: row('subject'), width: c.input('W'), height: 52},
      {name: 'after', label: 'Longer subject', spec: row({times: ['subject', 'longer']}), width: c.input('W'), height: 52, y: 76},
    ],
    claims: (c, scenes) => {
      const [time, timeAfter] = ['before', 'after'].map(name => measureBox(c, scenes[name]!, 'time'))
      const [subject, subjectAfter] = ['before', 'after'].map(name => measureBox(c, scenes[name]!, 'subject'))
      return [
        ...movesRightBy(c, 'time', time!.left, timeAfter!.left, 0,
          ['The time never moves left when the subject gets longer', 'The time never moves right when the subject gets longer']),
        {name: 'subject width doesn\'t shrink', says: 'The subject never gets narrower when it gets longer',
          wire: c.wireOf(subtract(c, subjectAfter!.width, subject!.width)), minimum: -tolerance, maximum: Infinity},
      ]
    },
    roles, texts,
  }
}

export const check: Check = {
  id: 'resize-jumps',
  title: 'Nothing jumps',
  question: 'Does anything jump when the window is resized a little, or move the wrong way when a text gets longer?',
  examples: [
    {id: 'inbox-resize', title: 'An inbox row, resized', versions: [resizeVersion(false), resizeVersion(true)]},
    {id: 'inbox-longer-subject', title: 'An inbox row, with a longer subject', versions: [longerVersion(false), longerVersion(true)]},
  ],
}
