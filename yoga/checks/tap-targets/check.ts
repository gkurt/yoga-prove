// Tap targets: every button stays at least 44 × 44 px, Apple's minimum, at
// least 8 px from the next button in its row, and on the screen, for every
// screen size and label length. Two examples:
//
// - Filter chips that may shrink (flexShrink: 1) so a long label fits a
//   narrow phone. Yoga shrinks every chip in proportion to its width, so a
//   long label squeezes "All" well below 44 px. The obvious fix, minWidth:
//   44, keeps every chip 44 wide but can stop Yoga shrinking the row at all
//   (README.md says why), and pushes chips hundreds of pixels off the
//   screen. Equal chips (flexGrow: 1, flexBasis: 0) fix it.
// - An onboarding footer with Skip on the left and Get started on the right,
//   justifyContent: 'space-between' and no gap. The space between them is
//   whatever the labels leave, and a long label leaves none. The fix is
//   gap: 8.
import type {Check, CheckClaim, Knob, Version} from '../../check.ts'
import {add, subtract, type LayoutCircuit, type Num} from '../../circuit.ts'
import {tolerance} from '../../claims.ts'
import type {Layout, Spec, Style} from '../../yoga.ts'

// Apple's Human Interface Guidelines: at least 44 × 44 points.
export const minimumSize = 44
// The space kept between two neighbouring targets.
export const minimumSpacing = 8

const viewport: Knob[] = [
  {name: 'W', label: 'Screen width', low: 320, high: 2560, grid: 1 / 64, base: 390},
  {name: 'H', label: 'Screen height', low: 480, high: 1600, grid: 1 / 64, base: 844},
]

// For every target by name: width and height at least 44, its right edge on
// the screen, and in a row (or a column), at least 8 px after the target
// before it when the two are siblings. `names` gives each target's name in
// the sentences.
export function tapClaims(c: LayoutCircuit, spec: Spec, root: Layout, names: Record<string, string>): CheckClaim[] {
  const claims: CheckClaim[] = []
  const visit = (spec: Spec, box: Layout, left: Num) => {
    const row = spec.style?.flexDirection === 'row'
    let previous: Layout | undefined
    box.children.forEach((child, index) => {
      const name = names[child.name]
      const childLeft = add(c, left, child.left)
      if (name !== undefined) {
        claims.push(
          {name: `${child.name}: width >= ${minimumSize}`, says: `${name} is at least ${minimumSize} px wide`, wire: c.wireOf(child.width), minimum: minimumSize - tolerance, maximum: Infinity},
          {name: `${child.name}: height >= ${minimumSize}`, says: `${name} is at least ${minimumSize} px tall`, wire: c.wireOf(child.height), minimum: minimumSize - tolerance, maximum: Infinity},
          {name: `${child.name}: right <= screen width`, says: `${name} ends before the right edge of the screen`, wire: c.wireOf(subtract(c, add(c, childLeft, child.width), root.width)), minimum: -Infinity, maximum: tolerance},
        )
        if (previous !== undefined) {
          const [start, size] = row ? (['left', 'width'] as const) : (['top', 'height'] as const)
          const space = subtract(c, child[start], add(c, previous[start], previous[size]))
          claims.push({
            name: `${child.name} after ${previous.name}: space >= ${minimumSpacing}`, says: `${name} is at least ${minimumSpacing} px from ${names[previous.name]!}`,
            wire: c.wireOf(space), minimum: minimumSpacing - tolerance, maximum: Infinity,
          })
        }
        previous = child
      }
      visit(spec.children![index]!, child, childLeft)
    })
  }
  visit(spec, root, 0)
  return claims
}

function version(
  id: string, label: string, expect: Version['expect'], knobs: Knob[], spec: Spec,
  names: Record<string, string>, roles: Version['roles'], texts: Record<string, string | string[]>,
): Version {
  return {
    id, label, expect, knobs, roles, texts,
    scenes: c => [{name: 'screen', spec, width: c.input('W'), height: c.input('H')}],
    claims: (c, scenes) => tapClaims(c, spec, scenes['screen']!.root, names),
  }
}

// A mail inbox with filter chips above the list. Each chip is its label with
// 12 px of padding on each side and 12 above and below a 20 px line: 44 tall.
// They may shrink so that a long label, e.g. in German, truncates instead of
// pushing the last chip off the screen.
const chipLabels = {all: 'All', unread: 'Unread', flagged: 'Flagged', attachments: 'With attachments'}
// Each label from its shortest wording to its longest.
const chipTexts = {
  all: [
    'All',
    'All mail',
    'All emails',
    'All messages',
    'All your messages',
    'All messages in inbox',
    'All messages in your inbox',
    'Show all messages in your inbox',
  ],
  unread: [
    'New',
    'Unread',
    'New mail',
    'Unread mail',
    'Unread emails',
    'Unread messages',
    'Unread messages only',
    'Messages you haven\'t read',
    'Messages you haven\'t read yet',
    'Only messages you haven\'t read yet',
  ],
  flagged: [
    'Flags',
    'Flagged',
    'Flagged mail',
    'Flagged emails',
    'Flagged messages',
    'Flagged messages only',
    'Messages you have flagged',
    'Only messages you have flagged',
  ],
  attachments: [
    'Files',
    'With files',
    'Attachments',
    'With attachments',
    'Mail with attachments',
    'Messages with attachments',
    'Only messages with attachments',
  ],
}

