// Interval evaluation of a handwired circuit: for a box of source values, a
// range per wire that holds every FP32 value the reference evaluator can
// produce for a source table inside the box.
//
// It runs the reference evaluator's own FP32 steps on the endpoints. Every
// step is monotone: f(x) = Math.fround(x) never decreases, a sum
// f(value + f(c × x)) grows with value and, for c > 0, with x, and a boolean
// atom f(f(score + K) - K) grows with its score. So the step at the lower
// endpoints is a lower bound, without widening for rounding, and one
// operation's bound is the exact range of that operation for its operands'
// ranges. What loses precision is reuse: min(a, b) = a - relu(a - b) reads a
// twice, and the interval of a - b forgets that the two a's are the same. A
// smaller box loses less, and a box of one point gives the point's value.
import type {Wire} from './wire.ts'
import {comparedValues, holds, operandsOf, type ProvableCircuit as Circuit, type Relation} from './circuit.ts'

type Operation = Circuit['operations'][number]
type Terms = Operation['leftTerms']

// The operations a set of wires reads, directly or through other operations,
// in program order, and the source cells they read.
export type Cone = {operations: Int32Array, sources: number[]}

export function coneOf(circuit: Circuit, wires: readonly Wire[]): Cone {
  const seen = new Uint8Array(circuit.sourceSize + circuit.operations.length)
  const pending = [...wires]
  while (pending.length > 0) {
    const wire = pending.pop()!
    if (seen[wire] === 1) continue
    seen[wire] = 1
    if (wire < circuit.sourceSize) continue
    const operation = circuit.operations[wire - circuit.sourceSize]!
    for (const [input] of operation.leftTerms) pending.push(input)
    for (const [input] of operation.gateTerms) pending.push(input)
    for (const candidate of operation.indexRead?.table.candidates ?? []) pending.push(candidate)
  }
  const operations: number[] = []
  const sources: number[] = []
  for (let wire = 0; wire < seen.length; wire++) {
    if (seen[wire] !== 1) continue
    if (wire < circuit.sourceSize) sources.push(wire)
    else operations.push(wire - circuit.sourceSize)
  }
  return {operations: Int32Array.from(operations), sources}
}

// lemmaLow and lemmaHigh hold ranges already proven for every allowed source
// table, ±Infinity where nothing is proven; each operation's range is
// intersected with its lemma.
export type Ranges = {low: Float64Array, high: Float64Array, lemmaLow: Float64Array, lemmaHigh: Float64Array}

export function createRanges(circuit: Circuit): Ranges {
  const width = circuit.sourceSize + circuit.operations.length
  return {
    low: new Float64Array(width),
    high: new Float64Array(width),
    lemmaLow: new Float64Array(width).fill(-Infinity),
    lemmaHigh: new Float64Array(width).fill(Infinity),
  }
}

function termsRange(ranges: Ranges, terms: Terms, bias: number, out: [number, number]) {
  let low = Math.fround(bias)
  let high = low
  for (const [wire, coefficient] of terms) {
    const c = Math.fround(coefficient)
    // 0 × NaN or an infinity is NaN.
    if (c === 0) {
      if (!Number.isFinite(ranges.low[wire]! + ranges.high[wire]!)) low = high = Number.NaN
      continue
    }
    if (c > 0) {
      low = Math.fround(low + Math.fround(c * ranges.low[wire]!))
      high = Math.fround(high + Math.fround(c * ranges.high[wire]!))
    } else {
      low = Math.fround(low + Math.fround(c * ranges.high[wire]!))
      high = Math.fround(high + Math.fround(c * ranges.low[wire]!))
    }
  }
  out[0] = low
  out[1] = high
}

function booleanAtom(value: number) {
  const base = 8_388_609
  return Math.fround(Math.fround(Math.fround(value) + base) - base)
}

const left: [number, number] = [0, 0]
const gate: [number, number] = [0, 0]

