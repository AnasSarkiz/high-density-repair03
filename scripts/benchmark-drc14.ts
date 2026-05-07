import { writeFileSync } from "node:fs"
import { cpus } from "node:os"
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads"
import samples from "dataset-drc14"
import type {
  HighDensityRoute,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "../lib"
import { GlobalDrcForceImproveSolver } from "../lib"
import { getDrcSnapshot } from "../lib/solvers/GlobalDrcForceImproveSolver/drc-snapshot"
import type { SimpleRouteConnection } from "../types/srj-types"

type DatasetSample = {
  id?: string
  simpleRouteJson?: SimpleRouteJson & { traces?: SimplifiedPcbTrace[] }
  metadata?: {
    relaxedDrcErrorCount?: number
    relaxedDrcPassed?: boolean
    sourceDataset?: string
    routingPipeline?: string
  }
}

type SampleResult = {
  sampleId: string
  traceCount: number
  initialDrcCount: number
  finalDrcCount: number
  improvement: number
  iterations: number
  elapsedMs: number
  metadataRelaxedDrcErrorCount?: number
  error?: string
}

type IndexedSampleResult = SampleResult & { sampleIndex: number }

type WorkerInput = {
  sampleIndex: number
  effort: number
  maxIterations?: number
}

type WorkerDoneMessage = {
  type: "done"
  sampleIndex: number
  result: SampleResult
}

type BenchmarkReport = {
  dataset: "drc14"
  sampleCount: number
  succeeded: number
  failed: number
  improved: number
  clean: number
  totalInitialDrcCount: number
  totalFinalDrcCount: number
  totalImprovement: number
  totalSolveTimeMs: number
  averageSolveTimeMs: number
  metadata: {
    effort: number
    maxIterations?: number
    concurrency: number
    scenarioLimitUsed: number
  }
  sampleResults: SampleResult[]
}

const formatMs = (ms: number) => `${ms.toFixed(2)}ms`

const printHelp = () => {
  console.log(`Usage:
  bun scripts/benchmark-drc14.ts [--limit N|all] [--concurrency N] [--effort N] [--max-iterations N] [--out PATH] [--json] [--fail-on-drc]

Options:
  --limit N|all          Run first N samples, or all samples (default: all)
  --concurrency N        Number of Bun workers, or "auto"
  --effort N             Solver effort value (default: 1)
  --max-iterations N     Override solver max iterations
  --out PATH             Write JSON benchmark report (default: benchmark-result.json)
  --no-out               Do not write a JSON benchmark report
  --json                 Print the JSON report to stdout
  --fail-on-drc          Exit non-zero when any final DRC remains
  -h, --help             Show this help`)
}

const parseValueArg = (args: string[], flag: string) => {
  const equalsArg = args.find((arg) => arg.startsWith(`${flag}=`))
  if (equalsArg) return equalsArg.slice(flag.length + 1)

  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

const parseFirstValueArg = (args: string[], flags: string[]) => {
  for (const flag of flags) {
    const value = parseValueArg(args, flag)
    if (value !== undefined) return value
  }

  return undefined
}

const parsePositiveNumberArg = (
  args: string[],
  flag: string,
  fallback: number,
) => {
  const rawValue = parseValueArg(args, flag)
  if (rawValue === undefined) return fallback

  const value = Number(rawValue)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid value for ${flag}: ${rawValue}`)
  }

  return value
}

const parseOptionalPositiveIntegerArg = (args: string[], flag: string) => {
  const rawValue = parseValueArg(args, flag)
  if (rawValue === undefined) return undefined

  const value = Number(rawValue)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid value for ${flag}: ${rawValue}`)
  }

  return value
}

const parseLimitArg = (args: string[], sampleCount: number) => {
  const rawValue = parseValueArg(args, "--limit")
  if (rawValue === undefined || rawValue.toLowerCase() === "all") {
    return sampleCount
  }

  const value = Number(rawValue)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid value for --limit: ${rawValue}`)
  }

  return Math.min(value, sampleCount)
}

const getDefaultConcurrency = () => {
  const rawValue = Bun.env.BENCHMARK_CONCURRENCY
  if (!rawValue) return Math.max(1, cpus().length)
  if (rawValue === "auto") return Math.max(1, cpus().length)

  const value = Number(rawValue)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid BENCHMARK_CONCURRENCY: ${rawValue}`)
  }

  return value
}

