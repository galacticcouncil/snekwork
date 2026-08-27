/**
 * Write the runtime's type bundle to the JSON file `typegen.json` reads.
 *
 * `squid-substrate-typegen` takes `typesBundle` as a bundle name or a file path,
 * so the bundle the processors use at runtime (src/basiliskTypesBundle.ts) has
 * to be materialised as JSON before generation. Running this from the same
 * module keeps one source of truth: the JSON is a build artifact and is not
 * tracked. `npm run typegen` runs this first.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { basiliskTypesBundle } from '../basiliskTypesBundle.js'

const outFile = process.argv[2] ?? 'typegen/basilisk-types.json'

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, `${JSON.stringify(basiliskTypesBundle, null, 2)}\n`)
console.log(`[typegen] wrote type bundle to ${outFile}`)
