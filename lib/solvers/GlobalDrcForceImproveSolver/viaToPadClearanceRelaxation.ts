import { distance, getUnitVectorFromPointAToB } from "@tscircuit/math-utils"
import { getRootConnectionName, obstacleSharesNet } from "./netUtils"
import { cloneRoutes, materializeRoutes } from "./solverHelpers"
import { mapZToLayerName } from "../../utils/mapZToLayerName"
import type { SimpleRouteJson } from "../../types"
import type { HighDensityRoute } from "../../types/high-density-types"

const CLEARANCE_EPSILON = 1e-6
const RELAXATION_CLEARANCE_SLACK = 0.006
const RELAXATION_ITERATIONS = 160
const RELAXATION_PASSES = 4
const MAX_NUDGE_DISTANCE = 0.5
const CANDIDATE_SCALES = [1, 0.5, 0.25, 0.1, 0.05, 0.025] as const

type Point2D = { x: number; y: number }

type ViaNode = {
  routeIndex: number
  rootConnectionName: string
  pointIndexes: number[]
  zLayers: number[]
  x: number
  y: number
  radius: number
  movable: boolean
}

type ViaPadBlocker = {
  obstacle: SimpleRouteJson["obstacles"][number]
}

const pointsEqual = (left: Point2D, right: Point2D) =>
  distance(left, right) < CLEARANCE_EPSILON

const normalizeVector = (vector: Point2D): Point2D => {
  const magnitude = distance({ x: 0, y: 0 }, vector)
  if (magnitude < CLEARANCE_EPSILON) return { x: 0, y: 0 }
  return getUnitVectorFromPointAToB({ x: 0, y: 0 }, vector)
}

const limitVector = (vector: Point2D, maxMagnitude: number): Point2D => {
  const magnitude = distance({ x: 0, y: 0 }, vector)
  if (magnitude <= maxMagnitude || magnitude < CLEARANCE_EPSILON) return vector
  const scale = maxMagnitude / magnitude
  return { x: vector.x * scale, y: vector.y * scale }
}

const getRouteViaDiameter = (srj: SimpleRouteJson, route: HighDensityRoute) =>
  route.viaDiameter ?? srj.minViaDiameter ?? 0.3

const getObstacleZLayers = (
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

const zLayersOverlap = (left: number[], right: number[]) =>
  left.some((z) => right.includes(z))

const viaIsAttachedToSameNetObstacle = (
  via: ViaNode,
  route: HighDensityRoute,
  obstacle: SimpleRouteJson["obstacles"][number],
) => {
  const isSameNet =
    obstacleSharesNet(via.rootConnectionName, obstacle) ||
    obstacleSharesNet(route.connectionName, obstacle)

  return (
    isSameNet && getPointToObstacleDistance(via, obstacle) <= CLEARANCE_EPSILON
  )
}

const collectViaNodes = (
  srj: SimpleRouteJson,
  routes: HighDensityRoute[],
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
      if (current.z === next.z || !pointsEqual(current, next)) continue

      const pointIndexes = [index, index + 1]
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const point = route.route[cursor]
        if (!point || !pointsEqual(point, current)) break
        pointIndexes.push(cursor)
      }
      for (let cursor = index + 2; cursor < route.route.length; cursor += 1) {
        const point = route.route[cursor]
        if (!point || !pointsEqual(point, current)) break
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
        radius: getRouteViaDiameter(srj, route) / 2,
        movable:
          !uniquePointIndexes.includes(0) &&
          !uniquePointIndexes.includes(route.route.length - 1),
      })
    }
  }

  return vias
}

const getViaPadBlockers = (
  srj: SimpleRouteJson,
  routes: HighDensityRoute[],
  via: ViaNode,
) => {
  const blockers: ViaPadBlocker[] = []
  const route = routes[via.routeIndex]
  if (!route) return blockers

  for (const obstacle of srj.obstacles) {
    if (
      obstacle.isCopperPour ||
      viaIsAttachedToSameNetObstacle(via, route, obstacle)
    ) {
      continue
    }

    const zLayers = getObstacleZLayers(obstacle, srj.layerCount)
    if (!zLayersOverlap(via.zLayers, zLayers)) continue
    blockers.push({ obstacle })
  }

  return blockers
}

