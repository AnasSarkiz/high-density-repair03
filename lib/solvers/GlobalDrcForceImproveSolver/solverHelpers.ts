import {
  pointToSegmentDistance,
  segmentToSegmentMinDistance,
} from "@tscircuit/math-utils"
import { RELAXED_DRC_OPTIONS } from "./drcPresets"
import { PREFERRED_VIA_TO_VIA_CLEARANCE, getDrcErrors } from "./getDrcErrors"
import { convertToCircuitJson } from "../utils/convertToCircuitJson"
import { getRootConnectionName, obstacleSharesNet, sharesNet } from "./netUtils"
import {
  BROAD_FORCE_PASSES,
  BROAD_MAX_MOVE,
  BROAD_SPATIAL_CELL_SIZE_MIN,
  CLEARANCE_SLACK,
  COORDINATE_EPSILON,
  MAX_ERROR_MOVE,
  POSITION_EPSILON,
  PREFERRED_TRACE_TO_PAD_CLEARANCE,
  TRACE_PAD_REPAIR_MAX_MOVE,
  VIA_PAIR_REPAIR_MAX_MOVE,
  getTraceToPadEdgeClearance,
  getViaEdgeToPadEdgeClearance,
} from "./solverConfig"
import {
  clampToBounds,
  clampValue,
  createSpatialIndex,
  expandBounds2d,
  getSpatialCandidateIndexes,
} from "./spatialIndex"
import type { DrcEvaluator, DrcSnapshot } from "./types"
import type {
  Bounds2D,
  MutableRoute,
  Point,
  Segment,
  ViaNode,
} from "./internalTypes"
import type { SimpleRouteJson, SimplifiedPcbTraces } from "../../types"
import type { HighDensityRoute } from "../../types/high-density-types"
import { convertHdRouteToSimplifiedRoute } from "../../utils/convertHdRouteToSimplifiedRoute"
import { mapZToLayerName } from "../../utils/mapZToLayerName"

export const cloneRoutes = (routes: HighDensityRoute[]): MutableRoute[] =>
  routes.map((route) => ({
    ...route,
    route: route.route.map((point) => ({ ...point })),
    vias: route.vias.map((via) => ({ ...via })),
  }))

const areSameXY = (left: Point, right: Point) =>
  Math.abs(left.x - right.x) <= COORDINATE_EPSILON &&
  Math.abs(left.y - right.y) <= COORDINATE_EPSILON

const OBSTACLE_TRACE_ERROR_TYPES = [
  "pcb_smtpad",
  "pcb_plated_hole",
  "pcb_hole",
  "pcb_keepout",
]

const isTraceObstacleDrcError = (error: Record<string, unknown>) => {
  const message =
    typeof error.message === "string" ? error.message.toLowerCase() : ""
  return (
    message.includes("pcb_trace") &&
    OBSTACLE_TRACE_ERROR_TYPES.some((type) => message.includes(type))
  )
}

const createSimplifiedTraces = (
  srj: SimpleRouteJson,
  routes: HighDensityRoute[],
): {
  traces: SimplifiedPcbTraces
  traceRouteIndexById: Map<string, number>
} => {
  const traces: SimplifiedPcbTraces = []
  const traceRouteIndexById = new Map<string, number>()

  for (const connection of srj.connections) {
    const hdRoutes = routes
      .map((route, routeIndex) => ({ route, routeIndex }))
      .filter(({ route }) => route.connectionName === connection.name)

    for (let i = 0; i < hdRoutes.length; i += 1) {
      const hdRoute = hdRoutes[i]
      if (!hdRoute) continue
      const traceId = `${connection.name}_${i}`

      traces.push({
        type: "pcb_trace",
        pcb_trace_id: traceId,
        connection_name:
          connection.netConnectionName ??
          connection.rootConnectionName ??
          connection.name,
        route: convertHdRouteToSimplifiedRoute(
          hdRoute.route.route,
          srj.layerCount,
          {
            traceThickness:
              hdRoute.route.traceThickness ??
              connection.nominalTraceWidth ??
              srj.nominalTraceWidth ??
              srj.minTraceWidth,
            viaDiameter: hdRoute.route.viaDiameter ?? srj.minViaDiameter,
            connectionPoints: connection.pointsToConnect,
          },
        ),
      })
      traceRouteIndexById.set(traceId, hdRoute.routeIndex)
    }
  }

  return { traces, traceRouteIndexById }
}

const getDrcErrorSeverity = (error: Record<string, unknown>) => {
  const message = typeof error.message === "string" ? error.message : ""
  const gapMatch = message.match(/gap: (-?\d+(?:\.\d+)?)mm/)
  const requiredMatch = message.match(/required: (-?\d+(?:\.\d+)?)mm/)
  if (gapMatch && requiredMatch) {
    const gap = Number.parseFloat(gapMatch[1]!)
    const required = Number.parseFloat(requiredMatch[1]!)
    if (Number.isFinite(gap) && Number.isFinite(required)) {
      return Math.max(0, required - gap)
    }
  }

  if (gapMatch) {
    const gap = Number.parseFloat(gapMatch[1]!)
    const required = RELAXED_DRC_OPTIONS.traceClearance ?? 0.1
    if (Number.isFinite(gap)) {
      return Math.max(0, required - gap)
    }
  }

  return 1
}

const getDrcIssueScore = (errors: Array<Record<string, unknown>>) =>
  errors.reduce((score, error) => score + getDrcErrorSeverity(error), 0)

export const getDrcSnapshot = (
  srj: SimpleRouteJson,
  routes: HighDensityRoute[],
  drcEvaluator?: DrcEvaluator,
): DrcSnapshot => {
  const { traces, traceRouteIndexById } = createSimplifiedTraces(srj, routes)
  const drcResult = drcEvaluator?.({
    srj,
    routes,
    traces,
  })

  if (drcResult) {
    const errors = Array.isArray(drcResult) ? drcResult : drcResult.errors
    const errorsWithCenters = Array.isArray(drcResult)
      ? drcResult
      : (drcResult.errorsWithCenters ?? drcResult.errors)

    return {
      errors: errors as Array<Record<string, unknown>>,
      count: errors.length,
      issueScore: getDrcIssueScore(errors as Array<Record<string, unknown>>),
      traceRouteIndexById,
    }
  }

  const drc = getDrcErrors(
    convertToCircuitJson(srj, traces, srj.minTraceWidth, srj.minViaDiameter),
    {
      ...RELAXED_DRC_OPTIONS,
      traceClearance:
        srj.minTraceToPadEdgeClearance ?? RELAXED_DRC_OPTIONS.traceClearance,
      viaClearance:
        srj.minTraceToPadEdgeClearance ?? RELAXED_DRC_OPTIONS.viaClearance,
    },
  )

  return {
    errors:
      drc.errorsWithCenters.length > 0
        ? (drc.errorsWithCenters as unknown as Array<Record<string, unknown>>)
        : (drc.errors as unknown as Array<Record<string, unknown>>),
    count: drc.errors.length,
    issueScore: getDrcIssueScore(
      (drc.errorsWithCenters.length > 0
        ? drc.errorsWithCenters
        : drc.errors) as unknown as Array<Record<string, unknown>>,
    ),
    traceRouteIndexById,
  }
}

export const collectViaNodes = (
  routes: HighDensityRoute[],
  defaultViaDiameter = 0.3,
): ViaNode[] => {
  const vias: ViaNode[] = []

  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex]
    if (!route) continue
    const seenIndexes = new Set<number>()

    for (let index = 0; index < route.route.length - 1; index += 1) {
      const current = route.route[index]
      const next = route.route[index + 1]
      if (!current || !next) continue
      if (current.z === next.z || !areSameXY(current, next)) continue

      const pointIndexes = [index, index + 1]
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const point = route.route[cursor]
        if (!point || !areSameXY(point, current)) break
        pointIndexes.push(cursor)
      }
      for (let cursor = index + 2; cursor < route.route.length; cursor += 1) {
        const point = route.route[cursor]
        if (!point || !areSameXY(point, current)) break
        pointIndexes.push(cursor)
      }

      const uniquePointIndexes = [...new Set(pointIndexes)]
      if (
        uniquePointIndexes.some((pointIndex) => seenIndexes.has(pointIndex))
      ) {
        continue
      }
      for (const pointIndex of uniquePointIndexes) {
        seenIndexes.add(pointIndex)
      }

      vias.push({
        routeIndex,
        rootConnectionName: getRootConnectionName(route),
        pointIndexes: uniquePointIndexes,
        zLayers: [...new Set(uniquePointIndexes.map((i) => route.route[i]!.z))],
        x: current.x,
        y: current.y,
        radius: (route.viaDiameter ?? defaultViaDiameter) / 2,
        movable:
          !uniquePointIndexes.includes(0) &&
          !uniquePointIndexes.includes(route.route.length - 1),
      })
    }
  }

  return vias
}

