// Two everyday layouts, each as it should be and with the classic bug that a
// screenshot test misses until someone's label is long or their window narrow.
// Text is a measured leaf: its content width is an input, any value in its
// range, and it reports min(available, content) when Yoga gives it at most a
// width, like a label that truncates with an ellipsis.
import type {Input} from './circuit.ts'
import type {Spec} from './yoga.ts'

export type Example = {name: string, spec: Spec, inputs: Input[]}

const viewport: Input[] = [
  {name: 'W', low: 320, high: 2560, grid: 1 / 64, base: 1280},
  {name: 'H', low: 480, high: 1600, grid: 1 / 64, base: 800},
]

// An app bar: icon, title, a spacer that takes the rest, and a button. The
// title may shrink; the button keeps its size.
function toolbar(titleShrinks: boolean): Spec {
  return {
    name: 'viewport',
    children: [{
      name: 'toolbar', style: {flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8},
      children: [
        {name: 'icon', style: {width: 24, height: 24}},
        {name: 'title', style: titleShrinks ? {flexShrink: 1} : {}, measure: {width: 'title', height: 20}},
        {name: 'spacer', style: {flexGrow: 1}},
        {name: 'button', style: {padding: {left: 12, right: 12, top: 6, bottom: 6}}, measure: {width: 'button', height: 20}},
      ],
    }],
  }
}

const toolbarInputs: Input[] = [
  ...viewport,
  {name: 'title', low: 0, high: 2000, grid: 1 / 64, base: 180},
  {name: 'button', low: 0, high: 120, grid: 1 / 64, base: 56},
]

// A card centered in the viewport, at most 480 wide, with a title, a body and
// two buttons that share a row and may shrink below their labels: of equal
// width, or each as wide as its label. The second looks as safe and isn't: a
// centered card's width is its content's, and Yoga measures the row of
// buttons as one label clamped to the card plus the other button and the
// gap, so a long label pushes the card past the viewport.
function card(equalButtons: boolean): Spec {
  const button = (name: string): Spec => ({
    name, style: {flexGrow: 1, flexShrink: 1, ...(equalButtons ? {flexBasis: 0} : {}), padding: {left: 16, right: 16, top: 8, bottom: 8}},
    measure: {width: name, height: 20},
  })
  return {
    name: 'viewport', style: {alignItems: 'center', justifyContent: 'center', padding: 16},
    children: [{
      name: 'card', style: {maxWidth: 480, padding: 16, gap: 12},
      children: [
        {name: 'heading', measure: {width: 'heading', height: 28}},
        {name: 'body', measure: {width: 'body', height: 60}},
        {name: 'actions', style: {flexDirection: 'row', gap: 8}, children: [button('cancel'), button('confirm')]},
      ],
    }],
  }
}

const cardInputs: Input[] = [
  ...viewport,
  {name: 'heading', low: 0, high: 1000, grid: 1 / 64, base: 200},
  {name: 'body', low: 0, high: 1000, grid: 1 / 64, base: 400},
  {name: 'cancel', low: 0, high: 400, grid: 1 / 64, base: 60},
  {name: 'confirm', low: 0, high: 400, grid: 1 / 64, base: 70},
]

export const examples: Example[] = [
  {name: 'toolbar', spec: toolbar(true), inputs: toolbarInputs},
  {name: 'toolbar, title without flexShrink', spec: toolbar(false), inputs: toolbarInputs},
  {name: 'card', spec: card(true), inputs: cardInputs},
  {name: 'card, buttons as wide as their labels', spec: card(false), inputs: cardInputs},
]
