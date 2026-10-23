// Random testing, the baseline: allowed source tables drawn at random, each
// evaluated and checked against every claim.
import type {Claim, Rule, Variable} from './prove.ts'

export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A value of low..high on the grid, uniform over the grid's points.
export function sampleValue(random: () => number, low: number, high: number, grid: number) {
  if (grid === 0) return Math.fround(low + (high - low) * random())
  const first = Math.ceil(low / grid)
  const steps = Math.floor(high / grid) - first
  return (first + Math.floor(random() * (steps + 1))) * grid
}

// Draws tables that every declaration and rule allows. Rules whose cells
// overlap, e.g. the rows and columns of a permutation, are drawn together as
// a random permutation; any other rule holds one random member, or none when
// it allows all zeros.
export function createSampler(base: Float32Array, variables: readonly Variable[], rules: readonly Rule[]) {
  const ruled = new Set(rules.flatMap(rule => rule.cells))
  const free = variables.filter(variable => !ruled.has(variable.cell) && Number.isFinite(variable.low) && Number.isFinite(variable.high))
  const isFree = new Set(variables.map(variable => variable.cell))
  // Overlapping rules, joined into components.
  const components: Rule[][] = []
  for (const rule of rules) {
    const touching = components.filter(component => component.some(other => other.cells.some(cell => rule.cells.includes(cell))))
    const merged = [rule, ...touching.flat()]
    for (const component of touching) components.splice(components.indexOf(component), 1)
    components.push(merged)
  }
  return (random: () => number) => {
    const table = Float32Array.from(base)
    for (const variable of free) table[variable.cell] = sampleValue(random, variable.low, variable.high, variable.grid)
    for (const component of components) {
      if (component.length === 1) {
        const [rule] = component as [Rule]
        const cells = rule.cells.filter(cell => isFree.has(cell))
        for (const cell of cells) table[cell] = 0
        const choices = cells.length + (rule.allowAllZero ? 1 : 0)
        const pick = Math.floor(random() * choices)
        if (pick < cells.length) table[cells[pick]!] = 1
      } else {
        // A permutation matrix: n rules over n × n cells, read as rows.
        const n = Math.round(Math.sqrt(new Set(component.flatMap(rule => rule.cells)).size))
        const rows = component.filter(rule => rule.cells.length === n).slice(0, n)
        const order = Array.from({length: n}, (_, i) => i)
        for (let i = n - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1))
          ;[order[i], order[j]] = [order[j]!, order[i]!]
        }
        rows.forEach((row, r) => row.cells.forEach((cell, c) => {
          table[cell] = c === order[r] ? 1 : 0
        }))
      }
    }
    return table
  }
}

export type SamplingResult = {samples: number, milliseconds: number, violated: Map<number, {table: Float32Array, value: number}>}

// Tests claims on random tables until the time runs out.
export function sampleClaims(evaluate: (table: Float32Array) => ArrayLike<number>, claims: readonly Claim[], sample: (random: () => number) => Float32Array, milliseconds: number, seed = 1): SamplingResult {
  const random = createRandom(seed)
  const violated = new Map<number, {table: Float32Array, value: number}>()
  const started = performance.now()
  let samples = 0
  while (performance.now() - started < milliseconds) {
    const table = sample(random)
    const values = evaluate(table)
    samples++
    claims.forEach((claim, index) => {
      const value = values[claim.wire]!
      if (!violated.has(index) && !(value >= claim.minimum && value <= claim.maximum)) violated.set(index, {table, value})
    })
  }
  return {samples, milliseconds: performance.now() - started, violated}
}
