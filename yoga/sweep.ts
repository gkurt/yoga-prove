// Yoga computes many values twice, once while measuring a node and once while
// laying it out, from different wires: the available width comes from the
// owner one way and from the measured size the other. The prover's boxes
// can't say that two wires are equal, so it pays for combinations that never
// happen, e.g. shrinking in one pass and growing in the other.
//
// This finds the equal wires and merges them, the way hardware equivalence
// checkers sweep a circuit (FRAIG). Random tables group the wires by their
// values. In program order, each wire whose group has an earlier member
// becomes a candidate: the prover runs on `earlier - wire`, claimed to be 0
// for every table, and a proven pair becomes one wire. The circuit is rebuilt
// as it goes, so an operation whose operands merged is identical to its twin
// and merges by itself, and later candidates are proven over merged wires.
//
// A merge must not change any value, so a proven difference of exactly 0 is
// not enough on its own: +0 and -0 differ under division. Only wires that
// can't be -0 merge: a sum starting at +0, a comparison bit, and selects of
// those; a product or quotient can be -0.
import type {Wire} from '../prove/wire.ts'
import type {Operation} from '../prove/circuit.ts'
import {prove, type Claim} from '../prove/prove.ts'
import {createRandom, sampleValue} from '../prove/sampling.ts'
import {compare, divide, LayoutCircuit, select, type Num, type Ref} from './circuit.ts'

export type SweepOptions = {
  // Random tables that group the wires.
  samples?: number
  // The prover's time per candidate pair, and for all of them: after it,
  // the sweep only folds.
  pairTimeLimit?: number
  timeLimit?: number
  seed?: number
}

export type Swept = {
  circuit: LayoutCircuit
  // Each claim with its wire in the swept circuit.
  claims: Claim[]
  merged: number
  tried: number
  milliseconds: number
}

