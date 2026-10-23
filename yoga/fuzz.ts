// Random trees over the supported subset, and random inputs for them, for
// the differential tests against the real Yoga.
import type {Input} from './circuit.ts'
import type {Align, Justify, Spec, Style} from './yoga.ts'

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

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!

// A tree of up to `depth` levels, with its measured leaves' widths as inputs
// named w0, w1, ..., and the viewport as W and H.
export function randomTree(random: () => number, depth = 3): {spec: Spec, inputs: Input[]} {
  const inputs: Input[] = [
    {name: 'W', low: 0, high: 2048, grid: 1 / 64, base: 800},
    {name: 'H', low: 0, high: 2048, grid: 1 / 64, base: 600},
  ]
  let count = 0
  const size = () => pick(random, [0, 8, 24, 40.5, 100, 160, 300, 1000])
  const style = (): Style => {
    const result: Style = {
      flexDirection: pick(random, ['row', 'column'] as const),
      justifyContent: pick(random, ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'] as Justify[]),
      alignItems: pick(random, ['stretch', 'flex-start', 'center', 'flex-end'] as Align[]),
      alignSelf: random() < 0.7 ? 'auto' : pick(random, ['stretch', 'flex-start', 'center', 'flex-end'] as Align[]),
      width: random() < 0.6 ? 'auto' : size(),
      height: random() < 0.6 ? 'auto' : size(),
      flexGrow: pick(random, [0, 0, 1, 1, 2, 0.5, 0.25, 3]),
      flexShrink: pick(random, [0, 1, 1, 2, 0.5]),
      flexBasis: random() < 0.75 ? 'auto' : size(),
      margin: random() < 0.6 ? 0 : {left: pick(random, [0, 4, 8]), right: pick(random, [0, 4, 8]), top: pick(random, [0, 2]), bottom: pick(random, [0, 2])},
      padding: random() < 0.5 ? 0 : {left: pick(random, [0, 6, 12]), right: pick(random, [0, 6, 12]), top: pick(random, [0, 4]), bottom: pick(random, [0, 4])},
      gap: pick(random, [0, 0, 4, 8.5, 16]),
    }
    if (random() < 0.2) result.minWidth = size()
    if (random() < 0.2) result.maxWidth = size()
    if (random() < 0.15) result.minHeight = size()
    if (random() < 0.15) result.maxHeight = size()
    if (random() < 0.2) result.aspectRatio = pick(random, [0.5, 1, 4 / 3, 16 / 9, 2.5])
    return result
  }
  const node = (level: number): Spec => {
    const name = `n${count++}`
    if (level >= depth || random() < 0.35) {
      if (random() < 0.7) {
        const width = `w${inputs.length - 2}`
        inputs.push({name: width, low: 0, high: 600, grid: 1 / 64, base: 120})
        return {name, style: style(), measure: {width, height: pick(random, [0, 16, 20, 24.5])}}
      }
      return {name, style: style()}
    }
    const children = Array.from({length: 1 + Math.floor(random() * 4)}, () => node(level + 1))
    return {name, style: style(), children}
  }
  const root = node(0)
  return {spec: root, inputs}
}

// Input values: anywhere on the grid, or at the ends of the range, or small.
export function randomInputs(random: () => number, inputs: readonly Input[]) {
  return inputs.map(input => {
    const r = random()
    if (r < 0.1) return input.low
    if (r < 0.2) return input.high
    const span = r < 0.4 ? Math.min(input.high - input.low, 64) : input.high - input.low
    return input.low + Math.floor(random() * span / input.grid) * input.grid
  })
}
