/**
 * Re-apply the local edit to the generated `src/types/support.ts`.
 *
 * `squid-substrate-typegen` emits a support module that re-exports `Option` and
 * `Result` from `@subsquid/substrate-runtime/lib/sts`. Both are types, not
 * values, so the generated form fails two ways: `tsc` rejects the re-export
 * under `isolatedModules`, and the ESM runtime throws on the missing named
 * exports the moment anything imports `src/types`. Declaring them locally is
 * equivalent — nothing in the generated code uses them as values.
 *
 * This runs as the last step of `npm run typegen` so regeneration cannot
 * silently drop the edit.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const supportFile = process.argv[2] ?? 'src/types/support.ts'

const generated = `import * as sts from '@subsquid/substrate-runtime/lib/sts'
import {Option, Result} from '@subsquid/substrate-runtime/lib/sts'
import assert from 'assert'


export {sts, Bytes, BitSequence, Option, Result}`

const patched = `import * as sts from '@subsquid/substrate-runtime/lib/sts'
import assert from 'assert'


// Option and Result are declared locally rather than re-exported from
// '@subsquid/substrate-runtime/lib/sts': they are types, so re-exporting them
// breaks \`tsc --isolatedModules\` and throws at ESM import time.
// Re-applied after every run by npm run typegen (see this file's header).
export type Option<T> = T | undefined
export type Result<T, E> = { __kind: 'Ok'; value: T } | { __kind: 'Err'; value: E }

export {sts, Bytes, BitSequence}`

const source = readFileSync(supportFile, 'utf8')

if (source.includes(patched)) {
  console.log(`[typegen] ${supportFile} already patched`)
} else if (source.includes(generated)) {
  writeFileSync(supportFile, source.replace(generated, patched))
  console.log(`[typegen] patched Option/Result exports in ${supportFile}`)
} else {
  throw new Error(
    `${supportFile} does not match either the generated or the patched form. `
    + 'squid-substrate-typegen changed its support module; update src/scripts/patch-typegen-support.ts.',
  )
}
