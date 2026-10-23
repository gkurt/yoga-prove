// Symbolic intervals over a box: each wire gets a lower and an upper linear
// function of the box's free cells, on top of the plain interval of
// interval.ts. The interval of a - relu(a - b) forgets that both a's are one
// value; the linear bounds keep it, e.g. relu(v) - relu(v - 1) is exactly 1
// wherever v >= 1, since both ReLUs pass their argument through there. This
// is ReluVal's symbolic interval analysis (Wang et al., 2018), with
// McCormick's bounds for ReGLU products of two varying forms.
//
// The linear bounds are real arithmetic, so each FP32 step needs care. A step
// whose operands sit on known grids, with every partial sum within 2^24 grid
// steps, rounds nothing: the builder's grid inference, but on this box's own
// ranges, and from the declared grids of the source cells only. Any other
// step widens its bounds by its worst rounding error. Bounds are evaluated in
// float64 with a margin for that arithmetic, then rounded inward to the
// wire's grid when it has one. Every range is intersected with the plain
// interval and the lemmas, so this is never looser than interval.ts.
import type {Wire} from './wire.ts'
import {operandsOf, type ProvableCircuit as Circuit} from './circuit.ts'
import {backwardFormBound} from './backward.ts'
import {decidedComparison, intervalStep, type Cone, type Ranges} from './interval.ts'

type Terms = Circuit['operations'][number]['leftTerms']
type Form = {lower: Float64Array, upper: Float64Array}
type FormInfo = {exact: boolean, grid: number, error: number}

const exactGridSteps = 2 ** 24
const float64Scratch = new DataView(new ArrayBuffer(8))

// The largest power of two dividing a finite nonzero value, Infinity for 0,
// and 0, no grid, for NaN or an infinity.
function lowestPowerOfTwo(value: number): number {
  if (value === 0) return Infinity
  if (!Number.isFinite(value)) return 0
  // Most values are on a grid of 1/2^16 or coarser and below 2^14: their
  // multiple of 2^-16 is a 31-bit integer, whose lowest set bit is it.
  const scaled = value * 65536
  if (Number.isInteger(scaled) && Math.abs(scaled) < 2 ** 30) {
    const bits = Math.abs(scaled) | 0
    return (bits & -bits) / 65536
  }
  float64Scratch.setFloat64(0, value)
  const high = float64Scratch.getUint32(0)
  const low = float64Scratch.getUint32(4)
  const biasedExponent = (high >>> 20) & 0x7ff
  if (biasedExponent === 0) return 2 ** -1074
  const trailing = (bits: number) => 31 - Math.clz32(bits & -bits)
  const zeros = low !== 0 ? trailing(low) : 32 + trailing((high & 0xfffff) | 0x100000)
  return 2 ** (biasedExponent - 1075 + zeros)
}

// emitMinimum(a, b) and emitMaximum(a, b) build d = a - b, r = relu(d), then
// a - r or b + r. When the three steps are exact, the result is exactly
// min(a, b) or max(a, b), whose range is the min or max of the operands'
// ranges, where the ReLU's relaxation alone loses that both a's are one value.
type Extremum = {kind: 'minimum' | 'maximum', a: number, b: number, difference: number, relu: number}
const extremaByCircuit = new WeakMap<Circuit, (Extremum | undefined)[]>()

function isTerm(terms: Terms, index: number, wire: number, coefficient: number) {
  return terms[index]![0] === wire && terms[index]![1] === coefficient
}

export function findExtrema(circuit: Circuit) {
  const cached = extremaByCircuit.get(circuit)
  if (cached !== undefined) return cached
  const {sourceSize, operations} = circuit
  const extrema = operations.map((operation): Extremum | undefined => {
    if (operation.kind !== 'affine' && operation.kind !== 'boolean' || operation.leftBias !== 0 || operation.leftTerms.length !== 2) return undefined
    for (const [reluSlot, otherSlot] of [[1, 0], [0, 1]] as const) {
      const relu = operation.leftTerms[reluSlot]![0]
      if (relu < sourceSize) continue
      const reluOperation = operations[relu - sourceSize]!
      if (reluOperation.kind !== 'reglu' || reluOperation.leftTerms.length !== 0 || reluOperation.leftBias !== 1
        || reluOperation.gateTerms.length !== 1 || reluOperation.gateBias !== 0 || reluOperation.gateTerms[0]![1] !== 1) continue
      const difference = reluOperation.gateTerms[0]![0]
      if (difference < sourceSize) continue
      const differenceOperation = operations[difference - sourceSize]!
      if (differenceOperation.kind !== 'affine' || differenceOperation.leftBias !== 0 || differenceOperation.leftTerms.length !== 2) continue
      const [a, one] = differenceOperation.leftTerms[0]!
      const [b, minusOne] = differenceOperation.leftTerms[1]!
      if (one !== 1 || minusOne !== -1) continue
      const other = operation.leftTerms[otherSlot]!
      if (isTerm(operation.leftTerms, reluSlot, relu, -1) && other[0] === a && other[1] === 1) return {kind: 'minimum', a, b, difference, relu}
      if (isTerm(operation.leftTerms, reluSlot, relu, 1) && other[0] === b && other[1] === 1) return {kind: 'maximum', a, b, difference, relu}
    }
    return undefined
  })
  extremaByCircuit.set(circuit, extrema)
  return extrema
}

// relu(g1) - relu(g2), e.g. emitClampZeroOne's clamp of a sum into 0..1, where
// g2's form is g1's with one more term -c, c a constant cell, or a bias lower
// by c. A gate that reads one affine wire counts as that wire's form. Adding
// -c at any point of the same ordered FP32 sum lowers every later partial sum,
// so g2 <= g1, and the result is never below 0. When both sums are exact, g2
// = g1 - c and the result is exactly g1 clamped into 0..c. For a gate that is
// one wire v, i.e. g2 = f(v - c), v - c is also exact whenever c is a
// multiple of the ulp of v's largest value.
type Clamp = {first: {terms: Terms, bias: number}, second: {terms: Terms, bias: number}, cCell: number, cBias: number, v: number}
const clampsByCircuit = new WeakMap<Circuit, (Clamp | undefined)[]>()