const collectSegments = (routes: MutableRoute[]): Segment[] => {
  const segments: Segment[] = []

  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex]
    if (!route) continue

    for (let index = 0; index < route.route.length - 1; index += 1) {
      const start = route.route[index]
      const end = route.route[index + 1]
      if (!start || !end) continue
      if (start.z !== end.z || areSameXY(start, end)) continue
      segments.push({
        routeIndex,
        rootConnectionName: getRootConnectionName(route),
        startIndex: index,
        endIndex: index + 1,
        start,
        end,
        z: start.z,
        radius: (route.traceThickness ?? 0.1) / 2,
      })
    }
  }

  return segments
}

const getViaBounds = (via: ViaNode): Bounds2D => ({
  minX: via.x,
  minY: via.y,
  maxX: via.x,
  maxY: via.y,
})

const getSegmentBounds = (segment: Segment): Bounds2D => ({
  minX: Math.min(segment.start.x, segment.end.x),
  minY: Math.min(segment.start.y, segment.end.y),
  maxX: Math.max(segment.start.x, segment.end.x),
  maxY: Math.max(segment.start.y, segment.end.y),
})

const getObstacleBounds = (
  obstacle: SimpleRouteJson["obstacles"][number],
): Bounds2D => ({
  minX: obstacle.center.x - obstacle.width / 2,
  minY: obstacle.center.y - obstacle.height / 2,
  maxX: obstacle.center.x + obstacle.width / 2,
  maxY: obstacle.center.y + obstacle.height / 2,
})

export const getObstacleZLayers = (
  obstacle: SimpleRouteJson["obstacles"][number],
  layerCount: number,
) => {
  if (obstacle.zLayers && obstacle.zLayers.length > 0) {
    return obstacle.zLayers
  }

  const zLayers = Array.from({ length: layerCount }, (_, z) => z).filter((z) =>
    obstacle.layers.includes(mapZToLayerName(z, layerCount)),
  )

  return zLayers.length > 0
    ? zLayers
    : Array.from({ length: layerCount }, (_, z) => z)
}

const getBroadSpatialInteractionDistance = (
  srj: SimpleRouteJson,
  vias: ViaNode[],
  segments: Segment[],
) => {
  const maxViaRadius = vias.reduce(
    (currentMax, via) => Math.max(currentMax, via.radius),
    (srj.minViaDiameter ?? 0.3) / 2,
  )
  const maxSegmentRadius = segments.reduce(
    (currentMax, segment) => Math.max(currentMax, segment.radius),
    srj.minTraceWidth / 2,
  )
  const traceClearance =
    (RELAXED_DRC_OPTIONS.traceClearance ?? 0.1) + CLEARANCE_SLACK

  return Math.max(
    maxViaRadius * 2 + PREFERRED_VIA_TO_VIA_CLEARANCE + CLEARANCE_SLACK,
    maxViaRadius + maxSegmentRadius + traceClearance,
    maxSegmentRadius * 2 + traceClearance,
    maxSegmentRadius + getTraceToPadEdgeClearance(srj) + CLEARANCE_SLACK,
    maxViaRadius + getViaEdgeToPadEdgeClearance(srj)! + CLEARANCE_SLACK,
  )
}

const projectPointOntoLineSegment = (
  point: Point,
  start: Point,
  end: Point,
) => {
  const segmentX = end.x - start.x
  const segmentY = end.y - start.y
  const lengthSquared = segmentX * segmentX + segmentY * segmentY
  if (lengthSquared <= POSITION_EPSILON) {
    return { x: start.x, y: start.y, t: 0 }
  }

  const t = clampValue(
    ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) /
      lengthSquared,
    0,
    1,
  )

  return {
    x: start.x + segmentX * t,
    y: start.y + segmentY * t,
    t,
  }
}

const pointToSegmentProjection = (point: Point, segment: Segment) =>
  projectPointOntoLineSegment(point, segment.start, segment.end)

export const getPointToObstacleDistance = (
  point: Point,
  obstacle: SimpleRouteJson["obstacles"][number],
) => {
  const halfWidth = obstacle.width / 2
  const halfHeight = obstacle.height / 2
  const dx = Math.max(Math.abs(point.x - obstacle.center.x) - halfWidth, 0)
  const dy = Math.max(Math.abs(point.y - obstacle.center.y) - halfHeight, 0)
  return Math.hypot(dx, dy)
}

const getNearestObstacleNearPoint = (
  srj: SimpleRouteJson,
  point: Point,
  maxDistance = 0.6,
  predicate?: (obstacle: SimpleRouteJson["obstacles"][number]) => boolean,
) => {
  let nearestObstacle:
    | {
        obstacle: SimpleRouteJson["obstacles"][number]
        distance: number
      }
    | undefined

  for (const obstacle of srj.obstacles) {
    if (predicate && !predicate(obstacle)) continue
    const distance = getPointToObstacleDistance(point, obstacle)
    if (distance > maxDistance) continue
    if (!nearestObstacle || distance < nearestObstacle.distance) {
      nearestObstacle = {
        obstacle,
        distance,
      }
    }
  }

  return nearestObstacle?.obstacle
}

export const getRectRepulsion = (
  point: Point,
  obstacle: SimpleRouteJson["obstacles"][number],
  requiredDistance: number,
) => {
  const halfWidth = obstacle.width / 2
  const halfHeight = obstacle.height / 2
  const closestX = clampValue(
    point.x,
    obstacle.center.x - halfWidth,
    obstacle.center.x + halfWidth,
  )
  const closestY = clampValue(
    point.y,
    obstacle.center.y - halfHeight,
    obstacle.center.y + halfHeight,
  )
  let separationX = point.x - closestX
  let separationY = point.y - closestY
  let distance = Math.hypot(separationX, separationY)

  if (distance <= POSITION_EPSILON) {
    const dxToSide = halfWidth - Math.abs(point.x - obstacle.center.x)
    const dyToSide = halfHeight - Math.abs(point.y - obstacle.center.y)
    if (dxToSide < dyToSide) {
      separationX = point.x >= obstacle.center.x ? 1 : -1
      separationY = 0
      distance = 0
    } else {
      separationX = 0
      separationY = point.y >= obstacle.center.y ? 1 : -1
      distance = 0
    }
  }

  const penetration = requiredDistance - distance
  if (penetration <= 0) return undefined

  const directionLength = Math.hypot(separationX, separationY)
  return {
    direction: {
      x: directionLength > POSITION_EPSILON ? separationX / directionLength : 1,
      y: directionLength > POSITION_EPSILON ? separationY / directionLength : 0,
    },
    penetration,
  }
}

const getRepulsionPointForError = (
  srj: SimpleRouteJson,
  error: Record<string, unknown>,
  center: Point,
  obstacleFilter?: (obstacle: SimpleRouteJson["obstacles"][number]) => boolean,
) => {
  const message = error.message
  if (typeof message !== "string" || !message.includes("pcb_")) {
    return center
  }

  return (
    getNearestObstacleNearPoint(srj, center, 0.6, obstacleFilter)?.center ??
    center
  )
}

const getCoincidentPointIndexes = (route: MutableRoute, pointIndex: number) => {
  const point = route.route[pointIndex]
  if (!point) return []
  const pointIndexes = [pointIndex]

  for (let cursor = pointIndex - 1; cursor >= 0; cursor -= 1) {
    const candidate = route.route[cursor]
    if (!candidate || !areSameXY(candidate, point)) break
    pointIndexes.push(cursor)
  }
  for (let cursor = pointIndex + 1; cursor < route.route.length; cursor += 1) {
    const candidate = route.route[cursor]
    if (!candidate || !areSameXY(candidate, point)) break
    pointIndexes.push(cursor)
  }

  return [...new Set(pointIndexes)]
}

const getMovableCoincidentPointIndexes = (
  route: MutableRoute,
  pointIndex: number,
) => {
  if (pointIndex <= 0 || pointIndex >= route.route.length - 1) return undefined

  const pointIndexes = getCoincidentPointIndexes(route, pointIndex)
  if (
    pointIndexes.includes(0) ||
    pointIndexes.includes(route.route.length - 1)
  ) {
    return undefined
  }

  return pointIndexes
}

const pointIsInsideBounds = (point: Point, bounds: SimpleRouteJson["bounds"]) =>
  point.x >= bounds.minX - COORDINATE_EPSILON &&
  point.x <= bounds.maxX + COORDINATE_EPSILON &&
  point.y >= bounds.minY - COORDINATE_EPSILON &&
  point.y <= bounds.maxY + COORDINATE_EPSILON

const getPointBoundsClearance = (
  point: Point,
  bounds: SimpleRouteJson["bounds"],
) =>
  Math.min(
    point.x - bounds.minX,
    bounds.maxX - point.x,
    point.y - bounds.minY,
    bounds.maxY - point.y,
  )

const pointIsOnSegment = (point: Point, start: Point, end: Point) => {
  const segmentX = end.x - start.x
  const segmentY = end.y - start.y
  const pointX = point.x - start.x
  const pointY = point.y - start.y
  const cross = segmentX * pointY - segmentY * pointX
  if (Math.abs(cross) > COORDINATE_EPSILON) return false

  const minX = Math.min(start.x, end.x) - COORDINATE_EPSILON
  const maxX = Math.max(start.x, end.x) + COORDINATE_EPSILON
  const minY = Math.min(start.y, end.y) - COORDINATE_EPSILON
  const maxY = Math.max(start.y, end.y) + COORDINATE_EPSILON

  return (
    point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY
  )
}

