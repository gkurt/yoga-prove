// Translations: German and Finnish labels often run 30 to 50% longer than
// English ones. Each label's width is its own input, from its English width
// to 1.5 times it, so a proof covers every mix: one label translated long and
// its neighbour short as well as all of them long. Nothing may stick out of
// its parent or overlap its neighbour, and a label that must be read in full
// may not be cut off.
//
// English widths are measured from the text at the stated size with the
// system font; heights don't change with the language.
import type {Check, Knob, Version} from '../../check.ts'
import type {Spec} from '../../yoga.ts'
import {fullTextClaims, phoneHeight, phoneWidth} from '../font-scale/check.ts'
import {overflowClaims} from '../overflow/check.ts'

// A label's width, from its English width to 1.5 times it, on the 1/64 px grid.
const translated = (name: string, text: string, english: number): Knob =>
  ({name, label: `“${text}” translated`, low: english, high: english * 1.5, grid: 1 / 64, base: english})

// A segmented control to pick a calendar's range: Day, Week, Month, Year at
// 13 pt semibold (27, 37, 43 and 31 px wide in English, 18 px line). As first
// written, the segments are of equal width (flexBasis: 0), as iOS's
// UISegmentedControl makes them by default. Fixed, each starts at its
// label's width and the segments share what is left.
function segmented(equalWidths: boolean): Spec {
  const segment = (name: string): Spec => ({
    name: `${name}Segment`,
    style: {flexGrow: 1, flexShrink: 1, ...(equalWidths ? {flexBasis: 0} : {}), alignItems: 'center', padding: {left: 8, right: 8, top: 6, bottom: 6}},
    children: [{name, measure: {width: name, height: 18}}],
  })
  return {
    name: 'screen', style: {padding: 16},
    children: [{name: 'control', style: {flexDirection: 'row', padding: 2}, children: ['day', 'week', 'month', 'year'].map(segment)}],
  }
}

const segmentedKnobs = [phoneWidth, phoneHeight, translated('day', 'Day', 27), translated('week', 'Week', 37), translated('month', 'Month', 43), translated('year', 'Year', 31)]
// Each label in English and in translations of it, shortest to longest.
const segmentedTexts = {
  day: ['Day', 'Jour', 'Päivä', 'Giorno'],
  week: ['Week', 'Woche', 'Semana', 'Semaine'],
  month: ['Month', 'Miesiąc', 'Mėnesis', 'Kuukausi'],
  year: ['Year', 'Vuosi', 'Année', 'Godina'],
}
const segmentedRoles: Version['roles'] = {
  screen: 'screen', control: 'surface',
  ...Object.fromEntries(Object.keys(segmentedTexts).flatMap(name => [[`${name}Segment`, 'button'], [name, 'text']])),
}

// A navigation bar over a form, 44 px tall: Cancel on the left, the title,
// Save on the right, all at 17 pt (Cancel 53 px, "Edit profile" 88 px
// semibold, Save 38 px semibold, 22 px line). As first written, each button
// sits in a slot 72 px wide, so that the title stays centered. Fixed, the
// slots are at least 72 px. The title may shrink and end in an ellipsis, as
// titles do; the buttons may not.
function navigationBar(slotWidth: 'width' | 'minWidth'): Spec {
  return {
    name: 'screen',
    children: [{
      name: 'bar', style: {flexDirection: 'row', alignItems: 'center', height: 44, padding: {left: 8, right: 8}},
      children: [
        {name: 'cancelSlot', style: {[slotWidth]: 72, alignItems: 'flex-start'}, children: [{name: 'cancel', measure: {width: 'cancel', height: 22}}]},
        {name: 'title', style: {flexGrow: 1, flexShrink: 1}, measure: {width: 'title', height: 22}},
        {name: 'saveSlot', style: {[slotWidth]: 72, alignItems: 'flex-end'}, children: [{name: 'save', measure: {width: 'save', height: 22}}]},
      ],
    }],
  }
}

const navigationKnobs = [phoneWidth, phoneHeight, translated('cancel', 'Cancel', 53), translated('title', 'Edit profile', 88), translated('save', 'Save', 38)]
const navigationTexts = {
  cancel: ['Cancel', 'Annuler', 'Cancelar', 'Annuleren'],
  title: ['Edit profile', 'Upravit profil', 'Redigera profil', 'Modifica profilo', 'Profil bearbeiten'],
  save: ['Save', 'Spara', 'Zapisz', 'Mentés'],
}
const navigationRoles: Version['roles'] = {screen: 'screen', bar: 'surface', cancelSlot: 'container', cancel: 'text', title: 'text', saveSlot: 'container', save: 'text'}

function version(id: string, label: string, expect: Version['expect'], spec: Spec, knobs: Knob[], roles: Version['roles'], texts: Record<string, string[]>, full: string[]): Version {
  // The claims name each label by its English, its first wording.
  const english = Object.fromEntries(Object.entries(texts).map(([name, wordings]) => [name, wordings[0]!]))
  return {
    id, label, expect, roles, texts, knobs,
    scenes: c => [{name: 'screen', spec, width: c.input('W'), height: c.input('H')}],
    claims: (c, scenes) => {
      const root = scenes['screen']!.root
      return [...overflowClaims(c, spec, root), ...fullTextClaims(c, spec, root, english, full)]
    },
  }
}

export const check: Check = {
  id: 'translations',
  title: 'Longer translations',
  question: 'Does the layout hold when every label is up to 1.5 times as long as in English, as in German or Finnish?',
  examples: [
    {id: 'segmented-control', title: 'A segmented control', versions: [
      version('equal-segments', 'Segments of equal width (flexBasis: 0)', 'refuted', segmented(true), segmentedKnobs, segmentedRoles, segmentedTexts, ['day', 'week', 'month', 'year']),
      version('sized-segments', 'Segments sized by their labels (flexBasis: auto)', 'proven', segmented(false), segmentedKnobs, segmentedRoles, segmentedTexts, ['day', 'week', 'month', 'year']),
    ]},
    {id: 'navigation-bar', title: 'A navigation bar', versions: [
      version('fixed-slots', 'Button slots with width: 72', 'refuted', navigationBar('width'), navigationKnobs, navigationRoles, navigationTexts, ['cancel', 'save']),
      version('min-slots', 'Button slots with minWidth: 72', 'proven', navigationBar('minWidth'), navigationKnobs, navigationRoles, navigationTexts, ['cancel', 'save']),
    ]},
  ],
}
