// A layout as a circuit the prover reads: each value that depends on an input,
// e.g. the viewport width or a label's measured width, is a wire, and every
// other value is an FP32 constant, folded while building. An operation
// computes exactly what Yoga's float arithmetic computes: a sum or difference
// rounds once, like `a + b` in C++, and division is IEEE division. A branch
// on a computed value becomes a comparison bit and a select, which returns one
// of its operands exactly, e.g. std::min(a, b) is (b < a) ? b : a.
//
// NaN is Yoga's undefined, and stays a constant: whether a value is defined
// depends only on the style, never on an input.
import {asWire, type Wire} from '../prove/wire.ts'
import {holds, type Operation, type ProvableCircuit, type Relation} from '../prove/circuit.ts'
import {coneOf, evaluatePoint} from '../prove/interval.ts'

export type Ref = {readonly wire: Wire}
export type Num = number | Ref

// An input cell: its declared range and grid, and the value the prover's base
// table gives it.
export type Input = {name: string, low: number, high: number, grid: number, base: number}

export class LayoutCircuit implements ProvableCircuit {
  readonly operations: Operation[] = []
  readonly inputs: readonly Input[]
  private readonly constants = new Map<number, Ref>()
  private readonly existing = new Map<string, Ref>()
  constructor(inputs: readonly Input[]) {
    this.inputs = inputs
  }
  get sourceSize() {
    return this.inputs.length
  }
  input(name: string): Ref {
    const cell = this.inputs.findIndex(input => input.name === name)
    if (cell < 0) throw new Error(`no input ${name}`)
    return {wire: asWire(cell)}
  }
  // An operation identical to an earlier one is that one's wire: Yoga
  // computes the same values in its measuring and laying out passes, and one
  // wire for each lets the prover decide them together.
  append(operation: Operation): Ref {
    const key = JSON.stringify(
      [operation.kind, operation.leftTerms, operation.leftBias, operation.gateTerms, operation.gateBias, operation.relation, operation.extremum],
      // NaN, Infinity and -0 as themselves, which JSON would make null or 0.
      (_, value: unknown) => typeof value === 'number' ? Object.is(value, -0) ? '-0' : String(value) : value,
    )
    const existing = this.existing.get(key)
    if (existing !== undefined) return existing
    this.operations.push(operation)
    const ref = {wire: asWire(this.sourceSize + this.operations.length - 1)}
    this.existing.set(key, ref)
    return ref
  }
  // A constant as a wire, for an operand that must be one.
  wireOf(value: Num): Wire {
    if (typeof value !== 'number') return value.wire
    const key = Object.is(value, -0) ? -0 : value
    let ref = this.constants.get(key)
    if (ref === undefined) {
      ref = this.append({kind: 'affine', leftTerms: [], leftBias: value, gateTerms: [], gateBias: 0})
      this.constants.set(key, ref)
    }
    return ref.wire
  }
  // Every wire's value for the given input values.
  evaluate(inputs: ArrayLike<number>): Float32Array {
    const values = new Float32Array(this.sourceSize + this.operations.length)
    values.set(Array.from(inputs, Math.fround))
    const cone = {operations: Int32Array.from(this.operations, (_, index) => index), sources: this.inputs.map((_, cell) => cell)}
    evaluatePoint(this, cone, values)
    return values
  }
  // The wires a set of wires reads, as the prover's cones.
  cone(wires: readonly Wire[]) {
    return coneOf(this, wires)
  }
}

export const isUndefined = (value: Num) => typeof value === 'number' && Number.isNaN(value)
export const isDefined = (value: Num) => !isUndefined(value)
export const valueOf = (value: Num, values: ArrayLike<number>) => typeof value === 'number' ? value : values[value.wire]!

// A sum of terms in order, as f(f(t1) + t2) + ..., with the constant ones
// folded where they lead. Each step rounds like C++ float addition.
function affine(c: LayoutCircuit, terms: [Num, number][]): Num {
  let bias = 0
  let index = 0
  // Leading constants fold into the bias, in order.
  while (index < terms.length && typeof terms[index]![0] === 'number') {
    const [value, coefficient] = terms[index]! as [number, number]
    bias = index === 0 ? Math.fround(coefficient * value) : Math.fround(bias + Math.fround(coefficient * value))
    index++
  }
  if (index === terms.length) return bias
  // f(bias + f(c × x)) reads the first wire; later terms, constants too, add
  // in order. A sum whose first term is a wire starts at +0, which only
  // changes the sign of a zero.
  const rest = terms.slice(index).map(([value, coefficient]) => [c.wireOf(value), coefficient] as const)
  return c.append({kind: 'affine', leftTerms: rest, leftBias: index === 0 ? 0 : bias, gateTerms: [], gateBias: 0})
}

