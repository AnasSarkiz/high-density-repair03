import { expect, test } from "bun:test"
import { GlobalDrcForceImproveSolver } from "../lib"
import { getDrcSnapshot } from "../lib/solvers/GlobalDrcForceImproveSolver/drc-snapshot"
import type { SimpleRouteJson } from "../lib"

test("moves an overlapping trace-pad run as a segment", () => {
  const srj: SimpleRouteJson = {
    bounds: { minX: -1, minY: -1, maxX: 11, maxY: 7 },
    connections: [{ name: "A", pointsToConnect: [] }],
    obstacles: [
      {
        type: "rect",
        center: { x: 2, y: 5 },
        width: 1,
        height: 1,
        layers: ["top"],
        connectedTo: ["different_net"],
      },
    ],
    layerCount: 2,
    minTraceWidth: 0.1,
    minViaDiameter: 0.3,
  }
  const hdRoutes = [
    {
      connectionName: "A",
      route: [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 5, z: 0 },
        { x: 5, y: 5, z: 0 },
        { x: 10, y: 5, z: 0 },
        { x: 10, y: 0, z: 0 },
      ],
      vias: [],
      traceThickness: 0.1,
      viaDiameter: 0.3,
    },
  ]
  const solver = new GlobalDrcForceImproveSolver({
    srj,
    hdRoutes,
    maxIterations: 1,
    drcEvaluator: ({ routes }) => {
      const route = routes?.[0]?.route
      const innerStart = route?.[1]
      if (!innerStart || innerStart.y > 5.1) return []
      return [
        {
          message: "pcb_trace overlaps pcb_smtpad",
          center: { x: 2, y: 5 },
          pcb_trace_id: "A_0",
        },
      ]
    },
  })

  solver.solve()

  const output = solver.getOutput()
  const movedRun = output[0]?.route.slice(1, 4) ?? []
  expect(movedRun).toHaveLength(3)
  for (const point of movedRun) {
    expect(point.y).toBeGreaterThan(5.1)
    expect(point.y).toBeCloseTo(movedRun[0]!.y, 6)
  }
})

test("moves a jittered trace-pad run as one segment run", () => {
  const srj: SimpleRouteJson = {
    bounds: { minX: -2, minY: -4, maxX: 2, maxY: 4 },
    connections: [{ name: "A", pointsToConnect: [] }],
    obstacles: [
      {
        type: "rect",
        center: { x: -1, y: 0 },
        width: 2,
        height: 3,
        layers: ["top"],
        connectedTo: ["different_net"],
      },
    ],
    layerCount: 2,
    minTraceWidth: 0.1,
    minViaDiameter: 0.3,
  }
  const hdRoutes = [
    {
      connectionName: "A",
      route: [
        { x: -1.2, y: -3, z: 0 },
        { x: 0, y: -1.2, z: 0 },
        { x: 0.008, y: -0.6, z: 0 },
        { x: -0.002, y: 0, z: 0 },
        { x: 0.007, y: 0.6, z: 0 },
        { x: 0, y: 1.2, z: 0 },
        { x: 1.2, y: 3, z: 0 },
      ],
      vias: [],
      traceThickness: 0.15,
      viaDiameter: 0.3,
    },
  ]
  const solver = new GlobalDrcForceImproveSolver({
    srj,
    hdRoutes,
    maxIterations: 1,
    drcEvaluator: ({ routes }) => {
      const route = routes?.[0]?.route ?? []
      const movedRun = route.slice(1, 6)
      if (movedRun.length === 5 && movedRun.every((point) => point.x > 0.2)) {
        return []
      }
      return [
        {
          message: "pcb_trace overlaps pcb_smtpad",
          center: { x: 0, y: 0 },
          pcb_trace_id: "A_0",
        },
      ]
    },
  })

  solver.solve()

  const output = solver.getOutput()
  expect(output[0]?.route[0]).toMatchObject({ x: -1.2, y: -3 })
  expect(output[0]?.route[6]).toMatchObject({ x: 1.2, y: 3 })
  for (const point of output[0]?.route.slice(1, 6) ?? []) {
    expect(point.x).toBeGreaterThan(0.2)
  }
})

test("does not move a trace away from a same-net pad", () => {
  const srj: SimpleRouteJson = {
    bounds: { minX: -1, minY: -1, maxX: 11, maxY: 7 },
    connections: [{ name: "A", pointsToConnect: [] }],
    obstacles: [
      {
        type: "rect",
        center: { x: 2, y: 5 },
        width: 1,
        height: 1,
        layers: ["top"],
        connectedTo: ["A"],
      },
    ],
    layerCount: 2,
    minTraceWidth: 0.1,
    minViaDiameter: 0.3,
  }
  const hdRoutes = [
    {
      connectionName: "A",
      route: [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 5, z: 0 },
        { x: 5, y: 5, z: 0 },
        { x: 10, y: 5, z: 0 },
        { x: 10, y: 0, z: 0 },
      ],
      vias: [],
      traceThickness: 0.1,
      viaDiameter: 0.3,
    },
  ]
  const solver = new GlobalDrcForceImproveSolver({
    srj,
    hdRoutes,
    maxIterations: 1,
    drcEvaluator: () => [
      {
        message: "pcb_trace overlaps pcb_smtpad",
        center: { x: 2, y: 5 },
        pcb_trace_id: "A_0",
      },
    ],
  })

  solver.solve()

  const output = solver.getOutput()
  const movedRun = output[0]?.route.slice(1, 4) ?? []
  expect(movedRun).toHaveLength(3)
  for (const point of movedRun) {
    expect(point.y).toBe(5)
  }
})

