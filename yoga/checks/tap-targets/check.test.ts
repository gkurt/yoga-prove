// The tap-target check's bugs are found and confirmed by the real Yoga, its
// fixes' main claims are proven, and the minWidth trap is Yoga's own.
import {expect, test} from 'bun:test'
import {prove} from '../../../prove/prove.ts'
import {build, confirm, proveAll, type Version} from '../../check.ts'
import {LayoutCircuit} from '../../circuit.ts'
import {yogaLayout} from '../../oracle.ts'
import {check} from './check.ts'

const versionOf = (id: string) => check.examples.flatMap(example => example.versions).find(version => version.id === id)!

// Proves the claims of a version whose names contain `part`.
function proveSome(id: string, part: string, seconds: number) {
  const version = versionOf(id)
  const some: Version = {...version, claims: (c, scenes) => version.claims(c, scenes).filter(claim => claim.name.includes(part))}
  return proveAll(some, build(some), seconds)
}

// The value of the one claim whose name contains `part` at the counterexample
// the prover finds on the circuit as built, which skips the sweep: finding a
// counterexample doesn't need it. The real Yoga must agree, box for box.
function refuted(id: string, part: string) {
  const version = versionOf(id)
  const built = build(version)
  const claim = built.claims.find(claim => claim.name.includes(part))!
  const base = Float32Array.from(version.knobs, knob => knob.base)
  const variablesOf = (cell: number) => cell < version.knobs.length ? {cell, ...version.knobs[cell]!} : null
  const proof = prove(built.circuit, claim, base, variablesOf, [], {timeLimit: 10_000})
  if (proof.status !== 'refuted') throw new Error(`expected a counterexample, got ${proof.status}`)
  expect(confirm(version, built, proof.source)).toEqual([])
  return proof.value
}

test('chips that shrink: a chip narrower than 44 px, and Yoga agrees', () => {
  expect(refuted('chips-shrink', 'all: width')).toBeLessThan(44)
}, 60_000)

test('chips with minWidth: 44 end up past the screen edge, and Yoga agrees', () => {
  expect(refuted('chips-min-width', 'attachments: right')).toBeGreaterThan(100)
}, 60_000)

test('minWidth: 44 stops Yoga shrinking the chips, without it they fit', () => {
  const inputs = {all: 133, unread: 240, flagged: 240, attachments: 240}
  const right = (id: string) => {
    const version = versionOf(id)
    const {spec} = version.scenes(new LayoutCircuit(version.knobs))[0]!
    const chips = yogaLayout(spec, 320, 800, inputs).children[0]!
    const last = chips.children.at(-1)!
    return {right: last.left + last.width, widths: chips.children.map(chip => chip.width)}
  }
  // Every chip keeps its natural width, label plus 24: the row isn't shrunk.
  expect(right('chips-min-width')).toEqual({right: 989, widths: [157, 264, 264, 264]})
  expect(right('chips-shrink').right).toBeLessThanOrEqual(304)
  expect(right('chips-equal').right).toBeLessThanOrEqual(304)
})

test('equal chips: every claim proven', () => {
  const outcomes = proveSome('chips-equal', '', 10)
  expect(outcomes.map(outcome => outcome.status)).toEqual(outcomes.map(() => 'proven'))
}, 60_000)

test('footer: Get started touches Skip without a gap, and Yoga agrees; with gap: 8 it never does', () => {
  expect(refuted('space-between', 'space')).toBeLessThan(8)
  const [spaced] = proveSome('space-between-gap', 'space', 40)
  expect(spaced!.status).toBe('proven')
}, 60_000)