const pointIsInsideOutline = (
  point: Point,
  outline: NonNullable<SimpleRouteJson["outline"]>,
) => {
  if (outline.length < 3) return true

  for (let index = 0; index < outline.length; index += 1) {
    const start = outline[index]
    const end = outline[(index + 1) % outline.length]
    if (!start || !end) continue
    if (pointIsOnSegment(point, start, end)) return true
  }

  let inside = false
  for (
    let index = 0, previousIndex = outline.length - 1;
    index < outline.length;
    previousIndex = index, index += 1
  ) {
    const current = outline[index]
    const previous = outline[previousIndex]
    if (!current || !previous) continue

    const intersects =
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) /
          (previous.y - current.y) +
          current.x

    if (intersects) inside = !inside
  }

  return inside
}

const getPointOutlineClearance = (
  point: Point,
  outline: NonNullable<SimpleRouteJson["outline"]>,
) => {
  let minDistance = Number.POSITIVE_INFINITY

  for (let index = 0; index < outline.length; index += 1) {
    const start = outline[index]
    const end = outline[(index + 1) % outline.length]
    if (!start || !end) continue
    minDistance = Math.min(
      minDistance,
      pointToSegmentDistance(point, start, end),
    )
  }

  return minDistance
}

const normalizeVector = (x: number, y: number) => {
  const length = Math.hypot(x, y)
  if (length <= POSITION_EPSILON) return undefined
  return { x: x / length, y: y / length }
}

const getOutlineSignedArea = (
  outline: NonNullable<SimpleRouteJson["outline"]>,
) => {
  let signedArea = 0

  for (let index = 0; index < outline.length; index += 1) {
    const current = outline[index]
    const next = outline[(index + 1) % outline.length]
    if (!current || !next) continue
    signedArea += current.x * next.y - next.x * current.y
  }

  return signedArea / 2
}

const getBoundsInwardNormal = (
  point: Point,
  bounds: SimpleRouteJson["bounds"],
) => {
  const leftClearance = point.x - bounds.minX
  const rightClearance = bounds.maxX - point.x
  const bottomClearance = point.y - bounds.minY
  const topClearance = bounds.maxY - point.y
  const minClearance = Math.min(
    leftClearance,
    rightClearance,
    bottomClearance,
    topClearance,
  )

  let inwardX = 0
  let inwardY = 0

  if (leftClearance <= minClearance + COORDINATE_EPSILON) inwardX += 1
  if (rightClearance <= minClearance + COORDINATE_EPSILON) inwardX -= 1
  if (bottomClearance <= minClearance + COORDINATE_EPSILON) inwardY += 1
  if (topClearance <= minClearance + COORDINATE_EPSILON) inwardY -= 1

  return normalizeVector(inwardX, inwardY)
}

const getOutlineInwardNormal = (
  point: Point,
  outline: NonNullable<SimpleRouteJson["outline"]>,
) => {
  const isInside = pointIsInsideOutline(point, outline)
  let nearestEdge:
    | {
        projection: Point
        start: Point
        end: Point
        distance: number
      }
    | undefined

  for (let index = 0; index < outline.length; index += 1) {
    const start = outline[index]
    const end = outline[(index + 1) % outline.length]
    if (!start || !end) continue

    const projection = projectPointOntoLineSegment(point, start, end)
    const distance = Math.hypot(point.x - projection.x, point.y - projection.y)
    if (!nearestEdge || distance < nearestEdge.distance) {
      nearestEdge = { projection, start, end, distance }
    }
  }

  if (!nearestEdge) return undefined

  const normalFromClosestPoint = normalizeVector(
    isInside
      ? point.x - nearestEdge.projection.x
      : nearestEdge.projection.x - point.x,
    isInside
      ? point.y - nearestEdge.projection.y
      : nearestEdge.projection.y - point.y,
  )
  if (normalFromClosestPoint) return normalFromClosestPoint

  const edgeX = nearestEdge.end.x - nearestEdge.start.x
  const edgeY = nearestEdge.end.y - nearestEdge.start.y
  const edgeLength = Math.hypot(edgeX, edgeY)
  if (edgeLength <= POSITION_EPSILON) return undefined

  const isCounterClockwise = getOutlineSignedArea(outline) >= 0
  return {
    x: isCounterClockwise ? -edgeY / edgeLength : edgeY / edgeLength,
    y: isCounterClockwise ? edgeX / edgeLength : -edgeX / edgeLength,
  }
}

const getPointBoardInwardNormal = (srj: SimpleRouteJson, point: Point) =>
  srj.outline && srj.outline.length >= 3
    ? getOutlineInwardNormal(point, srj.outline)
    : getBoundsInwardNormal(point, srj.bounds)

const pointIsInsideBoard = (srj: SimpleRouteJson, point: Point) =>
  srj.outline && srj.outline.length >= 3
    ? pointIsInsideOutline(point, srj.outline)
    : pointIsInsideBounds(point, srj.bounds)

const getPointBoardClearance = (srj: SimpleRouteJson, point: Point) => {
  if (srj.outline && srj.outline.length >= 3) {
    const clearance = getPointOutlineClearance(point, srj.outline)
    return pointIsInsideOutline(point, srj.outline) ? clearance : -clearance
  }

  return getPointBoundsClearance(point, srj.bounds)
}

const getSegmentBoardClearance = (
  srj: SimpleRouteJson,
  start: Point,
  end: Point,
) => {
  if (
    Math.abs(start.x - end.x) <= COORDINATE_EPSILON &&
    Math.abs(start.y - end.y) <= COORDINATE_EPSILON
  ) {
    return Math.min(
      getPointBoardClearance(srj, start),
      getPointBoardClearance(srj, end),
    )
  }

  if (srj.outline && srj.outline.length >= 3) {
    if (
      !pointIsInsideOutline(start, srj.outline) ||
      !pointIsInsideOutline(end, srj.outline)
    ) {
      return Math.min(
        getPointBoardClearance(srj, start),
        getPointBoardClearance(srj, end),
      )
    }

    let minDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < srj.outline.length; index += 1) {
      const edgeStart = srj.outline[index]
      const edgeEnd = srj.outline[(index + 1) % srj.outline.length]
      if (!edgeStart || !edgeEnd) continue
      minDistance = Math.min(
        minDistance,
        segmentToSegmentMinDistance(start, end, edgeStart, edgeEnd),
      )
    }
    return minDistance
  }

  if (
    !pointIsInsideBounds(start, srj.bounds) ||
    !pointIsInsideBounds(end, srj.bounds)
  ) {
    return Math.min(
      getPointBoardClearance(srj, start),
      getPointBoardClearance(srj, end),
    )
  }

  return Math.min(
    getPointBoundsClearance(start, srj.bounds),
    getPointBoundsClearance(end, srj.bounds),
  )
}

const getBoardEdgeProximityThreshold = (
  srj: SimpleRouteJson,
  featureRadius: number,
) =>
  featureRadius +
  Math.max(
    PREFERRED_TRACE_TO_PAD_CLEARANCE,
    srj.defaultObstacleMargin ?? 0,
    RELAXED_DRC_OPTIONS.traceClearance ?? 0.1,
  )

const moveReducesClearanceIntoBoardEdgeZone = (
  currentClearance: number,
  nextClearance: number,
  edgeProximityThreshold: number,
) =>
  nextClearance < currentClearance - COORDINATE_EPSILON &&
  Math.min(currentClearance, nextClearance) <=
    edgeProximityThreshold + COORDINATE_EPSILON

const clipTranslationAgainstBoardEdge = (
  dx: number,
  dy: number,
  inwardNormal: Point,
  currentClearance: number,
  edgeProximityThreshold: number,
) => {
  const dot = dx * inwardNormal.x + dy * inwardNormal.y
  const maxOutwardMotion = Math.max(
    0,
    currentClearance - edgeProximityThreshold,
  )
  const minAllowedDot = -maxOutwardMotion

  if (dot >= minAllowedDot - COORDINATE_EPSILON) {
    return { x: dx, y: dy }
  }

  const adjustment = minAllowedDot - dot
  return {
    x: dx + inwardNormal.x * adjustment,
    y: dy + inwardNormal.y * adjustment,
  }
}

const clipPointTranslationAwayFromBoardEdge = (
  srj: SimpleRouteJson,
  point: Point,
  dx: number,
  dy: number,
  featureRadius: number,
) => {
  const inwardNormal = getPointBoardInwardNormal(srj, point)
  if (!inwardNormal) return { x: dx, y: dy }

  return clipTranslationAgainstBoardEdge(
    dx,
    dy,
    inwardNormal,
    getPointBoardClearance(srj, point),
    getBoardEdgeProximityThreshold(srj, featureRadius),
  )
}

