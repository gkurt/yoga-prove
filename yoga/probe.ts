// Every claim of every check (checks/*/check.ts): proven, refuted with a
// counterexample that the real Yoga confirms, or unknown within the time
// limit. Each claim is tried on the swept circuit (sweep.ts) for half the
// time, then on the circuit as built for the rest. Each check's versions,
// with the outcomes, go to viz/data/<id>.json for the visualizer, and
// viz/data/index.json lists them.
//
//   bun yoga/probe.ts [seconds per claim, default 60] [check id] [example id]
import {mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {build, exportVersion, loadChecks, proveAll, type Outcome} from './check.ts'

const seconds = Number(process.argv[2] ?? 60)
const onlyCheck = process.argv[3] ?? ''
const onlyExample = process.argv[4] ?? ''
const data = resolve(import.meta.dir, 'viz/data')
mkdirSync(data, {recursive: true})

for (const check of await loadChecks(onlyCheck)) {
  console.log(`\n${check.title} (${check.id}): ${check.question}`)
  const examples: {id: string, title: string, versions: ReturnType<typeof exportVersion>[]}[] = []
  for (const example of check.examples.filter(e => onlyExample === '' || e.id === onlyExample)) {
    const versions: ReturnType<typeof exportVersion>[] = []
    for (const version of example.versions) {
      const built = build(version)
      console.log(`\n  ${example.title}, ${version.label}: ${built.circuit.operations.length} operations, ${built.claims.length} claims`)
      const show = (outcome: Outcome) => {
        let detail = ''
        if (outcome.status === 'refuted') {
          const shown = version.knobs.map((knob, cell) => `${knob.name} ${outcome.source[cell]}`).join(', ')
          const confirmed = outcome.confirmed!.length === 0 ? 'Yoga agrees' : `YOGA DIFFERS: ${outcome.confirmed!.slice(0, 3).join('; ')}`
          detail = `${outcome.value} at ${shown}; ${confirmed}`
        } else if (outcome.status === 'unknown') {
          detail = outcome.reason
        }
        // Claims proven in one box are listed only in the count.
        if (outcome.status !== 'proven' || outcome.boxes > 1) {
          console.log(`    ${outcome.status.padEnd(8)} ${String(outcome.boxes).padStart(6)} boxes ${(outcome.milliseconds / 1000).toFixed(1).padStart(6)} s  ${outcome.says}${detail === '' ? '' : `: ${detail}`}`)
        }
      }
      const outcomes = proveAll(version, built, seconds, show)
      const counts = {proven: 0, refuted: 0, unknown: 0}
      for (const outcome of outcomes) counts[outcome.status]++
      const expected = version.expect === 'proven' ? counts.proven === outcomes.length : counts.refuted > 0
      console.log(`    ${counts.proven} proven, ${counts.refuted} refuted, ${counts.unknown} unknown${expected ? '' : `  (expected ${version.expect})`}`)
      versions.push(exportVersion(version, built, outcomes))
    }
    examples.push({id: example.id, title: example.title, versions})
  }
  const path = resolve(data, `${check.id}.json`)
  // A run of one example keeps the other examples' last outcomes.
  let previous: {examples?: {id: string}[]} = {}
  try {
    previous = JSON.parse(readFileSync(path, 'utf8')) as typeof previous
  } catch {
    // no earlier run
  }
  const merged = check.examples
    .map(e => examples.find(x => x.id === e.id) ?? previous.examples?.find(x => x.id === e.id))
    .filter(e => e !== undefined)
  writeFileSync(path, JSON.stringify({id: check.id, title: check.title, question: check.question, examples: merged}))
}

const index = readdirSync(data).filter(name => name.endsWith('.json') && name !== 'index.json').sort().map(name => {
  const {id, title, question} = JSON.parse(readFileSync(resolve(data, name), 'utf8')) as {id: string, title: string, question: string}
  return {id, title, question, file: name}
})
writeFileSync(resolve(data, 'index.json'), JSON.stringify(index, null, 1))