export function findClamps(circuit: Circuit) {
  const cached = clampsByCircuit.get(circuit)
  if (cached !== undefined) return cached
  const {sourceSize, operations} = circuit
  const reluOf = (wire: number) => {
    if (wire < sourceSize) return undefined
    const operation = operations[wire - sourceSize]!
    if (operation.kind !== 'reglu' || operation.leftTerms.length !== 0 || operation.leftBias !== 1) return undefined
    return operation
  }
  // A gate of one affine wire, as that wire's own form.
  const expand = (terms: Terms, bias: number) => {
    if (terms.length === 1 && terms[0]![1] === 1 && bias === 0 && terms[0]![0] >= sourceSize) {
      const inner = operations[terms[0]![0] - sourceSize]!
      if (inner.kind === 'affine') return {terms: inner.leftTerms, bias: inner.leftBias}
    }
    return {terms, bias}
  }
  const clamps = operations.map((operation): Clamp | undefined => {
    if (operation.kind !== 'affine' && operation.kind !== 'boolean' || operation.leftBias !== 0 || operation.leftTerms.length !== 2) return undefined
    const plus = operation.leftTerms.find(([, coefficient]) => coefficient === 1)
    const minus = operation.leftTerms.find(([, coefficient]) => coefficient === -1)
    if (plus === undefined || minus === undefined) return undefined
    const p = reluOf(plus[0])
    const q = reluOf(minus[0])
    if (p === undefined || q === undefined) return undefined
    const v = p.gateTerms.length === 1 && p.gateTerms[0]![1] === 1 && p.gateBias === 0 ? p.gateTerms[0]![0] : -1
    for (const [first, second] of [[{terms: p.gateTerms, bias: p.gateBias}, {terms: q.gateTerms, bias: q.gateBias}], [expand(p.gateTerms, p.gateBias), expand(q.gateTerms, q.gateBias)]] as const) {
      // second = first with one term [cell, -1] inserted, or with a lower bias.
      if (second.terms.length === first.terms.length + 1 && second.bias === first.bias) {
        let skip = -1
        let matches = true
        for (let i = 0, j = 0; j < second.terms.length; j++) {
          const term = second.terms[j]!
          if (i < first.terms.length && term[0] === first.terms[i]![0] && term[1] === first.terms[i]![1]) i++
          else if (skip < 0 && term[1] === -1 && term[0] < sourceSize) skip = j
          else matches = false
        }
        if (matches && skip >= 0) return {first, second, cCell: second.terms[skip]![0], cBias: 0, v}
      }
      if (second.terms.length === first.terms.length && second.bias < first.bias
        && second.terms.every((term, i) => term[0] === first.terms[i]![0] && term[1] === first.terms[i]![1])) {
        return {first, second, cCell: -1, cBias: first.bias - second.bias, v}
      }
    }
    return undefined
  })
  clampsByCircuit.set(circuit, clamps)
  return clamps
}

// Forgets the patterns found in a circuit, e.g. after changing an operation.
export function forgetPatterns(circuit: Circuit) {
  extremaByCircuit.delete(circuit)
  clampsByCircuit.delete(circuit)
}

export type Symbolic = {
  count: number
  freeCells: readonly number[]
  freeGrids: Float64Array
  // For each wire of the cone, its slot; -1 elsewhere.
  slot: Int32Array
  // For each source cell, its free variable; -1 for a fixed cell.
  variable: Int32Array
  // slot × (count + 1): the coefficients of the free cells, then the constant.
  lower: Float64Array
  upper: Float64Array
  // The grid a wire's value is on, 0 when unknown, Infinity when it is 0.
  grid: Float64Array
  // For each wire, the wire it copies in this box, or itself: f(0 + x) and
  // f(x + y) with y always 0 copy x, up to the sign of 0, and a decided select
  // its chosen operand. Scratch for merging a sum's terms by that wire.
  alias: Int32Array
  merged: Float64Array
  // For a product that ratioForms bounds as k × a, the quotient a / b's wire
  // and k, for back-substitution, with the error in leftError; -1 elsewhere.
  ratioOf: Int32Array
  ratioK: Float64Array
  // For back-substitution (backward.ts), per operation: the most its left
  // and gate sums and its ReGLU product can round, and the ranges of its left
  // and gate values.
  leftError: Float64Array
  gateError: Float64Array
  productError: Float64Array
  leftLow: Float64Array
  leftHigh: Float64Array
  gateLow: Float64Array
  gateHigh: Float64Array
  coefficients: Float64Array
  boxLow: Float64Array
  boxHigh: Float64Array
  a: Form
  b: Form
  p: Form
  scratch: Form
}

export function createSymbolic(circuit: Circuit, cone: Cone, freeCells: readonly number[], freeGrids: readonly number[]): Symbolic {
  const width = circuit.sourceSize + circuit.operations.length
  const slot = new Int32Array(width).fill(-1)
  let slots = 0
  for (const cell of cone.sources) slot[cell] = slots++
  for (const index of cone.operations) slot[circuit.sourceSize + index] = slots++
  const variable = new Int32Array(circuit.sourceSize).fill(-1)
  freeCells.forEach((cell, i) => {
    variable[cell] = i
  })
  const count = freeCells.length
  const form = (): Form => ({lower: new Float64Array(count + 1), upper: new Float64Array(count + 1)})
  const alias = Int32Array.from({length: width}, (_, wire) => wire)
  return {
    alias, merged: new Float64Array(width), ratioOf: new Int32Array(width).fill(-1), ratioK: new Float64Array(width),
    count, freeCells, freeGrids: Float64Array.from(freeGrids), slot, variable,
    lower: new Float64Array(slots * (count + 1)),
    upper: new Float64Array(slots * (count + 1)),
    grid: new Float64Array(width),
    leftError: new Float64Array(width),
    gateError: new Float64Array(width),
    productError: new Float64Array(width),
    leftLow: new Float64Array(width),
    leftHigh: new Float64Array(width),
    gateLow: new Float64Array(width),
    gateHigh: new Float64Array(width),
    coefficients: new Float64Array(width),
    boxLow: new Float64Array(count),
    boxHigh: new Float64Array(count),
    a: form(), b: form(), p: form(), scratch: form(),
  }
}

// Float64 builds each form from earlier ones and can round away a little of
// a bound, which a later subtraction can expose, e.g. 1 - 0.9999999999999999.
// So every step widens its forms by this much of the magnitudes it combined.
const formMargin = 2 ** -40

// |constant| + Σ |coefficient| × the largest |value| of its cell in the box.
function magnitudeOf(state: Symbolic, form: Float64Array, offset: number) {
  let magnitude = Math.abs(form[offset + state.count]!)
  for (let i = 0; i < state.count; i++) {
    const a = form[offset + i]!
    if (a !== 0) magnitude += Math.abs(a) * Math.max(Math.abs(state.boxLow[i]!), Math.abs(state.boxHigh[i]!))
  }
  return magnitude
}

function widen(form: Form, count: number, margin: number) {
  form.lower[count] = form.lower[count]! - margin
  form.upper[count] = form.upper[count]! + margin
}

// The minimum or maximum of a linear form over the box, widened by a margin
// for the float64 arithmetic that evaluates the form.
function concretize(state: Symbolic, form: Float64Array, offset: number, wantMinimum: boolean) {
  const {count, boxLow, boxHigh} = state
  let value = form[offset + count]!
  let magnitude = Math.abs(value)
  for (let i = 0; i < count; i++) {
    const a = form[offset + i]!
    if (a === 0) continue
    const term = a * ((a > 0) === wantMinimum ? boxLow[i]! : boxHigh[i]!)
    value += term
    magnitude += Math.abs(term)
  }
  const margin = magnitude * 2 ** -32 + 2 ** -120
  return wantMinimum ? value - margin : value + margin
}

