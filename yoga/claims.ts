// What "no overflow, no overlap" means for a laid-out tree, as claims the
// prover checks: every box inside its parent's box, and in a row or a column,
// every child after the previous one along the main axis. Each claim is a
// wire computed in FP32 from the layout's own wires, e.g. left + width -
// parent width <= 0.
import type {Claim} from '../prove/prove.ts'
import {add, subtract, type LayoutCircuit, type Num} from './circuit.ts'
import type {Layout, Spec} from './yoga.ts'

// How far past an edge counts as rounding, not overflow: Yoga computes in
// FP32, and a row its children fill exactly can end 3e-5 px past its edge,
// which no screen shows and pixel rounding removes.
export const tolerance = 2 ** -10

// A value that doesn't depend on any input becomes a constant wire.
export function layoutClaims(c: LayoutCircuit, spec: Spec, box: Layout): Claim[] {
  const claims: Claim[] = []
  const claim = (name: string, value: Num, minimum: number, maximum: number) => {
    claims.push({name, wire: c.wireOf(value), minimum, maximum})
  }
  const visit = (spec: Spec, box: Layout) => {
    const row = spec.style?.flexDirection === 'row'
    box.children.forEach((child, index) => {
      const name = `${child.name} in ${box.name}`
      claim(`${name}: left >= 0`, child.left, -tolerance, Infinity)
      claim(`${name}: top >= 0`, child.top, -tolerance, Infinity)
      claim(`${name}: right <= width`, subtract(c, add(c, child.left, child.width), box.width), -Infinity, tolerance)
      claim(`${name}: bottom <= height`, subtract(c, add(c, child.top, child.height), box.height), -Infinity, tolerance)
      const previous = box.children[index - 1]
      if (previous !== undefined) {
        const [start, size] = row ? (['left', 'width'] as const) : (['top', 'height'] as const)
        claim(`${child.name} after ${previous.name}`, subtract(c, child[start], add(c, previous[start], previous[size])), -tolerance, Infinity)
      }
      visit(spec.children![index]!, child)
    })
  }
  visit(spec, box)
  return claims
}
