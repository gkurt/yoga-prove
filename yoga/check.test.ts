// Every check's versions, at random inputs: each scene the port lays out is
// the real Yoga's, box for box and bit for bit, and the visualizer's
// evaluator computes every exported wire exactly as the circuit does.
import {expect, test} from 'bun:test'
import {build, confirm, evaluateCompact, evaluateWires, exportVersion, loadChecks} from './check.ts'
import {createRandom} from './fuzz.ts'

const checks = await loadChecks()

for (const check of checks) {
  test(`${check.id}: every version is laid out as Yoga lays it out, and exports exactly`, () => {
    const random = createRandom(3)
    for (const example of check.examples) {
      for (const version of example.versions) {
        const built = build(version)
        const exported = exportVersion(version, built, [])
        const wires = built.claims.map(claim => claim.wire)
        for (let trial = 0; trial < 25; trial++) {
          const source = version.knobs.map(knob => {
            const r = random()
            const value = r < 0.1 ? knob.low : r < 0.2 ? knob.high : knob.low + Math.floor(random() * ((knob.high - knob.low) / knob.grid + 1)) * knob.grid
            return Math.min(knob.high, value)
          })
          const differences = confirm(version, built, source)
          if (differences.length > 0) throw new Error(`${check.id}/${example.id}/${version.id} at ${source.join(', ')}: ${differences.slice(0, 3).join('; ')}`)
          const values = evaluateCompact(exported.sourceSize, exported.operations, source)
          const expected = evaluateWires(built.circuit, wires, source)
          // Each claim by its wire in the exported circuit, which also holds
          // what the drawing reads, so it numbers wires differently from a
          // compaction of the claims alone when the drawing reads boxes that
          // no claim does.
          exported.claims.forEach((claim, index) => expect(Object.is(values[claim.wire], expected[index])).toBe(true))
        }
      }
    }
  }, 120_000)
}

test('there are checks', () => {
  expect(checks.length).toBeGreaterThan(0)
})
