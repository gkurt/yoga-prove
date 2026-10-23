// The first check: no box sticks out of its parent, and in a row or a column
// no child overlaps the one before it, for every screen size and text length.
// Its two examples, a toolbar and a centered dialog, are layouts.ts's.
import {layoutClaims} from '../../claims.ts'
import type {Check, CheckClaim, Knob, Version} from '../../check.ts'
import type {LayoutCircuit} from '../../circuit.ts'
import {examples} from '../../layouts.ts'
import type {Spec} from '../../yoga.ts'

const labels: Record<string, string> = {
  W: 'Screen width', H: 'Screen height', title: 'Title text', button: 'Button label',
  heading: 'Heading text', body: 'Body text', cancel: 'Cancel label', confirm: 'Confirm label',
}

// layoutClaims' names, e.g. "title in toolbar: right <= width", in words.
export function says(name: string) {
  const inside = /^(\S+) in (\S+): (left|top|right|bottom)/.exec(name)
  if (inside !== null) return `${inside[1]} stays inside ${inside[2]} on the ${inside[3]}`
  const after = /^(\S+) after (\S+)$/.exec(name)
  if (after !== null) return `${after[1]} doesn't overlap ${after[2]}`
  return name
}

export const overflowClaims = (c: LayoutCircuit, spec: Spec, root: Parameters<typeof layoutClaims>[2]): CheckClaim[] =>
  layoutClaims(c, spec, root).map(claim => ({...claim, says: says(claim.name)}))

function version(exampleName: string, id: string, label: string, expect: 'proven' | 'refuted', roles: Version['roles'], texts: Record<string, string | string[]>): Version {
  const example = examples.find(e => e.name === exampleName)!
  return {
    id, label, expect, roles, texts,
    knobs: example.inputs.map((input): Knob => ({...input, label: labels[input.name] ?? input.name})),
    scenes: c => [{name: 'screen', spec: example.spec, width: c.input('W'), height: c.input('H')}],
    claims: (c, scenes) => overflowClaims(c, example.spec, scenes['screen']!.root),
  }
}

const toolbarRoles: Version['roles'] = {viewport: 'screen', toolbar: 'surface', icon: 'icon', title: 'text', spacer: 'hidden', button: 'button'}
const toolbarTexts = {
  title: [
    'Report',
    'Q3 report',
    'North report',
    'Quarterly report',
    'Q3 report, North region',
    'Quarterly report, North region',
    'Quarterly report for the North region',
    'Quarterly sales report for the North region, Q3 2026',
    'Quarterly sales report for the North region, July to September 2026',
    'Quarterly sales and revenue report for the North region, July to September 2026',
    'Quarterly sales and revenue report for the North region, July to September 2026, draft for review',
    'Quarterly sales and revenue report for the North region and its four districts, July to September 2026, draft for review',
    'Quarterly sales and revenue report for the North region and its four districts, July to September 2026, second draft for review by the finance team',
    'Quarterly sales and revenue report for the North region and its four districts, July to September 2026, with year-on-year comparisons, second draft for review by the finance team and the regional managers',
    'Quarterly sales and revenue report for the North region and its four districts, July to September 2026, with year-on-year comparisons, forecasts for the next two quarters and staffing notes, second draft for review by the finance team and the regional managers before the board meeting',
  ],
  button: ['Share', 'Share it', 'Share link', 'Share report', 'Share this report'],
}
const cardRoles: Version['roles'] = {viewport: 'screen', card: 'surface', heading: 'text', body: 'text', actions: 'hidden', cancel: 'button', confirm: 'button'}
const cardTexts = {
  heading: [
    'Delete?',
    'Delete it?',
    'Delete project?',
    'Delete this project?',
    'Delete the Spring launch?',
    'Delete the Spring launch project?',
    'Delete the Spring launch project for good?',
    'Delete the Spring launch project and all its files?',
    'Delete the Spring launch project and all of its files and history?',
    'Delete the Spring launch project, with all of its files, comments and history?',
    'Delete the Spring launch project for good, with all of its files, comments and history?',
  ],
  body: [
    'Files removed.',
    'Its files will go.',
    'All its files will go.',
    'Its files will be removed.',
    'All of its files will be removed.',
    'Its files and history will be removed.',
    'Its files, comments and history will be removed.',
    'Its files, comments and history will be removed for everyone on the team. This cannot be undone, so download anything you want to keep first.',
  ],
  cancel: [
    'No',
    'Back',
    'Cancel',
    'Keep it',
    'No, keep it',
    'Keep the project',
    'No, keep the project',
    'Cancel, keep the project',
    'No, keep the project as it is',
    'Cancel and keep the project as it is',
    'Cancel and keep the project with its files',
    'No, cancel and keep the project with all of its files',
  ],
  confirm: [
    'Delete',
    'Delete it',
    'Yes, delete',
    'Delete project',
    'Delete the project',
    'Delete project and files',
    'Delete the project and files',
    'Delete project and everything in it',
    'Yes, delete the project and everything in it',
    'Yes, delete the project and everything in it for good',
  ],
}

export const check: Check = {
  id: 'overflow',
  title: 'Nothing sticks out',
  question: 'Can any element stick out of its parent, or overlap its neighbour, at any screen size and text length?',
  examples: [
    {id: 'toolbar', title: 'A toolbar', versions: [
      version('toolbar, title without flexShrink', 'title-without-shrink', 'Title without flexShrink', 'refuted', toolbarRoles, toolbarTexts),
      version('toolbar', 'title-shrinks', 'Title with flexShrink: 1', 'proven', toolbarRoles, toolbarTexts),
    ]},
    {id: 'dialog', title: 'A centered dialog', versions: [
      version('card, buttons as wide as their labels', 'label-sized-buttons', 'Buttons as wide as their labels', 'refuted', cardRoles, cardTexts),
      version('card', 'equal-buttons', 'Equal buttons (flexBasis: 0)', 'proven', cardRoles, cardTexts),
    ]},
  ],
}