// The linear bounds of an affine form, and whether its FP32 evaluation is
// exact, i.e. every product and partial sum is a multiple of the form's grid
// within 2^24 of its steps.
function linearForm(state: Symbolic, ranges: Ranges, terms: Terms, bias: number, out: Form): FormInfo {
  const {count} = state
  const stride = count + 1
  out.lower.fill(0)
  out.upper.fill(0)
  const b = Math.fround(bias)
  out.lower[count] = b
  out.upper[count] = b
  let grid = lowestPowerOfTwo(b)
  let magnitude = Math.abs(b)
  let formMagnitude = Math.abs(b)
  // The partial sum's real range, while every step so far is exact.
  let partialLow = b
  let partialHigh = b
  let exact = true
  // The forms: a term on a copy of a wire, e.g. f(0 + x), counts as one on
  // that wire, and terms on one wire add up first, so x - x is exactly 0
  // even when x's lower and upper forms differ.
  const {alias, merged} = state
  // f(c x - c x') for two copies of one finite value is +0 in FP32 too.
  if (terms.length === 2 && b === 0 && alias[terms[0]![0]] === alias[terms[1]![0]]
    && Math.fround(terms[0]![1]) === -Math.fround(terms[1]![1]) && Number.isFinite(ranges.low[terms[0]![0]]! + ranges.high[terms[0]![0]]!)) {
    return {exact: true, grid: Infinity, error: 0}
  }
  for (const [wire, coefficient] of terms) merged[alias[wire]!] = merged[alias[wire]!]! + Math.fround(coefficient)
  for (const [term] of terms) {
    const wire = alias[term]!
    const c = merged[wire]!
    merged[wire] = 0
    if (c === 0) continue
    const s = state.slot[wire]! * stride
    const from = c > 0 ? state.lower : state.upper
    const to = c > 0 ? state.upper : state.lower
    for (let i = 0; i <= count; i++) {
      out.lower[i] = out.lower[i]! + c * from[s + i]!
      out.upper[i] = out.upper[i]! + c * to[s + i]!
    }
    formMagnitude += Math.abs(c) * Math.max(magnitudeOf(state, state.lower, s), magnitudeOf(state, state.upper, s))
  }
  for (const [wire, coefficient] of terms) {
    const c = Math.fround(coefficient)
    if (c === 0) continue
    const xLow = ranges.low[wire]!
    const xHigh = ranges.high[wire]!
    const largest = Math.abs(c) * Math.max(Math.abs(xLow), Math.abs(xHigh))
    magnitude += largest
    // A product is exact when the coefficient is a power of two, or when it
    // stays within 2^24 steps of its grid. The sum then is exact while every
    // partial sum stays within 2^24 steps of the grid of the terms so far.
    const operandGrid = state.grid[wire]!
    if (operandGrid === 0) {
      exact = false
      continue
    }
    const termGrid = operandGrid * lowestPowerOfTwo(c)
    // A grid that overflows, or underflows below FP32's, holds nothing; a
    // term on 0 is 0.
    if (!(termGrid >= 2 ** -149 && (termGrid < Infinity || operandGrid === Infinity))) exact = false
    if (lowestPowerOfTwo(c) !== Math.abs(c) && largest > exactGridSteps * termGrid) exact = false
    grid = Math.min(grid, termGrid)
    partialLow += Math.min(c * xLow, c * xHigh)
    partialHigh += Math.max(c * xLow, c * xHigh)
    if (Math.max(Math.abs(partialLow), Math.abs(partialHigh)) > exactGridSteps * grid) exact = false
  }
  widen(out, count, formMagnitude * formMargin + 2 ** -200)
  // Each product and each partial sum rounds by at most half an ulp of a
  // value within the magnitude, or half the smallest subnormal.
  const error = exact ? 0 : (2 * terms.length + 1) * (magnitude * 2 ** -23 + 2 ** -148)
  out.lower[count] = out.lower[count] - error
  out.upper[count] = out.upper[count] + error
  return {exact, grid: exact ? grid : 0, error}
}

function setConstant(target: Float64Array, offset: number, count: number, value: number) {
  target.fill(0, offset, offset + count)
  target[offset + count] = value
}

function setRange(state: Symbolic, wire: number, low: number, high: number) {
  const s = state.slot[wire]! * (state.count + 1)
  setConstant(state.lower, s, state.count, low)
  setConstant(state.upper, s, state.count, high)
}

function store(state: Symbolic, wire: number, form: Form) {
  const s = state.slot[wire]! * (state.count + 1)
  state.lower.set(form.lower, s)
  state.upper.set(form.upper, s)
}

// A bound of a value on a grid, rounded inward to the grid: up for a lower
// bound, down for an upper one. The grid Infinity holds only 0, and 0 is no
// grid.
export function roundToGrid(bound: number, grid: number, up: boolean) {
  if (grid === Infinity) return up ? bound <= 0 ? 0 : Infinity : bound >= 0 ? 0 : -Infinity
  if (!(grid > 0) || !(Math.abs(bound / grid) < 2 ** 52)) return bound
  return up ? Math.ceil(bound / grid) * grid : Math.floor(bound / grid) * grid
}

// The wire's final range: its plain interval (with its lemma), its symbolic
// bounds and its grid. Returns false when nothing is left.
function settle(state: Symbolic, ranges: Ranges, wire: number): boolean {
  const s = state.slot[wire]! * (state.count + 1)
  // A wire whose interval is the whole line may be NaN, which no form bounds.
  if (ranges.low[wire] === -Infinity && ranges.high[wire] === Infinity) {
    setConstant(state.lower, s, state.count, -Infinity)
    setConstant(state.upper, s, state.count, Infinity)
    state.grid[wire] = 0
    return true
  }
  let low = Math.max(ranges.low[wire]!, concretize(state, state.lower, s, true))
  let high = Math.min(ranges.high[wire]!, concretize(state, state.upper, s, false))
  if (Number.isNaN(low)) low = ranges.low[wire]!
  if (Number.isNaN(high)) high = ranges.high[wire]!
  const grid = rangeGrid(state, wire, low, high)
  low = roundToGrid(low, grid, true)
  high = roundToGrid(high, grid, false)
  if (low > high) return false
  ranges.low[wire] = low
  ranges.high[wire] = high
  // A wire with one value, e.g. a fixed bit, is that value for every table,
  // and on that value's grid.
  if (low === high) {
    setConstant(state.lower, s, state.count, low)
    setConstant(state.upper, s, state.count, low)
    state.grid[wire] = lowestPowerOfTwo(low)
  }
  return true
}

function copyForms(state: Symbolic, from: number, to: number) {
  const stride = state.count + 1
  const t = state.slot[from]! * stride
  const s = state.slot[to]! * stride
  state.lower.copyWithin(s, t, t + stride)
  state.upper.copyWithin(s, t, t + stride)
}