export function sweep(original: LayoutCircuit, claims: readonly Claim[], options: SweepOptions = {}): Swept {
  const started = performance.now()
  const inputs = original.inputs
  const random = createRandom(options.seed ?? 7)
  const samples = options.samples ?? 64
  const pairTimeLimit = options.pairTimeLimit ?? 300
  const timeLimit = options.timeLimit ?? 60_000
  // Each wire's values on the random tables, and the corners of the inputs'
  // ranges, as a key.
  const tables: Float32Array[] = []
  for (let k = 0; k < samples; k++) {
    tables.push(original.evaluate(inputs.map(input =>
      k === 0 ? input.base : k === 1 ? input.low : k === 2 ? input.high : sampleValue(random, input.low, input.high, input.grid))))
  }
  const width = original.sourceSize + original.operations.length
  const keys = Array.from({length: width}, (): string | null => null)
  for (let wire = 0; wire < width; wire++) {
    let key = ''
    for (const values of tables) {
      const value = values[wire]!
      if (!Number.isFinite(value)) {
        key = ''
        break
      }
      key += `${value},`
    }
    keys[wire] = key === '' ? null : key
  }

  const circuit = new LayoutCircuit(inputs)
  // Each original wire's wire in the swept circuit.
  const mapped = new Int32Array(width)
  for (let cell = 0; cell < original.sourceSize; cell++) mapped[cell] = cell
  const map = (wire: Wire) => mapped[wire]! as Wire
  const terms = (list: Operation['leftTerms']) => list.map(([wire, coefficient]) => [map(wire), coefficient] as const)
  // Whether a swept wire can be -0.
  const negativeZero = Array.from({length: original.sourceSize}, (): boolean | undefined => false)
  const canBeNegativeZero = (wire: number) => negativeZero[wire] ?? true
  // A swept wire's value when it is a constant.
  const constantOf = (wire: Wire) => {
    const operation = circuit.operations[wire - circuit.sourceSize]
    return operation?.kind === 'affine' && operation.leftTerms.length === 0 ? operation.leftBias : undefined
  }
  const num = (wire: Wire): Num => constantOf(wire) ?? {wire}
  // A select that is std::min or std::max of its operands, written out by
  // hand in the port, e.g. a measured label's (available < content) ?
  // available : content: as such, back-substitution bounds it by either
  // operand. Only in the swept circuit, whose merged wires need it; in the
  // circuit as built it costs some claims their proof.
  const same = (a: Num, b: Num) => typeof a === 'number' ? Object.is(a, b) : typeof b !== 'number' && a.wire === b.wire
  const extremumOf = (bit: Num, off: Num, on: Num): {kind: 'minimum' | 'maximum', a: Num, b: Num} | undefined => {
    if (typeof bit === 'number') return undefined
    const test = circuit.operations[bit.wire - circuit.sourceSize]
    if (test?.kind !== 'compare' || test.leftTerms[0]![1] !== 1) return undefined
    const u: Num = {wire: test.leftTerms[0]![0]}
    const v: Num = test.leftTerms.length === 2 ? {wire: test.leftTerms[1]![0]} : -test.leftBias
    // (u < v) ? on : off, and (u > v) ? on : off, as (v < u).
    if (test.relation !== '<' && test.relation !== '>') return undefined
    const [lesser, greater] = test.relation === '<' ? [u, v] : [v, u]
    if (same(lesser, on) && same(greater, off)) return {kind: 'minimum', a: off, b: on}
    if (same(lesser, off) && same(greater, on)) return {kind: 'maximum', a: off, b: on}
    return undefined
  }
  // Each group's members so far that may differ, as original wires, by key.
  // A refuted pair's table joins the tables, and a candidate is tried
  // against the first member that agrees with it there too.
  const groups = new Map<string, number[]>()
  const refutations: Float32Array[] = []
  const base = Float32Array.from(inputs, input => input.base)
  const variablesOf = (cell: number) => cell < inputs.length ? {cell, ...inputs[cell]!} : null
  let merged = 0
  let tried = 0

  for (let index = 0; index < original.operations.length; index++) {
    const operation = original.operations[index]!
    const wire = original.sourceSize + index
    // Merges leave operations that fold, or that read a constant as a wire
    // where the builder would have folded it in, e.g. a quotient by a constant
    // wire, which the prover only scales by when the divisor is its bias.
    const leftTerms = terms(operation.leftTerms)
    const gateTerms = terms(operation.gateTerms)
    const [first, second, third] = leftTerms.map(([operand]) => num(operand))
    let ref: Wire
    if ([...leftTerms, ...gateTerms].every(([operand]) => constantOf(operand) !== undefined)) {
      ref = circuit.wireOf(tables[0]![wire]!)
    } else if (operation.kind === 'select') {
      const extremum = operation.extremum === undefined ? extremumOf(first!, second!, third!) : {kind: operation.extremum.kind, a: num(map(operation.extremum.a)), b: num(map(operation.extremum.b))}
      ref = circuit.wireOf(select(circuit, first!, second!, third!, extremum))
    } else if (operation.kind === 'compare') {
      ref = circuit.wireOf(compare(circuit, first!, operation.relation!, second ?? -operation.leftBias))
    } else if (operation.kind === 'divide') {
      ref = circuit.wireOf(divide(circuit, first ?? operation.leftBias, gateTerms.length === 0 ? operation.gateBias : num(gateTerms[0]![0])))
    } else if (operation.kind === 'product' && (typeof first === 'number' || typeof second === 'number')) {
      // f(x × k) is f(-0 + f(k × x)), -0 included.
      const [x, k] = typeof first === 'number' ? [second as Ref, first] : [first as Ref, second as number]
      ref = circuit.append({kind: 'affine', leftTerms: [[x.wire, k]], leftBias: -0, gateTerms: [], gateBias: 0}).wire
    } else {
      // f(f(x + 0) + y) is f(x + y), unless the sum starts at -0.
      const kept = operation.kind === 'affine' && !Object.is(operation.leftBias, -0) ? leftTerms.filter(([operand]) => constantOf(operand) !== 0) : leftTerms
      const [only] = kept
      if (operation.kind === 'affine' && kept.length === 1 && only![1] === 1 && Object.is(operation.leftBias, 0) && !canBeNegativeZero(only![0])) {
        ref = only![0]
      } else {
        ref = circuit.append({...operation, leftTerms: kept, gateTerms}).wire
      }
    }
    if (negativeZero[ref] === undefined) {
      const swept = circuit.operations[ref - circuit.sourceSize]!
      negativeZero[ref] = swept.kind === 'affine' ? Object.is(swept.leftBias, -0)
        : swept.kind === 'compare' ? false
        : swept.kind === 'select' ? canBeNegativeZero(swept.leftTerms[1]![0]) || canBeNegativeZero(swept.leftTerms[2]![0])
        : true
    }
    mapped[wire] = ref
    const key = keys[wire] ?? null
    if (key === null || canBeNegativeZero(ref)) continue
    const members = groups.get(key) ?? []
    groups.set(key, members)
    const agrees = (member: number) => refutations.every(values => Object.is(values[member], values[wire]))
    const member = members.find(agrees)
    if (member === undefined || performance.now() - started > timeLimit) {
      members.push(wire)
      continue
    }
    const earlier = map(member as Wire)
    if (earlier === ref) continue
    // earlier - wire is 0 for every table: the two are one value.
    tried++
    const difference = circuit.append({kind: 'affine', leftTerms: [[earlier, 1], [ref, -1]], leftBias: 0, gateTerms: [], gateBias: 0}).wire
    const proof = prove(circuit, {name: 'equal', wire: difference, minimum: 0, maximum: 0}, base, variablesOf, [], {timeLimit: pairTimeLimit})
    if (proof.status === 'proven') {
      mapped[wire] = earlier
      merged++
    } else {
      if (proof.status === 'refuted') refutations.push(original.evaluate(proof.source))
      members.push(wire)
    }
  }
  return {
    circuit,
    claims: claims.map(claim => ({...claim, wire: map(claim.wire)})),
    merged,
    tried,
    milliseconds: performance.now() - started,
  }
}
