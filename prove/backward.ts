// Back-substitution, the bound DeepPoly and CROWN compute: a linear form over
// wires, starting as the claimed wire itself, whose operations are replaced by
// their definitions from the last one back to the sources. An affine
// operation substitutes exactly, so terms cancel before anything is relaxed:
// the overshoot of a window's left edge, width / 2 - (left + width / 2),
// becomes -left, where the forward bounds of symbolic.ts relax the width's
// clamp first and keep its slack. A ReLU is relaxed only where it is reached,
// by the side that its coefficient's sign asks for: x - relu(x - y), a
// minimum, becomes y or x, i.e. min(x, y) <= y or <= x, whichever cancels
// more of the bound. A minimum is concave, so no single plane bounds it from
// below well; there, and above a maximum, the substitution splits into the
// case x and the case y, a few times per bound, and then takes the wire's
// range, which symbolic.ts gets right from the pattern, as it does around a
// clamp whose ReLUs can switch.
//
// It runs after evaluateSymbolic, whose ranges give each ReLU's gate range and
// whose records give each step's FP32 rounding, which every substitution adds
// at the side that loosens the bound.
import {asWire, type Wire} from './wire.ts'
import {operandsOf, type ProvableCircuit as Circuit} from './circuit.ts'
import type {Cone, Ranges} from './interval.ts'
import {findClamps, findExtrema, type Symbolic} from './symbolic.ts'

type Terms = Circuit['operations'][number]['leftTerms']

// How many hard-side extrema one bound splits into cases, see below.
const extremumBranches = 3

// An upper bound of the wire over the box, or a lower bound with
// wantUpper false; the cone and ranges are those of the last evaluation.
export function backwardBound(circuit: Circuit, cone: Cone, ranges: Ranges, state: Symbolic, wire: number, wantUpper: boolean, debug?: (wire: number, coefficient: number, constant: number) => void): number {
  const last = cone.operations.indexOf(wire - circuit.sourceSize)
  return backwardFormBound(circuit, cone, ranges, state, [[asWire(wire), 1]], 0, last, wantUpper, debug)
}

// The undecided selects whose ranges the bound of the wire takes whole,
// which deciding would tighten.
export function rangedSelects(circuit: Circuit, cone: Cone, ranges: Ranges, state: Symbolic, wire: number, wantUpper: boolean) {
  const gaveUp = new Set<number>()
  const last = cone.operations.indexOf(wire - circuit.sourceSize)
  backwardFormBound(circuit, cone, ranges, state, [[asWire(wire), 1]], 0, last, wantUpper, undefined, undefined, undefined, gaveUp)
  return gaveUp
}