// McCormick bounds of f(a × b) from a's and b's own forms, replacing those of
// the expansion's two ReLU products, which lose that only one is nonzero.
function productForms(state: Symbolic, ranges: Ranges, left: number, right: number, wire: number) {
  const {count, a, b, p} = state
  const stride = count + 1
  const al = ranges.low[left]!
  const ah = ranges.high[left]!
  const bl = ranges.low[right]!
  const bh = ranges.high[right]!
  if (![al, ah, bl, bh].every(Number.isFinite)) return
  const l = state.slot[left]! * stride
  const r = state.slot[right]! * stride
  a.lower.set(state.lower.subarray(l, l + stride))
  a.upper.set(state.upper.subarray(l, l + stride))
  b.lower.set(state.lower.subarray(r, r + stride))
  b.upper.set(state.upper.subarray(r, r + stride))
  if (al === ah) scale(state, p, b, al)
  else if (bl === bh) scale(state, p, a, bl)
  else mcCormick(state, p, al, ah, bl, bh)
  const productGrid = state.grid[left]! * state.grid[right]!
  const magnitude = Math.max(Math.abs(al), Math.abs(ah)) * Math.max(Math.abs(bl), Math.abs(bh))
  const exact = productGrid === Infinity || productGrid > 0 && magnitude <= exactGridSteps * productGrid
  if (!exact) widen(p, count, magnitude * 2 ** -23 + 2 ** -148)
  store(state, wire, p)
  state.grid[wire] = exact ? productGrid : 0
}

// Bounds of f(a / b). By a constant, a's forms scaled by 1 / b, exact for a
// power of two whose quotient stays on a grid, e.g. a centering offset
// remaining / 2. By a divisor of one sign, a × r with r = 1 / b, which is
// convex in b > 0: below its tangent at the geometric mean of b's range, above
// its chord, then McCormick's planes for the product. Inexact, the quotient
// rounds once, by at most half an ulp of itself.
function divideForms(state: Symbolic, ranges: Ranges, operation: Circuit['operations'][number], wire: number) {
  const {count, a, b, p, scratch} = state
  state.grid[wire] = 0
  state.leftError[wire] = Infinity
  setRange(state, wire, ranges.low[wire]!, ranges.high[wire]!)
  const quotientMagnitude = Math.max(Math.abs(ranges.low[wire]!), Math.abs(ranges.high[wire]!))
  if (!Number.isFinite(quotientMagnitude)) return
  const left = linearForm(state, ranges, operation.leftTerms, operation.leftBias, a)
  const roundingError = quotientMagnitude * 2 ** -24 + 2 ** -149
  if (operation.gateTerms.length === 0) {
    const divisor = Math.fround(operation.gateBias)
    if (!(divisor !== 0 && Number.isFinite(divisor))) return
    scale(state, p, a, 1 / divisor)
    const powerOfTwo = lowestPowerOfTwo(divisor) === Math.abs(divisor)
    const grid = left.grid / Math.abs(divisor)
    const exact = powerOfTwo && left.exact && grid >= 2 ** -149 && grid < Infinity
    if (!exact) widen(p, count, roundingError)
    // Against the real sum of the dividend's terms, for back-substitution.
    state.leftError[wire] = left.error / Math.abs(divisor) + (exact ? 0 : roundingError)
    store(state, wire, p)
    state.grid[wire] = exact ? grid : 0
    return
  }
  linearForm(state, ranges, operation.gateTerms, operation.gateBias, b)
  let al = Math.max(concretize(state, a.lower, 0, true), termsBound(ranges, operation.leftTerms, operation.leftBias, true))
  let ah = Math.min(concretize(state, a.upper, 0, false), termsBound(ranges, operation.leftTerms, operation.leftBias, false))
  let bl = Math.max(concretize(state, b.lower, 0, true), termsBound(ranges, operation.gateTerms, operation.gateBias, true))
  let bh = Math.min(concretize(state, b.upper, 0, false), termsBound(ranges, operation.gateTerms, operation.gateBias, false))
  if (![al, ah, bl, bh].every(Number.isFinite) || !(bl > 0 || bh < 0)) return
  // a / b = (-a) / (-b), so a negative divisor becomes a positive one.
  if (bh < 0) {
    for (const form of [a, b]) {
      scratch.lower.set(form.lower)
      for (let i = 0; i <= count; i++) {
        form.lower[i] = -form.upper[i]!
        form.upper[i] = -scratch.lower[i]!
      }
    }
    ;[al, ah, bl, bh] = [-ah, -al, -bh, -bl]
  }
  // r <= (bl + bh - b) / (bl bh), the chord, and r >= 2 / t - b / t², the
  // tangent at t: each reads the side of b's forms its negative slope asks for.
  const magnitudeB = Math.max(magnitudeOf(state, b.lower, 0), magnitudeOf(state, b.upper, 0))
  const chord = 1 / (bl * bh)
  const t = Math.sqrt(bl * bh)
  scratch.lower.set(b.lower)
  for (let i = 0; i <= count; i++) {
    b.lower[i] = -b.upper[i]! / (t * t)
    b.upper[i] = -scratch.lower[i]! * chord
  }
  b.lower[count] = b.lower[count]! + 2 / t - (magnitudeB / (t * t) + 2 / t) * formMargin
  b.upper[count] = b.upper[count]! + (bl + bh) * chord + (magnitudeB * chord + (bl + bh) * chord) * formMargin
  // r's range, widened for float64's rounding of 1 / b.
  mcCormick(state, p, al, ah, (1 - 2 ** -50) / bh, (1 + 2 ** -50) / bl)
  widen(p, count, roundingError)
  store(state, wire, p)
}