// 1 or 0 when every value within low..high stands, or doesn't, in the
// relation to 0; undefined when some do and some don't. A value that can be
// NaN, e.g. 0 / 0, has the whole line as its range, see intervalStep, and NaN
// stands in no relation.
export function decidedComparison(relation: Relation, low: number, high: number): 0 | 1 | undefined {
  if (!(low <= high)) return undefined
  const mayBeNaN = low === -Infinity && high === Infinity
  if (relation === 'number') return mayBeNaN ? undefined : 1
  if (mayBeNaN) return undefined
  const always = relation === '<' ? high < 0 : relation === '<=' ? high <= 0 : relation === '>' ? low > 0 : relation === '>=' ? low >= 0 : low === 0 && high === 0
  const never = relation === '<' ? low >= 0 : relation === '<=' ? low > 0 : relation === '>' ? high <= 0 : relation === '>=' ? high < 0 : low > 0 || high < 0
  return always ? 1 : never ? 0 : undefined
}

// One operation's range from its operands' ranges, intersected with its lemma.
// Returns false when nothing is left. A NaN bound, e.g. from
// Infinity - Infinity, becomes the whole line, which proves nothing.
export function intervalStep(circuit: Circuit, index: number, ranges: Ranges): boolean {
  const {low, high, lemmaLow, lemmaHigh} = ranges
  const operation = circuit.operations[index]!
  const wire = circuit.sourceSize + index
  let minimum = Infinity
  let maximum = -Infinity
  if (operation.kind === 'index') {
    termsRange(ranges, operation.gateTerms, operation.gateBias, gate)
    const read = operation.indexRead!
    const count = read.table.candidates.length
    const first = Math.floor(gate[0])
    const last = Math.floor(gate[1])
    const include = (position: number) => {
      const candidate = read.table.candidates[position]!
      minimum = Math.min(minimum, low[candidate]!)
      maximum = Math.max(maximum, high[candidate]!)
    }
    const includeZero = () => {
      minimum = Math.min(minimum, 0)
      maximum = Math.max(maximum, 0)
    }
    if (Number.isNaN(first) || Number.isNaN(last)) {
      minimum = Number.NaN
    } else {
      if (first < 0) {
        if (read.below === 'zero') includeZero()
        else include(0)
      }
      if (last > count - 1) {
        if (read.above === 'zero') includeZero()
        else include(count - 1)
      }
      for (let position = Math.max(0, first); position <= Math.min(count - 1, last); position++) include(position)
    }
  } else if (operation.kind === 'select') {
    const [bit, off, on] = operandsOf(operation) as [Wire, Wire, Wire]
    if (low[bit]! >= 1) {
      minimum = low[on]!
      maximum = high[on]!
    } else if (high[bit]! <= 0) {
      minimum = low[off]!
      maximum = high[off]!
    } else {
      minimum = Math.min(low[off]!, low[on]!)
      maximum = Math.max(high[off]!, high[on]!)
    }
  } else if (operation.kind === 'product') {
    const [a, b] = operandsOf(operation) as [Wire, Wire]
    const corners = [low[a]! * low[b]!, low[a]! * high[b]!, high[a]! * low[b]!, high[a]! * high[b]!].map(Math.fround)
    minimum = Math.min(...corners)
    maximum = Math.max(...corners)
  } else {
    termsRange(ranges, operation.leftTerms, operation.leftBias, left)
    if (operation.kind === 'affine') {
      minimum = left[0]
      maximum = left[1]
    } else if (operation.kind === 'boolean') {
      minimum = booleanAtom(left[0])
      maximum = booleanAtom(left[1])
    } else if (operation.kind === 'compare') {
      // A bit that the whole range decides, or either.
      const bit = decidedComparison(operation.relation!, left[0], left[1])
      minimum = bit ?? 0
      maximum = bit ?? 1
    } else if (operation.kind === 'divide') {
      // Monotone in each operand while the divisor keeps its sign, so the
      // corners bound it; a divisor that can be 0 bounds nothing.
      termsRange(ranges, operation.gateTerms, operation.gateBias, gate)
      if (gate[0] > 0 || gate[1] < 0) {
        const corners = [left[0] / gate[0], left[0] / gate[1], left[1] / gate[0], left[1] / gate[1]].map(Math.fround)
        minimum = Math.min(...corners)
        maximum = Math.max(...corners)
      } else {
        minimum = Number.NaN
      }
    } else {
      termsRange(ranges, operation.gateTerms, operation.gateBias, gate)
      const g0 = Math.max(0, gate[0])
      const g1 = Math.max(0, gate[1])
      const a = Math.fround(left[0] * g0)
      const b = Math.fround(left[0] * g1)
      const c = Math.fround(left[1] * g0)
      const d = Math.fround(left[1] * g1)
      minimum = Math.min(a, b, c, d)
      maximum = Math.max(a, b, c, d)
    }
  }
  if (Number.isNaN(minimum) || Number.isNaN(maximum)) {
    minimum = -Infinity
    maximum = Infinity
  }
  minimum = Math.max(minimum, lemmaLow[wire]!)
  maximum = Math.min(maximum, lemmaHigh[wire]!)
  if (minimum > maximum) return false
  low[wire] = minimum
  high[wire] = maximum
  return true
}

