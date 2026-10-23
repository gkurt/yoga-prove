import {expect, test} from 'bun:test'
import {backwardBound} from '../prove/backward.ts'
import {createRanges, evaluateIntervals, evaluatePoint} from '../prove/interval.ts'
import {claimCone, prove} from '../prove/prove.ts'
import {createSymbolic, evaluateSymbolic} from '../prove/symbolic.ts'
import {LayoutCircuit, type Input} from './circuit.ts'
import {layoutClaims} from './claims.ts'
import {sweep} from './sweep.ts'
import {createRandom, randomInputs, randomTree} from './fuzz.ts'
import {examples} from './layouts.ts'
import {yogaLayout, type Box} from './oracle.ts'
import {layout, type Spec} from './yoga.ts'

const onGrid = (random: () => number, low: number, high: number, grid: number) => low + Math.floor(random() * ((high - low) / grid + 1)) * grid

test('interval, symbolic and back-substituted bounds hold every value of random points in random boxes of layout circuits', () => {
  const random = createRandom(5)
  let checked = 0
  for (let tree = 0; tree < 60; tree++) {
    const {spec, inputs} = randomTree(random)
    const c = new LayoutCircuit(inputs)
    const claims = layoutClaims(c, spec, layout(c, spec, c.input('W'), c.input('H')))
    for (const claim of claims.filter((_, index) => index % 3 === 0)) {
      const cone = claimCone(c, claim)
      const plain = createRanges(c)
      const ranges = createRanges(c)
      const symbolic = createSymbolic(c, cone, inputs.map((_, cell) => cell), inputs.map(input => input.grid))
      const values = new Float32Array(c.sourceSize + c.operations.length)
      for (let box = 0; box < 4; box++) {
        // Boxes from the whole range down to a few grid steps.
        const low = inputs.map(input => onGrid(random, input.low, input.high, input.grid))
        const high = inputs.map((input, cell) => Math.min(input.high, onGrid(random, low[cell]!, low[cell]! + (input.high - input.low) * random() ** 4, input.grid)))
        inputs.forEach((_, cell) => {
          plain.low[cell] = ranges.low[cell] = low[cell]!
          plain.high[cell] = ranges.high[cell] = high[cell]!
        })
        expect(evaluateIntervals(c, cone, plain)).toBe(true)
        expect(evaluateSymbolic(c, cone, ranges, symbolic)).toBe(true)
        const backLow = backwardBound(c, cone, ranges, symbolic, claim.wire, false)
        const backHigh = backwardBound(c, cone, ranges, symbolic, claim.wire, true)
        for (let point = 0; point < 12; point++) {
          inputs.forEach((input, cell) => {
            values[cell] = random() < 0.2 ? (random() < 0.5 ? low[cell]! : high[cell]!) : onGrid(random, low[cell]!, high[cell]!, input.grid)
          })
          evaluatePoint(c, cone, values)
          const claimed = values[claim.wire]!
          if (!Number.isNaN(claimed) && !(claimed >= backLow && claimed <= backHigh)) {
            throw new Error(`back-substituted bounds of ${claim.name}: ${claimed} outside ${backLow}..${backHigh} in ${JSON.stringify(spec)}`)
          }
          for (const index of cone.operations) {
            const wire = c.sourceSize + index
            const value = values[wire]!
            if (Number.isNaN(value)) continue
            for (const bounds of [plain, ranges]) {
              if (!(value >= bounds.low[wire]! && value <= bounds.high[wire]!)) {
                throw new Error(`${bounds === plain ? 'interval' : 'symbolic'} bounds of wire ${wire} (${c.operations[index]!.kind}) in ${claim.name}: ${value} outside ${bounds.low[wire]}..${bounds.high[wire]}`)
              }
            }
            checked++
          }
        }
      }
    }
  }
  expect(checked).toBeGreaterThan(100_000)
}, 120_000)

// The claim's value in a Yoga layout, by the box names in the claim's name.
function inYoga(spec: Spec, inputs: readonly Input[], source: Float32Array, claim: string) {
  const named = Object.fromEntries(inputs.map((input, cell) => [input.name, source[cell]!]))
  const boxes = new Map<string, Box>()
  const parents = new Map<string, Box>()
  const visit = (box: Box) => {
    boxes.set(box.name, box)
    for (const child of box.children) {
      parents.set(child.name, box)
      visit(child)
    }
  }
  visit(yogaLayout(spec, named['W']!, named['H']!, named))
  const [, name, parent, edge] = /^(\S+) in (\S+): (.*)$/.exec(claim)!
  const box = boxes.get(name!)!
  const parentBox = boxes.get(parent!)!
  expect(parents.get(name!)).toBe(parentBox)
  if (edge === 'left >= 0') return box.left
  // In FP32, as the claim's wire computes it.
  if (edge === 'right <= width') return Math.fround(Math.fround(box.left + box.width) - parentBox.width)
  throw new Error(`no check for ${claim}`)
}

