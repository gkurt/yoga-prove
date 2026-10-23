// Every version of the check proven as expected: each first-written layout
// has a claim the prover refutes, with a counterexample the real Yoga
// confirms, and each fixed one has every claim proven.
import {expect, test} from 'bun:test'
import {build, proveAll} from '../../check.ts'
import {check} from './check.ts'

for (const example of check.examples) {
  for (const version of example.versions) {
    test(`${check.id}/${example.id}/${version.id} is ${version.expect}`, () => {
      const outcomes = proveAll(version, build(version), 10)
      if (version.expect === 'proven') {
        expect(outcomes.filter(outcome => outcome.status !== 'proven').map(outcome => outcome.claim)).toEqual([])
      } else {
        const refuted = outcomes.filter(outcome => outcome.status === 'refuted')
        expect(refuted.length).toBeGreaterThan(0)
        for (const outcome of refuted) expect(outcome.confirmed).toEqual([])
      }
    }, 60_000)
  }
}