const getPointToObstacleDistance = (
  point: Point2D,
  obstacle: SimpleRouteJson["obstacles"][number],
) => {
  const halfWidth = obstacle.width / 2
  const halfHeight = obstacle.height / 2
  const dx = Math.max(Math.abs(point.x - obstacle.center.x) - halfWidth, 0)
  const dy = Math.max(Math.abs(point.y - obstacle.center.y) - halfHeight, 0)
  return Math.hypot(dx, dy)
}

const getRectRepulsion = (
  point: Point2D,
  obstacle: SimpleRouteJson["obstacles"][number],
  requiredDistance: number,
) => {
  const halfWidth = obstacle.width / 2
  const halfHeight = obstacle.height / 2
  const closestX = Math.min(
    Math.max(point.x, obstacle.center.x - halfWidth),
    obstacle.center.x + halfWidth,
  )
  const closestY = Math.min(
    Math.max(point.y, obstacle.center.y - halfHeight),
    obstacle.center.y + halfHeight,
  )
  let separationX = point.x - closestX
  let separationY = point.y - closestY
  let currentDistance = Math.hypot(separationX, separationY)

  if (currentDistance <= CLEARANCE_EPSILON) {
    const dxToSide = halfWidth - Math.abs(point.x - obstacle.center.x)
    const dyToSide = halfHeight - Math.abs(point.y - obstacle.center.y)
    if (dxToSide < dyToSide) {
      separationX = point.x >= obstacle.center.x ? 1 : -1
      separationY = 0
    } else {
      separationX = 0
      separationY = point.y >= obstacle.center.y ? 1 : -1
    }
    currentDistance = 0
  }

  const penetration = requiredDistance - currentDistance
  if (penetration <= 0) return undefined

  const direction = normalizeVector({ x: separationX, y: separationY })
  if (
    Math.abs(direction.x) < CLEARANCE_EPSILON &&
    Math.abs(direction.y) < CLEARANCE_EPSILON
  ) {
    return undefined
  }

  return { direction, penetration }
}

const getSignedClearanceToBlocker = (
  srj: SimpleRouteJson,
  via: ViaNode,
  blocker: ViaPadBlocker,
) =>
  getPointToObstacleDistance(via, blocker.obstacle) -
  (via.radius + srj.minViaEdgeToPadEdgeClearance! + RELAXATION_CLEARANCE_SLACK)

const getViaClearancePenalty = (
  srj: SimpleRouteJson,
  routes: HighDensityRoute[],
  via: ViaNode,
) => {
  let penalty = 0
  for (const blocker of getViaPadBlockers(srj, routes, via)) {
    const signedClearance = getSignedClearanceToBlocker(srj, via, blocker)
    if (signedClearance >= 0) continue

    penalty += signedClearance * signedClearance

    if (getPointToObstacleDistance(via, blocker.obstacle) < CLEARANCE_EPSILON) {
      const centerDistance = distance(via, blocker.obstacle.center)
      penalty += 0.01 / (centerDistance + 0.01)
    }
  }

  return penalty
}

const getRouteViaClearancePenalty = (
  srj: SimpleRouteJson,
  routes: HighDensityRoute[],
  routeIndex: number,
) =>
  collectViaNodes(srj, routes)
    .filter((via) => via.routeIndex === routeIndex)
    .reduce(
      (penalty, via) => penalty + getViaClearancePenalty(srj, routes, via),
      0,
    )

const computeViaNudgeForces = (
  srj: SimpleRouteJson,
  routes: HighDensityRoute[],
  routeIndex: number,
) => {
  const route = routes[routeIndex]
  if (!route) return []
  const forces = route.route.map(() => ({ x: 0, y: 0 }))
  const vias = collectViaNodes(srj, routes).filter(
    (via) => via.routeIndex === routeIndex,
  )

  for (const via of vias) {
    if (!via.movable) continue

    for (const blocker of getViaPadBlockers(srj, routes, via)) {
      const requiredDistance =
        via.radius +
        srj.minViaEdgeToPadEdgeClearance! +
        RELAXATION_CLEARANCE_SLACK
      const repulsion = getRectRepulsion(
        via,
        blocker.obstacle,
        requiredDistance,
      )
      if (!repulsion) continue

      for (const pointIndex of via.pointIndexes) {
        forces[pointIndex]!.x += repulsion.direction.x * repulsion.penetration
        forces[pointIndex]!.y += repulsion.direction.y * repulsion.penetration
      }
    }
  }

  return forces
}

