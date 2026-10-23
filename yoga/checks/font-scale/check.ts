// Every system text size, from 100% to the largest accessibility size: one
// input, the font scale, multiplies every label's width and line height, the
// way iOS's Dynamic Type and Android's font scale do. Nothing may stick out
// of its parent or overlap its neighbour, and a label that must be read in
// full may not be cut off, in width or in height.
//
// Label widths are constants, each measured from its English text at the
// stated size with the system font, so the scale is the only input besides
// the screen width.
import {tolerance} from '../../claims.ts'
import type {Check, CheckClaim, Knob, Version} from '../../check.ts'
import {amountOf, type Layout, type Spec} from '../../yoga.ts'
import {subtract, type LayoutCircuit} from '../../circuit.ts'
import {overflowClaims} from '../overflow/check.ts'

// The node named `name` in a spec and its laid-out box.
function find(spec: Spec, box: Layout, name: string): {spec: Spec, box: Layout} | undefined {
  if (spec.name === name) return {spec, box}
  for (const [index, child] of (spec.children ?? []).entries()) {
    const found = find(child, box.children[index]!, name)
    if (found !== undefined) return found
  }
  return undefined
}

// Each named label is at least as wide and as tall as its text: the layout
// gives it room for all of it, so nothing is cut off with an ellipsis or
// clipped at the top and bottom. `texts` gives the words to say.
export function fullTextClaims(c: LayoutCircuit, spec: Spec, root: Layout, texts: Record<string, string>, names: string[]): CheckClaim[] {
  return names.flatMap(name => {
    const found = find(spec, root, name)
    if (found?.spec.measure === undefined) throw new Error(`${name}: no measured label`)
    const {box, spec: {measure}} = found
    const text = texts[name] ?? name
    return [
      {name: `${name} shows all its text`, says: `“${text}” is wide enough to show the whole text`, wire: c.wireOf(subtract(c, box.width, amountOf(c, measure.width))), minimum: -tolerance, maximum: Infinity},
      {name: `${name} shows its full line`, says: `“${text}” is tall enough for its line of text`, wire: c.wireOf(subtract(c, box.height, amountOf(c, measure.height))), minimum: -tolerance, maximum: Infinity},
    ]
  })
}

// Phone widths, from the 320 px of the smallest iPhone SE to the 430 px of a
// Pro Max, on the 1/64 px grid.
export const phoneWidth: Knob = {name: 'W', label: 'Screen width', low: 320, high: 430, grid: 1 / 64, base: 375}
// And heights, from 568 px (iPhone SE) to 932 px (Pro Max).
export const phoneHeight: Knob = {name: 'H', label: 'Screen height', low: 568, high: 932, grid: 1 / 64, base: 812}

// 100% to 312.5%, just past iOS's largest accessibility size of 310%. The
// grid is 1/64 (about 1.6%), which FP32 holds exactly, as the prover's grid
// reasoning requires; 1/100 isn't, and 3.1 isn't on the 1/64 grid, hence
// 3.125.
const scale: Knob = {name: 'scale', label: 'Text size', low: 1, high: 3.125, grid: 1 / 64, base: 1}

// A label that scales: width and line height at 100%, times the font scale.
const label = (name: string, width: number, lineHeight: number, style?: Spec['style']): Spec => ({
  name, ...(style === undefined ? {} : {style}),
  measure: {width: {times: [width, 'scale']}, height: {times: [lineHeight, 'scale']}},
})

// An inset grouped list, as in Settings.
const screen = (row: Spec): Spec => ({name: 'screen', style: {padding: 16}, children: [{name: 'list', children: [row]}]})

// A row's height, as first written and as fixed: the fixed one is 44 px at
// 100% too, 22 px of line plus 11 px above and below, and grows with the text.
const fixedHeight: Spec['style'] = {height: 44, padding: {left: 16, right: 16}}
const growingHeight: Spec['style'] = {minHeight: 44, padding: {left: 16, right: 16, top: 11, bottom: 11}}

// A Settings row: an icon, "Sounds" at 17 pt (53 px wide, 22 px line), and a
// chevron.
function settingsRow(rowHeight: Spec['style']): Spec {
  return screen({
    name: 'row', style: {flexDirection: 'row', alignItems: 'center', gap: 12, ...rowHeight},
    children: [
      {name: 'icon', style: {width: 29, height: 29}},
      label('sounds', 53, 22, {flexGrow: 1, flexShrink: 1}),
      {name: 'chevron', style: {width: 8, height: 13}},
    ],
  })
}

// A mailbox row: an icon, "Inbox" at 17 pt (38 px, 22 px line), and a pill
// with the unread count, "12" at 13 pt (15 px, 16 px line). The pill as first
// written is a fixed 24 × 20; fixed, it is at least that, with 4 px and 2 px
// of padding, which is still 24 × 20 at 100%.
function mailboxRow(pillSize: Spec['style']): Spec {
  return screen({
    name: 'row', style: {flexDirection: 'row', alignItems: 'center', gap: 12, ...growingHeight},
    children: [
      {name: 'icon', style: {width: 29, height: 29}},
      label('inbox', 38, 22, {flexGrow: 1, flexShrink: 1}),
      {name: 'pill', style: {alignItems: 'center', justifyContent: 'center', ...pillSize}, children: [label('count', 15, 16)]},
    ],
  })
}

const fixedPill: Spec['style'] = {width: 24, height: 20}
const growingPill: Spec['style'] = {minWidth: 24, minHeight: 20, padding: {left: 4, right: 4, top: 2, bottom: 2}}

function version(id: string, label: string, expect: Version['expect'], spec: Spec, roles: Version['roles'], texts: Record<string, string>, full: string[]): Version {
  return {
    id, label, expect, roles, texts,
    knobs: [phoneWidth, phoneHeight, scale],
    scenes: c => [{name: 'screen', spec, width: c.input('W'), height: c.input('H')}],
    claims: (c, scenes) => {
      const root = scenes['screen']!.root
      return [...overflowClaims(c, spec, root), ...fullTextClaims(c, spec, root, texts, full)]
    },
  }
}

const settingsRoles: Version['roles'] = {screen: 'screen', list: 'surface', row: 'container', icon: 'icon', sounds: 'text', chevron: 'icon'}
const settingsTexts = {sounds: 'Sounds'}
const mailboxRoles: Version['roles'] = {screen: 'screen', list: 'surface', row: 'container', icon: 'icon', inbox: 'text', pill: 'surface', count: 'text'}
const mailboxTexts = {inbox: 'Inbox', count: '12'}

export const check: Check = {
  id: 'font-scale',
  title: 'Large text',
  question: 'Does the layout hold at every system text size, from 100% to the largest accessibility size?',
  examples: [
    {id: 'settings-row', title: 'A Settings row', versions: [
      version('fixed-height', 'Row with height: 44', 'refuted', settingsRow(fixedHeight), settingsRoles, settingsTexts, ['sounds']),
      version('min-height', 'Row with minHeight: 44 and padding', 'proven', settingsRow(growingHeight), settingsRoles, settingsTexts, ['sounds']),
    ]},
    {id: 'unread-count', title: 'A mailbox row with an unread count', versions: [
      version('fixed-pill', 'Count pill with width: 24, height: 20', 'refuted', mailboxRow(fixedPill), mailboxRoles, mailboxTexts, ['inbox', 'count']),
      version('growing-pill', 'Count pill with minWidth, minHeight and padding', 'proven', mailboxRow(growingPill), mailboxRoles, mailboxTexts, ['inbox', 'count']),
    ]},
  ],
}