const clipPointIndexesTranslationAwayFromBoardEdge = (
  srj: SimpleRouteJson,
  route: MutableRoute,
  pointIndexes: number[],
  dx: number,
  dy: number,
  featureRadius: number,
) => {
  const uniquePointIndexes = [...new Set(pointIndexes)].sort(
    (left, right) => left - right,
  )
  let translation = { x: dx, y: dy }
  const edgeProximityThreshold = getBoardEdgeProximityThreshold(
    srj,
    featureRadius,
  )

  for (let pass = 0; pass < Math.max(1, uniquePointIndexes.length); pass += 1) {
    let changed = false

    for (const pointIndex of uniquePointIndexes) {
      const point = route.route[pointIndex]
      if (!point) continue

      const inwardNormal = getPointBoardInwardNormal(srj, point)
      if (!inwardNormal) continue

      const clippedTranslation = clipTranslationAgainstBoardEdge(
        translation.x,
        translation.y,
        inwardNormal,
        getPointBoardClearance(srj, point),
        edgeProximityThreshold,
      )

      if (
        Math.abs(clippedTranslation.x - translation.x) > POSITION_EPSILON ||
        Math.abs(clippedTranslation.y - translation.y) > POSITION_EPSILON
      ) {
        translation = clippedTranslation
        changed = true
      }
    }

    if (!changed) break
  }

  return translation
}

const getRoutePointIndexesMinBoardClearance = (
  srj: SimpleRouteJson,
  route: MutableRoute,
  pointIndexes: number[],
  translatedPoints?: Map<number, Point>,
) => {
  const uniquePointIndexes = [...new Set(pointIndexes)].sort(
    (left, right) => left - right,
  )
  if (uniquePointIndexes.length === 0) return Number.POSITIVE_INFINITY

  const movedPointIndexes = new Set(uniquePointIndexes)
  const getPoint = (pointIndex: number) =>
    translatedPoints?.get(pointIndex) ?? route.route[pointIndex]

  let minClearance = Number.POSITIVE_INFINITY

  for (const pointIndex of uniquePointIndexes) {
    const point = getPoint(pointIndex)
    if (!point) continue
    minClearance = Math.min(minClearance, getPointBoardClearance(srj, point))
  }

  for (
    let pointIndex = 0;
    pointIndex < route.route.length - 1;
    pointIndex += 1
  ) {
    if (
      !movedPointIndexes.has(pointIndex) &&
      !movedPointIndexes.has(pointIndex + 1)
    ) {
      continue
    }

    const start = getPoint(pointIndex)
    const end = getPoint(pointIndex + 1)
    if (!start || !end) continue
    minClearance = Math.min(
      minClearance,
      getSegmentBoardClearance(srj, start, end),
    )
  }

  return minClearance
}

const getSafeTranslationForPointIndexes = (
  srj: SimpleRouteJson,
  route: MutableRoute,
  pointIndexes: number[],
  dx: number,
  dy: number,
  featureRadius: number,
) => {
  const sortedPointIndexes = [...new Set(pointIndexes)].sort(
    (left, right) => left - right,
  )
  if (sortedPointIndexes.length === 0) return undefined
  const translation = clipPointIndexesTranslationAwayFromBoardEdge(
    srj,
    route,
    sortedPointIndexes,
    dx,
    dy,
    featureRadius,
  )
  if (
    Math.abs(translation.x) <= POSITION_EPSILON &&
    Math.abs(translation.y) <= POSITION_EPSILON
  ) {
    return undefined
  }
  const translatedPoints = new Map<number, Point>()

  for (const pointIndex of sortedPointIndexes) {
    const point = route.route[pointIndex]
    if (!point) continue

    const translatedPoint = {
      x: point.x + translation.x,
      y: point.y + translation.y,
    }
    translatedPoints.set(pointIndex, translatedPoint)
  }

  const currentMinClearance = getRoutePointIndexesMinBoardClearance(
    srj,
    route,
    sortedPointIndexes,
  )
  const translatedMinClearance = getRoutePointIndexesMinBoardClearance(
    srj,
    route,
    sortedPointIndexes,
    translatedPoints,
  )

  if (translatedMinClearance < featureRadius - COORDINATE_EPSILON) {
    return undefined
  }

  const edgeProximityThreshold = getBoardEdgeProximityThreshold(
    srj,
    featureRadius,
  )
  if (
    moveReducesClearanceIntoBoardEdgeZone(
      currentMinClearance,
      translatedMinClearance,
      edgeProximityThreshold,
    )
  ) {
    return undefined
  }

  return translation
}

const moveRoutePoint = (
  routes: MutableRoute[],
  routeIndex: number,
  pointIndex: number,
  dx: number,
  dy: number,
  srj: SimpleRouteJson,
  featureRadius: number,
) => {
  const route = routes[routeIndex]
  if (!route) return false

  const pointIndexes = getMovableCoincidentPointIndexes(route, pointIndex)
  if (!pointIndexes) return false
  const translation = getSafeTranslationForPointIndexes(
    srj,
    route,
    pointIndexes,
    dx,
    dy,
    featureRadius,
  )
  if (!translation) {
    return false
  }

  let changed = false
  for (const candidateIndex of pointIndexes) {
    const point = route.route[candidateIndex]
    if (!point) continue
    point.x += translation.x
    point.y += translation.y
    clampToBounds(point, srj.bounds)
    changed = true
  }

  return changed
}

const moveSegmentByTranslation = (
  routes: MutableRoute[],
  segment: Segment,
  dx: number,
  dy: number,
  srj: SimpleRouteJson,
) => {
  const route = routes[segment.routeIndex]
  if (!route) return false

  const startIndexes = getMovableCoincidentPointIndexes(
    route,
    segment.startIndex,
  )
  const endIndexes = getMovableCoincidentPointIndexes(route, segment.endIndex)
  if (!startIndexes || !endIndexes) return false

  const pointIndexes = [...new Set([...startIndexes, ...endIndexes])]
  const translation = getSafeTranslationForPointIndexes(
    srj,
    route,
    pointIndexes,
    dx,
    dy,
    segment.radius,
  )
  if (!translation) {
    return false
  }

  let changed = false
  for (const pointIndex of pointIndexes) {
    const point = route.route[pointIndex]
    if (!point) continue
    point.x += translation.x
    point.y += translation.y
    clampToBounds(point, srj.bounds)
    changed = true
  }

  return changed
}

const moveRoutePointIndexesByTranslation = (
  route: MutableRoute,
  pointIndexes: number[],
  dx: number,
  dy: number,
  srj: SimpleRouteJson,
  featureRadius: number,
) => {
  const translation = getSafeTranslationForPointIndexes(
    srj,
    route,
    pointIndexes,
    dx,
    dy,
    featureRadius,
  )
  if (!translation) return false

  let changed = false
  for (const pointIndex of pointIndexes) {
    const point = route.route[pointIndex]
    if (!point) continue
    point.x += translation.x
    point.y += translation.y
    clampToBounds(point, srj.bounds)
    changed = true
  }

  return changed
}

const segmentVectorsAreCollinear = (
  left: Point,
  middle: Point,
  right: Point,
) => {
  const leftX = middle.x - left.x
  const leftY = middle.y - left.y
  const rightX = right.x - middle.x
  const rightY = right.y - middle.y
  return Math.abs(leftX * rightY - leftY * rightX) <= COORDINATE_EPSILON
}

const pointIsOnSegmentLine = (
  point: HighDensityRoute["route"][number],
  segment: Segment,
) => {
  if (point.z !== segment.z) return false
  const segmentX = segment.end.x - segment.start.x
  const segmentY = segment.end.y - segment.start.y
  const pointX = point.x - segment.start.x
  const pointY = point.y - segment.start.y
  return Math.abs(segmentX * pointY - segmentY * pointX) <= COORDINATE_EPSILON
}

const getCollinearRunPointIndexes = (route: MutableRoute, segment: Segment) => {
  const segmentX = segment.end.x - segment.start.x
  const segmentY = segment.end.y - segment.start.y
  const axisLineTolerance = Math.max(
    COORDINATE_EPSILON,
    (route.traceThickness ?? 0.1) * 0.12,
  )
  const isHorizontal = Math.abs(segmentY) <= axisLineTolerance
  const isVertical = Math.abs(segmentX) <= axisLineTolerance
  let startIndex = segment.startIndex
  let endIndex = segment.endIndex

  if (isHorizontal || isVertical) {
    const lineCoordinate = isHorizontal
      ? (segment.start.y + segment.end.y) / 2
      : (segment.start.x + segment.end.x) / 2
    while (startIndex > 0) {
      const previousPoint = route.route[startIndex - 1]
      if (
        !previousPoint ||
        previousPoint.z !== segment.z ||
        Math.abs(
          (isHorizontal ? previousPoint.y : previousPoint.x) - lineCoordinate,
        ) > axisLineTolerance
      ) {
        break
      }
      startIndex -= 1
    }

    while (endIndex < route.route.length - 1) {
      const nextPoint = route.route[endIndex + 1]
      if (
        !nextPoint ||
        nextPoint.z !== segment.z ||
        Math.abs((isHorizontal ? nextPoint.y : nextPoint.x) - lineCoordinate) >
          axisLineTolerance
      ) {
        break
      }
      endIndex += 1
    }

    return Array.from(
      { length: endIndex - startIndex + 1 },
      (_, index) => startIndex + index,
    )
  }

  while (startIndex > 0) {
    const previousPoint = route.route[startIndex - 1]
    const currentPoint = route.route[startIndex]
    const nextPoint = route.route[startIndex + 1]
    if (
      !previousPoint ||
      !currentPoint ||
      !nextPoint ||
      previousPoint.z !== segment.z ||
      !pointIsOnSegmentLine(previousPoint, segment) ||
      !segmentVectorsAreCollinear(previousPoint, currentPoint, nextPoint)
    ) {
      break
    }
    startIndex -= 1
  }

  while (endIndex < route.route.length - 1) {
    const previousPoint = route.route[endIndex - 1]
    const currentPoint = route.route[endIndex]
    const nextPoint = route.route[endIndex + 1]
    if (
      !previousPoint ||
      !currentPoint ||
      !nextPoint ||
      nextPoint.z !== segment.z ||
      !pointIsOnSegmentLine(nextPoint, segment) ||
      !segmentVectorsAreCollinear(previousPoint, currentPoint, nextPoint)
    ) {
      break
    }
    endIndex += 1
  }

  return Array.from(
    { length: endIndex - startIndex + 1 },
    (_, index) => startIndex + index,
  )
}

