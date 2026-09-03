import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODELS_DEV_PROVIDER_IDS, type GeneratedManifest } from '../src/models/generated-card'
import { mapProvider } from './catalogue-map'
import type { ProviderMapping, ProviderReport } from './catalogue-report'
import { mapInferenceModels } from './inference-map'
import { fetchInferenceModels, INFERENCE_SOURCE } from './inference-net'
import { fetchModelsDevIndex, MODELS_DEV_SOURCE } from './models-dev'

const SOURCE = `${MODELS_DEV_SOURCE} + ${INFERENCE_SOURCE}`

const SHRINK_FLOOR = 0.6
const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/models/generated')
const MANIFEST_PATH = join(OUTPUT_DIR, 'manifest.json')

const providerPath = (providerId: string): string => join(OUTPUT_DIR, `${providerId}.json`)

const writeJson = async ({ path, value }: { path: string; value: unknown }): Promise<void> => {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function previousModelCount(providerId: string): Promise<number | undefined> {
  const file = Bun.file(providerPath(providerId))
  if (!(await file.exists())) return undefined

  const parsed: unknown = await file.json()
  return Array.isArray(parsed) ? parsed.length : undefined
}

async function recordedModelCount(): Promise<number | undefined> {
  const file = Bun.file(MANIFEST_PATH)
  if (!(await file.exists())) return undefined

  const parsed: unknown = await file.json()
  if (parsed === null || typeof parsed !== 'object') return undefined

  const modelCount = Reflect.get(parsed, 'modelCount')
  return typeof modelCount === 'number' ? modelCount : undefined
}

function hashOf(mappings: readonly ProviderMapping[]): string {
  const hasher = new Bun.CryptoHasher('sha256')
  for (const mapping of mappings) {
    hasher.update(`${mapping.report.providerId}\n`)
    hasher.update(`${JSON.stringify(mapping.cards)}\n`)
  }
  return hasher.digest('hex')
}

async function assertNoShrink(mappings: readonly ProviderMapping[]): Promise<void> {
  for (const mapping of mappings) {
    if (mapping.cards.length > 0) continue

    const before = await previousModelCount(mapping.report.providerId)
    if (before !== undefined && before > 0) {
      throw new Error(
        `${mapping.report.providerId} came back empty but held ${before} models — refusing to write a truncated catalogue`,
      )
    }
  }

  const recorded = await recordedModelCount()
  if (recorded === undefined) return

  const total = mappings.reduce((sum, mapping) => sum + mapping.cards.length, 0)
  const floor = Math.ceil(recorded * SHRINK_FLOOR)
  if (total < floor) {
    throw new Error(
      `${SOURCE} yielded ${total} models against ${recorded} recorded — below the ${floor} floor, refusing to write`,
    )
  }
}

function printReport(report: ProviderReport): void {
  const api = report.api ?? '(no api mapping)'
  console.log(`  ${report.providerId} [${api}]: ${report.kept} kept`)

  for (const [reason, count] of Object.entries(report.skipped)) {
    console.log(`    skipped ${count}: ${reason}`)
  }
  for (const [note, count] of Object.entries(report.notes)) {
    console.log(`    note ${count}: ${note}`)
  }
}

async function main(): Promise<void> {
  const index = await fetchModelsDevIndex()

  const mappings: ProviderMapping[] = []
  for (const providerId of MODELS_DEV_PROVIDER_IDS) {
    const provider = index[providerId]
    if (provider === undefined) {
      throw new Error(`models.dev no longer lists provider ${providerId}`)
    }
    mappings.push(mapProvider({ providerId, provider }))
  }

  mappings.push(mapInferenceModels(await fetchInferenceModels()))

  await assertNoShrink(mappings)

  for (const mapping of mappings) {
    await writeJson({ path: providerPath(mapping.report.providerId), value: mapping.cards })
  }

  const modelCount = mappings.reduce((sum, mapping) => sum + mapping.cards.length, 0)
  const manifest: GeneratedManifest = {
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    providerCount: mappings.length,
    modelCount,
    hash: hashOf(mappings),
  }
  await writeJson({ path: MANIFEST_PATH, value: manifest })

  console.log(`${SOURCE} → ${modelCount} models across ${mappings.length} providers`)
  for (const mapping of mappings) printReport(mapping.report)
  console.log(`hash ${manifest.hash}`)
}

await main()