export const add = (c: LayoutCircuit, a: Num, b: Num): Num =>
  typeof a === 'number' && typeof b === 'number' ? Math.fround(a + b) : affine(c, [[a, 1], [b, 1]])
export const subtract = (c: LayoutCircuit, a: Num, b: Num): Num =>
  typeof a === 'number' && typeof b === 'number' ? Math.fround(a - b) : affine(c, [[a, 1], [b, -1]])
export const negate = (c: LayoutCircuit, a: Num): Num =>
  typeof a === 'number' ? -a : affine(c, [[a, -1]])

export function multiply(c: LayoutCircuit, a: Num, b: Num): Num {
  if (typeof a === 'number' && typeof b === 'number') return Math.fround(a * b)
  if (typeof a === 'number') return Number.isNaN(a) ? Number.NaN : affine(c, [[b, a]])
  if (typeof b === 'number') return Number.isNaN(b) ? Number.NaN : affine(c, [[a, b]])
  return c.append({kind: 'product', leftTerms: [[a.wire, 1], [b.wire, 1]], leftBias: 0, gateTerms: [], gateBias: 0})
}

export function divide(c: LayoutCircuit, a: Num, b: Num): Num {
  if (typeof a === 'number' && typeof b === 'number') return Math.fround(a / b)
  if (isUndefined(a) || isUndefined(b)) return Number.NaN
  const left = typeof a === 'number' ? {leftTerms: [], leftBias: a} : {leftTerms: [[a.wire, 1] as const], leftBias: 0}
  const gate = typeof b === 'number' ? {gateTerms: [], gateBias: b} : {gateTerms: [[b.wire, 1] as const], gateBias: 0}
  return c.append({kind: 'divide', ...left, ...gate})
}

// 1 when a stands in the relation to b, else 0, e.g. compare(c, a, '<', b),
// as IEEE compares them: Infinity == Infinity, and NaN in no relation.
export function compare(c: LayoutCircuit, a: Num, relation: Relation, b: Num): Num {
  if (typeof a === 'number' && typeof b === 'number') return holds(relation, a, b) ? 1 : 0
  if (typeof a === 'number') {
    const flipped = ({'<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', 'number': 'number'} as const)[relation]
    return relation === 'number' ? (Number.isNaN(a) ? 0 : 1) : compare(c, b, flipped, a)
  }
  const leftTerms = typeof b === 'number' ? [[a.wire, 1] as const] : [[a.wire, 1] as const, [b.wire, -1] as const]
  return c.append({kind: 'compare', leftTerms, leftBias: typeof b === 'number' ? -b : 0, gateTerms: [], gateBias: 0, relation})
}

// on when the bit is 1, off when it is 0, exactly, whatever the other is.
export function select(c: LayoutCircuit, bit: Num, off: Num, on: Num, extremum?: {kind: 'minimum' | 'maximum', a: Num, b: Num}): Num {
  if (typeof bit === 'number') return bit === 1 ? on : off
  if (typeof on === 'number' && typeof off === 'number' && Object.is(on, off)) return on
  if (typeof on !== 'number' && typeof off !== 'number' && on.wire === off.wire) return on
  const leftTerms = [[bit.wire, 1], [c.wireOf(off), 1], [c.wireOf(on), 1]] as const
  return c.append({
    kind: 'select', leftTerms, leftBias: 0, gateTerms: [], gateBias: 0,
    extremum: extremum === undefined ? undefined : {kind: extremum.kind, a: c.wireOf(extremum.a), b: c.wireOf(extremum.b)},
  })
}

// std::min and std::max: (b < a) ? b : a and (a < b) ? b : a.
export const minimum = (c: LayoutCircuit, a: Num, b: Num) => select(c, compare(c, b, '<', a), a, b, {kind: 'minimum', a, b})
export const maximum = (c: LayoutCircuit, a: Num, b: Num) => select(c, compare(c, a, '<', b), a, b, {kind: 'maximum', a, b})

// Yoga's maxOrDefined and minOrDefined: the other value when one is undefined.
export const maxOrDefined = (c: LayoutCircuit, a: Num, b: Num) => isUndefined(a) ? b : isUndefined(b) ? a : maximum(c, a, b)
export const minOrDefined = (c: LayoutCircuit, a: Num, b: Num) => isUndefined(a) ? b : isUndefined(b) ? a : minimum(c, a, b)

// Bits.
export const and = (c: LayoutCircuit, a: Num, b: Num): Num =>
  typeof a === 'number' ? (a === 1 ? b : 0) : typeof b === 'number' ? (b === 1 ? a : 0) : select(c, a, 0, b)
export const not = (c: LayoutCircuit, a: Num): Num => typeof a === 'number' ? 1 - a : affine(c, [[1, 1], [a, -1]])
export const or = (c: LayoutCircuit, a: Num, b: Num): Num => not(c, and(c, not(c, a), not(c, b)))