const proveExample = (name: string, claimName: string, timeLimit: number) => {
  const example = examples.find(e => e.name === name)!
  const c = new LayoutCircuit(example.inputs)
  const claim = layoutClaims(c, example.spec, layout(c, example.spec, c.input('W'), c.input('H'))).find(cl => cl.name === claimName)!
  const variablesOf = (cell: number) => cell < example.inputs.length ? {cell, ...example.inputs[cell]!} : null
  return {example, proof: prove(c, claim, Float32Array.from(example.inputs, input => input.base), variablesOf, [], {timeLimit})}
}

test('the toolbar title stays inside the toolbar for every viewport and label width', () => {
  const {proof} = proveExample('toolbar', 'title in toolbar: right <= width', 60_000)
  expect(proof.status).toBe('proven')
}, 120_000)

test('without flexShrink, the title overflows, at a width and label Yoga confirms', () => {
  const {example, proof} = proveExample('toolbar, title without flexShrink', 'button in toolbar: right <= width', 10_000)
  if (proof.status !== 'refuted') throw new Error(`expected a counterexample, got ${proof.status}`)
  expect(inYoga(example.spec, example.inputs, proof.source, 'button in toolbar: right <= width')).toBe(proof.value)
  expect(proof.value).toBeGreaterThan(0)
})

test('a centered card with buttons as wide as their labels leaves the viewport, at a width and labels Yoga confirms', () => {
  const {example, proof} = proveExample('card, buttons as wide as their labels', 'card in viewport: left >= 0', 10_000)
  if (proof.status !== 'refuted') throw new Error(`expected a counterexample, got ${proof.status}`)
  expect(inYoga(example.spec, example.inputs, proof.source, 'card in viewport: left >= 0')).toBe(proof.value)
  expect(proof.value).toBeLessThan(0)
})

test('random layouts: the port at random inputs agrees with the counterexample checks', () => {
  // inYoga reads Yoga's own boxes, so it is checked against the circuit here.
  const random = createRandom(9)
  const example = examples.find(e => e.name === 'card')!
  const c = new LayoutCircuit(example.inputs)
  const claims = layoutClaims(c, example.spec, layout(c, example.spec, c.input('W'), c.input('H')))
  for (let trial = 0; trial < 50; trial++) {
    const source = Float32Array.from(randomInputs(random, example.inputs))
    const values = c.evaluate(source)
    for (const claim of claims.filter(cl => /: (left >= 0|right <= width)$/.test(cl.name))) {
      expect(inYoga(example.spec, example.inputs, source, claim.name)).toBe(values[claim.wire]!)
    }
  }
})

test('sweeping changes no claim\'s value, even when few tables group many wires that differ', () => {
  const random = createRandom(11)
  let merged = 0
  for (let tree = 0; tree < 16; tree++) {
    const {spec, inputs} = randomTree(random)
    const c = new LayoutCircuit(inputs)
    const claims = layoutClaims(c, spec, layout(c, spec, c.input('W'), c.input('H')))
    // With 4 tables, wires that agree on them but not everywhere are tried
    // too, and only a proof may merge them.
    const swept = sweep(c, claims, {samples: tree % 2 === 0 ? 4 : 64, pairTimeLimit: 100, seed: tree})
    merged += swept.merged
    for (let point = 0; point < 200; point++) {
      const source = inputs.map(input => random() < 0.2 ? (random() < 0.5 ? input.low : input.high) : onGrid(random, input.low, input.high, input.grid))
      const before = c.evaluate(source)
      const after = swept.circuit.evaluate(source)
      claims.forEach((claim, index) => {
        const a = before[claim.wire]!
        const b = after[swept.claims[index]!.wire]!
        if (!Object.is(a, b)) throw new Error(`${claim.name}: ${a} before sweeping, ${b} after, at ${source.join(', ')} in ${JSON.stringify(spec)}`)
      })
    }
  }
  expect(merged).toBeGreaterThan(100)
}, 300_000)
