// A layout check: a question about layouts, e.g. "can any button get smaller
// than 44 × 44?", asked of one or more example layouts, each in versions,
// e.g. as first written and as fixed. Each check lives in checks/<id>/check.ts
// and exports `check`; probe.ts and export.ts find them there.
//
// A version builds one circuit. Its scenes are trees laid out by the port at
// a size that may depend on the inputs, e.g. the screen less the keyboard,
// and placed on the screen at x, y. Its claims read the laid-out boxes. A
// counterexample is confirmed by laying out every scene again with the real
// Yoga at the same inputs and comparing every box, bit for bit: the claims
// are computed from the boxes, so equal boxes mean the claim fails in Yoga
// too.
//
// The visualizer draws a version from what export() writes: the circuit's
// operations in a compact form that evaluateCompact runs in the browser, the
// scenes as trees of wires, each box's role and text, overlays such as the
// keyboard, and every claim with the prover's answer.
import type {Wire} from '../prove/wire.ts'
import {coneOf, evaluatePoint} from '../prove/interval.ts'
import {prove, type Claim, type Proof} from '../prove/prove.ts'
import {LayoutCircuit, type Input, type Num} from './circuit.ts'
import {yogaLayout, type Box} from './oracle.ts'
import {sweep} from './sweep.ts'
import {amountOf, layout, type Layout, type Spec} from './yoga.ts'

// How a box is drawn: the screen, a plain container, a filled panel such as
// a card or a bar, a line of text, a button, an image or icon, a text field,
// or nothing.
export type Role = 'screen' | 'container' | 'surface' | 'text' | 'button' | 'image' | 'icon' | 'field' | 'hidden'

// An input the visualizer shows as a slider.
export type Knob = Input & {label: string}

// Scenes with the same frame are drawn on one device, e.g. the screen and
// the app laid out inside its safe area; others each get their own, e.g.
// loading and loaded.
export type SceneSpec = {name: string, label?: string, frame?: string, spec: Spec, width: Num, height: Num, x?: Num, y?: Num}
export type Scene = SceneSpec & {root: Layout, x: Num, y: Num}

// A claim with what it says in plain words, e.g. "Delete stays at least 44
// px wide".
export type CheckClaim = Claim & {says: string}

// Something drawn over the scenes that isn't a box, e.g. the keyboard, a
// safe-area band or an image's native size, as x, y, width, height on the
// screen, and the scene it belongs to when it isn't every scene's.
export type Overlay = {name: string, role: 'keyboard' | 'inset' | 'native' | 'guide', label?: string, scene?: string, rect: [Num, Num, Num, Num]}

export type Version = {
  id: string
  // What this version is, e.g. "Buttons as wide as their labels".
  label: string
  // Whether its claims all hold, as far as we know: 'refuted' for a
  // version with a bug, which the prover should find.
  expect: 'proven' | 'refuted'
  knobs: Knob[]
  scenes(c: LayoutCircuit): SceneSpec[]
  claims(c: LayoutCircuit, scenes: Record<string, Scene>): CheckClaim[]
  overlays?(c: LayoutCircuit, scenes: Record<string, Scene>): Overlay[]
  // Each box's role and text by its name; a box with neither is a container.
  roles: Record<string, Role>
  // A text, or its wordings from shortest to longest: the visualizer shows
  // the longest that fits the width the layout measured, e.g. "Email",
  // "Email address", "Email address of the account", so a short width shows
  // a short label rather than a long one cut off.
  texts?: Record<string, string | string[]>
}

export type Example = {id: string, title: string, versions: Version[]}

export type Check = {
  id: string
  title: string
  // The question, in plain words.
  question: string
  examples: Example[]
}

// laidOut: the circuit's size after the scenes, so what comes after is the
// claims' and overlays' arithmetic.
export type Built = {circuit: LayoutCircuit, scenes: Scene[], claims: CheckClaim[], overlays: Overlay[], laidOut: number}