// The same for an affine form over wires at cone positions up to `last`,
// e.g. a ReLU's gate while the forward pass reaches that ReLU. The form's own
// FP32 rounding is the caller's to add.
export function backwardFormBound(
  circuit: Circuit,
  cone: Cone,
  ranges: Ranges,
  state: Symbolic,
  terms: Terms,
  bias: number,
  last: number,
  wantUpper: boolean,
  debug?: (wire: number, coefficient: number, constant: number) => void,
  // α per ReLU: which lower bound, the gate (1) or 0 (0), it takes where its
  // coefficient is negative; ReLUs it doesn't name use the default. The ReLUs
  // where a choice was made are set in `chosen`, with the α they took.
  alphas?: ReadonlyMap<number, number>,
  chosen?: Map<number, number>,
  // Collects the undecided selects that the bound takes whole ranges of.
  gaveUp?: Set<number>,
): number {
  const {sourceSize} = circuit
  const coefficients = state.coefficients
  const sign = wantUpper ? 1 : -1
  // The bound of sign × form: constant plus the sources' terms.
  let constant = sign * Math.fround(bias)
  for (const [input, coefficient] of terms) coefficients[input] = coefficients[input]! + sign * Math.fround(coefficient)
  let magnitude = 0
  const add = (k: number, terms: Terms, bias: number) => {
    constant += k * Math.fround(bias)
    for (const [input, coefficient] of terms) coefficients[input] = coefficients[input]! + k * Math.fround(coefficient)
  }
  // The α of an extremum's ReLU on its easy side, chosen when the extremum is
  // reached, see below.
  const extremumAlphas = new Map<number, number>()
  // k × relu(gate) at most, for the gate of operation w.
  const addRelu = (k: number, w: number, operation: Circuit['operations'][number]) => {
    const low = state.gateLow[w]!
    const high = state.gateHigh[w]!
    const error = state.gateError[w]!
    if (high <= 0 || k === 0) return
    if (low >= 0) {
      add(k, operation.gateTerms, operation.gateBias)
      constant += Math.abs(k) * error
    } else if (k > 0) {
      // relu(g) <= λ (g - low), the chord, for g within low..high.
      const lambda = high / (high - low)
      add(k * lambda, operation.gateTerms, operation.gateBias)
      constant += k * lambda * (error - low)
    } else if (chooseAlpha(w) === 1) {
      // relu(g) >= g, so k relu(g) <= k g.
      add(k, operation.gateTerms, operation.gateBias)
      constant += -k * error
    }
    // Otherwise relu(g) >= 0, so k relu(g) <= 0.
  }
  const chooseAlpha = (w: number) => {
    const alpha = alphas?.get(w) ?? extremumAlphas.get(w) ?? (state.gateHigh[w]! >= -state.gateLow[w]! ? 1 : 0)
    chosen?.set(w, alpha)
    return alpha
  }

  const extrema = findExtrema(circuit)
  const clamps = findClamps(circuit)
  // Of two operands that a min or max may stand for, the one to put in its
  // place, 0 for the first: the one whose term the bound already has with the
  // other sign, so they cancel, e.g. viewport width - min(width, viewport
  // width) >= 0 takes the viewport width, looking into sums such as viewport
  // width / 2. Otherwise the one whose own range bounds better, e.g. max(left,
  // 0) >= 0 for a left edge that a drag can move to -16384.
  const preferredOperand = (c: number, a: number, b: number): 0 | 1 | undefined => {
    const cancels = (wire: number, k = Math.sign(c), depth = 0): number => {
      let amount = Math.max(0, -k * coefficients[wire]!)
      const inner = wire >= sourceSize ? circuit.operations[wire - sourceSize]! : undefined
      if (inner?.kind === 'affine' && depth < 2) for (const [term, coefficient] of inner.leftTerms) amount += Math.abs(coefficient) * cancels(term, k * Math.sign(coefficient), depth + 1)
      return amount
    }
    // How much the operand's range adds to the bound, less is better.
    const adds = (wire: number) => c > 0 ? c * ranges.high[wire]! : c * ranges.low[wire]!
    const [ofA, ofB] = [cancels(a), cancels(b)]
    if (ofA !== ofB) return ofA > ofB ? 0 : 1
    const [addsA, addsB] = [adds(a), adds(b)]
    return addsA < addsB ? 0 : addsB < addsA ? 1 : undefined
  }
  // A value that is always one of two wires, up to `error`, bounded as the
  // larger of the bounds with each in its place, continuing below position k.
  const splitCases = (k: number, c: number, first: number, second: number, error: number, branches: number) => {
    const saved = {coefficients: coefficients.slice(), constant: constant + error, magnitude, alphas: [...extremumAlphas]}
    const restore = () => {
      coefficients.set(saved.coefficients)
      constant = saved.constant
      magnitude = saved.magnitude
      extremumAlphas.clear()
      for (const [relu, alpha] of saved.alphas) extremumAlphas.set(relu, alpha)
    }
    restore()
    coefficients[first] = coefficients[first]! + c
    const withFirst = run(k - 1, branches - 1)
    restore()
    coefficients[second] = coefficients[second]! + c
    return Math.max(withFirst, run(k - 1, branches - 1))
  }
  // Substitutes from cone position `from` down, then the sources, and returns
  // the bound of sign × form.
  const run = (from: number, branches: number): number => {
    for (let k = from; k >= 0; k--) {
      const index = cone.operations[k]!
      const w = sourceSize + index
      const c = coefficients[w]!
      if (c === 0) continue
      coefficients[w] = 0
      debug?.(w, c, constant)
      const low = ranges.low[w]!
      const high = ranges.high[w]!
      magnitude += Math.abs(c) * Math.max(Math.abs(low), Math.abs(high))
      // A wire with one value in this box, e.g. a decided bit, is that value.
      if (low === high) {
        constant += c * low
        continue
      }
      const operation = circuit.operations[index]!
      const extremum = extrema[index]
      const clamp = clamps[index]
      const hardSide = extremum !== undefined && (extremum.kind === 'minimum' ? c < 0 : c > 0) && state.gateLow[extremum.relu]! < 0 && state.gateHigh[extremum.relu]! > 0
      // On the easy side, min(a, b) <= a and <= b, and max(a, b) >= a and >= b:
      // the ReLU's α picks one, b for a minimum and a for a maximum with α 1.
      // The operand whose term the bound already has with the other sign goes
      // in, so they cancel, e.g. viewport width - min(width, viewport width) >=
      // 0 takes the viewport width. Otherwise the one whose own range bounds
      // better, e.g. max(left, 0) >= 0 for a left edge that a drag can move to
      // -16384.
      if (extremum !== undefined && !hardSide && !extremumAlphas.has(extremum.relu)) {
        const pick = preferredOperand(c, extremum.a, extremum.b)
        if (pick !== undefined) extremumAlphas.set(extremum.relu, (extremum.kind === 'minimum') === (pick === 1) ? 1 : 0)
      }
      // On the hard side, no plane bounds the extremum well, but it is always
      // one of its operands, up to its two steps' rounding: the bound is the
      // larger of the bounds with a and with b in its place, e.g. a viewport
      // width minus max(width, minimum width) is >= 0 when both are within the
      // viewport. Each such case split doubles the work, so only the first few
      // split, the nearest the claim.
      if (hardSide && branches > 0) return splitCases(k, c, extremum.a, extremum.b, Math.abs(c) * (state.leftError[extremum.difference]! + state.leftError[w]!), branches)
      if (operation.kind === 'select') {
        // A decided bit picks its operand exactly. An undecided extremum on its
        // easy side takes one operand, as above, with the choice open to the
        // α search; any other select splits into its two cases, or takes its
        // range.
        const [bit, off, on] = operandsOf(operation) as [Wire, Wire, Wire]
        if (ranges.low[bit]! >= 1 || ranges.high[bit]! <= 0) {
          const picked = ranges.low[bit]! >= 1 ? on : off
          coefficients[picked] = coefficients[picked]! + c
          continue
        }
        // As in the forward pass, only when neither operand may be NaN.
        const choice = operation.extremum
        const mayBeNaN = (wire: number) => ranges.low[wire] === -Infinity && ranges.high[wire] === Infinity
        if (choice !== undefined && (choice.kind === 'minimum' ? c > 0 : c < 0) && !mayBeNaN(choice.a) && !mayBeNaN(choice.b)) {
          const alpha = alphas?.get(w) ?? preferredOperand(c, choice.a, choice.b) ?? 0
          chosen?.set(w, alpha)
          const operand = alpha === 1 ? choice.b : choice.a
          coefficients[operand] = coefficients[operand]! + c
          continue
        }
        if (branches > 0) return splitCases(k, c, off, on, 0, branches)
        gaveUp?.add(w)
        constant += c > 0 ? c * high : c * low
        continue
      }
      if (hardSide || clamp !== undefined && operation.leftTerms.some(([relu]) => relu >= sourceSize && state.gateLow[relu]! < 0 && state.gateHigh[relu]! > 0)) {
        constant += c > 0 ? c * high : c * low
        continue
      }
      if (operation.kind === 'affine') {
        add(c, operation.leftTerms, operation.leftBias)
        constant += Math.abs(c) * state.leftError[w]!
      } else if (operation.kind === 'reglu') {
        const al = state.leftLow[w]!
        const ah = state.leftHigh[w]!
        const gl = state.gateLow[w]!
        const gh = state.gateHigh[w]!
        if (!(Number.isFinite(al) && Number.isFinite(ah) && Number.isFinite(gl) && Number.isFinite(gh))) {
          constant += c > 0 ? c * high : c * low
          continue
        }
        constant += Math.abs(c) * state.productError[w]!
        if (gh <= 0) continue
        const bl = Math.max(0, gl)
        const bh = gh
        if (al === ah) {
          // A constant left side, e.g. 1 for a plain ReLU.
          addRelu(c * al, w, operation)
        } else if (bl === bh) {
          add(c * bl, operation.leftTerms, operation.leftBias)
          constant += Math.abs(c * bl) * state.leftError[w]!
        } else {
          // McCormick's planes for a × b, b = relu(gate): an upper plane for a
          // positive coefficient, a lower one for a negative one, whichever is
          // tighter at the middle of the ranges.
          const am = (al + ah) / 2
          const bm = (bl + bh) / 2
          const planes: [number, number, number][] = c > 0
            ? [[ah, bl, -ah * bl], [al, bh, -al * bh]]
            : [[al, bl, -al * bl], [ah, bh, -ah * bh]]
          const at = ([kb, ka, k0]: [number, number, number]) => kb * bm + ka * am + k0
          const [kb, ka, k0] = c > 0 ? (at(planes[0]!) <= at(planes[1]!) ? planes[0]! : planes[1]!) : (at(planes[0]!) >= at(planes[1]!) ? planes[0]! : planes[1]!)
          add(c * ka, operation.leftTerms, operation.leftBias)
          constant += Math.abs(c * ka) * state.leftError[w]! + c * k0
          addRelu(c * kb, w, operation)
        }
      } else if (operation.kind === 'divide' && operation.gateTerms.length === 0 && Number.isFinite(state.leftError[w]!)) {
        // A quotient by a constant d: the dividend's terms / d.
        add(c / Math.fround(operation.gateBias), operation.leftTerms, operation.leftBias)
        constant += Math.abs(c) * state.leftError[w]!
      } else if (operation.kind === 'product' && state.ratioOf[w]! >= 0) {
        // f(f(a / b) × s) with s close to k b: k × a's terms, see ratioForms.
        const divide = circuit.operations[state.ratioOf[w]! - sourceSize]!
        add(c * state.ratioK[w]!, divide.leftTerms, divide.leftBias)
        constant += Math.abs(c) * state.leftError[w]!
      } else {
        // A boolean atom, an index read, any other quotient or product: its
        // range.
        constant += c > 0 ? c * high : c * low
      }
    }
    // The sources: free cells take the end of their range that the
    // coefficient's sign asks for, fixed ones their value.
    let bound = constant
    for (const cell of cone.sources) {
      const c = coefficients[cell]!
      if (c === 0) continue
      coefficients[cell] = 0
      const value = c > 0 ? ranges.high[cell]! : ranges.low[cell]!
      bound += c * value
      magnitude += Math.abs(c * value)
    }
    return bound + magnitude * 2 ** -40 + 2 ** -100
  }
  // Infinity - Infinity on the way, e.g. a quotient's range on both sides,
  // bounds nothing.
  const bound = sign * run(last, extremumBranches)
  return Number.isNaN(bound) ? sign * Infinity : bound
}

