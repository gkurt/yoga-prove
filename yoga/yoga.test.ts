import {expect, test} from 'bun:test'
import {LayoutCircuit, valueOf, type Input} from './circuit.ts'
import {createRandom, randomInputs, randomTree} from './fuzz.ts'
import {yogaLayout, type Box} from './oracle.ts'
import {layout, type Layout, type Spec} from './yoga.ts'

// Every box as name: left top width height, for comparing whole layouts.
const flatten = (box: Layout | Box, values?: ArrayLike<number>): string[] => [
  `${box.name}: ${[box.left, box.top, box.width, box.height].map(value => values === undefined ? value as number : valueOf(value as never, values)).join(' ')}`,
  ...box.children.flatMap(child => flatten(child, values)),
]

// The spec with its inputs replaced by their values.
function withValues(spec: Spec, named: Record<string, number>): Spec {
  return {
    ...spec,
    ...(spec.measure === undefined ? {} : {measure: {
      width: typeof spec.measure.width === 'string' ? named[spec.measure.width]! : spec.measure.width,
      height: typeof spec.measure.height === 'string' ? named[spec.measure.height]! : spec.measure.height,
    }}),
    ...(spec.children === undefined ? {} : {children: spec.children.map(child => withValues(child, named))}),
  }
}

function check(spec: Spec, inputs: readonly Input[], samples: readonly number[][]) {
  const circuit = new LayoutCircuit(inputs)
  const wired = layout(circuit, spec, circuit.input('W'), circuit.input('H'))
  let compared = 0
  for (const values of samples) {
    const named = Object.fromEntries(inputs.map((input, index) => [input.name, values[index]!]))
    const expected = flatten(yogaLayout(spec, named['W']!, named['H']!, named))
    const constants = new LayoutCircuit(inputs)
    const ported = flatten(layout(constants, withValues(spec, named), Math.fround(named['W']!), Math.fround(named['H']!)))
    const evaluated = flatten(wired, circuit.evaluate(values))
    if (ported.join('\n') !== expected.join('\n') || evaluated.join('\n') !== expected.join('\n')) {
      throw new Error(`mismatch for ${JSON.stringify(named)} in ${JSON.stringify(spec)}\nyoga:\n${expected.join('\n')}\nport:\n${ported.join('\n')}\ncircuit:\n${evaluated.join('\n')}`)
    }
    compared++
  }
  return compared
}

test('the port and its circuits lay out random trees exactly as Yoga does', () => {
  const random = createRandom(1)
  let compared = 0
  for (let tree = 0; tree < 300; tree++) {
    const {spec, inputs} = randomTree(random)
    compared += check(spec, inputs, Array.from({length: 20}, () => randomInputs(random, inputs)))
  }
  expect(compared).toBe(6000)
}, 120_000)