// f(f(a / b) × s) where s is close to k × b, e.g. Yoga's shrinking child, its
// size less remaining / total × its scaled shrink factor, where the total is
// that same factor: k × a, up to the two roundings and a × (s - k b) / b. The
// tighter side of these forms and the product's own replaces it.
function ratioForms(state: Symbolic, ranges: Ranges, quotient: number, divide: Circuit['operations'][number], factor: number, wire: number) {
  const {count, a, b, p, scratch} = state
  const stride = count + 1
  linearForm(state, ranges, divide.gateTerms, divide.gateBias, b)
  const bl = Math.max(concretize(state, b.lower, 0, true), termsBound(ranges, divide.gateTerms, divide.gateBias, true))
  const bh = Math.min(concretize(state, b.upper, 0, false), termsBound(ranges, divide.gateTerms, divide.gateBias, false))
  const smallest = bl > 0 ? bl : bh < 0 ? -bh : 0
  if (!(smallest > 0 && Number.isFinite(bl) && Number.isFinite(bh))) return
  // k from the first free cell the divisor reads.
  const f = state.slot[factor]! * stride
  let k = Number.NaN
  for (let i = 0; i < count; i++) {
    if (b.lower[i] !== 0) {
      k = state.lower[f + i]! / b.lower[i]!
      break
    }
  }
  if (!Number.isFinite(k) || k === 0) return
  // |s - k b| over the box, from s's forms against b's.
  for (let i = 0; i <= count; i++) {
    scratch.lower[i] = state.lower[f + i]! - k * (k > 0 ? b.upper[i]! : b.lower[i]!)
    scratch.upper[i] = state.upper[f + i]! - k * (k > 0 ? b.lower[i]! : b.upper[i]!)
  }
  const deviation = Math.max(-concretize(state, scratch.lower, 0, true), concretize(state, scratch.upper, 0, false), 0)
  const left = linearForm(state, ranges, divide.leftTerms, divide.leftBias, a)
  const al = Math.max(concretize(state, a.lower, 0, true), termsBound(ranges, divide.leftTerms, divide.leftBias, true))
  const ah = Math.min(concretize(state, a.upper, 0, false), termsBound(ranges, divide.leftTerms, divide.leftBias, false))
  const largest = Math.max(Math.abs(al), Math.abs(ah))
  const factorLargest = Math.max(Math.abs(ranges.low[factor]!), Math.abs(ranges.high[factor]!))
  // A quotient that can overflow FP32 is no longer a × (1 + δ).
  if (!(largest / smallest < 2 ** 120 && Number.isFinite(factorLargest))) return
  scale(state, scratch, a, k)
  // Each rounding is within 2^-24 of its result, or half the smallest
  // subnormal, which the factor then scales.
  const error = Math.abs(k) * largest * 2 ** -22 + largest * deviation / smallest * (1 + 2 ** -20) + (factorLargest + 1) * 2 ** -148
  widen(scratch, count, error)
  // k × the real sum of the dividend's terms, for back-substitution.
  state.ratioOf[wire] = quotient
  state.ratioK[wire] = k
  state.leftError[wire] = error + Math.abs(k) * left.error * (1 + 2 ** -20)
  const s = state.slot[wire]! * stride
  p.lower.set(state.lower.subarray(s, s + stride))
  p.upper.set(state.upper.subarray(s, s + stride))
  if (concretize(state, scratch.lower, 0, true) > concretize(state, p.lower, 0, true)) p.lower.set(scratch.lower)
  if (concretize(state, scratch.upper, 0, false) < concretize(state, p.upper, 0, false)) p.upper.set(scratch.upper)
  store(state, wire, p)
}

function booleanAtom(value: number) {
  const base = 8_388_609
  return Math.fround(Math.fround(Math.fround(value) + base) - base)
}

function formReadable(state: Symbolic, terms: Terms) {
  return terms.every(([wire]) => state.slot[wire]! >= 0)
}

// The range of a recognized min, max or clamp form, and the operand that is
// always the result, if any, whose bounds the result can take.
function patternRange(state: Symbolic, ranges: Ranges, clamp: Clamp | undefined, extremum: Extremum | undefined, exactForm: boolean) {
  let low = -Infinity
  let high = Infinity
  let winner = -1
  let found = false
  if (clamp !== undefined && formReadable(state, clamp.first.terms) && formReadable(state, clamp.second.terms)) {
    const c = clamp.cCell >= 0 ? ranges.low[clamp.cCell]! : Math.fround(clamp.cBias)
    const constant = clamp.cCell < 0 || ranges.high[clamp.cCell] === c
    const gLow = termsBound(ranges, clamp.first.terms, clamp.first.bias, true)
    const gHigh = termsBound(ranges, clamp.first.terms, clamp.first.bias, false)
    if (constant && c > 0 && Number.isFinite(gHigh) && Number.isFinite(gLow)) {
      const firstExact = linearForm(state, ranges, clamp.first.terms, clamp.first.bias, state.scratch).exact
      const secondExact = linearForm(state, ranges, clamp.second.terms, clamp.second.bias, state.scratch).exact
      const ulpOfLargest = gHigh > 0 ? Math.max(2 ** -149, 2 ** (Math.floor(Math.log2(gHigh)) - 23)) : 0
      const exactAbove = gHigh <= c || firstExact && secondExact
        || clamp.v >= 0 && clamp.second.terms.length === 2 && lowestPowerOfTwo(c) >= ulpOfLargest
      high = exactAbove ? Math.min(c, Math.max(0, gHigh)) : Math.max(0, gHigh)
      low = exactAbove && gLow >= 0 ? Math.min(gLow, c) : 0
      found = true
    }
  }
  if (extremum !== undefined && state.slot[extremum.difference]! >= 0 && state.slot[extremum.relu]! >= 0) {
    const {a: x, b: y} = extremum
    const minimum = extremum.kind === 'minimum'
    const pick = minimum ? Math.min : Math.max
    const exactSteps = exactForm && state.grid[extremum.difference]! > 0 && state.grid[extremum.relu]! > 0
    // Inexact: the difference rounds by at most 2^-24 of |x - y| and the
    // result by 2^-24 of itself. Either way, x - relu(d) <= x and
    // y + relu(d) >= y, and x - relu(f(x - y)) >= 0 when x, y >= 0, since
    // then f(x - y) <= x.
    const error = exactSteps ? 0 : (Math.max(Math.abs(ranges.low[x]!), Math.abs(ranges.high[x]!)) + Math.max(Math.abs(ranges.low[y]!), Math.abs(ranges.high[y]!))) * 2 ** -23 + 2 ** -148
    let extremumLow = pick(ranges.low[x]!, ranges.low[y]!) - error
    let extremumHigh = pick(ranges.high[x]!, ranges.high[y]!) + error
    if (minimum) {
      extremumHigh = Math.min(extremumHigh, ranges.high[x]!)
      if (ranges.low[x]! >= 0 && ranges.low[y]! >= 0) extremumLow = Math.max(extremumLow, 0)
    } else {
      extremumLow = Math.max(extremumLow, ranges.low[y]!)
    }
    low = Math.max(low, extremumLow)
    high = Math.min(high, extremumHigh)
    // An operand that is always the extremum is the result, bounds and all.
    // When the difference is never positive, the ReLU is 0 and the result is
    // that operand even in FP32: x for a minimum, y for a maximum. The other
    // operand wins exactly only when the steps are.
    const xWins = minimum ? ranges.high[x]! <= ranges.low[y]! : ranges.low[x]! >= ranges.high[y]!
    const yWins = minimum ? ranges.high[y]! <= ranges.low[x]! : ranges.low[y]! >= ranges.high[x]!
    winner = minimum
      ? xWins ? x : yWins && exactSteps ? y : -1
      : yWins ? y : xWins && exactSteps ? x : -1
    found = true
  }
  return found ? {low, high, winner} : null
}

// The grid both of two grids' values are on: the finer one when it divides
// the coarser, Infinity, i.e. 0, adding nothing.
function commonGrid(first: number, second: number) {
  if (first === Infinity) return second
  if (second === Infinity) return first
  const fine = Math.min(first, second)
  return fine > 0 && Number.isInteger(Math.max(first, second) / fine) ? fine : 0
}