const getMovableCollinearRunPointIndexes = (
  route: MutableRoute,
  segment: Segment,
) => {
  const runPointIndexes = getCollinearRunPointIndexes(route, segment)
  if (runPointIndexes.length <= 2) return undefined

  const movablePointIndexes: number[] = []
  for (const pointIndex of runPointIndexes) {
    const coincidentIndexes = getMovableCoincidentPointIndexes(
      route,
      pointIndex,
    )
    if (!coincidentIndexes) return undefined
    movablePointIndexes.push(...coincidentIndexes)
  }

  return [...new Set(movablePointIndexes)]
}

const moveCollinearSegmentRunByTranslation = (
  routes: MutableRoute[],
  segment: Segment,
  dx: number,
  dy: number,
  srj: SimpleRouteJson,
) => {
  const route = routes[segment.routeIndex]
  if (!route) return false

  const movablePointIndexes = getMovableCollinearRunPointIndexes(route, segment)
  if (!movablePointIndexes) return false

  return moveRoutePointIndexesByTranslation(
    route,
    movablePointIndexes,
    dx,
    dy,
    srj,
    segment.radius,
  )
}

const getDirectionAwayFromPoint = (segment: Segment, point: Point) => {
  const projection = pointToSegmentProjection(point, segment)
  const separationX = projection.x - point.x
  const separationY = projection.y - point.y
  const distance = Math.hypot(separationX, separationY)
  const segmentX = segment.end.x - segment.start.x
  const segmentY = segment.end.y - segment.start.y
  const segmentLength = Math.hypot(segmentX, segmentY)
  const fallbackSign = segment.routeIndex % 2 === 0 ? 1 : -1

  return {
    projection,
    direction:
      distance > POSITION_EPSILON
        ? {
            x: separationX / distance,
            y: separationY / distance,
          }
        : segmentLength > POSITION_EPSILON
          ? {
              x: (-segmentY / segmentLength) * fallbackSign,
              y: (segmentX / segmentLength) * fallbackSign,
            }
          : { x: 1, y: 0 },
  }
}

const insertDetourPointAwayFromPoint = (
  routes: MutableRoute[],
  segment: Segment,
  point: Point,
  srj: SimpleRouteJson,
  scale: number,
) => {
  const route = routes[segment.routeIndex]
  if (!route) return false

  const { projection, direction } = getDirectionAwayFromPoint(segment, point)
  const detourTranslation = clipPointTranslationAwayFromBoardEdge(
    srj,
    projection,
    direction.x * MAX_ERROR_MOVE * scale,
    direction.y * MAX_ERROR_MOVE * scale,
    segment.radius,
  )
  if (
    Math.abs(detourTranslation.x) <= POSITION_EPSILON &&
    Math.abs(detourTranslation.y) <= POSITION_EPSILON
  ) {
    return false
  }
  const detourPoint = {
    ...route.route[segment.startIndex]!,
    x: projection.x + detourTranslation.x,
    y: projection.y + detourTranslation.y,
  }
  clampToBounds(detourPoint, srj.bounds)
  if (
    pointToSegmentDistance(detourPoint, segment.start, segment.end) <=
    COORDINATE_EPSILON
  ) {
    return false
  }

  const startPoint = route.route[segment.startIndex]
  const endPoint = route.route[segment.endIndex]
  if (!startPoint || !endPoint) return false

  const currentMinClearance = getSegmentBoardClearance(
    srj,
    startPoint,
    endPoint,
  )
  const detourMinClearance = Math.min(
    getPointBoardClearance(srj, detourPoint),
    getSegmentBoardClearance(srj, startPoint, detourPoint),
    getSegmentBoardClearance(srj, detourPoint, endPoint),
  )
  if (detourMinClearance < segment.radius - COORDINATE_EPSILON) return false

  const edgeProximityThreshold = getBoardEdgeProximityThreshold(
    srj,
    segment.radius,
  )
  if (
    moveReducesClearanceIntoBoardEdgeZone(
      currentMinClearance,
      detourMinClearance,
      edgeProximityThreshold,
    )
  ) {
    return false
  }

  route.route.splice(segment.endIndex, 0, detourPoint)
  return true
}

const moveVia = (
  routes: MutableRoute[],
  via: ViaNode,
  dx: number,
  dy: number,
  srj: SimpleRouteJson,
) => {
  if (!via.movable) return false
  const route = routes[via.routeIndex]
  if (!route) return false
  const translation = clipPointTranslationAwayFromBoardEdge(
    srj,
    via,
    dx,
    dy,
    via.radius,
  )
  if (
    Math.abs(translation.x) <= POSITION_EPSILON &&
    Math.abs(translation.y) <= POSITION_EPSILON
  ) {
    return false
  }

  const nextPosition = {
    x: via.x + translation.x,
    y: via.y + translation.y,
  }
  const currentClearance = getPointBoardClearance(srj, via)
  const nextClearance = getPointBoardClearance(srj, nextPosition)
  if (nextClearance < via.radius - COORDINATE_EPSILON) return false

  const edgeProximityThreshold = getBoardEdgeProximityThreshold(srj, via.radius)
  if (
    moveReducesClearanceIntoBoardEdgeZone(
      currentClearance,
      nextClearance,
      edgeProximityThreshold,
    )
  ) {
    return false
  }

  via.x += translation.x
  via.y += translation.y
  clampToBounds(via, srj.bounds)
  for (const pointIndex of via.pointIndexes) {
    const point = route.route[pointIndex]
    if (!point) continue
    point.x = via.x
    point.y = via.y
  }
  return true
}

const moveSegmentAwayFromPoint = (
  routes: MutableRoute[],
  segment: Segment,
  point: Point,
  srj: SimpleRouteJson,
  scale = 1,
) => {
  const { projection, direction } = getDirectionAwayFromPoint(segment, point)
  const move = MAX_ERROR_MOVE * scale
  const startWeight = 1 - projection.t
  const endWeight = projection.t

  const movedStart = moveRoutePoint(
    routes,
    segment.routeIndex,
    segment.startIndex,
    direction.x * move * startWeight,
    direction.y * move * startWeight,
    srj,
    segment.radius,
  )
  const movedEnd = moveRoutePoint(
    routes,
    segment.routeIndex,
    segment.endIndex,
    direction.x * move * endWeight,
    direction.y * move * endWeight,
    srj,
    segment.radius,
  )

  if (movedStart || movedEnd) {
    return true
  }

  return insertDetourPointAwayFromPoint(routes, segment, point, srj, scale)
}

