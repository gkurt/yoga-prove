// Boxes of source tables, and their evaluation, shared by the prover and the
// range tightener.
//
// A box gives each free source cell a range, and can bound internal wires,
// e.g. fix a wire that can only be 0 or 1, or keep a ReLU's gate on one side
// of 0. A table is in the box when every free cell lies in its range and every
// bounded wire evaluates within its bounds; the declared rules, e.g. a
// one-hot, and the lemmas hold for every table that matters.
import type {ProvableCircuit as Circuit} from './circuit.ts'
import {createRanges, evaluateIntervals, evaluatePoint, type Cone, type Ranges} from './interval.ts'
import {createSymbolic, evaluateSymbolic} from './symbolic.ts'

// A free source cell: its declared range and grid, 0 for none. A bit is the
// range 0..1 on the grid 1.
export type Variable = {cell: number, low: number, high: number, grid: number}
// The cells of a one-hot group or an at-most-one rule.
export type Rule = {cells: readonly number[], allowAllZero: boolean}
// Each free cell's range as low, high pairs, and the bounded wires as wire,
// low, high triples.
export type Box = {cells: Float64Array, bounds: number[]}

export type Lemmas = Pick<Ranges, 'lemmaLow' | 'lemmaHigh'>
export type Domain = 'interval' | 'symbolic'

// The free cells a cone reads, or the first one without a finite range, and
// every cell that shares a rule with them, transitively. A rule constrains
// its cells together: with a permutation, a cone that reads stack[2][0]
// can't take it as 1 while the rest of rank 2 keeps its initial values, since
// those are free too.
export function freeVariables(cone: Cone, variablesOf: (cell: number) => Variable | null, rules: readonly Rule[]): Variable[] | {unbounded: number} {
  const cells = new Set<number>()
  for (const cell of cone.sources) {
    const variable = variablesOf(cell)
    if (variable === null) continue
    if (!Number.isFinite(variable.low) || !Number.isFinite(variable.high)) return {unbounded: cell}
    cells.add(cell)
  }
  for (let grew = true; grew;) {
    grew = false
    for (const rule of rules) {
      if (!rule.cells.some(cell => cells.has(cell))) continue
      for (const cell of rule.cells) {
        if (cells.has(cell) || variablesOf(cell) === null) continue
        cells.add(cell)
        grew = true
      }
    }
  }
  return [...cells].sort((a, b) => a - b).map(cell => variablesOf(cell)!)
}