// Every FP32 value x with |x| >= 2^k is a multiple of 2^(k - 23), so a range
// that excludes 0 gives its wire a grid, which can be coarser than the one the
// wire's computation gives it.
function rangeGrid(state: Symbolic, wire: number, low: number, high: number) {
  let grid = state.grid[wire]!
  const nearest = low > 0 ? low : high < 0 ? -high : 0
  if (nearest > 0 && Number.isFinite(nearest)) {
    const fromRange = Math.max(2 ** -149, 2 ** (Math.floor(Math.log2(nearest)) - 23))
    if (grid !== Infinity) grid = Math.max(grid, fromRange)
    state.grid[wire] = grid
  }
  return grid
}

// Evaluates the cone over the box whose ranges the caller wrote into
// ranges.low and ranges.high of the cone's sources: free cells may span a
// range, fixed cells hold one value. Returns false when the box holds no
// allowed source table. With `from`, the cone's operations before that
// position keep what the last evaluation gave them, for a box that differs
// from the last one only in what those operations don't read.
export function evaluateSymbolic(circuit: Circuit, cone: Cone, ranges: Ranges, state: Symbolic, from = 0): boolean {
  const {count} = state
  const stride = count + 1
  const sourceSize = circuit.sourceSize
  state.freeCells.forEach((cell, i) => {
    state.boxLow[i] = ranges.low[cell]!
    state.boxHigh[i] = ranges.high[cell]!
  })
  for (const cell of cone.sources) {
    const s = state.slot[cell]! * stride
    const variable = state.variable[cell]!
    const low = ranges.low[cell]!
    const high = ranges.high[cell]!
    if (variable < 0 || low === high) {
      setConstant(state.lower, s, count, low)
      setConstant(state.upper, s, count, high)
      state.grid[cell] = low === high ? lowestPowerOfTwo(low) : 0
    } else {
      setConstant(state.lower, s, count, 0)
      setConstant(state.upper, s, count, 0)
      state.lower[s + variable] = 1
      state.upper[s + variable] = 1
      state.grid[cell] = state.freeGrids[variable]!
      rangeGrid(state, cell, low, high)
    }
  }
  const {a, b, p} = state
  const extrema = findExtrema(circuit)
  const clamps = findClamps(circuit)

  for (let k = from; k < cone.operations.length; k++) {
    const index = cone.operations[k]!
    const operation = circuit.operations[index]!
    const wire = sourceSize + index
    if (!intervalStep(circuit, index, ranges)) return false
    state.alias[wire] = wire
    if (operation.kind === 'affine') {
      if (operation.leftBias === 0) {
        let only = -1
        let others = 0
        for (const [term, coefficient] of operation.leftTerms) {
          if (ranges.low[term] === 0 && ranges.high[term] === 0) continue
          if (coefficient === 1 && only < 0) only = term
          else others++
        }
        if (only >= 0 && others === 0) state.alias[wire] = state.alias[only]!
      }
      const info = linearForm(state, ranges, operation.leftTerms, operation.leftBias, p)
      state.leftError[wire] = info.error
      state.grid[wire] = info.grid
      store(state, wire, p)
      const pattern = patternRange(state, ranges, clamps[index], extrema[index], info.exact)
      if (pattern !== null) {
        ranges.low[wire] = Math.max(ranges.low[wire]!, pattern.low)
        ranges.high[wire] = Math.min(ranges.high[wire]!, pattern.high)
        if (pattern.winner >= 0) copyForms(state, pattern.winner, wire)
      }
      const macro = operation.macro
      if (macro?.kind === 'multiply' && state.slot[macro.left]! >= 0 && state.slot[macro.right]! >= 0) {
        // f(a × relu(b)) - f(a × relu(-b)): one product is ±0, so this is
        // f(a × b), monotone in each operand, its range at the corners.
        const corners = [ranges.low[macro.left]! * ranges.low[macro.right]!, ranges.low[macro.left]! * ranges.high[macro.right]!, ranges.high[macro.left]! * ranges.low[macro.right]!, ranges.high[macro.left]! * ranges.high[macro.right]!].map(Math.fround)
        if (!corners.some(Number.isNaN)) {
          ranges.low[wire] = Math.max(ranges.low[wire]!, Math.min(...corners))
          ranges.high[wire] = Math.min(ranges.high[wire]!, Math.max(...corners))
          productForms(state, ranges, macro.left, macro.right, wire)
        }
      } else if (macro?.kind === 'select' && state.slot[macro.gate]! >= 0 && state.slot[macro.off]! >= 0 && state.slot[macro.on]! >= 0) {
        // f(f(g × on) + f(f(1 - g) × off)): for an exact bit g, exactly off
        // or on, since the other product is ±0.
        const gateLow = ranges.low[macro.gate]!
        const gateHigh = ranges.high[macro.gate]!
        const exactBit = gateLow >= 0 && gateHigh <= 1 && state.grid[macro.gate]! >= 1 && state.grid[macro.gate]! < Infinity
          || gateLow === gateHigh && (gateLow === 0 || gateLow === 1)
        if (exactBit && Number.isFinite(ranges.low[macro.on]! + ranges.high[macro.on]! + ranges.low[macro.off]! + ranges.high[macro.off]!)) {
          const chosen = gateHigh === 0 ? [macro.off] : gateLow === 1 ? [macro.on] : [macro.off, macro.on]
          ranges.low[wire] = Math.max(ranges.low[wire]!, Math.min(...chosen.map(w => ranges.low[w]!)))
          ranges.high[wire] = Math.min(ranges.high[wire]!, Math.max(...chosen.map(w => ranges.high[w]!)))
          if (chosen.length === 1) {
            copyForms(state, chosen[0]!, wire)
            state.grid[wire] = state.grid[chosen[0]!]!
          }
        }
      }
    } else if (operation.kind === 'boolean') {
      // The step f(f(score + K) - K) is monotone, so a recognized score's
      // range bounds it; a score within 0..1 gives a bit.
      const info = linearForm(state, ranges, operation.leftTerms, operation.leftBias, p)
      const pattern = patternRange(state, ranges, clamps[index], extrema[index], info.exact)
      if (pattern !== null) {
        ranges.low[wire] = Math.max(ranges.low[wire]!, booleanAtom(pattern.low))
        ranges.high[wire] = Math.min(ranges.high[wire]!, booleanAtom(pattern.high))
        if (ranges.low[wire] > ranges.high[wire]) return false
      }
      state.grid[wire] = ranges.low[wire]! >= 0 && ranges.high[wire]! <= 1 ? 1 : 0
      setRange(state, wire, ranges.low[wire]!, ranges.high[wire]!)
    } else if (operation.kind === 'select') {
      // One operand exactly when the bit is decided. Otherwise either, and an
      // extremum on its easy side keeps one operand's bound: min(a, b) is
      // below a's upper bound and b's, max(a, b) above their lower bounds.
      const [bit, off, on] = operandsOf(operation) as [Wire, Wire, Wire]
      if (ranges.low[bit]! >= 1 || ranges.high[bit]! <= 0) {
        const chosen = ranges.low[bit]! >= 1 ? on : off
        copyForms(state, chosen, wire)
        state.grid[wire] = state.grid[chosen]!
        state.alias[wire] = state.alias[chosen]!
      } else {
        setRange(state, wire, ranges.low[wire]!, ranges.high[wire]!)
        state.grid[wire] = commonGrid(state.grid[off]!, state.grid[on]!)
        // Only for numbers: max(NaN, b) is NaN, not above b. A range of the
        // whole line is one that may be NaN.
        const extremum = operation.extremum
        const mayBeNaN = (w: number) => ranges.low[w] === -Infinity && ranges.high[w] === Infinity
        if (extremum !== undefined && !mayBeNaN(extremum.a) && !mayBeNaN(extremum.b)) {
          const {a, b} = extremum
          const s = state.slot[wire]! * stride
          if (extremum.kind === 'minimum') {
            const from = state.slot[ranges.high[a]! <= ranges.high[b]! ? a : b]! * stride
            state.upper.copyWithin(s, from, from + stride)
          } else {
            const from = state.slot[ranges.low[a]! >= ranges.low[b]! ? a : b]! * stride
            state.lower.copyWithin(s, from, from + stride)
          }
        }
      }
    } else if (operation.kind === 'product') {
      // McCormick's planes, as for handwired's multiply, or a quotient's
      // dividend where the other factor cancels its divisor.
      const [left, right] = operandsOf(operation) as [Wire, Wire]
      setRange(state, wire, ranges.low[wire]!, ranges.high[wire]!)
      state.grid[wire] = 0
      productForms(state, ranges, left, right, wire)
      state.ratioOf[wire] = -1
      for (const [quotient, factor] of [[left, right], [right, left]] as const) {
        const divide = quotient >= sourceSize ? circuit.operations[quotient - sourceSize]! : undefined
        if (divide?.kind === 'divide' && divide.gateTerms.length > 0 && state.ratioOf[wire] < 0) ratioForms(state, ranges, quotient, divide, factor, wire)
      }
    } else if (operation.kind === 'compare') {
      // A comparison decided by its difference's bounds: the symbolic ones,
      // and where those leave both answers, the back-substituted ones, as for
      // a ReLU's gate below, e.g. that a width clamped to the viewport is not
      // above it.
      const difference = linearForm(state, ranges, operation.leftTerms, operation.leftBias, a)
      let dl = Math.max(concretize(state, a.lower, 0, true), termsBound(ranges, operation.leftTerms, operation.leftBias, true))
      let dh = Math.min(concretize(state, a.upper, 0, false), termsBound(ranges, operation.leftTerms, operation.leftBias, false))
      const relation = operation.relation!
      if (decidedComparison(relation, dl, dh) === undefined && Number.isFinite(dl) && Number.isFinite(dh)) {
        dl = Math.max(dl, backwardFormBound(circuit, cone, ranges, state, operation.leftTerms, operation.leftBias, k - 1, false) - difference.error)
        dh = Math.min(dh, backwardFormBound(circuit, cone, ranges, state, operation.leftTerms, operation.leftBias, k - 1, true) + difference.error)
      }
      if (difference.exact) {
        dl = roundToGrid(dl, difference.grid, true)
        dh = roundToGrid(dh, difference.grid, false)
      }
      const bit = decidedComparison(relation, dl, dh)
      if (bit !== undefined) {
        ranges.low[wire] = Math.max(ranges.low[wire]!, bit)
        ranges.high[wire] = Math.min(ranges.high[wire]!, bit)
        if (ranges.low[wire] > ranges.high[wire]) return false
      }
      state.grid[wire] = 1
      setRange(state, wire, ranges.low[wire]!, ranges.high[wire]!)
    } else if (operation.kind === 'divide') {
      divideForms(state, ranges, operation, wire)
    } else if (operation.kind === 'index') {
      const read = operation.indexRead!
      const candidates = read.table.candidates
      const last = candidates.length - 1
      let indexLow = Math.fround(operation.gateBias)
      let indexHigh = indexLow
      for (const [w, coefficient] of operation.gateTerms) {
        const c = Math.fround(coefficient)
        if (c > 0) {
          indexLow = Math.fround(indexLow + Math.fround(c * ranges.low[w]!))
          indexHigh = Math.fround(indexHigh + Math.fround(c * ranges.high[w]!))
        } else if (c < 0) {
          indexLow = Math.fround(indexLow + Math.fround(c * ranges.high[w]!))
          indexHigh = Math.fround(indexHigh + Math.fround(c * ranges.low[w]!))
        }
      }
      // Which candidates the read can reach, -1 for a 'zero' side.
      const reached = new Set<number>()
      const from = Math.floor(indexLow)
      const to = Math.floor(indexHigh)
      if (Number.isNaN(from) || Number.isNaN(to)) reached.add(-2)
      else {
        if (from < 0) reached.add(read.below === 'zero' ? -1 : candidates[0]!)
        if (to > last) reached.add(read.above === 'zero' ? -1 : candidates[last]!)
        for (let position = Math.max(0, from); position <= Math.min(last, to); position++) reached.add(candidates[position]!)
      }
      const only = reached.size === 1 ? [...reached][0]! : -2
      if (only >= 0) {
        const t = state.slot[only]! * stride
        const s = state.slot[wire]! * stride
        state.lower.copyWithin(s, t, t + stride)
        state.upper.copyWithin(s, t, t + stride)
        state.grid[wire] = state.grid[only]!
      } else {
        setRange(state, wire, ranges.low[wire]!, ranges.high[wire]!)
        let grid = reached.has(-2) ? 0 : Infinity
        for (const candidate of reached) {
          if (candidate < 0) continue
          const g = state.grid[candidate]!
          grid = g === 0 ? 0 : Math.min(grid, g)
        }
        state.grid[wire] = grid
      }
    } else {
      // ReGLU: f(left × max(0, gate)).
      const left = linearForm(state, ranges, operation.leftTerms, operation.leftBias, a)
      const gate = linearForm(state, ranges, operation.gateTerms, operation.gateBias, b)
      const al = Math.max(concretize(state, a.lower, 0, true), termsBound(ranges, operation.leftTerms, operation.leftBias, true))
      const ah = Math.min(concretize(state, a.upper, 0, false), termsBound(ranges, operation.leftTerms, operation.leftBias, false))
      let gl = Math.max(concretize(state, b.lower, 0, true), termsBound(ranges, operation.gateTerms, operation.gateBias, true))
      let gh = Math.min(concretize(state, b.upper, 0, false), termsBound(ranges, operation.gateTerms, operation.gateBias, false))
      // A gate that can be on either side of 0: its back-substituted bounds,
      // CROWN's bounds of intermediate neurons, which keep e.g. that a
      // clamped width never exceeds the viewport width it was clamped to.
      if (gl < 0 && gh > 0 && Number.isFinite(gl) && Number.isFinite(gh)) {
        gl = Math.max(gl, backwardFormBound(circuit, cone, ranges, state, operation.gateTerms, operation.gateBias, k - 1, false) - gate.error)
        gh = Math.min(gh, backwardFormBound(circuit, cone, ranges, state, operation.gateTerms, operation.gateBias, k - 1, true) + gate.error)
      }
      // An exact gate on a grid is a multiple of it, so its bounds round
      // inward, e.g. a gate that the margins leave at -4e-8 is >= 0 when it
      // is a sum of pixel values on the 1/64 px grid.
      if (gate.exact) {
        gl = roundToGrid(gl, gate.grid, true)
        gh = roundToGrid(gh, gate.grid, false)
      }
      if (gl > gh) return false
      state.leftError[wire] = left.error
      state.gateError[wire] = gate.error
      state.leftLow[wire] = al
      state.leftHigh[wire] = ah
      state.gateLow[wire] = gl
      state.gateHigh[wire] = gh
      state.productError[wire] = 0
      if (!(Number.isFinite(al) && Number.isFinite(ah) && Number.isFinite(gl) && Number.isFinite(gh))) {
        setRange(state, wire, ranges.low[wire]!, ranges.high[wire]!)
        state.grid[wire] = 0
      } else if (gh <= 0) {
        setRange(state, wire, 0, 0)
        state.grid[wire] = Infinity
      } else {
        // b = max(0, gate), within bl..bh.
        const bl = Math.max(0, gl)
        const bh = gh
        if (gl < 0) {
          // Upper: the chord from (gl, 0) to (gh, gh), which bounds the ReLU of
          // every gate value within gl..gh. Lower: the gate or 0, whichever
          // is closer over more of the range.
          const lambda = gh / (gh - gl)
          const chordMagnitude = lambda * (magnitudeOf(state, b.upper, 0) + Math.abs(gl))
          for (let i = 0; i <= count; i++) b.upper[i] = lambda * b.upper[i]!
          b.upper[count] = b.upper[count]! - lambda * gl + chordMagnitude * formMargin
          if (gh < -gl) b.lower.fill(0)
        }
        // An exact product needs both forms exact and the product within 2^24
        // steps of the product of their grids.
        const productGrid = left.grid * gate.grid
        const productMagnitude = Math.max(Math.abs(al), Math.abs(ah)) * bh
        const exact = left.exact && gate.exact && (productGrid === Infinity || productGrid > 0 && productMagnitude <= exactGridSteps * productGrid)
        if (al === ah) scale(state, p, b, al)
        else if (bl === bh) scale(state, p, a, bl)
        else mcCormick(state, p, al, ah, bl, bh)
        if (!exact) {
          const error = productMagnitude * 2 ** -23 + 2 ** -148
          state.productError[wire] = error
          p.lower[count] = p.lower[count]! - error
          p.upper[count] = p.upper[count]! + error
        }
        state.grid[wire] = exact ? productGrid : 0
        store(state, wire, p)
      }
    }
    if (!settle(state, ranges, wire)) return false
  }
  return true
}

