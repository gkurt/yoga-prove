// Line length: a column of body text stays between about 15 and 80
// characters wide at every screen size. Body text is 16 px, about 8 px per
// character, so a column must be 120 px to 640 px wide. A paragraph that
// wraps fills its column, so its width is the length of its lines.
import type {Check, CheckClaim, Knob, Version} from '../../check.ts'
import type {LayoutCircuit, Num} from '../../circuit.ts'
import {tolerance} from '../../claims.ts'
import type {Spec} from '../../yoga.ts'

const characterWidth = 8
const fewest = 15
const most = 80

const screen: Knob[] = [
  {name: 'W', low: 320, high: 2560, grid: 1 / 64, base: 1280, label: 'Screen width'},
  {name: 'H', low: 480, high: 1600, grid: 1 / 64, base: 800, label: 'Screen height'},
]

// A paragraph: its unwrapped line is far longer than any column, and the
// port has no wrapping, so it stands for text that fills its column's width.
const paragraph = (name: string, height: number): Spec => ({name, measure: {width: 4000, height}})

// Claims that a paragraph's lines are neither too short nor too long.
function readable(c: LayoutCircuit, width: Num, name: string, what: string): CheckClaim[] {
  const wire = c.wireOf(width)
  const shortest = fewest * characterWidth
  const longest = most * characterWidth
  return [
    {name: `${name} width >= ${shortest}`, says: `Lines of ${what} are never shorter than about ${fewest} characters (${shortest} px at 8 px a character)`, wire, minimum: shortest - tolerance, maximum: Infinity},
    {name: `${name} width <= ${longest}`, says: `Lines of ${what} are never longer than about ${most} characters (${longest} px at 8 px a character)`, wire, minimum: -Infinity, maximum: longest + tolerance},
  ]
}

const texts = {
  title: 'How we cut our build times in half',
  lead: 'Last spring a full build of our app took eleven minutes. Here is what we changed, and what it cost us.',
  body: 'The first thing we measured was where the time went. Most of it was not compiling at all, but waiting on a cache that missed far more often than we thought.',
}

// An article. As first written it fills the screen less 16 px on each side,
// so on a wide monitor a line runs to 300 characters. Fixed, the article is
// 640 px wide and may shrink (width: 640, flexShrink: 1), in the middle of a
// row. `flex: 1, maxWidth: 640` lays out the same; README.md says why this
// one is the one proven.
function article(limited: boolean): Spec {
  return {
    name: 'screen', style: {padding: 16, ...(limited ? {flexDirection: 'row', justifyContent: 'center'} : {})},
    children: [{
      name: 'article', style: {gap: 16, ...(limited ? {width: 640, flexShrink: 1} : {})},
      children: [paragraph('title', 32), paragraph('lead', 72), paragraph('body', 240)],
    }],
  }
}

function articleVersion(limited: boolean): Version {
  return {
    id: limited ? 'max-width' : 'full-width',
    label: limited ? 'At most 640 px wide, centered' : 'As wide as the screen',
    expect: limited ? 'proven' : 'refuted',
    knobs: screen,
    scenes: c => [{name: 'screen', spec: article(limited), width: c.input('W'), height: c.input('H')}],
    claims: (c, {screen}) => {
      const body = screen!.root.children[0]!.children.find(box => box.name === 'body')!
      return readable(c, body.width, 'body', 'the article')
    },
    roles: {screen: 'screen', article: 'container', title: 'text', lead: 'text', body: 'text'},
    texts,
  }
}

// A docs page: a navigation sidebar and the page's text, which is at most
// 640 px wide. As first written the sidebar is always 280 px wide, so on a
// phone the text column gets what is left, 40 px at a 320 px screen, which
// its 24 px padding on each side more than fills. Fixed, the sidebar may
// shrink and the text column keeps at least 168 px: 120 px of text and its
// padding.
function docs(shrinkingSidebar: boolean): Spec {
  return {
    name: 'screen', style: {flexDirection: 'row'},
    children: [
      {name: 'sidebar', style: {width: 280, padding: 16, gap: 8, ...(shrinkingSidebar ? {flexShrink: 1} : {})}, children: [
        {name: 'navHeading', measure: {width: 'navHeading', height: 20}},
        {name: 'navFirst', measure: {width: 'navFirst', height: 20}},
        {name: 'navSecond', measure: {width: 'navSecond', height: 20}},
      ]},
      {name: 'main', style: {flexGrow: 1, flexShrink: 1, flexBasis: 0, padding: 24, ...(shrinkingSidebar ? {minWidth: 168} : {})}, children: [
        {name: 'page', style: {maxWidth: 640, gap: 16}, children: [paragraph('heading', 32), paragraph('text', 320)]},
      ]},
    ],
  }
}

function docsVersion(shrinkingSidebar: boolean): Version {
  return {
    id: shrinkingSidebar ? 'text-keeps-room' : 'fixed-sidebar',
    label: shrinkingSidebar ? 'Sidebar shrinks, text keeps 168 px' : 'Sidebar always 280 px',
    expect: shrinkingSidebar ? 'proven' : 'refuted',
    knobs: [
      ...screen,
      {name: 'navHeading', low: 0, high: 400, grid: 1 / 64, base: 90, label: 'Section heading'},
      {name: 'navFirst', low: 0, high: 400, grid: 1 / 64, base: 120, label: 'First link'},
      {name: 'navSecond', low: 0, high: 400, grid: 1 / 64, base: 140, label: 'Second link'},
    ],
    scenes: c => [{name: 'screen', spec: docs(shrinkingSidebar), width: c.input('W'), height: c.input('H')}],
    claims: (c, {screen}) => {
      const page = screen!.root.children[1]!.children[0]!
      const text = page.children.find(box => box.name === 'text')!
      return readable(c, text.width, 'text', 'the page text')
    },
    roles: {screen: 'screen', sidebar: 'surface', navHeading: 'text', navFirst: 'text', navSecond: 'text', main: 'container', page: 'container', heading: 'text', text: 'text'},
    texts: {
      navHeading: [
        'Intro',
        'Basics',
        'Start here',
        'Get started',
        'Getting started',
        'Getting started guide',
        'Getting started with the CLI',
        'Getting started with the command line',
        'Getting started with the command line tool',
        'Getting started with the command line tool, step by step',
      ],
      navFirst: [
        'Setup',
        'Install',
        'Installing',
        'Installation',
        'Install the CLI',
        'Installing the CLI',
        'Install the CLI tool',
        'Installing the CLI tool',
        'Install the command line tool',
        'Installing the command line tool',
        'Install the command line tool on your machine',
        'Install the command line tool on macOS, Linux or Windows',
      ],
      navSecond: [
        'First app',
        'First project',
        'Your first project',
        'Create your first project',
        'Creating your first project',
        'Build and run your first project',
        'Creating and running your first project',
        'Creating, building and running your first project',
      ],
      heading: 'Install the command line tool', text: texts.body,
    },
  }
}

export const check: Check = {
  id: 'line-length',
  title: 'Lines stay readable',
  question: 'Do text columns stay readable: never squeezed below about 15 characters, never stretched past about 80?',
  examples: [
    {id: 'article', title: 'An article', versions: [articleVersion(false), articleVersion(true)]},
    {id: 'docs', title: 'Sidebar and text', versions: [docsVersion(false), docsVersion(true)]},
  ],
}
