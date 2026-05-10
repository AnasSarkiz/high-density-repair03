import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import samples from "dataset-drc14"
import { useMemo, useState } from "react"
import {
  GlobalDrcForceImproveSolver,
  type HighDensityRoute,
  type SimpleRouteJson,
  type SimplifiedPcbTrace,
} from "../lib"
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

type SolverInput = {
  srj: SimpleRouteJson
  hdRoutes: HighDensityRoute[]
}

const datasetSamples = samples as DatasetSample[]

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

const sampleToSolverInput = (sample: DatasetSample): SolverInput => {
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

const parsePositiveIntegerInput = (value: string) => {
  const parsedValue = Number.parseInt(value, 10)
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : undefined
}

const parsePositiveNumberInput = (value: string, fallback: number) => {
  const parsedValue = Number(value)
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : fallback
}

export default function Drc14ProblemsFixture() {
  const [sampleNumberInput, setSampleNumberInput] = useState("1")
  const [effortInput, setEffortInput] = useState("1")
  const [maxIterationsInput, setMaxIterationsInput] = useState("")

  const maxSampleNumber = datasetSamples.length
  const parsedSampleNumber = Number.parseInt(sampleNumberInput, 10)
  const safeSampleNumber = Number.isFinite(parsedSampleNumber)
    ? Math.min(Math.max(parsedSampleNumber, 1), maxSampleNumber)
    : 1
  const selectedSample =
    datasetSamples[safeSampleNumber - 1] ?? datasetSamples[0]
  const effort = parsePositiveNumberInput(effortInput, 1)
  const maxIterations = parsePositiveIntegerInput(maxIterationsInput)

  const input = useMemo(() => {
    if (!selectedSample) return null

    try {
      const solverInput = sampleToSolverInput(selectedSample)
      return { solverInput, error: null }
    } catch (error) {
      return {
        solverInput: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }, [selectedSample])

  const initialDrcCount = useMemo(() => {
    if (!input?.solverInput) return null
    return getDrcSnapshot(input.solverInput.srj, input.solverInput.hdRoutes)
      .count
  }, [input])

  if (!selectedSample || !input) {
    return <div>No DRC14 samples found.</div>
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label htmlFor="drc14-sample-number">Sample #</label>
        <input
          id="drc14-sample-number"
          type="number"
          min={1}
          max={maxSampleNumber}
          value={sampleNumberInput}
          onChange={(event) => setSampleNumberInput(event.currentTarget.value)}
          style={{ width: 96 }}
        />
        <button
          type="button"
          onClick={() =>
            setSampleNumberInput(String(Math.max(1, safeSampleNumber - 1)))
          }
        >
          Prev
        </button>
        <button
          type="button"
          onClick={() =>
            setSampleNumberInput(
              String(Math.min(maxSampleNumber, safeSampleNumber + 1)),
            )
          }
        >
          Next
        </button>
        <label htmlFor="drc14-effort">Effort</label>
        <input
          id="drc14-effort"
          type="number"
          min={0.1}
          step={0.1}
          value={effortInput}
          onChange={(event) => setEffortInput(event.currentTarget.value)}
          style={{ width: 72 }}
        />
        <label htmlFor="drc14-max-iterations">Max iterations</label>
        <input
          id="drc14-max-iterations"
          type="number"
          min={1}
          placeholder="auto"
          value={maxIterationsInput}
          onChange={(event) => setMaxIterationsInput(event.currentTarget.value)}
          style={{ width: 112 }}
        />
      </div>

      <div style={{ fontFamily: "monospace", fontSize: 12 }}>
        {selectedSample.id ?? "unknown"} ({safeSampleNumber} / {maxSampleNumber}
        ) initialDrc={initialDrcCount ?? "n/a"} traces=
        {input.solverInput?.hdRoutes.length ?? "n/a"}
      </div>

      {input.error ? <div>Failed to load sample: {input.error}</div> : null}

      {input.solverInput ? (
        <GenericSolverDebugger
          key={`${selectedSample.id ?? safeSampleNumber}-${effort}-${maxIterations ?? "auto"}`}
          createSolver={() =>
            new GlobalDrcForceImproveSolver({
              srj: input.solverInput.srj,
              hdRoutes: input.solverInput.hdRoutes,
              effort,
              ...(maxIterations !== undefined ? { maxIterations } : {}),
            })
          }
        />
      ) : null}
    </div>
  )
}