// The plain interval's bound of an affine form, in its FP32 steps.
// A sum that may be NaN, e.g. 0 × an operand that may be NaN or infinite, is
// bounded by nothing.
function termsBound(ranges: Ranges, terms: Terms, bias: number, wantMinimum: boolean) {
  let value = Math.fround(bias)
  for (const [wire, coefficient] of terms) {
    const c = Math.fround(coefficient)
    if (c === 0) {
      if (!Number.isFinite(ranges.low[wire]! + ranges.high[wire]!)) value = Number.NaN
      continue
    }
    value = Math.fround(value + Math.fround(c * ((c > 0) === wantMinimum ? ranges.low[wire]! : ranges.high[wire]!)))
  }
  return Number.isNaN(value) ? (wantMinimum ? -Infinity : Infinity) : value
}

function scale(state: Symbolic, target: Form, source: Form, k: number) {
  const {count} = state
  const margin = Math.abs(k) * Math.max(magnitudeOf(state, source.lower, 0), magnitudeOf(state, source.upper, 0)) * formMargin
  for (let i = 0; i <= count; i++) {
    target.lower[i] = k * (k >= 0 ? source.lower[i]! : source.upper[i]!)
    target.upper[i] = k * (k >= 0 ? source.upper[i]! : source.lower[i]!)
  }
  widen(target, count, margin)
}