export function build(version: Version): Built {
  const c = new LayoutCircuit(version.knobs)
  const scenes = version.scenes(c).map(scene => ({...scene, x: scene.x ?? 0, y: scene.y ?? 0, root: layout(c, scene.spec, scene.width, scene.height)}))
  const byName = Object.fromEntries(scenes.map(scene => [scene.name, scene]))
  const laidOut = c.sourceSize + c.operations.length
  return {circuit: c, scenes, claims: version.claims(c, byName), overlays: version.overlays?.(c, byName) ?? [], laidOut}
}

// Every scene laid out by the real Yoga at the inputs, compared box by box
// with the circuit's values. Returns the boxes that differ, none when the
// circuit's layout is Yoga's.
export function confirm(version: Version, built: Built, source: ArrayLike<number>): string[] {
  const values = built.circuit.evaluate(source)
  const named = Object.fromEntries(version.knobs.map((knob, cell) => [knob.name, values[cell]!]))
  const at = (value: Num) => typeof value === 'number' ? value : values[value.wire]!
  const differences: string[] = []
  for (const scene of built.scenes) {
    const visit = (ours: Layout, theirs: Box) => {
      for (const field of ['left', 'top', 'width', 'height'] as const) {
        if (!Object.is(Math.fround(at(ours[field])), Math.fround(theirs[field]))) {
          differences.push(`${scene.name}/${ours.name}.${field}: ${at(ours[field])} here, ${theirs[field]} in Yoga`)
        }
      }
      ours.children.forEach((child, index) => visit(child, theirs.children[index]!))
    }
    visit(scene.root, yogaLayout(scene.spec, at(scene.width), at(scene.height), named))
  }
  return differences
}

export type Outcome = Proof & {claim: string, says: string, confirmed?: string[]}

// Proves every claim of a version: each on the swept circuit for half the
// time, then on the circuit as built for the rest (sweep.ts says why), and
// confirms each counterexample with the real Yoga.
export function proveAll(version: Version, built: Built, seconds: number, onOutcome?: (outcome: Outcome) => void): Outcome[] {
  const {circuit, claims} = built
  const swept = sweep(circuit, claims)
  const base = Float32Array.from(version.knobs, knob => knob.base)
  const variablesOf = (cell: number) => cell < version.knobs.length ? {cell, ...version.knobs[cell]!} : null
  return claims.map((claim, index) => {
    const first = prove(swept.circuit, swept.claims[index]!, base, variablesOf, [], {timeLimit: seconds * 500})
    const second = first.status === 'unknown' ? prove(circuit, claim, base, variablesOf, [], {timeLimit: seconds * 1000 - first.milliseconds}) : first
    const proof: Proof = second === first ? first : {...second, boxes: first.boxes + second.boxes, milliseconds: first.milliseconds + second.milliseconds}
    const outcome: Outcome = {...proof, claim: claim.name, says: claim.says}
    if (proof.status === 'refuted') outcome.confirmed = confirm(version, built, proof.source)
    onOutcome?.(outcome)
    return outcome
  })
}

// An operation as an array: [kind, leftTerms, leftBias, gateTerms, gateBias,
// relation], terms flattened as wire, coefficient, wire, coefficient, ...
export type CompactOperation = [string, number[], number, number[], number, string?]

const kinds = new Set(['affine', 'divide', 'product', 'compare', 'select'])

// The operations that the given wires read, renumbered to a compact circuit,
// and each given wire's number in it.
export function compact(circuit: LayoutCircuit, wires: readonly Wire[]) {
  const cone = coneOf(circuit, wires)
  const renumber = new Map<number, number>()
  for (let cell = 0; cell < circuit.sourceSize; cell++) renumber.set(cell, cell)
  const operations: CompactOperation[] = []
  const flat = (terms: readonly (readonly [number, number])[]) => terms.flatMap(([wire, coefficient]) => [renumber.get(wire)!, coefficient])
  for (const index of cone.operations) {
    const operation = circuit.operations[index]!
    if (!kinds.has(operation.kind)) throw new Error(`no compact form for a ${operation.kind} operation`)
    renumber.set(circuit.sourceSize + index, circuit.sourceSize + operations.length)
    const entry: CompactOperation = [operation.kind, flat(operation.leftTerms), operation.leftBias, flat(operation.gateTerms), operation.gateBias]
    if (operation.relation !== undefined) entry.push(operation.relation)
    operations.push(entry)
  }
  return {sourceSize: circuit.sourceSize, operations, wire: (wire: Wire) => renumber.get(wire)!}
}