// The upper or lower bound with α chosen by coordinate descent: start from the
// default, flip one ReLU's α at a time, keep a flip that tightens the bound.
// CROWN optimizes the same α by gradient; this is the discrete version, e.g.
// it finds that a clamped left edge is below the viewport width minus the
// width rather than below the unclamped left edge.
export function optimizedBound(circuit: Circuit, cone: Cone, ranges: Ranges, state: Symbolic, wire: number, wantUpper: boolean, sweeps = 2, limit = 24): number {
  const last = cone.operations.indexOf(wire - circuit.sourceSize)
  const sign = wantUpper ? 1 : -1
  const chosen = new Map<number, number>()
  let best = sign * backwardFormBound(circuit, cone, ranges, state, [[asWire(wire), 1]], 0, last, wantUpper, undefined, undefined, chosen)
  // Start from the α that the first pass took.
  const alphas = new Map([...chosen].slice(0, limit))
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let improved = false
    for (const [relu, current] of alphas) {
      alphas.set(relu, 1 - current)
      const bound = sign * backwardFormBound(circuit, cone, ranges, state, [[asWire(wire), 1]], 0, last, wantUpper, undefined, alphas)
      if (bound < best) {
        best = bound
        improved = true
      } else {
        alphas.set(relu, current)
      }
    }
    if (!improved) break
  }
  return sign * best
}