const parseConcurrencyArg = (args: string[]) => {
  const rawValue = parseFirstValueArg(args, [
    "--concurrency",
    "--concurrent",
    "--concurent",
    "--CONCURENT",
  ])
  if (rawValue === undefined) return getDefaultConcurrency()
  if (rawValue === "auto") return Math.max(1, cpus().length)

  const value = Number(rawValue)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid value for --concurrency: ${rawValue}`)
  }

  return value
}

const getLayerZ = (layer: string, layerCount: number) => {
  if (layer === "top") return 0
  if (layer === "bottom") return Math.max(0, layerCount - 1)

  const innerLayerMatch = layer.match(/^inner(\d+)$/)
  if (innerLayerMatch) {
    const z = Number(innerLayerMatch[1])
    if (Number.isInteger(z) && z > 0 && z < layerCount - 1) return z
  }

  throw new Error(`Unsupported route layer: ${layer}`)
}

const pushRoutePoint = (
  route: HighDensityRoute["route"],
  point: HighDensityRoute["route"][number],
) => {
  const lastPoint = route[route.length - 1]
  if (
    lastPoint &&
    lastPoint.x === point.x &&
    lastPoint.y === point.y &&
    lastPoint.z === point.z
  ) {
    return
  }
  route.push(point)
}

const getConnectionNameForTrace = (
  trace: SimplifiedPcbTrace,
  connections: SimpleRouteConnection[],
) => {
  const matchingConnection = connections
    .filter((connection) =>
      trace.pcb_trace_id.startsWith(`${connection.name}_`),
    )
    .sort((a, b) => b.name.length - a.name.length)[0]

  return matchingConnection?.name ?? trace.connection_name
}

const traceToHdRoute = (
  trace: SimplifiedPcbTrace,
  srj: SimpleRouteJson,
): HighDensityRoute => {
  const route: HighDensityRoute["route"] = []
  const vias: HighDensityRoute["vias"] = []
  let traceThickness = srj.minTraceWidth
  let viaDiameter = srj.minViaDiameter ?? 0.3

  for (const segment of trace.route) {
    if (segment.route_type === "wire") {
      traceThickness = segment.width
      pushRoutePoint(route, {
        x: segment.x,
        y: segment.y,
        z: getLayerZ(segment.layer, srj.layerCount),
        ...(segment.start_pcb_port_id
          ? { pcb_port_id: segment.start_pcb_port_id }
          : {}),
        ...(segment.end_pcb_port_id
          ? { pcb_port_id: segment.end_pcb_port_id }
          : {}),
      })
      continue
    }

    if (segment.route_type === "via") {
      viaDiameter = segment.via_diameter ?? viaDiameter
      vias.push({ x: segment.x, y: segment.y })
      pushRoutePoint(route, {
        x: segment.x,
        y: segment.y,
        z: getLayerZ(segment.from_layer, srj.layerCount),
      })
      pushRoutePoint(route, {
        x: segment.x,
        y: segment.y,
        z: getLayerZ(segment.to_layer, srj.layerCount),
      })
      continue
    }

    pushRoutePoint(route, {
      x: segment.start.x,
      y: segment.start.y,
      z: getLayerZ(segment.layer, srj.layerCount),
    })
    pushRoutePoint(route, {
      x: segment.end.x,
      y: segment.end.y,
      z: getLayerZ(segment.layer, srj.layerCount),
    })
  }

  return {
    connectionName: getConnectionNameForTrace(trace, srj.connections),
    rootConnectionName: trace.connection_name,
    traceThickness,
    viaDiameter,
    route,
    vias,
  }
}

const sampleToHdRoutes = (sample: DatasetSample) => {
  const srj = sample.simpleRouteJson
  if (!srj) {
    throw new Error("Sample is missing simpleRouteJson")
  }
  if (!srj.traces || srj.traces.length === 0) {
    throw new Error("Sample simpleRouteJson is missing traces")
  }

  return {
    srj,
    hdRoutes: srj.traces.map((trace) => traceToHdRoute(trace, srj)),
  }
}

const runSample = ({
  sample,
  effort,
  maxIterations,
}: {
  sample: DatasetSample
  effort: number
  maxIterations?: number
}): SampleResult => {
  const sampleId = sample.id ?? "unknown"
  const startedAt = performance.now()

  try {
    const { srj, hdRoutes } = sampleToHdRoutes(sample)
    const initialDrc = getDrcSnapshot(srj, hdRoutes)
    const solver = new GlobalDrcForceImproveSolver({
      srj,
      hdRoutes,
      effort,
      ...(maxIterations !== undefined ? { maxIterations } : {}),
    })

    solver.solve()

    const outputRoutes = solver.getOutput()
    const finalDrc = getDrcSnapshot(srj, outputRoutes)
    const elapsedMs = performance.now() - startedAt

    return {
      sampleId,
      traceCount: hdRoutes.length,
      initialDrcCount: initialDrc.count,
      finalDrcCount: finalDrc.count,
      improvement: initialDrc.count - finalDrc.count,
      iterations: solver.iterations,
      elapsedMs,
      metadataRelaxedDrcErrorCount: sample.metadata?.relaxedDrcErrorCount,
    }
  } catch (error) {
    return {
      sampleId,
      traceCount: 0,
      initialDrcCount: 0,
      finalDrcCount: 0,
      improvement: 0,
      iterations: 0,
      elapsedMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const buildReport = ({
  results,
  effort,
  maxIterations,
  concurrency,
  scenarioLimitUsed,
}: {
  results: SampleResult[]
  effort: number
  maxIterations?: number
  concurrency: number
  scenarioLimitUsed: number
}): BenchmarkReport => {
  const succeeded = results.filter((result) => !result.error)
  const totalSolveTimeMs = results.reduce(
    (sum, result) => sum + result.elapsedMs,
    0,
  )
  const totalInitialDrcCount = succeeded.reduce(
    (sum, result) => sum + result.initialDrcCount,
    0,
  )
  const totalFinalDrcCount = succeeded.reduce(
    (sum, result) => sum + result.finalDrcCount,
    0,
  )

  return {
    dataset: "drc14",
    sampleCount: results.length,
    succeeded: succeeded.length,
    failed: results.length - succeeded.length,
    improved: succeeded.filter((result) => result.improvement > 0).length,
    clean: succeeded.filter((result) => result.finalDrcCount === 0).length,
    totalInitialDrcCount,
    totalFinalDrcCount,
    totalImprovement: totalInitialDrcCount - totalFinalDrcCount,
    totalSolveTimeMs,
    averageSolveTimeMs:
      results.length > 0 ? totalSolveTimeMs / results.length : 0,
    metadata: {
      effort,
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      concurrency,
      scenarioLimitUsed,
    },
    sampleResults: results,
  }
}

const logSummary = (report: BenchmarkReport) => {
  const rows: Array<[string, string]> = [
    ["Samples", String(report.sampleCount)],
    ["Succeeded", String(report.succeeded)],
    ["Failed", String(report.failed)],
    ["Improved", String(report.improved)],
    ["Clean", String(report.clean)],
    ["Initial DRC", String(report.totalInitialDrcCount)],
    ["Final DRC", String(report.totalFinalDrcCount)],
    ["DRC improvement", String(report.totalImprovement)],
    ["Total solve time", formatMs(report.totalSolveTimeMs)],
    ["Average solve time", formatMs(report.averageSolveTimeMs)],
  ]
  const metricHeader = "Metric"
  const valueHeader = "Value"
  const metricWidth = Math.max(
    metricHeader.length,
    ...rows.map(([metric]) => metric.length),
  )
  const valueWidth = Math.max(
    valueHeader.length,
    ...rows.map(([, value]) => value.length),
  )
  const horizontal = `+${"-".repeat(metricWidth + 2)}+${"-".repeat(valueWidth + 2)}+`
  const renderRow = (metric: string, value: string) =>
    `| ${metric.padEnd(metricWidth)} | ${value.padStart(valueWidth)} |`

  console.log("")
  console.log("Dataset DRC14 benchmark summary")
  console.log(horizontal)
  console.log(renderRow(metricHeader, valueHeader))
  console.log(horizontal)
  for (const [metric, value] of rows) {
    console.log(renderRow(metric, value))
  }
  console.log(horizontal)
}

const logSampleResult = (
  result: SampleResult,
  sampleNumber: number,
  sampleCount: number,
) => {
  const status = result.error
    ? `error=${result.error}`
    : `drc=${result.initialDrcCount}->${result.finalDrcCount} iterations=${result.iterations}`
  console.log(
    `[sample] ${sampleNumber}/${sampleCount} ${result.sampleId} traces=${result.traceCount} ${status} time=${formatMs(result.elapsedMs)}`,
  )
}

const runSamples = async ({
  selectedSamples,
  effort,
  maxIterations,
  concurrency,
}: {
  selectedSamples: DatasetSample[]
  effort: number
  maxIterations?: number
  concurrency: number
}) => {
  const results: IndexedSampleResult[] = []
  let nextIndex = 0
  let activeWorkers = 0

  return await new Promise<SampleResult[]>((resolve) => {
    const finishIfDone = () => {
      if (
        nextIndex >= selectedSamples.length &&
        activeWorkers === 0 &&
        results.length === selectedSamples.length
      ) {
        resolve(
          results
            .sort((a, b) => a.sampleIndex - b.sampleIndex)
            .map(({ sampleIndex: _sampleIndex, ...result }) => result),
        )
      }
    }

    const launchNextWorker = () => {
      while (
        activeWorkers < concurrency &&
        nextIndex < selectedSamples.length
      ) {
        const sampleIndex = nextIndex
        nextIndex += 1
        activeWorkers += 1
        let hasResult = false

        const worker = new Worker(new URL(import.meta.url), {
          workerData: {
            sampleIndex,
            effort,
            ...(maxIterations !== undefined ? { maxIterations } : {}),
          } satisfies WorkerInput,
        })

        worker.on("message", (message: WorkerDoneMessage) => {
          if (message.type !== "done") return
          hasResult = true

          const sampleNumber = message.sampleIndex + 1
          logSampleResult(message.result, sampleNumber, selectedSamples.length)
          results.push({
            ...message.result,
            sampleIndex: message.sampleIndex,
          })
        })

        worker.on("error", (error) => {
          hasResult = true
          const sample = selectedSamples[sampleIndex]
          const result: SampleResult = {
            sampleId: sample?.id ?? `sample${sampleIndex + 1}`,
            traceCount: 0,
            initialDrcCount: 0,
            finalDrcCount: 0,
            improvement: 0,
            iterations: 0,
            elapsedMs: 0,
            error: error instanceof Error ? error.message : String(error),
          }
          logSampleResult(result, sampleIndex + 1, selectedSamples.length)
          results.push({ ...result, sampleIndex })
        })

        worker.on("exit", () => {
          if (!hasResult) {
            const sample = selectedSamples[sampleIndex]
            const result: SampleResult = {
              sampleId: sample?.id ?? `sample${sampleIndex + 1}`,
              traceCount: 0,
              initialDrcCount: 0,
              finalDrcCount: 0,
              improvement: 0,
              iterations: 0,
              elapsedMs: 0,
              error: "Worker exited before returning a result",
            }
            logSampleResult(result, sampleIndex + 1, selectedSamples.length)
            results.push({ ...result, sampleIndex })
          }
          activeWorkers -= 1
          launchNextWorker()
          finishIfDone()
        })
      }

      finishIfDone()
    }

    launchNextWorker()
  })
}

const runWorker = () => {
  const { sampleIndex, effort, maxIterations } = workerData as WorkerInput
  const datasetSamples = samples as DatasetSample[]
  const sample = datasetSamples[sampleIndex]

  const result = sample
    ? runSample({ sample, effort, maxIterations })
    : ({
        sampleId: `sample${sampleIndex + 1}`,
        traceCount: 0,
        initialDrcCount: 0,
        finalDrcCount: 0,
        improvement: 0,
        iterations: 0,
        elapsedMs: 0,
        error: `Missing dataset sample at index ${sampleIndex}`,
      } satisfies SampleResult)

  parentPort?.postMessage({
    type: "done",
    sampleIndex,
    result,
  } satisfies WorkerDoneMessage)
}

export const runBenchmark = async (args: string[] = Bun.argv.slice(2)) => {
  if (args.includes("-h") || args.includes("--help")) {
    printHelp()
    return
  }

  const datasetSamples = samples as DatasetSample[]
  const limit = parseLimitArg(args, datasetSamples.length)
  const effort = parsePositiveNumberArg(args, "--effort", 1)
  const concurrency = parseConcurrencyArg(args)
  const maxIterations = parseOptionalPositiveIntegerArg(
    args,
    "--max-iterations",
  )
  const outputPath = parseValueArg(args, "--out") ?? "benchmark-result.json"
  const shouldWriteOutput = !args.includes("--no-out")
  const shouldPrintJson = args.includes("--json")
  const shouldFailOnDrc = args.includes("--fail-on-drc")

  const selectedSamples = datasetSamples.slice(0, limit)
  const effectiveConcurrency = Math.min(
    concurrency,
    Math.max(1, selectedSamples.length),
  )
  console.log(
    `Starting DRC14 benchmark: samples=${selectedSamples.length} workers=${effectiveConcurrency} effort=${effort}` +
      (maxIterations !== undefined ? ` maxIterations=${maxIterations}` : ""),
  )

  const results = await runSamples({
    selectedSamples,
    effort,
    maxIterations,
    concurrency: effectiveConcurrency,
  })

  const report = buildReport({
    results,
    effort,
    maxIterations,
    concurrency: effectiveConcurrency,
    scenarioLimitUsed: selectedSamples.length,
  })

  logSummary(report)

  if (shouldWriteOutput) {
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Wrote benchmark report to ${outputPath}`)
  }

  if (shouldPrintJson) {
    console.log(JSON.stringify(report, null, 2))
  }

  if (report.failed > 0 || (shouldFailOnDrc && report.totalFinalDrcCount > 0)) {
    process.exitCode = 1
  }
}

if (import.meta.main && isMainThread) {
  await runBenchmark()
} else if (!isMainThread) {
  runWorker()
}
