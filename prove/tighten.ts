// Tighter ranges for intermediate wires, as lemmas. A wire such as a
// workspace height, viewport height - min(dock, viewport height) - ..., is
// never negative, but its interval over the whole viewport range says -112,
// since the terms are correlated. Every claim that reads it inherits the
// slack. Over a few free cells, best-first branch and bound finds its range:
// split the box whose bound is most extreme, until that bound is a value some
// table takes, or the budget runs out. The bound over the remaining boxes is
// sound at any point, so a lemma is never wrong, only sometimes loose.
import type {Wire} from './wire.ts'
import type {ProvableCircuit as Circuit} from './circuit.ts'
import {createBoxEvaluator, freeVariables, type Box, type Lemmas, type Rule, type Variable} from './box.ts'
import {coneOf} from './interval.ts'
import {smear} from './symbolic.ts'

export function tighten(
  circuit: Circuit,
  wire: Wire,
  base: Float32Array,
  variablesOf: (cell: number) => Variable | null,
  rules: readonly Rule[],
  lemmas: Lemmas,
  budget: number,
): [number, number] | null {
  const cone = coneOf(circuit, [wire])
  const variables = freeVariables(cone, variablesOf, rules)
  if (!Array.isArray(variables)) return null
  const boxes = createBoxEvaluator(circuit, cone, base, variables, rules, lemmas, 'symbolic')
  const {ranges, symbolic} = boxes
  const smears = new Float64Array(boxes.count)
  const bounds: [number, number] = [-Infinity, Infinity]
  for (const lowerSide of [true, false]) {
    const sign = lowerSide ? 1 : -1
    // Leaves as [box, bound], the bound as a minimum: the low bound, or minus
    // the high bound.
    const leaves: [Box, number][] = []
    // The most extreme value seen at a table.
    let seen = Infinity
    const visit = (box: Box) => {
      if (!boxes.evaluate(box)) return
      leaves.push([box, sign * (lowerSide ? ranges.low[wire]! : ranges.high[wire]!)])
      const values = boxes.evaluateCenter(box)
      if (values !== null) seen = Math.min(seen, sign * values[wire]!)
    }
    visit(boxes.initial())
    for (let step = 0; step < budget && leaves.length > 0; step++) {
      let at = 0
      for (let k = 1; k < leaves.length; k++) if (leaves[k]![1] < leaves[at]![1]) at = k
      const [box, bound] = leaves[at]!
      // A table takes this bound, so it is the extreme.
      if (bound >= seen) break
      // Its forms, for the smear.
      boxes.evaluate(box)
      smear(symbolic!, wire, lowerSide, smears)
      let chosen = -1
      let largest = 0
      for (let index = 0; index < boxes.count; index++) {
        if (smears[index]! > largest) {
          largest = smears[index]!
          chosen = index
        }
      }
      if (chosen < 0) chosen = boxes.widest(box)
      if (chosen < 0) break
      leaves.splice(at, 1)
      for (const half of boxes.split(box, chosen)) visit(half)
    }
    const extreme = leaves.reduce((most, [, bound]) => Math.min(most, bound), Infinity)
    // No leaves left: no allowed table reaches this wire's value at all.
    bounds[lowerSide ? 0 : 1] = sign * extreme
  }
  return bounds
}
