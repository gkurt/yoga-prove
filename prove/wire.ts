// What the prover needs of the handwired runtime's circuit format, copied from
// handwired's src/runtime/numeric-ui-core.ts so this repo stands alone. The
// layouts here build only 'affine' operations and the kinds circuit.ts adds,
// but the prover still reads handwired's own atoms ('reglu', 'boolean' and
// 'index'), so their shape stays.

declare const wireBrand: unique symbol

// A wire is a position in the array an evaluation fills: source cells first,
// then one position per operation. It's a number with a type of its own, so a
// plain number doesn't type-check as a wire.
export type Wire = number & {readonly [wireBrand]: true}

// A position counted by hand as a wire, e.g. the position of a source cell.
export function asWire(position: number): Wire {
  if (!(Number.isInteger(position) && position >= 0)) throw new Error(`a wire must be a nonnegative integer, got ${position}`)
  return position as Wire
}

export type Terms = readonly (readonly [wire: Wire, coefficient: number])[]

// What an index read returns when floor(index) is outside 0..count-1.
export type OutOfRange = 'clamp' | 'zero'

export type HandwiredOperation = {
  kind: 'affine' | 'reglu' | 'boolean' | 'index'
  leftTerms: Terms
  leftBias: number
  gateTerms: Terms
  gateBias: number
  macro?: {kind: 'multiply', left: Wire, right: Wire} | {kind: 'select', gate: Wire, off: Wire, on: Wire}
  indexRead?: {table: {candidates: readonly Wire[]}, below: OutOfRange, above: OutOfRange}
}