function inbox(fix: 'none' | 'min-width' | 'equal'): Spec {
  const sizing: Style = fix === 'min-width' ? {minWidth: minimumSize} : fix === 'equal' ? {flexGrow: 1, flexBasis: 0} : {}
  const chip = (name: string): Spec => ({
    name,
    style: {flexShrink: 1, ...sizing, padding: {left: 12, right: 12, top: 12, bottom: 12}},
    measure: {width: name, height: 20},
  })
  return {
    name: 'screen',
    children: [
      {name: 'chips', style: {flexDirection: 'row', padding: {left: 16, right: 16, top: 8, bottom: 8}, gap: 8}, children: Object.keys(chipLabels).map(chip)},
      {name: 'messages', style: {flexGrow: 1}},
    ],
  }
}

const inboxKnobs: Knob[] = [
  ...viewport,
  {name: 'all', label: '"All" label width', low: 20, high: 240, grid: 1 / 64, base: 20},
  {name: 'unread', label: '"Unread" label width', low: 20, high: 240, grid: 1 / 64, base: 46},
  {name: 'flagged', label: '"Flagged" label width', low: 20, high: 240, grid: 1 / 64, base: 50},
  {name: 'attachments', label: '"With attachments" label width', low: 20, high: 240, grid: 1 / 64, base: 116},
]
const inboxNames = Object.fromEntries(Object.entries(chipLabels).map(([name, text]) => [name, `"${text}" chip`]))
const inboxRoles: Version['roles'] = {screen: 'screen', chips: 'surface', messages: 'container', all: 'button', unread: 'button', flagged: 'button', attachments: 'button'}

// The last page of an onboarding flow: an illustration that takes the rest
// of the screen, then a footer with Skip at the left edge and Next at the
// right. Each button is at least 64 wide and 44 tall. Skip is short in every
// language and keeps its size; Get started may shrink so a long label
// truncates.
function onboarding(gap: boolean): Spec {
  const button = (name: string, shrinks: boolean): Spec => ({
    name,
    style: {...(shrinks ? {flexShrink: 1} : {}), minWidth: 64, padding: {left: 16, right: 16, top: 12, bottom: 12}},
    measure: {width: name, height: 20},
  })
  const footer: Style = {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, ...(gap ? {gap: minimumSpacing} : {})}
  return {
    name: 'screen',
    children: [
      {name: 'illustration', style: {flexGrow: 1, margin: 24}},
      {name: 'footer', style: footer, children: [button('skip', false), button('next', true)]},
    ],
  }
}

const onboardingKnobs: Knob[] = [
  ...viewport,
  {name: 'skip', label: '"Skip" label width', low: 16, high: 120, grid: 1 / 64, base: 32},
  {name: 'next', label: '"Get started" label width', low: 16, high: 400, grid: 1 / 64, base: 80},
]
const onboardingNames = {skip: 'Skip', next: 'Get started'}
// Each label from its shortest wording to its longest.
const onboardingTexts = {
  skip: ['Skip', 'Later', 'Not now', 'Skip for now', 'Skip this for now'],
  next: [
    'Go',
    'Next',
    'Let\'s go',
    'Continue',
    'Get started',
    'Get started now',
    'Start using the app',
    'Get started with the app',
    'Get started with your account',
    'Create your account and get started',
    'Continue to set up your account and get started',
    'Continue to set up your account and start using the app',
  ],
}
const onboardingRoles: Version['roles'] = {screen: 'screen', illustration: 'image', footer: 'surface', skip: 'button', next: 'button'}

export const check: Check = {
  id: 'tap-targets',
  title: 'Big enough to tap',
  question: 'Can any button get smaller than 44 × 44 px, Apple\'s minimum tap target, or end up closer than 8 px to its neighbour?',
  examples: [
    {id: 'filter-chips', title: 'Filter chips in an inbox', versions: [
      version('chips-shrink', 'Chips with flexShrink: 1', 'refuted', inboxKnobs, inbox('none'), inboxNames, inboxRoles, chipTexts),
      version('chips-min-width', 'Chips with flexShrink: 1 and minWidth: 44', 'refuted', inboxKnobs, inbox('min-width'), inboxNames, inboxRoles, chipTexts),
      version('chips-equal', 'Equal chips (flexGrow: 1, flexBasis: 0)', 'proven', inboxKnobs, inbox('equal'), inboxNames, inboxRoles, chipTexts),
    ]},
    {id: 'onboarding-footer', title: 'An onboarding footer', versions: [
      version('space-between', 'Skip and Get started pushed apart with space-between', 'refuted', onboardingKnobs, onboarding(false), onboardingNames, onboardingRoles, onboardingTexts),
      version('space-between-gap', 'space-between with gap: 8', 'proven', onboardingKnobs, onboarding(true), onboardingNames, onboardingRoles, onboardingTexts),
    ]},
  ],
}
