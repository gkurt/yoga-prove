// Branch and bound over a circuit's inputs: prove that a wire stays within a
// range for every source table the declarations allow, or find a table where
// it doesn't.
//
// Interval evaluation bounds the claimed wire over a box (box.ts): inside the
// claimed range, the box is proven. If not, one table of the box is evaluated
// exactly, and a value outside the range is a counterexample. Otherwise the
// box splits in two. Random tables of the box are tried too, many in the
// first box that isn't proven, a few in each later one: a claim that most
// tables break is found by sampling faster than by splitting toward the one
// table at the center, the attack that α,β-CROWN runs before and during its
// branch and bound.
//
// With symbolic intervals, a decision splits first: an undecided free bit,
// an internal wire with a few whole-number values, e.g. 0 or 1, or the gate of a ReLU that can be on either side of
// 0. Splitting an internal wire gives two boxes that bound it, e.g. to 0 and
// to 1, or the gate to <= 0 and to >= 0, which together hold every table of
// the box. Neural network verifiers split ReLUs the same way (β-CROWN). A
// decision, e.g. a hit test or a clamp, usually selects between unrelated
// computations, and fixing it separates them without cutting the pixel ranges
// that feed it into pieces; a fixed ReLU is linear, so the linear bounds of
// what reads it stay exact, e.g. left + width - viewport width cancels to 0
// for a clamped left edge. A tight claim, e.g. a window flush with the
// viewport's edge, needs that: a box across a clamp's kink keeps some slack
// however small, and boxes of pixel ranges never line up with a diagonal kink
// such as width = viewport width. Each candidate is tried both ways; the one
// whose worse side leaves the least violation wins, then the least total of
// both sides, as long as it changes anything. Only when no decision does,
// the free cell whose width moves the failing bound most splits, ReluVal's
// smear. A decision once split stays decided below, so the search ends. A box shrinks
// to single points at worst, where evaluation is exact, so on grid cells the
// search always ends; the limits stop it earlier.
import type {Wire} from './wire.ts'
import {operandsOf, type ProvableCircuit as Circuit} from './circuit.ts'
import {createBoxEvaluator, freeVariables, type Box, type Domain, type Lemmas, type Rule, type Variable} from './box.ts'
import {backwardBound, optimizedBound, rangedSelects} from './backward.ts'
import {coneOf, type Cone, type Ranges} from './interval.ts'
import {createRandom} from './sampling.ts'
import {roundToGrid, smear} from './symbolic.ts'

export type {Rule, Variable} from './box.ts'
export type Claim = {name: string, wire: Wire, minimum: number, maximum: number}

export type Proof =
  | {status: 'proven', boxes: number, milliseconds: number, range: [number, number]}
  | {status: 'refuted', boxes: number, milliseconds: number, source: Float32Array, value: number}
  | {status: 'unknown', boxes: number, milliseconds: number, reason: string}

// How many internal decisions a split tries, nearest the claim first.
const decisionCandidateLimit = 40
// With at most this many free cells, a split tries each one's halves.
const fewCells = 8
// How many undecided selects, those whose union adds the most, a split tries.
const slackCandidateLimit = 24
// How many wires of an unbounded chain to follow for its decisions.
const looseChainLimit = 4000
// The share of the time limit for random tables in the first box that isn't
// proven, and how many each later box tries.
const attackShare = 0.1
const samplesPerBox = 4

// lemmas: ranges proven earlier for every allowed source table, see Ranges.
// domain: plain intervals (interval.ts) or symbolic intervals (symbolic.ts).
export type ProveOptions = {
  boxLimit?: number
  timeLimit?: number
  // Seeds the random tables.
  seed?: number
  lemmas?: Lemmas | undefined
  domain?: Domain
  // Called for each box that is neither proven nor refuted, for debugging.
  trace?: (box: {box: Box, low: number, high: number, ranges: Ranges}) => void
}

// The FP32 value next to x, above for direction 1, below for -1.
const float32 = new Float32Array(1)
const bits = new Int32Array(float32.buffer)
function nextFloat32(x: number, direction: 1 | -1) {
  if (x === 0) return direction * 2 ** -149
  float32[0] = x
  bits[0]! += (x > 0) === (direction > 0) ? 1 : -1
  return float32[0]
}