const applyNudgeForces = (
  srj: SimpleRouteJson,
  route: HighDensityRoute,
  forces: Point2D[],
  scale: number,
): HighDensityRoute => {
  const viaPointIndexes = new Set(
    collectViaNodes(srj, [route]).flatMap((via) =>
      via.movable ? via.pointIndexes : [],
    ),
  )

  return {
    ...route,
    route: route.route.map((point, pointIndex) => {
      if (!viaPointIndexes.has(pointIndex)) return { ...point }
      const force = limitVector(
        forces[pointIndex] ?? { x: 0, y: 0 },
        MAX_NUDGE_DISTANCE,
      )
      return {
        ...point,
        x: point.x + force.x * scale,
        y: point.y + force.y * scale,
      }
    }),
    vias: route.vias.map((via) => ({ ...via })),
    jumpers: route.jumpers ? [...route.jumpers] : undefined,
  }
}

const routeStaysInsideBounds = (
  srj: SimpleRouteJson,
  route: HighDensityRoute,
) =>
  route.route.every(
    (point) =>
      point.x >= srj.bounds.minX - CLEARANCE_EPSILON &&
      point.x <= srj.bounds.maxX + CLEARANCE_EPSILON &&
      point.y >= srj.bounds.minY - CLEARANCE_EPSILON &&
      point.y <= srj.bounds.maxY + CLEARANCE_EPSILON,
  )

const nudgeRouteVias = (
  srj: SimpleRouteJson,
  routes: HighDensityRoute[],
  route: HighDensityRoute,
  routeIndex: number,
) => {
  let nudgedRoute = route
  let currentPenalty = getRouteViaClearancePenalty(srj, routes, routeIndex)

  for (let iteration = 0; iteration < RELAXATION_ITERATIONS; iteration += 1) {
    if (currentPenalty <= CLEARANCE_EPSILON) break

    const forces = computeViaNudgeForces(srj, routes, routeIndex)
    if (forces.every((force) => distance(force, { x: 0, y: 0 }) < 1e-9)) {
      break
    }

    let acceptedCandidate: HighDensityRoute | null = null
    let acceptedPenalty = currentPenalty

    for (const scale of CANDIDATE_SCALES) {
      const candidate = applyNudgeForces(srj, nudgedRoute, forces, scale)
      const candidateRoutes = [...routes]
      candidateRoutes[routeIndex] = candidate
      const candidatePenalty = getRouteViaClearancePenalty(
        srj,
        candidateRoutes,
        routeIndex,
      )

      if (
        candidatePenalty < currentPenalty - 1e-6 &&
        routeStaysInsideBounds(srj, candidate)
      ) {
        acceptedCandidate = candidate
        acceptedPenalty = candidatePenalty
        break
      }
    }

    if (!acceptedCandidate) break
    routes[routeIndex] = acceptedCandidate
    nudgedRoute = acceptedCandidate
    currentPenalty = acceptedPenalty
  }

  return nudgedRoute
}

export const applyViaToPadClearanceRelaxation = (
  srj: SimpleRouteJson,
  routes: HighDensityRoute[],
) => {
  if (
    srj.minViaEdgeToPadEdgeClearance === undefined ||
    srj.minViaEdgeToPadEdgeClearance <= 0
  ) {
    return routes
  }

  let changed = false
  const relaxedRoutes = cloneRoutes(routes)

  for (let pass = 0; pass < RELAXATION_PASSES; pass += 1) {
    for (
      let routeIndex = 0;
      routeIndex < relaxedRoutes.length;
      routeIndex += 1
    ) {
      const route = relaxedRoutes[routeIndex]
      if (!route) continue
      const nudgedRoute = nudgeRouteVias(srj, relaxedRoutes, route, routeIndex)
      if (nudgedRoute !== route) {
        relaxedRoutes[routeIndex] = nudgedRoute
        changed = true
      }
    }
  }

  return changed ? materializeRoutes(relaxedRoutes) : routes
}