test("moves a via until its edge clears a different-net pad edge", () => {
  const srj: SimpleRouteJson = {
    bounds: { minX: -2, minY: -2, maxX: 6, maxY: 4 },
    connections: [{ name: "A", pointsToConnect: [] }],
    obstacles: [
      {
        type: "rect",
        center: { x: 2, y: 2 },
        width: 1,
        height: 1,
        layers: ["top"],
        connectedTo: ["different_net"],
      },
    ],
    layerCount: 2,
    minTraceWidth: 0.1,
    minViaDiameter: 0.3,
    minViaEdgeToPadEdgeClearance: 0.2,
  }
  const hdRoutes = [
    {
      connectionName: "A",
      route: [
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 1.56, z: 0 },
        { x: 2, y: 1.56, z: 1 },
        { x: 4, y: 0, z: 1 },
      ],
      vias: [{ x: 2, y: 1.56 }],
      traceThickness: 0.1,
      viaDiameter: 0.3,
    },
  ]
  const solver = new GlobalDrcForceImproveSolver({
    srj,
    hdRoutes,
    maxIterations: 1,
    drcEvaluator: () => [],
  })

  solver.solve()

  const output = solver.getOutput()
  const route = output[0]?.route ?? []
  const viaPoint = route[1]!
  const pairedViaPoint = route[2]!
  const padBottomEdgeY = 1.5
  const viaRadius = 0.15
  const viaEdgeToPadEdgeClearance = padBottomEdgeY - viaPoint.y - viaRadius

  expect(viaEdgeToPadEdgeClearance).toBeGreaterThanOrEqual(0.2)
  expect(pairedViaPoint).toMatchObject({ x: viaPoint.x, y: viaPoint.y })
  expect(output[0]?.vias[0]?.x).toBeCloseTo(viaPoint.x, 6)
  expect(output[0]?.vias[0]?.y).toBeCloseTo(viaPoint.y, 3)
})

test("moves a via until its edge clears a same-net pad edge when not attached", () => {
  const srj: SimpleRouteJson = {
    bounds: { minX: -2, minY: -2, maxX: 6, maxY: 4 },
    connections: [{ name: "A", pointsToConnect: [] }],
    obstacles: [
      {
        type: "rect",
        center: { x: 2, y: 2 },
        width: 1,
        height: 1,
        layers: ["top"],
        connectedTo: ["A"],
      },
    ],
    layerCount: 2,
    minTraceWidth: 0.1,
    minViaDiameter: 0.3,
    minViaEdgeToPadEdgeClearance: 0.2,
  }
  const hdRoutes = [
    {
      connectionName: "A",
      route: [
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 1.26, z: 0 },
        { x: 2, y: 1.26, z: 1 },
        { x: 4, y: 0, z: 1 },
      ],
      vias: [{ x: 2, y: 1.26 }],
      traceThickness: 0.1,
      viaDiameter: 0.3,
    },
  ]
  const solver = new GlobalDrcForceImproveSolver({
    srj,
    hdRoutes,
    maxIterations: 1,
    drcEvaluator: () => [],
  })

  solver.solve()

  const output = solver.getOutput()
  const route = output[0]?.route ?? []
  const viaPoint = route[1]!
  const padBottomEdgeY = 1.5
  const viaRadius = 0.15
  const viaEdgeToPadEdgeClearance = padBottomEdgeY - viaPoint.y - viaRadius

  expect(viaEdgeToPadEdgeClearance).toBeGreaterThanOrEqual(0.2)
  expect(route[2]).toMatchObject({ x: viaPoint.x, y: viaPoint.y })
  expect(output[0]?.vias[0]?.x).toBeCloseTo(viaPoint.x, 6)
  expect(output[0]?.vias[0]?.y).toBeCloseTo(viaPoint.y, 3)
})