// Fills the ranges of the cone's operations; the caller has set the ranges of
// the cone's sources. Returns false when a lemma leaves an operation no
// value, i.e. the box holds no allowed source table.
export function evaluateIntervals(circuit: Circuit, cone: Cone, ranges: Ranges): boolean {
  for (let k = 0; k < cone.operations.length; k++) {
    if (!intervalStep(circuit, cone.operations[k]!, ranges)) return false
  }
  return true
}

// The same cone at one point, as the reference evaluator computes it: values
// holds the source table in its first cells.
export function evaluatePoint(circuit: Circuit, cone: Cone, values: Float32Array) {
  const sourceSize = circuit.sourceSize
  const sum = (terms: Terms, bias: number) => {
    let value = Math.fround(bias)
    for (const [wire, coefficient] of terms) value = Math.fround(value + Math.fround(Math.fround(coefficient) * values[wire]!))
    return value
  }
  for (let k = 0; k < cone.operations.length; k++) {
    const index = cone.operations[k]!
    const operation = circuit.operations[index]!
    let value: number
    if (operation.kind === 'index') {
      const read = operation.indexRead!
      const at = sum(operation.gateTerms, operation.gateBias)
      const count = read.table.candidates.length
      const position = Math.floor(at)
      if (Number.isNaN(at)) value = Number.NaN
      else if (position < 0) value = read.below === 'zero' ? 0 : values[read.table.candidates[0]!]!
      else if (position > count - 1) value = read.above === 'zero' ? 0 : values[read.table.candidates[count - 1]!]!
      else value = values[read.table.candidates[position]!]!
    } else if (operation.kind === 'select') {
      const [bit, off, on] = operandsOf(operation) as [Wire, Wire, Wire]
      value = values[bit]! === 1 ? values[on]! : values[off]!
    } else if (operation.kind === 'product') {
      const [a, b] = operandsOf(operation) as [Wire, Wire]
      value = Math.fround(values[a]! * values[b]!)
    } else {
      value = sum(operation.leftTerms, operation.leftBias)
      if (operation.kind === 'reglu') value = Math.fround(value * Math.max(0, sum(operation.gateTerms, operation.gateBias)))
      else if (operation.kind === 'boolean') value = booleanAtom(value)
      else if (operation.kind === 'compare') value = holds(operation.relation!, ...comparedValues(operation, values)) ? 1 : 0
      else if (operation.kind === 'divide') value = Math.fround(value / sum(operation.gateTerms, operation.gateBias))
    }
    values[sourceSize + index] = value
  }
}