export function createBoxEvaluator(
  circuit: Circuit,
  cone: Cone,
  base: Float32Array,
  variables: readonly Variable[],
  rules: readonly Rule[],
  lemmas: Lemmas | undefined,
  domain: Domain,
) {
  const count = variables.length
  const position = new Map(variables.map((variable, index) => [variable.cell, index]))
  // Rules over these variables, as variable positions; a member that is not
  // free holds its base value.
  const localRules = rules
    .filter(rule => rule.cells.some(cell => position.has(cell)))
    .map(rule => ({
      members: rule.cells.filter(cell => position.has(cell)).map(cell => position.get(cell)!),
      fixedOnes: rule.cells.filter(cell => !position.has(cell)).reduce((sum, cell) => sum + base[cell]!, 0),
      allowAllZero: rule.allowAllZero,
    }))
  const ranges = createRanges(circuit)
  if (lemmas !== undefined) {
    ranges.lemmaLow = lemmas.lemmaLow
    ranges.lemmaHigh = lemmas.lemmaHigh
  }
  for (const cell of cone.sources) {
    ranges.low[cell] = base[cell]!
    ranges.high[cell] = base[cell]!
  }
  for (const variable of variables) {
    ranges.low[variable.cell] = variable.low
    ranges.high[variable.cell] = variable.high
  }
  const symbolic = domain === 'interval' ? null : createSymbolic(circuit, cone, variables.map(variable => variable.cell), variables.map(variable => variable.grid))
  const isBit = variables.map(variable => variable.grid === 1 && variable.low === 0 && variable.high === 1)
  const point = new Float32Array(circuit.sourceSize + circuit.operations.length)
  point.set(base)
  const savedLow: number[] = []
  const savedHigh: number[] = []

  // Each wire's position in the cone, and for each free cell the first
  // position that reads it, from where a change to that cell matters.
  const positionOf = new Map<number, number>()
  cone.operations.forEach((index, k) => positionOf.set(circuit.sourceSize + index, k))
  const firstReader = new Int32Array(count).fill(cone.operations.length)
  cone.operations.forEach((index, k) => {
    const operation = circuit.operations[index]!
    const inputs = [...operation.leftTerms, ...operation.gateTerms].map(([wire]) => wire).concat(operation.indexRead?.table.candidates ?? [])
    for (const input of inputs) {
      const variable = position.get(input)
      if (variable !== undefined && firstReader[variable]! > k) firstReader[variable] = k
    }
  })

  const ruled = Array.from({length: count}, (_, index) => localRules.some(rule => rule.members.includes(index)))
  const snap = (value: number, variable: Variable, low: number) => variable.grid > 0 ? Math.max(low, Math.floor(value / variable.grid) * variable.grid) : value

  // Leaves every wire's range over the box in `ranges`, or returns false when
  // the box holds no allowed table: its decided bits break a rule, or a lemma
  // or a bound leaves some wire no value. With `from`, operations before
  // that cone position keep their last ranges, see evaluateSymbolic.
  function evaluate(box: Box, from = 0): boolean {
    const {cells, bounds} = box
    for (const rule of localRules) {
      let ones = rule.fixedOnes
      let open = 0
      for (const member of rule.members) {
        if (cells[member * 2] === 1) ones++
        else if (cells[member * 2 + 1] === 1) open++
      }
      if (ones > 1 || !rule.allowAllZero && ones === 0 && open === 0) return false
    }
    for (let index = 0; index < count; index++) {
      const cell = variables[index]!.cell
      ranges.low[cell] = cells[index * 2]!
      ranges.high[cell] = cells[index * 2 + 1]!
    }
    // A bound is a lemma for this box only.
    for (let k = 0; k < bounds.length; k += 3) {
      const wire = bounds[k]!
      savedLow[k] = ranges.lemmaLow[wire]!
      savedHigh[k] = ranges.lemmaHigh[wire]!
      ranges.lemmaLow[wire] = Math.max(savedLow[k]!, bounds[k + 1]!)
      ranges.lemmaHigh[wire] = Math.min(savedHigh[k]!, bounds[k + 2]!)
    }
    const nonempty = symbolic === null ? evaluateIntervals(circuit, cone, ranges) : evaluateSymbolic(circuit, cone, ranges, symbolic, from)
    for (let k = bounds.length - 3; k >= 0; k -= 3) {
      ranges.lemmaLow[bounds[k]!] = savedLow[k]!
      ranges.lemmaHigh[bounds[k]!] = savedHigh[k]!
    }
    return nonempty
  }

  // One table of the box, exactly: the grid point at or below the center,
  // with the undecided bits at 0, except where a rule needs a 1, e.g. the rest
  // of a permutation. Returns every wire's value, or null when the point
  // breaks a rule or a bound, so it isn't a table of the box.
  function evaluateCenter(box: Box): Float32Array | null {
    const {cells, bounds} = box
    for (let index = 0; index < count; index++) {
      const variable = variables[index]!
      const low = cells[index * 2]!
      point[variable.cell] = isBit[index] ? low : snap((low + cells[index * 2 + 1]!) / 2, variable, low)
    }
    const mass = (rule: (typeof localRules)[number]) => rule.members.reduce((sum, member) => sum + point[variables[member]!.cell]!, rule.fixedOnes)
    for (const rule of localRules) {
      if (rule.allowAllZero || mass(rule) !== 0) continue
      const member = rule.members.find(m => cells[m * 2] === 0 && cells[m * 2 + 1] === 1
        && localRules.every(other => !other.members.includes(m) || mass(other) === 0))
      if (member !== undefined) point[variables[member]!.cell] = 1
    }
    for (const rule of localRules) {
      let ones = rule.fixedOnes
      for (const member of rule.members) ones += point[variables[member]!.cell]!
      if (ones > 1 || !rule.allowAllZero && ones !== 1) return null
    }
    evaluatePoint(circuit, cone, point)
    for (let k = 0; k < bounds.length; k += 3) if (!(point[bounds[k]!]! >= bounds[k + 1]! && point[bounds[k]!]! <= bounds[k + 2]!)) return null
    return point
  }

  // A random table of the box, exactly, as evaluateCenter: each free cell
  // uniform on its grid within the box, an undecided bit 0 or 1, except that
  // the undecided members of rules are drawn one rule at a time, a random member that no other rule has a 1 for
  // yet, or none when the rule allows it. Null when the draw breaks a rule or
  // a bound.
  function evaluateSample(box: Box, random: () => number): Float32Array | null {
    const {cells, bounds} = box
    for (let index = 0; index < count; index++) {
      const variable = variables[index]!
      const low = cells[index * 2]!
      const high = cells[index * 2 + 1]!
      point[variable.cell] = isBit[index] ? (low === high || ruled[index] || random() < 0.5 ? low : high) : variable.grid > 0 ? Math.min(high, low + Math.floor(random() * ((high - low) / variable.grid + 1)) * variable.grid) : Math.fround(low + (high - low) * random())
    }
    const mass = (rule: (typeof localRules)[number]) => rule.members.reduce((sum, member) => sum + point[variables[member]!.cell]!, rule.fixedOnes)
    for (const rule of localRules) {
      if (mass(rule) !== 0) continue
      const open = rule.members.filter(m => cells[m * 2] === 0 && cells[m * 2 + 1] === 1
        && localRules.every(other => !other.members.includes(m) || mass(other) === 0))
      const pick = Math.floor(random() * (open.length + (rule.allowAllZero ? 1 : 0)))
      if (pick < open.length) point[variables[open[pick]!]!.cell] = 1
    }
    for (const rule of localRules) {
      const ones = mass(rule)
      if (ones > 1 || !rule.allowAllZero && ones !== 1) return null
    }
    evaluatePoint(circuit, cone, point)
    for (let k = 0; k < bounds.length; k += 3) if (!(point[bounds[k]!]! >= bounds[k + 1]! && point[bounds[k]!]! <= bounds[k + 2]!)) return null
    return point
  }

  // The two halves of a box along a free cell, on its grid.
  function split(box: Box, index: number): [Box, Box] {
    const variable = variables[index]!
    const low = box.cells[index * 2]!
    const high = box.cells[index * 2 + 1]!
    const lower = Float64Array.from(box.cells)
    const upper = Float64Array.from(box.cells)
    if (variable.grid > 0) {
      const middle = snap((low + high) / 2, variable, low)
      lower[index * 2 + 1] = middle
      upper[index * 2] = Math.min(high, middle + variable.grid)
    } else {
      lower[index * 2 + 1] = upper[index * 2] = (low + high) / 2
    }
    return [{cells: lower, bounds: box.bounds}, {cells: upper, bounds: box.bounds}]
  }

  // The free cell with the most grid points left, preferring undecided bits.
  function widest(box: Box) {
    let chosen = -1
    let most = 0
    for (let index = 0; index < count; index++) {
      const width = box.cells[index * 2 + 1]! - box.cells[index * 2]!
      if (width === 0) continue
      if (isBit[index]) return index
      const grid = variables[index]!.grid
      const points = grid > 0 ? width / grid : width
      if (points > most) {
        most = points
        chosen = index
      }
    }
    return chosen
  }

  const initial = (): Box => ({cells: Float64Array.from(variables.flatMap(variable => [variable.low, variable.high])), bounds: []})
  return {count, variables, isBit, symbolic, ranges, positionOf, firstReader, evaluate, evaluateCenter, evaluateSample, split, widest, initial}
}

export type BoxEvaluator = ReturnType<typeof createBoxEvaluator>