test("does not move an attached via centered on a same-net pad", () => {
  const srj: SimpleRouteJson = {
    bounds: { minX: -2, minY: -2, maxX: 6, maxY: 4 },
    connections: [{ name: "A", pointsToConnect: [] }],
    obstacles: [
      {
        type: "rect",
        center: { x: 2, y: 2 },
        width: 1,
        height: 1,
        layers: ["top"],
        connectedTo: ["A"],
      },
    ],
    layerCount: 2,
    minTraceWidth: 0.1,
    minViaDiameter: 0.3,
    minViaEdgeToPadEdgeClearance: 0.2,
  }
  const hdRoutes = [
    {
      connectionName: "A",
      route: [
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 2, z: 0 },
        { x: 2, y: 2, z: 1 },
        { x: 4, y: 0, z: 1 },
      ],
      vias: [{ x: 2, y: 2 }],
      traceThickness: 0.1,
      viaDiameter: 0.3,
    },
  ]
  const solver = new GlobalDrcForceImproveSolver({
    srj,
    hdRoutes,
    maxIterations: 1,
    drcEvaluator: () => [],
  })

  solver.solve()

  const output = solver.getOutput()
  expect(output[0]?.route[1]).toMatchObject({ x: 2, y: 2 })
  expect(output[0]?.route[2]).toMatchObject({ x: 2, y: 2 })
  expect(output[0]?.vias[0]).toMatchObject({ x: 2, y: 2 })
})

test("treats composite root names as same-net when checking pad attachments", () => {
  const srj: SimpleRouteJson = {
    bounds: { minX: -1, minY: -1, maxX: 11, maxY: 7 },
    connections: [{ name: "A", pointsToConnect: [] }],
    obstacles: [
      {
        type: "rect",
        center: { x: 2, y: 5 },
        width: 1,
        height: 1,
        layers: ["top"],
        connectedTo: ["source_trace_1", "pcb_port_1"],
      },
    ],
    layerCount: 2,
    minTraceWidth: 0.1,
    minViaDiameter: 0.3,
  }
  const hdRoutes = [
    {
      connectionName: "source_trace_1__source_trace_2_mst0",
      rootConnectionName: "source_trace_1__source_trace_2",
      route: [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 5, z: 0 },
        { x: 5, y: 5, z: 0 },
        { x: 10, y: 5, z: 0 },
        { x: 10, y: 0, z: 0 },
      ],
      vias: [],
      traceThickness: 0.1,
      viaDiameter: 0.3,
    },
  ]
  const solver = new GlobalDrcForceImproveSolver({
    srj,
    hdRoutes,
    maxIterations: 1,
    drcEvaluator: () => [
      {
        message: "pcb_trace overlaps pcb_smtpad",
        center: { x: 2, y: 5 },
        pcb_trace_id: "source_trace_1__source_trace_2_mst0_0",
      },
    ],
  })

  solver.solve()

  const output = solver.getOutput()
  const movedRun = output[0]?.route.slice(1, 4) ?? []
  expect(movedRun).toHaveLength(3)
  for (const point of movedRun) {
    expect(point.y).toBe(5)
  }
})

test("preserves width, via diameter, and endpoint port ids in DRC traces", () => {
  const srj = {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    connections: [
      {
        name: "A",
        pointsToConnect: [
          { x: 1, y: 1, layer: "top", pcb_port_id: "pcb_port_start" },
          { x: 4, y: 1, layer: "bottom", pcb_port_id: "pcb_port_end" },
        ],
      },
    ],
    obstacles: [],
    layerCount: 2,
    minTraceWidth: 0.1,
    minViaDiameter: 0.3,
  }
  const hdRoutes = [
    {
      connectionName: "A",
      route: [
        { x: 1, y: 1, z: 0 },
        { x: 2, y: 1, z: 0 },
        { x: 2, y: 1, z: 1 },
        { x: 4, y: 1, z: 1 },
      ],
      vias: [{ x: 2, y: 1 }],
      traceThickness: 0.42,
      viaDiameter: 0.71,
    },
  ]
  let observedTrace: {
    route: Array<Record<string, unknown>>
  } | null = null

  const snapshot = getDrcSnapshot(srj, hdRoutes, ({ traces }) => {
    observedTrace = traces[0] ?? null
    return []
  })

  expect(snapshot.count).toBe(0)
  expect(observedTrace).not.toBeNull()
  if (!observedTrace) {
    throw new Error("expected drcEvaluator to receive a trace")
  }
  const trace = observedTrace as {
    route: Array<Record<string, unknown>>
  }
  expect(trace.route[0]).toEqual({
    route_type: "wire",
    x: 1,
    y: 1,
    width: 0.42,
    layer: "top",
    start_pcb_port_id: "pcb_port_start",
  })
  expect(trace.route[1]).toEqual({
    route_type: "wire",
    x: 2,
    y: 1,
    width: 0.42,
    layer: "top",
  })
  expect(trace.route[2]).toEqual({
    route_type: "via",
    x: 2,
    y: 1,
    from_layer: "top",
    to_layer: "bottom",
    via_diameter: 0.71,
  })
  expect(trace.route[3]).toEqual({
    route_type: "wire",
    x: 4,
    y: 1,
    width: 0.42,
    layer: "bottom",
    end_pcb_port_id: "pcb_port_end",
  })
})