// Runs compact operations for a source table, exactly as the circuit's own
// evaluator does, in FP32: the visualizer carries a copy of this function.
export function evaluateCompact(sourceSize: number, operations: readonly CompactOperation[], source: ArrayLike<number>): Float32Array {
  const values = new Float32Array(sourceSize + operations.length)
  for (let cell = 0; cell < sourceSize; cell++) values[cell] = Math.fround(source[cell]!)
  const sum = (terms: readonly number[], bias: number) => {
    let value = Math.fround(bias)
    for (let i = 0; i < terms.length; i += 2) value = Math.fround(value + Math.fround(Math.fround(terms[i + 1]!) * values[terms[i]!]!))
    return value
  }
  operations.forEach(([kind, left, leftBias, gate, gateBias, relation], index) => {
    let value: number
    if (kind === 'select') value = values[left[0]!] === 1 ? values[left[4]!]! : values[left[2]!]!
    else if (kind === 'product') value = Math.fround(values[left[0]!]! * values[left[2]!]!)
    else if (kind === 'divide') value = Math.fround(sum(left, leftBias) / sum(gate, gateBias))
    else if (kind === 'compare') {
      const a = values[left[0]!]!
      const b = left.length > 2 ? values[left[2]!]! : -leftBias
      value = (relation === '<' ? a < b : relation === '<=' ? a <= b : relation === '>' ? a > b : relation === '>=' ? a >= b
        : relation === '==' ? a === b : !Number.isNaN(a)) ? 1 : 0
    } else value = sum(left, leftBias)
    values[sourceSize + index] = value
  })
  return values
}

// content: a measured leaf's own width and height, e.g. its text's, which
// the box can be narrower than when it truncates; padding: its padding, top,
// right, bottom, left, around what it measures.
type ExportedBox = {name: string, role: Role, text?: string | string[], left: number, top: number, width: number, height: number, content?: [number, number], padding?: [number, number, number, number], children: ExportedBox[]}

const paddingOf = (spec: Spec): [number, number, number, number] => {
  const padding = spec.style?.padding ?? 0
  return typeof padding === 'number' ? [padding, padding, padding, padding] : [padding.top ?? 0, padding.right ?? 0, padding.bottom ?? 0, padding.left ?? 0]
}

