// What the prover reads of a circuit: its source count and its operations.
// A Handwired circuit is one (wire.ts); yoga/ builds others, whose operations
// add kinds that Handwired has no instruction for, each exactly as IEEE FP32
// computes it:
//
// - 'divide': f(left / gate), the left form divided by the gate form, e.g. a
//   flex item's share of the free space.
// - 'product': f(a × b) for leftTerms [[a, 1], [b, 1]].
// - 'compare': 1 when a stands in `relation` to b as IEEE compares them, else
//   0, for leftTerms [[a, 1], [b, -1]], or [[a, 1]] with leftBias -b for a
//   constant b. Bounds read the left form, a - b: the FP32 difference of two
//   finite values has the sign of the real one and is 0 only when they are
//   equal, and a value that can be infinite has the whole line as its range,
//   which decides nothing, e.g. Infinity == Infinity while their difference is
//   NaN. NaN stands in no relation.
// - 'select': on when the bit is 1, else off, for leftTerms [[bit, 1], [off,
//   1], [on, 1]]. Unlike handwired's masked products, the unselected operand
//   may be Infinity or NaN, as in Yoga's arithmetic. `extremum` says that it
//   picks min(a, b) or max(a, b), which the bounds of backward.ts use: min(a,
//   b) <= a and <= b.
import type {HandwiredOperation, Wire} from './wire.ts'

// 'number' holds for every value but NaN, Yoga's isDefined.
export type Relation = '<' | '<=' | '>' | '>=' | '==' | 'number'

export type Operation = Pick<HandwiredOperation, 'leftTerms' | 'leftBias' | 'gateTerms' | 'gateBias' | 'indexRead' | 'macro'> & {
  kind: HandwiredOperation['kind'] | 'divide' | 'product' | 'compare' | 'select'
  relation?: Relation | undefined
  extremum?: {kind: 'minimum' | 'maximum', a: Wire, b: Wire} | undefined
}

export type ProvableCircuit = {readonly sourceSize: number, readonly operations: readonly Operation[]}

// The wires of a select, [bit, off, on], or of a product, [a, b].
export const operandsOf = (operation: Operation) => operation.leftTerms.map(([wire]) => wire)

export function holds(relation: Relation, a: number, b: number) {
  return relation === '<' ? a < b : relation === '<=' ? a <= b : relation === '>' ? a > b : relation === '>=' ? a >= b
    : relation === '==' ? a === b : !Number.isNaN(a)
}

// A compare operation's operands as values.
export function comparedValues(operation: Operation, values: ArrayLike<number>): [number, number] {
  const [first, second] = operation.leftTerms
  return [values[first![0]]!, second === undefined ? -operation.leftBias : values[second[0]]!]
}