export function claimCone(circuit: Circuit, claim: Claim) {
  return coneOf(circuit, [claim.wire])
}

export function prove(
  circuit: Circuit,
  claim: Claim,
  base: Float32Array,
  variablesOf: (cell: number) => Variable | null,
  rules: readonly Rule[],
  options: ProveOptions = {},
  cone: Cone = claimCone(circuit, claim),
): Proof {
  const started = performance.now()
  const boxLimit = options.boxLimit ?? 100_000
  const timeLimit = options.timeLimit ?? 2_000
  const variables = freeVariables(cone, variablesOf, rules)
  if (!Array.isArray(variables)) {
    return {status: 'unknown', boxes: 0, milliseconds: 0, reason: `reads cell ${variables.unbounded}, which has no finite range`}
  }
  const boxes = createBoxEvaluator(circuit, cone, base, variables, rules, options.lemmas, options.domain ?? 'symbolic')
  const {count, isBit, symbolic, ranges} = boxes
  const smears = new Float64Array(count)
  // The claimed wire's range after an evaluation: the forward range, and
  // where that fails, the back-substituted bound too, with α optimized for a
  // box's own check and the default α for the tries of a split.
  const claimRange = (optimize: boolean): [number, number] => {
    let low = ranges.low[claim.wire]!
    let high = ranges.high[claim.wire]!
    if (symbolic !== null) {
      const bound = optimize ? optimizedBound : backwardBound
      if (low < claim.minimum) low = Math.max(low, bound(circuit, cone, ranges, symbolic, claim.wire, false))
      if (high > claim.maximum) high = Math.min(high, bound(circuit, cone, ranges, symbolic, claim.wire, true))
      // The claimed wire is a multiple of its grid, so its bounds round inward,
      // e.g. an overshoot bounded by 1e-7 px is 0 on the 1/64 px grid.
      low = roundToGrid(low, symbolic.grid[claim.wire]!, true)
      high = roundToGrid(high, symbolic.grid[claim.wire]!, false)
    }
    return [low, high]
  }
  // How far a range leaves the claim's, counting only a side that fails, so
  // an open side, e.g. a maximum of Infinity, adds nothing.
  const excess = (low: number, high: number) => Math.max(low < claim.minimum ? claim.minimum - low : 0, high > claim.maximum ? high - claim.maximum : 0)
  const violation = (nonempty: boolean) => {
    if (!nonempty) return -Infinity
    return excess(...claimRange(false))
  }
  const stack: Box[] = [boxes.initial()]
  let visited = 0
  let overall: [number, number] = [Infinity, -Infinity]
  const random = createRandom(options.seed ?? 1)
  let attacked = false
  const result = (status: 'unknown', reason: string): Proof => ({status, boxes: visited, milliseconds: performance.now() - started, reason})

  while (stack.length > 0) {
    if (visited >= boxLimit) return result('unknown', `box limit ${boxLimit}`)
    if (performance.now() - started > timeLimit) return result('unknown', `time limit ${timeLimit} ms`)
    const box = stack.pop()!
    visited++
    if (!boxes.evaluate(box)) continue
    const [low, high] = claimRange(true)
    if (low >= claim.minimum && high <= claim.maximum) {
      overall = [Math.min(overall[0], low), Math.max(overall[1], high)]
      continue
    }
    const refuted = (values: Float32Array | null): Proof | null => {
      const value = values?.[claim.wire]
      if (values === null || value === undefined || value >= claim.minimum && value <= claim.maximum) return null
      return {status: 'refuted', boxes: visited, milliseconds: performance.now() - started, source: values.slice(0, circuit.sourceSize), value}
    }
    const found = refuted(boxes.evaluateCenter(box))
    if (found !== null) return found
    const attackUntil = attacked ? 0 : performance.now() + attackShare * timeLimit
    attacked = true
    for (let tries = 0; tries < samplesPerBox || performance.now() < attackUntil; tries++) {
      const found = refuted(boxes.evaluateSample(box, random))
      if (found !== null) return found
    }
    options.trace?.({box, low, high, ranges})

    let chosen = -1
    if (symbolic !== null) {
      const current = excess(low, high)
      // The smear needs this box's forms, before the tries overwrite them.
      let smeared = -1
      let largest = 0
      for (const [side, failing] of [low < claim.minimum, high > claim.maximum].entries()) {
        if (!failing) continue
        smear(symbolic, claim.wire, side === 0, smears)
        for (let index = 0; index < count; index++) {
          if (smears[index]! > largest) {
            largest = smears[index]!
            smeared = index
          }
        }
      }
      // A free bit splits at its cell; an internal decision at its wire, into
      // two bounds: 0 and 1 for a bit, <= 0 and >= 0 for a ReLU's gate.
      // While the bound is infinite, the smear says nothing, and the halves of
      // each free cell are tried too: e.g. a divisor that can be 0 only where
      // its branch isn't taken, a title width of 0 that never shrinks, is
      // finite once the cell's range leaves 0. So they are with a few free
      // cells, where the smear misses what an undecided select's range hides,
      // e.g. a shrunk title's width, which depends on the title's own.
      type Candidate = {cell: number, wire: number, from: number, sides: [[number, number], [number, number]], halves?: [Box, Box]}
      const candidates: Candidate[] = []
      for (let index = 0; index < count; index++) {
        if (box.cells[index * 2] === box.cells[index * 2 + 1]) continue
        if (isBit[index]) candidates.push({cell: index, wire: -1, from: boxes.firstReader[index]!, sides: [[0, 0], [1, 1]]})
        else if (current === Infinity || count <= fewCells) candidates.push({cell: index, wire: -1, from: boxes.firstReader[index]!, sides: [[0, 0], [0, 0]], halves: boxes.split(box, index)})
      }
      const seenGates = new Set<number>()
      const seenThresholds = new Set<string>()
      const seenBits = new Set<number>()
      // An undecided comparison of a computed value with a constant: the
      // value's range splits at the constant, into the FP32 values on each
      // side, so every comparison of it with that constant decides, e.g.
      // Yoga's remaining free space < 0 and > 0, which choose between
      // shrinking and growing.
      const threshold = (wire: number) => {
        const operation = circuit.operations[wire - circuit.sourceSize]!
        if (operation.kind !== 'compare' || operation.leftTerms.length !== 1 || operation.leftTerms[0]![1] !== 1 || ranges.low[wire] === ranges.high[wire]) return false
        const operand = operation.leftTerms[0]![0]
        const at = boxes.positionOf.get(operand)
        const t = -operation.leftBias
        if (at === undefined || !Number.isFinite(t) || !(ranges.low[operand]! <= t && ranges.high[operand]! >= t)) return false
        // x < t and x >= t decide at t's left, x <= t and x > t at its right,
        // x == t at both: first the side its range doesn't reach yet.
        const low = ranges.low[operand]!
        const high = ranges.high[operand]!
        const leftOfT = operation.relation === '<' || operation.relation === '>=' || operation.relation === '==' && high <= t
        const below = leftOfT ? nextFloat32(t, -1) : t
        const key = `${operand} ${below}`
        if (seenThresholds.has(key)) return false
        seenThresholds.add(key)
        // Each side must leave out some of the range, or the split repeats.
        if (!(low <= below && high >= nextFloat32(below, 1))) return false
        candidates.push({cell: -1, wire: operand, from: at, sides: [[-Infinity, below], [nextFloat32(below, 1), Infinity]]})
        return true
      }
      // An undecided bit: 0 against 1.
      const bitCandidate = (wire: number) => {
        const at = boxes.positionOf.get(wire)
        if (at === undefined || seenBits.has(wire) || !(ranges.low[wire] === 0 && ranges.high[wire] === 1)) return
        seenBits.add(wire)
        candidates.push({cell: -1, wire, from: at, sides: [[0, 0], [1, 1]]})
        if (circuit.operations[wire - circuit.sourceSize]!.kind === 'compare') threshold(wire)
      }
      // The undecided selects whose union of their two operands adds the most
      // beyond the wider one, e.g. a child's size, shrunk or not: their bits.
      const slacks: [number, number][] = []
      for (const index of cone.operations) {
        const operation = circuit.operations[index]!
        if (operation.kind !== 'select') continue
        const [bit, off, on] = operandsOf(operation) as [Wire, Wire, Wire]
        if (!(ranges.low[bit] === 0 && ranges.high[bit] === 1)) continue
        const union = Math.max(ranges.high[off]!, ranges.high[on]!) - Math.min(ranges.low[off]!, ranges.low[on]!)
        const wider = Math.max(ranges.high[off]! - ranges.low[off]!, ranges.high[on]! - ranges.low[on]!)
        const slack = union === Infinity ? Infinity : union - wider
        if (slack > 0) slacks.push([bit, slack])
      }
      slacks.sort((a, b) => b[1] - a[1])
      for (const [bit] of slacks.slice(0, slackCandidateLimit)) bitCandidate(bit)
      // The selects back-substitution takes whole ranges of, e.g. a free space
      // shrunk or not, and the comparisons their bits are made of, e.g. the
      // free space < 0: deciding those lets it substitute one side. The
      // smear of the forms can't see these.
      const decisionsOf = (bit: number, depth: number) => {
        if (bit < circuit.sourceSize || depth > 4 || !(ranges.low[bit] === 0 && ranges.high[bit] === 1)) return
        const operation = circuit.operations[bit - circuit.sourceSize]!
        if (operation.kind === 'compare') bitCandidate(bit)
        else if (operation.kind === 'select') for (const operand of operandsOf(operation)) decisionsOf(operand, depth + 1)
        else if (operation.kind === 'affine' && operation.leftTerms.length === 1) decisionsOf(operation.leftTerms[0]![0], depth + 1)
      }
      if (current < Infinity) {
        for (const [side, failing] of [low < claim.minimum, high > claim.maximum].entries()) {
          if (!failing) continue
          for (const select of rangedSelects(circuit, cone, ranges, symbolic, claim.wire, side === 1)) {
            const bit = circuit.operations[select - circuit.sourceSize]!.leftTerms[0]![0]
            bitCandidate(bit)
            decisionsOf(bit, 0)
          }
        }
      }
      // An infinite bound comes from a chain of unbounded wires, e.g. a
      // quotient whose divisor can be 0 only in a branch that a select leaves
      // undecided, and the decisions along it are what can end it, however
      // far from the claim. Follows unbounded operands, and a divisor whose
      // range holds 0, collecting each undecided select's bit.
      if (current === Infinity) {
        const unbounded = (wire: number) => !Number.isFinite(ranges.low[wire]!) || !Number.isFinite(ranges.high[wire]!)
        const followed = new Set<number>()
        const pending = [claim.wire as number]
        while (pending.length > 0 && followed.size < looseChainLimit) {
          const wire = pending.pop()!
          if (wire < circuit.sourceSize || followed.has(wire) || boxes.positionOf.get(wire) === undefined) continue
          followed.add(wire)
          const operation = circuit.operations[wire - circuit.sourceSize]!
          const operands = operandsOf(operation) as number[]
          if (operation.kind === 'select') {
            const [bit, off, on] = operands as [number, number, number]
            bitCandidate(bit)
            for (const operand of ranges.low[bit]! >= 1 ? [on] : ranges.high[bit]! <= 0 ? [off] : [off, on]) if (unbounded(operand)) pending.push(operand)
          } else if (operation.kind === 'divide') {
            for (const [operand] of operation.gateTerms) if (ranges.low[operand]! <= 0 && ranges.high[operand]! >= 0) pending.push(operand)
            for (const [operand] of operation.leftTerms) if (unbounded(operand)) pending.push(operand)
          } else {
            for (const operand of operands) if (unbounded(operand)) pending.push(operand)
          }
          // A divisor's range holds 0 through its own selects, which are
          // bounded: follow them too.
          if (operation.kind === 'select' && !unbounded(wire)) for (const operand of operands.slice(1)) if (ranges.low[operand] !== ranges.high[operand]) pending.push(operand)
        }
      }
      for (let k = cone.operations.length - 1, found = 0; k >= 0 && found < decisionCandidateLimit; k--) {
        const index = cone.operations[k]!
        const wire = circuit.sourceSize + index
        // A whole number with a few values, e.g. a bit, or a product of bits
        // whose operands' ranges are loose: its lowest value against the rest.
        const grid = symbolic.grid[wire]!
        const wireLow = ranges.low[wire]!
        const wireHigh = ranges.high[wire]!
        if (grid >= 1 && grid < Infinity && wireHigh > wireLow && wireHigh - wireLow <= 4 * grid && wire !== claim.wire) {
          candidates.push({cell: -1, wire, from: k, sides: [[wireLow, wireLow], [wireLow + grid, wireHigh]]})
          found++
        }
        const operation = circuit.operations[index]!
        if (operation.kind === 'compare') {
          if (threshold(wire)) found++
          continue
        }
        if (operation.kind !== 'reglu' || operation.gateTerms.length !== 1 || operation.gateBias !== 0 || operation.gateTerms[0]![1] !== 1) continue
        const gate = operation.gateTerms[0]![0]
        const at = boxes.positionOf.get(gate)
        if (at === undefined || seenGates.has(gate) || !(ranges.low[gate]! < 0 && ranges.high[gate]! > 0)) continue
        seenGates.add(gate)
        candidates.push({cell: -1, wire: gate, from: at, sides: [[-Infinity, 0], [0, Infinity]]})
        found++
      }
      // Each try changes only what reads the candidate, so it evaluates from
      // there. Later candidates go first: a try leaves the operations after its
      // start changed, and the next try starts no later.
      candidates.sort((a, b) => b.from - a.from)
      const side = (candidate: Candidate, which: 0 | 1): Box => {
        if (candidate.halves !== undefined) return candidate.halves[which]
        const [low, high] = candidate.sides[which]
        if (candidate.cell < 0) return {cells: box.cells, bounds: [...box.bounds, candidate.wire, low, high]}
        const cells = Float64Array.from(box.cells)
        cells[candidate.cell * 2] = low
        cells[candidate.cell * 2 + 1] = high
        return {cells, bounds: box.bounds}
      }
      // Fewer infinite sides first, then the worse side's violation, then
      // both sides' total.
      // Fewer infinite sides first, then fewer unbounded wires on both sides,
      // then the worse side's violation, then both sides' total.
      const unboundedWires = () => {
        let unbounded = 0
        for (const index of cone.operations) {
          const wire = circuit.sourceSize + index
          if (!Number.isFinite(ranges.low[wire]!) || !Number.isFinite(ranges.high[wire]!)) unbounded++
        }
        return unbounded
      }
      const finite = (v: number) => v === Infinity ? 0 : Math.max(0, v)
      let best: Candidate | null = null
      let bestKey = [current === Infinity ? 2 : 0, current === Infinity ? 2 * unboundedWires() : 0, finite(current), 2 * finite(current)]
      for (const candidate of candidates) {
        let infinite = 0
        let unbounded = 0
        const sides = ([0, 1] as const).map(which => {
          const nonempty = boxes.evaluate(side(candidate, which), candidate.from)
          const v = violation(nonempty)
          if (v === Infinity) {
            infinite++
            unbounded += unboundedWires()
          }
          return finite(v)
        })
        const key = [infinite, unbounded, Math.max(sides[0]!, sides[1]!), sides[0]! + sides[1]!]
        const better = key.findIndex((value, i) => value !== bestKey[i])
        if (better >= 0 && key[better]! < bestKey[better]!) {
          bestKey = key
          best = candidate
        }
      }
      if (best === null && smeared < 0 && candidates.length > 0) best = candidates[0]!
      if (best !== null && best.wire >= 0) {
        stack.push(side(best, 1), side(best, 0))
        continue
      }
      chosen = best !== null ? best.cell : smeared
    }
    if (chosen < 0) chosen = boxes.widest(box)
    // A single point whose ranges aren't exact, e.g. a quotient by a divisor
    // of exactly 0 in a branch that a select drops: its one table, evaluated
    // exactly. A table that breaks the box's bounds, e.g. decisions that the
    // loose ranges couldn't rule out, leaves the box empty; one that meets
    // them is inside the claim, or the center would have refuted it.
    if (chosen < 0) {
      const values = boxes.evaluateCenter(box)
      if (values === null) continue
      const value = values[claim.wire]!
      if (!(value >= claim.minimum && value <= claim.maximum)) return result('unknown', 'a point did not evaluate exactly')
      overall = [Math.min(overall[0], value), Math.max(overall[1], value)]
      continue
    }
    const [lower, upper] = boxes.split(box, chosen)
    stack.push(upper, lower)
  }
  return {status: 'proven', boxes: visited, milliseconds: performance.now() - started, range: overall}
}