const moveSegmentAwayFromObstacle = (
  routes: MutableRoute[],
  segment: Segment,
  obstacle: SimpleRouteJson["obstacles"][number],
  srj: SimpleRouteJson,
  scale = 1,
) => {
  const requiredDistance =
    segment.radius + getTraceToPadEdgeClearance(srj) + CLEARANCE_SLACK
  const repulsion = getSegmentRectRepulsion(segment, obstacle, requiredDistance)
  if (!repulsion) return false

  const move = Math.min(
    TRACE_PAD_REPAIR_MAX_MOVE * Math.abs(scale),
    repulsion.penetration,
  )
  const dx = repulsion.direction.x * move
  const dy = repulsion.direction.y * move
  const movedSegment =
    moveCollinearSegmentRunByTranslation(routes, segment, dx, dy, srj) ||
    moveSegmentByTranslation(routes, segment, dx, dy, srj)
  if (movedSegment) return true

  const route = routes[segment.routeIndex]
  if (!route) return false
  const halfWidth = obstacle.width / 2
  const halfHeight = obstacle.height / 2
  const detourPoints =
    Math.abs(repulsion.direction.y) >= Math.abs(repulsion.direction.x)
      ? [
          {
            ...route.route[segment.startIndex]!,
            x: obstacle.center.x - halfWidth - requiredDistance,
            y:
              obstacle.center.y +
              repulsion.direction.y * (halfHeight + requiredDistance),
          },
          {
            ...route.route[segment.startIndex]!,
            x: obstacle.center.x + halfWidth + requiredDistance,
            y:
              obstacle.center.y +
              repulsion.direction.y * (halfHeight + requiredDistance),
          },
        ]
      : [
          {
            ...route.route[segment.startIndex]!,
            x:
              obstacle.center.x +
              repulsion.direction.x * (halfWidth + requiredDistance),
            y: obstacle.center.y - halfHeight - requiredDistance,
          },
          {
            ...route.route[segment.startIndex]!,
            x:
              obstacle.center.x +
              repulsion.direction.x * (halfWidth + requiredDistance),
            y: obstacle.center.y + halfHeight + requiredDistance,
          },
        ]

  const orderedDetourPoints = detourPoints
    .map((point) => {
      const { t } = pointToSegmentProjection(point, segment)
      const projectionPoint = {
        x: segment.start.x + (segment.end.x - segment.start.x) * t,
        y: segment.start.y + (segment.end.y - segment.start.y) * t,
      }
      const translation = clipPointTranslationAwayFromBoardEdge(
        srj,
        projectionPoint,
        point.x - projectionPoint.x,
        point.y - projectionPoint.y,
        segment.radius,
      )

      point.x = projectionPoint.x + translation.x
      point.y = projectionPoint.y + translation.y
      clampToBounds(point, srj.bounds)

      return {
        point,
        t,
        moved:
          Math.abs(translation.x) > POSITION_EPSILON ||
          Math.abs(translation.y) > POSITION_EPSILON,
        awayFromObstacleMotion:
          translation.x * repulsion.direction.x +
          translation.y * repulsion.direction.y,
      }
    })
    .sort((a, b) => a.t - b.t)

  if (!orderedDetourPoints.some(({ moved }) => moved)) {
    return false
  }
  if (
    !orderedDetourPoints.some(
      ({ awayFromObstacleMotion }) =>
        awayFromObstacleMotion > COORDINATE_EPSILON,
    )
  ) {
    return false
  }

  const normalizedDetourPoints = orderedDetourPoints.map(({ point }) => point)
  if (
    normalizedDetourPoints.every(
      (point) =>
        pointToSegmentDistance(point, segment.start, segment.end) <=
        COORDINATE_EPSILON,
    )
  ) {
    return false
  }

  if (normalizedDetourPoints.some((point) => !pointIsInsideBoard(srj, point))) {
    return false
  }

  const startPoint = route.route[segment.startIndex]
  const endPoint = route.route[segment.endIndex]
  const firstDetourPoint = normalizedDetourPoints[0]
  const secondDetourPoint = normalizedDetourPoints[1]
  if (!startPoint || !endPoint || !firstDetourPoint || !secondDetourPoint) {
    return false
  }

  const currentMinClearance = getSegmentBoardClearance(
    srj,
    startPoint,
    endPoint,
  )
  const detourMinClearance = Math.min(
    getPointBoardClearance(srj, firstDetourPoint),
    getPointBoardClearance(srj, secondDetourPoint),
    getSegmentBoardClearance(srj, startPoint, firstDetourPoint),
    getSegmentBoardClearance(srj, firstDetourPoint, secondDetourPoint),
    getSegmentBoardClearance(srj, secondDetourPoint, endPoint),
  )
  if (detourMinClearance < segment.radius - COORDINATE_EPSILON) {
    return false
  }

  const edgeProximityThreshold = getBoardEdgeProximityThreshold(
    srj,
    segment.radius,
  )
  if (
    moveReducesClearanceIntoBoardEdgeZone(
      currentMinClearance,
      detourMinClearance,
      edgeProximityThreshold,
    )
  ) {
    return false
  }

  route.route.splice(segment.endIndex, 0, ...normalizedDetourPoints)
  return true
}

const getNearestSegment = (
  segments: Segment[],
  point: Point,
  routeIndex?: number,
) => {
  let best:
    | {
        segment: Segment
        distance: number
      }
    | undefined

  for (const segment of segments) {
    if (routeIndex !== undefined && segment.routeIndex !== routeIndex) continue
    const projection = pointToSegmentProjection(point, segment)
    const distance = Math.hypot(projection.x - point.x, projection.y - point.y)
    if (!best || distance < best.distance) {
      best = { segment, distance }
    }
  }

  return best?.segment
}

const getNearestVia = (vias: ViaNode[], point: Point) => {
  let best:
    | {
        via: ViaNode
        distance: number
      }
    | undefined

  for (const via of vias) {
    const distance = Math.hypot(via.x - point.x, via.y - point.y)
    if (!best || distance < best.distance) {
      best = { via, distance }
    }
  }

  return best?.via
}