// What the visualizer reads for one version, with the prover's outcomes.
export function exportVersion(version: Version, built: Built, outcomes: readonly Outcome[]) {
  const {circuit} = built
  const wireOf = (value: Num) => circuit.wireOf(value)
  // Every wire the drawing or the claims read, as constants where they are.
  const read: Wire[] = []
  const note = (value: Num) => {
    const wire = wireOf(value)
    read.push(wire)
    return wire
  }
  const tree = (box: Layout, spec: Spec): unknown => ({
    name: box.name, left: note(box.left), top: note(box.top), width: note(box.width), height: note(box.height),
    ...(spec.measure === undefined ? {} : {content: [note(amountOf(circuit, spec.measure.width)), note(amountOf(circuit, spec.measure.height))], padding: paddingOf(spec)}),
    children: box.children.map((child, index) => tree(child, spec.children![index]!)),
  })
  const scenes = built.scenes.map(scene => ({name: scene.name, label: scene.label, frame: scene.frame, x: note(scene.x), y: note(scene.y), width: note(scene.width), height: note(scene.height), root: tree(scene.root, scene.spec)}))
  const overlays = built.overlays.map(overlay => ({...overlay, rect: overlay.rect.map(note)}))
  for (const claim of built.claims) read.push(claim.wire)
  const {sourceSize, operations, wire} = compact(circuit, read)
  // The boxes a claim is about, as scene/box: those whose left, top, width or
  // height its own arithmetic reads, past the layout. Constants are shared by
  // unrelated boxes, so they don't count.
  const boxesOf = new Map<Wire, string[]>()
  const constant = (w: Wire) => w >= circuit.sourceSize && circuit.operations[w - circuit.sourceSize]!.kind === 'affine' && circuit.operations[w - circuit.sourceSize]!.leftTerms.length === 0
  for (const scene of built.scenes) {
    const visit = (box: Layout) => {
      for (const value of [box.left, box.top, box.width, box.height]) {
        if (typeof value === 'number' || constant(value.wire)) continue
        const names = boxesOf.get(value.wire) ?? []
        const name = `${scene.name}/${box.name}`
        if (!names.includes(name)) names.push(name)
        boxesOf.set(value.wire, names)
      }
      box.children.forEach(visit)
    }
    visit(scene.root)
  }
  const targetsOf = (claimWire: Wire) => {
    const targets = new Set<string>()
    const seen = new Set<number>()
    const pending: number[] = [claimWire]
    while (pending.length > 0) {
      const w = pending.pop()!
      if (seen.has(w)) continue
      seen.add(w)
      for (const name of boxesOf.get(w as Wire) ?? []) targets.add(name)
      if (w < built.laidOut) continue
      const operation = circuit.operations[w - circuit.sourceSize]!
      for (const [operand] of [...operation.leftTerms, ...operation.gateTerms]) pending.push(operand)
    }
    return [...targets]
  }
  const renumber = (box: unknown): ExportedBox => {
    const b = box as {name: string, left: Wire, top: Wire, width: Wire, height: Wire, content?: [Wire, Wire], padding?: [number, number, number, number], children: unknown[]}
    return {
      name: b.name, role: version.roles[b.name] ?? 'container', ...(version.texts?.[b.name] === undefined ? {} : {text: version.texts[b.name]}),
      left: wire(b.left), top: wire(b.top), width: wire(b.width), height: wire(b.height),
      ...(b.content === undefined ? {} : {content: [wire(b.content[0]), wire(b.content[1])] as [number, number], padding: b.padding}), children: b.children.map(renumber),
    }
  }
  return {
    id: version.id,
    label: version.label,
    expect: version.expect,
    knobs: version.knobs,
    sourceSize,
    operations,
    scenes: scenes.map(scene => ({...scene, x: wire(scene.x), y: wire(scene.y), width: wire(scene.width), height: wire(scene.height), root: renumber(scene.root)})),
    overlays: overlays.map(overlay => ({...overlay, rect: overlay.rect.map(wire)})),
    claims: built.claims.map((claim, index) => {
      const outcome = outcomes[index]
      return {
        name: claim.name, says: claim.says, wire: wire(claim.wire), minimum: claim.minimum, maximum: claim.maximum, targets: targetsOf(claim.wire),
        ...(outcome === undefined ? {} : {
          status: outcome.status, boxes: outcome.boxes, milliseconds: Math.round(outcome.milliseconds),
          ...(outcome.status === 'refuted' ? {source: Array.from(outcome.source), value: outcome.value, confirmed: (outcome.confirmed ?? []).length === 0} : {}),
        }),
      }
    }),
  }
}

// Every check under checks/, sorted by id.
export async function loadChecks(only?: string): Promise<Check[]> {
  const glob = new Bun.Glob('checks/*/check.ts')
  const checks: Check[] = []
  for await (const path of glob.scan({cwd: import.meta.dir})) {
    const module = await import(`./${path}`) as {check: Check}
    if (only === undefined || only === '' || module.check.id === only) checks.push(module.check)
  }
  return checks.sort((a, b) => a.id.localeCompare(b.id))
}

// Values for every wire at the evaluated source, the same as the circuit's
// own evaluator: used by the tests of evaluateCompact.
export function evaluateWires(circuit: LayoutCircuit, wires: readonly Wire[], source: ArrayLike<number>) {
  const values = new Float32Array(circuit.sourceSize + circuit.operations.length)
  values.set(Array.from(source, Math.fround))
  evaluatePoint(circuit, coneOf(circuit, wires), values)
  return wires.map(wire => values[wire]!)
}
