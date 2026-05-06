import { distance } from "@tscircuit/math-utils"
import { obstacleSharesNet } from "./netUtils"
import {
  cloneRoutes,
  collectViaNodes,
  getObstacleZLayers,
  getPointToObstacleDistance,
  getRectRepulsion,
  materializeRoutes,
} from "./solverHelpers"
import type { SimpleRouteJson } from "../../types"
import type { HighDensityRoute } from "../../types/high-density-types"
import type { ViaNode } from "./internalTypes"

const CLEARANCE_EPSILON = 1e-6
const RELAXATION_CLEARANCE_SLACK = 0.006
const RELAXATION_ITERATIONS = 160
const RELAXATION_PASSES = 4
const MAX_NUDGE_DISTANCE = 0.5
const CANDIDATE_SCALES = [1, 0.5, 0.25, 0.1, 0.05, 0.025] as const

type Point2D = { x: number; y: number }

type ViaPadBlocker = {
  obstacle: SimpleRouteJson["obstacles"][number]
}

const limitVector = (vector: Point2D, maxMagnitude: number): Point2D => {
  const magnitude = distance({ x: 0, y: 0 }, vector)
  if (magnitude <= maxMagnitude || magnitude < CLEARANCE_EPSILON) return vector
  const scale = maxMagnitude / magnitude
  return { x: vector.x * scale, y: vector.y * scale }
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
  collectViaNodes(routes, srj.minViaDiameter)
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
  const vias = collectViaNodes(routes, srj.minViaDiameter).filter(
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
    collectViaNodes([route], srj.minViaDiameter).flatMap((via) =>
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