const getNearestViaPair = (vias: ViaNode[], point: Point) => {
  const nearest = vias
    .map((via) => ({
      via,
      distance: Math.hypot(via.x - point.x, via.y - point.y),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 2)
    .map(({ via }) => via)

  return nearest.length === 2 ? (nearest as [ViaNode, ViaNode]) : undefined
}

const moveViaAwayFromPoint = (
  routes: MutableRoute[],
  via: ViaNode,
  point: Point,
  srj: SimpleRouteJson,
) => {
  const separationX = via.x - point.x
  const separationY = via.y - point.y
  const distance = Math.hypot(separationX, separationY)
  const directionX = distance > POSITION_EPSILON ? separationX / distance : 1
  const directionY = distance > POSITION_EPSILON ? separationY / distance : 0

  return moveVia(
    routes,
    via,
    directionX * MAX_ERROR_MOVE,
    directionY * MAX_ERROR_MOVE,
    srj,
  )
}

const getSegmentDistanceCandidates = (left: Segment, right: Segment) => {
  const leftStartProjection = pointToSegmentProjection(left.start, right)
  const leftEndProjection = pointToSegmentProjection(left.end, right)
  const rightStartProjection = pointToSegmentProjection(right.start, left)
  const rightEndProjection = pointToSegmentProjection(right.end, left)

  return [
    {
      leftT: 0,
      rightT: leftStartProjection.t,
      leftPoint: left.start,
      rightPoint: leftStartProjection,
    },
    {
      leftT: 1,
      rightT: leftEndProjection.t,
      leftPoint: left.end,
      rightPoint: leftEndProjection,
    },
    {
      leftT: rightStartProjection.t,
      rightT: 0,
      leftPoint: rightStartProjection,
      rightPoint: right.start,
    },
    {
      leftT: rightEndProjection.t,
      rightT: 1,
      leftPoint: rightEndProjection,
      rightPoint: right.end,
    },
  ].sort((a, b) => {
    const aDistance = Math.hypot(
      a.leftPoint.x - a.rightPoint.x,
      a.leftPoint.y - a.rightPoint.y,
    )
    const bDistance = Math.hypot(
      b.leftPoint.x - b.rightPoint.x,
      b.leftPoint.y - b.rightPoint.y,
    )
    return aDistance - bDistance
  })
}

const moveSegmentByDistribution = (
  routes: MutableRoute[],
  segment: Segment,
  dx: number,
  dy: number,
  srj: SimpleRouteJson,
  t: number,
) => {
  const clampedT = clampValue(t, 0, 1)
  const startWeight = 1 - clampedT
  const endWeight = clampedT
  const movedStart = moveRoutePoint(
    routes,
    segment.routeIndex,
    segment.startIndex,
    dx * startWeight,
    dy * startWeight,
    srj,
    segment.radius,
  )
  const movedEnd = moveRoutePoint(
    routes,
    segment.routeIndex,
    segment.endIndex,
    dx * endWeight,
    dy * endWeight,
    srj,
    segment.radius,
  )

  return movedStart || movedEnd
}

const pushViaViaPair = (
  routes: MutableRoute[],
  left: ViaNode,
  right: ViaNode,
  srj: SimpleRouteJson,
  maxMove = BROAD_MAX_MOVE,
) => {
  const requiredDistance =
    left.radius +
    right.radius +
    PREFERRED_VIA_TO_VIA_CLEARANCE +
    CLEARANCE_SLACK
  const separationX = left.x - right.x
  const separationY = left.y - right.y
  const distance = Math.hypot(separationX, separationY)
  const penetration = requiredDistance - distance
  if (penetration <= 0) return false

  const fallbackAngle = (left.routeIndex * 97 + right.routeIndex * 13) * 1.618
  const directionX =
    distance > POSITION_EPSILON
      ? separationX / distance
      : Math.cos(fallbackAngle)
  const directionY =
    distance > POSITION_EPSILON
      ? separationY / distance
      : Math.sin(fallbackAngle)
  const movableCount = Number(left.movable) + Number(right.movable)
  if (movableCount === 0) return false

  const move = Math.min(maxMove, penetration / movableCount)
  const movedLeft = moveVia(
    routes,
    left,
    directionX * move,
    directionY * move,
    srj,
  )
  const movedRight = moveVia(
    routes,
    right,
    -directionX * move,
    -directionY * move,
    srj,
  )
  return movedLeft || movedRight
}

const pushViaSegmentPair = (
  routes: MutableRoute[],
  via: ViaNode,
  segment: Segment,
  srj: SimpleRouteJson,
  maxMove = BROAD_MAX_MOVE,
  moveDivisor = 2,
) => {
  if (sharesNet(via.rootConnectionName, segment.rootConnectionName))
    return false

  const projection = pointToSegmentProjection(via, segment)
  const separationX = via.x - projection.x
  const separationY = via.y - projection.y
  const distance = Math.hypot(separationX, separationY)
  const requiredDistance =
    via.radius +
    segment.radius +
    (RELAXED_DRC_OPTIONS.traceClearance ?? 0.1) +
    CLEARANCE_SLACK
  const penetration = requiredDistance - distance
  if (penetration <= 0) return false

  const segmentX = segment.end.x - segment.start.x
  const segmentY = segment.end.y - segment.start.y
  const segmentLength = Math.hypot(segmentX, segmentY)
  const fallbackSign = via.routeIndex % 2 === 0 ? 1 : -1
  const directionX =
    distance > POSITION_EPSILON
      ? separationX / distance
      : segmentLength > POSITION_EPSILON
        ? (-segmentY / segmentLength) * fallbackSign
        : 1
  const directionY =
    distance > POSITION_EPSILON
      ? separationY / distance
      : segmentLength > POSITION_EPSILON
        ? (segmentX / segmentLength) * fallbackSign
        : 0
  const move = Math.min(maxMove, penetration / moveDivisor)
  const movedVia = moveVia(
    routes,
    via,
    directionX * move,
    directionY * move,
    srj,
  )
  const movedSegment = moveSegmentByDistribution(
    routes,
    segment,
    -directionX * move,
    -directionY * move,
    srj,
    projection.t,
  )
  return movedVia || movedSegment
}

const pushSegmentSegmentPair = (
  routes: MutableRoute[],
  left: Segment,
  right: Segment,
  srj: SimpleRouteJson,
) => {
  if (
    left.z !== right.z ||
    sharesNet(left.rootConnectionName, right.rootConnectionName)
  ) {
    return false
  }

  const [candidate] = getSegmentDistanceCandidates(left, right)
  if (!candidate) return false

  const separationX = candidate.leftPoint.x - candidate.rightPoint.x
  const separationY = candidate.leftPoint.y - candidate.rightPoint.y
  const distance = Math.hypot(separationX, separationY)
  const requiredDistance =
    left.radius +
    right.radius +
    (RELAXED_DRC_OPTIONS.traceClearance ?? 0.1) +
    CLEARANCE_SLACK
  const penetration = requiredDistance - distance
  if (penetration <= 0) return false

  const leftVectorX = left.end.x - left.start.x
  const leftVectorY = left.end.y - left.start.y
  const fallbackLength = Math.hypot(leftVectorX, leftVectorY)
  const fallbackSign = (left.routeIndex + right.routeIndex) % 2 === 0 ? 1 : -1
  const directionX =
    distance > POSITION_EPSILON
      ? separationX / distance
      : fallbackLength > POSITION_EPSILON
        ? (-leftVectorY / fallbackLength) * fallbackSign
        : 1
  const directionY =
    distance > POSITION_EPSILON
      ? separationY / distance
      : fallbackLength > POSITION_EPSILON
        ? (leftVectorX / fallbackLength) * fallbackSign
        : 0
  const move = Math.min(BROAD_MAX_MOVE, penetration / 2)
  const movedLeft = moveSegmentByDistribution(
    routes,
    left,
    directionX * move,
    directionY * move,
    srj,
    candidate.leftT,
  )
  const movedRight = moveSegmentByDistribution(
    routes,
    right,
    -directionX * move,
    -directionY * move,
    srj,
    candidate.rightT,
  )
  return movedLeft || movedRight
}

const obstacleAppliesToSegment = (
  obstacle: SimpleRouteJson["obstacles"][number],
  segment: Segment,
) => {
  if (obstacle.zLayers?.includes(segment.z)) return true
  if (segment.z === 0 && obstacle.layers.includes("top")) return true
  if (segment.z === 1 && obstacle.layers.includes("bottom")) return true
  return obstacle.layers.length === 0
}

const getSegmentRectRepulsion = (
  segment: Segment,
  obstacle: SimpleRouteJson["obstacles"][number],
  requiredDistance: number,
) => {
  const halfWidth = obstacle.width / 2
  const halfHeight = obstacle.height / 2
  const obstacleCorners = [
    {
      x: obstacle.center.x - halfWidth,
      y: obstacle.center.y - halfHeight,
    },
    {
      x: obstacle.center.x + halfWidth,
      y: obstacle.center.y - halfHeight,
    },
    {
      x: obstacle.center.x + halfWidth,
      y: obstacle.center.y + halfHeight,
    },
    {
      x: obstacle.center.x - halfWidth,
      y: obstacle.center.y + halfHeight,
    },
  ]
  const projectedCandidates = [obstacle.center, ...obstacleCorners].map(
    (point) => pointToSegmentProjection(point, segment),
  )
  const candidates = [
    { point: segment.start, t: 0 },
    { point: segment.end, t: 1 },
    {
      point: {
        x: (segment.start.x + segment.end.x) / 2,
        y: (segment.start.y + segment.end.y) / 2,
      },
      t: 0.5,
    },
    ...projectedCandidates.map((projection) => ({
      point: { x: projection.x, y: projection.y },
      t: projection.t,
    })),
  ]

  let best:
    | {
        direction: Point
        penetration: number
        normality: number
        t: number
      }
    | undefined

  const segmentLength = Math.hypot(
    segment.end.x - segment.start.x,
    segment.end.y - segment.start.y,
  )
  for (const candidate of candidates) {
    const repulsion = getRectRepulsion(
      candidate.point,
      obstacle,
      requiredDistance,
    )
    if (!repulsion) continue
    const normality =
      segmentLength > POSITION_EPSILON
        ? Math.abs(
            ((segment.end.x - segment.start.x) * repulsion.direction.y -
              (segment.end.y - segment.start.y) * repulsion.direction.x) /
              segmentLength,
          )
        : 0
    if (
      !best ||
      repulsion.penetration > best.penetration + POSITION_EPSILON ||
      (Math.abs(repulsion.penetration - best.penetration) <= POSITION_EPSILON &&
        normality > best.normality)
    ) {
      best = {
        ...repulsion,
        normality,
        t: candidate.t,
      }
    }
  }

  return best
}

const pushMovablesAwayFromObstacles = (
  srj: SimpleRouteJson,
  routes: MutableRoute[],
  vias: ViaNode[],
  segments: Segment[],
  viaSpatialIndex: Map<string, number[]>,
  segmentSpatialIndex: Map<string, number[]>,
  spatialCellSize: number,
) => {
  let changed = false
  const requiredTraceObstacleDistance =
    srj.minTraceWidth / 2 + getTraceToPadEdgeClearance(srj) + CLEARANCE_SLACK
  const requiredViaObstacleDistance =
    (srj.minViaDiameter ?? 0.3) / 2 +
    getViaEdgeToPadEdgeClearance(srj)! +
    CLEARANCE_SLACK

  for (const obstacle of srj.obstacles) {
    if (obstacle.isCopperPour) continue
    const obstacleBounds = getObstacleBounds(obstacle)

    const nearbyViaIndexes = getSpatialCandidateIndexes(
      viaSpatialIndex,
      expandBounds2d(obstacleBounds, requiredViaObstacleDistance),
      spatialCellSize,
    )
    for (const viaIndex of nearbyViaIndexes) {
      const via = vias[viaIndex]
      if (!via) continue
      if (obstacleSharesNet(via.rootConnectionName, obstacle)) continue
      const repulsion = getRectRepulsion(
        via,
        obstacle,
        requiredViaObstacleDistance,
      )
      if (!repulsion) continue
      const move = Math.min(BROAD_MAX_MOVE, repulsion.penetration)
      changed =
        moveVia(
          routes,
          via,
          repulsion.direction.x * move,
          repulsion.direction.y * move,
          srj,
        ) || changed
    }

    const nearbySegmentIndexes = getSpatialCandidateIndexes(
      segmentSpatialIndex,
      expandBounds2d(obstacleBounds, requiredTraceObstacleDistance),
      spatialCellSize,
    )
    for (const segmentIndex of nearbySegmentIndexes) {
      const segment = segments[segmentIndex]
      if (!segment) continue
      if (
        obstacleSharesNet(segment.rootConnectionName, obstacle) ||
        !obstacleAppliesToSegment(obstacle, segment)
      ) {
        continue
      }
      const repulsion = getSegmentRectRepulsion(
        segment,
        obstacle,
        requiredTraceObstacleDistance,
      )
      if (!repulsion) continue
      const move = Math.min(BROAD_MAX_MOVE, repulsion.penetration)
      changed =
        moveSegmentByDistribution(
          routes,
          segment,
          repulsion.direction.x * move,
          repulsion.direction.y * move,
          srj,
          repulsion.t,
        ) || changed
    }
  }

  return changed
}

const applyBroadRepulsionPass = (
  srj: SimpleRouteJson,
  routes: MutableRoute[],
) => {
  let changed = false
  const vias = collectViaNodes(routes)
  const segments = collectSegments(routes)
  const spatialInteractionDistance = getBroadSpatialInteractionDistance(
    srj,
    vias,
    segments,
  )
  const spatialCellSize = Math.max(
    BROAD_SPATIAL_CELL_SIZE_MIN,
    spatialInteractionDistance * 2,
  )
  const viaSpatialIndex = createSpatialIndex(
    vias,
    getViaBounds,
    spatialCellSize,
  )
  const segmentSpatialIndex = createSpatialIndex(
    segments,
    getSegmentBounds,
    spatialCellSize,
  )

  for (let leftIndex = 0; leftIndex < vias.length; leftIndex += 1) {
    const left = vias[leftIndex]
    if (!left) continue
    const nearbyViaIndexes = getSpatialCandidateIndexes(
      viaSpatialIndex,
      expandBounds2d(getViaBounds(left), spatialInteractionDistance),
      spatialCellSize,
    )
    for (const rightIndex of nearbyViaIndexes) {
      if (rightIndex <= leftIndex) continue
      const right = vias[rightIndex]
      if (!right) continue
      changed = pushViaViaPair(routes, left, right, srj) || changed
    }
  }

  for (let viaIndex = 0; viaIndex < vias.length; viaIndex += 1) {
    const via = vias[viaIndex]
    if (!via) continue
    const nearbySegmentIndexes = getSpatialCandidateIndexes(
      segmentSpatialIndex,
      expandBounds2d(getViaBounds(via), spatialInteractionDistance),
      spatialCellSize,
    )
    for (const segmentIndex of nearbySegmentIndexes) {
      const segment = segments[segmentIndex]
      if (!segment) continue
      changed = pushViaSegmentPair(routes, via, segment, srj) || changed
    }
  }

  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    const left = segments[leftIndex]
    if (!left) continue
    const nearbySegmentIndexes = getSpatialCandidateIndexes(
      segmentSpatialIndex,
      expandBounds2d(getSegmentBounds(left), spatialInteractionDistance),
      spatialCellSize,
    )
    for (const rightIndex of nearbySegmentIndexes) {
      if (rightIndex <= leftIndex) continue
      const right = segments[rightIndex]
      if (!right) continue
      changed = pushSegmentSegmentPair(routes, left, right, srj) || changed
    }
  }

  return (
    pushMovablesAwayFromObstacles(
      srj,
      routes,
      vias,
      segments,
      viaSpatialIndex,
      segmentSpatialIndex,
      spatialCellSize,
    ) || changed
  )
}

export const applyBroadRepulsionForces = (
  srj: SimpleRouteJson,
  routes: HighDensityRoute[],
  effort: number,
) => {
  const mutableRoutes = cloneRoutes(routes)
  const maxPasses = Math.max(
    2,
    Math.round(BROAD_FORCE_PASSES * Math.max(1, effort)),
  )
  let changed = false

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const passChanged = applyBroadRepulsionPass(srj, mutableRoutes)
    if (!passChanged) break
    changed = true
  }

  return changed ? materializeRoutes(mutableRoutes) : routes
}