// McCormick's planes for p = a × b with a in [al, ah] and b in [bl, bh]:
// p >= al b + bl a - al bl, p >= ah b + bh a - ah bh, p <= ah b + bl a - ah bl
// and p <= al b + bh a - al bh. Each term takes the lower or upper form of a
// or b by the sign of its factor, and of the two planes on each side, the one
// with the better bound over the box wins.
function mcCormick(state: Symbolic, target: Form, al: number, ah: number, bl: number, bh: number) {
  const {count, a, b, scratch} = state
  const magnitudeA = Math.max(magnitudeOf(state, a.lower, 0), magnitudeOf(state, a.upper, 0))
  const magnitudeB = Math.max(magnitudeOf(state, b.lower, 0), magnitudeOf(state, b.upper, 0))
  const plane = (out: Float64Array, kb: number, ka: number, constant: number, lowerSide: boolean) => {
    for (let i = 0; i <= count; i++) {
      const bTerm = (kb >= 0) === lowerSide ? b.lower[i]! : b.upper[i]!
      const aTerm = (ka >= 0) === lowerSide ? a.lower[i]! : a.upper[i]!
      out[i] = kb * bTerm + ka * aTerm
    }
    const margin = (Math.abs(kb) * magnitudeB + Math.abs(ka) * magnitudeA + Math.abs(constant)) * formMargin
    out[count] = out[count]! + constant + (lowerSide ? -margin : margin)
  }
  plane(scratch.lower, al, bl, -al * bl, true)
  plane(scratch.upper, ah, bh, -ah * bh, true)
  target.lower.set(concretize(state, scratch.lower, 0, true) >= concretize(state, scratch.upper, 0, true) ? scratch.lower : scratch.upper)
  plane(scratch.lower, ah, bl, -ah * bl, false)
  plane(scratch.upper, al, bh, -al * bh, false)
  target.upper.set(concretize(state, scratch.lower, 0, false) <= concretize(state, scratch.upper, 0, false) ? scratch.lower : scratch.upper)
}

// How much each free cell's width moves a wire's lower or upper bound:
// |coefficient| × width, ReluVal's smear, for choosing the cell to split.
export function smear(state: Symbolic, wire: number, lowerSide: boolean, out: Float64Array) {
  const s = state.slot[wire]! * (state.count + 1)
  const form = lowerSide ? state.lower : state.upper
  for (let i = 0; i < state.count; i++) out[i] = Math.abs(form[s + i]!) * (state.boxHigh[i]! - state.boxLow[i]!)
}