const deriveVias = (route: MutableRoute): MutableRoute["vias"] => {
  const vias: MutableRoute["vias"] = []
  for (let index = 0; index < route.route.length - 1; index += 1) {
    const current = route.route[index]
    const next = route.route[index + 1]
    if (!current || !next) continue
    if (current.z === next.z || !areSameXY(current, next)) continue

    const via = {
      x: Number(current.x.toFixed(3)),
      y: Number(current.y.toFixed(3)),
    }
    const previousVia = vias.at(-1)
    if (previousVia && areSameXY(previousVia, via)) continue
    vias.push(via)
  }
  return vias
}

export const materializeRoutes = (routes: MutableRoute[]): HighDensityRoute[] =>
  routes.map((route) => ({
    ...route,
    vias: deriveVias(route),
  }))

const parseTraceRouteIndex = (error: Record<string, unknown>) => {
  const traceId = error.pcb_trace_id
  if (typeof traceId !== "string") return undefined
  const match = traceId.match(/^trace_(\d+)/)
  return match ? Number.parseInt(match[1]!, 10) : undefined
}

const getErrorCenter = (error: Record<string, unknown>): Point | undefined => {
  const center = error.center ?? error.pcb_center
  if (!center || typeof center !== "object") return undefined
  const maybeCenter = center as Record<string, unknown>
  return typeof maybeCenter.x === "number" && typeof maybeCenter.y === "number"
    ? { x: maybeCenter.x, y: maybeCenter.y }
    : undefined
}

export const getCenteredErrors = (errors: Array<Record<string, unknown>>) =>
  errors.filter((error) => Boolean(getErrorCenter(error)))

const isViaDrcError = (error: Record<string, unknown>) =>
  Array.isArray(error.pcb_via_ids) ||
  (typeof error.pcb_error_id === "string" &&
    (error.pcb_error_id.startsWith("same_net_vias_close_") ||
      error.pcb_error_id.startsWith("different_net_vias_close_")))

export const getViaDrcIssueCount = (snapshot: DrcSnapshot) =>
  snapshot.errors.filter(isViaDrcError).length

const getTraceRouteIndexForError = (
  error: Record<string, unknown>,
  traceRouteIndexById: Map<string, number>,
) => {
  const traceId = error.pcb_trace_id
  return typeof traceId === "string"
    ? (traceRouteIndexById.get(traceId) ?? parseTraceRouteIndex(error))
    : parseTraceRouteIndex(error)
}

export const isBetterDrcSnapshot = (
  candidateSnapshot: DrcSnapshot,
  candidateViaIssueCount: number,
  bestIssueCount: number,
  bestIssueScore: number,
  bestViaIssueCount: number,
) =>
  candidateSnapshot.count < bestIssueCount ||
  (candidateSnapshot.count === bestIssueCount &&
    candidateSnapshot.issueScore < bestIssueScore) ||
  (candidateSnapshot.count === bestIssueCount &&
    candidateViaIssueCount < bestViaIssueCount)

export const applyDrcErrorForces = (
  srj: SimpleRouteJson,
  routes: MutableRoute[],
  errors: Array<Record<string, unknown>>,
  traceRouteIndexById: Map<string, number>,
  scale: number,
) => {
  let changed = false
  const vias = collectViaNodes(routes)
  const segments = collectSegments(routes)

  for (const error of errors) {
    const center = getErrorCenter(error)
    if (!center) continue
    let repulsionPoint = center

    const viaIds = error.pcb_via_ids
    if (Array.isArray(viaIds) && viaIds.length > 0) {
      repulsionPoint = getRepulsionPointForError(srj, error, center)
      const nearestViaPair = getNearestViaPair(vias, center)
      if (nearestViaPair) {
        changed =
          pushViaViaPair(
            routes,
            nearestViaPair[0],
            nearestViaPair[1],
            srj,
            VIA_PAIR_REPAIR_MAX_MOVE * Math.abs(scale),
          ) || changed
      } else {
        const nearestVia = getNearestVia(vias, center)
        if (nearestVia) {
          changed =
            moveViaAwayFromPoint(routes, nearestVia, repulsionPoint, srj) ||
            changed
        }
      }
      continue
    }

    const traceId = error.pcb_trace_id
    const routeIndex = getTraceRouteIndexForError(error, traceRouteIndexById)
    const nearestSegment = getNearestSegment(segments, center, routeIndex)
    if (nearestSegment) {
      const isObstacleError = isTraceObstacleDrcError(error)
      const nearestObstacle = isObstacleError
        ? getNearestObstacleNearPoint(
            srj,
            center,
            0.6,
            (obstacle) =>
              !obstacleSharesNet(nearestSegment.rootConnectionName, obstacle) &&
              obstacleAppliesToSegment(obstacle, nearestSegment),
          )
        : getNearestObstacleNearPoint(srj, center)
      if (isObstacleError && !nearestObstacle) {
        continue
      }
      repulsionPoint = isObstacleError
        ? (nearestObstacle?.center ?? center)
        : getRepulsionPointForError(srj, error, center)
      const nearestVia = getNearestVia(vias, center)
      if (
        nearestVia &&
        !sharesNet(
          nearestVia.rootConnectionName,
          nearestSegment.rootConnectionName,
        ) &&
        Math.hypot(nearestVia.x - center.x, nearestVia.y - center.y) < 0.45
      ) {
        changed =
          pushViaSegmentPair(
            routes,
            nearestVia,
            nearestSegment,
            srj,
            TRACE_PAD_REPAIR_MAX_MOVE * Math.abs(scale),
            1,
          ) || changed
      }

      const shouldUseObstacleMove =
        nearestObstacle !== undefined &&
        (isObstacleError ||
          (!obstacleSharesNet(
            nearestSegment.rootConnectionName,
            nearestObstacle,
          ) &&
            obstacleAppliesToSegment(nearestObstacle, nearestSegment)))
      const movedSegment = shouldUseObstacleMove
        ? moveSegmentAwayFromObstacle(
            routes,
            nearestSegment,
            nearestObstacle!,
            srj,
            scale,
          )
        : moveSegmentAwayFromPoint(
            routes,
            nearestSegment,
            repulsionPoint,
            srj,
            scale,
          )
      changed = movedSegment || changed
    }

    const nearestVia = getNearestVia(vias, center)
    if (
      nearestVia &&
      Math.hypot(nearestVia.x - center.x, nearestVia.y - center.y) < 0.35
    ) {
      changed =
        moveViaAwayFromPoint(routes, nearestVia, repulsionPoint, srj) || changed
    }
  }

  return changed
}
