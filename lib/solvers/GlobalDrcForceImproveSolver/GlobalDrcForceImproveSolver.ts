import { BaseSolver } from "../BaseSolver"
import type { GraphicsObject } from "graphics-debug"
import {
  BROAD_FALLBACK_SMALL_ROUTE_LIMIT,
  LARGE_DRC_COUNT_THRESHOLD,
  MAX_DRC_COUNT_PLATEAU_CHECKS,
  MAX_LARGE_BOARD_BROAD_FALLBACK_MISSES,
  MIN_ITERATIONS_FOR_LARGE_BOARD_BROAD_FALLBACK,
  getBaseMaxIterations,
  getDrcCountImprovementCheckInterval,
  getDrcScaledMaxIterations,
  getForceScalesForEffort,
  getLargeBoardBroadFallbackCadence,
  getMaxTargetedCandidateAttemptsForEffort,
  getRouteComplexityMinIterations,
} from "./solverConfig"
import {
  applyBroadRepulsionForces,
  applyDrcErrorForces,
  cloneRoutes,
  getCenteredErrors,
  getDrcSnapshot,
  getViaDrcIssueCount,
  isBetterDrcSnapshot,
  materializeRoutes,
} from "./solverHelpers"
import { applyTraceToPadClearanceRelaxation } from "./traceToPadClearanceRelaxation"
import { applyViaToPadClearanceRelaxation } from "./viaToPadClearanceRelaxation"
import type {
  DrcEvaluator,
  DrcSnapshot,
  GlobalDrcForceImproveSolverParams,
} from "./types"
import type { SimpleRouteJson } from "../../types"
import type { HighDensityRoute } from "../../types/high-density-types"

const layerColor = (z: number) => {
  if (z === 0) return "#FF0000"
  if (z === 1) return "#0000FF"
  return "#4f46e5"
}

const getBoardOutlineGraphics = (srj: SimpleRouteJson): GraphicsObject => {
  if (srj.outline && srj.outline.length >= 3) {
    return {
      polygons: [
        {
          points: srj.outline,
          stroke: "#1d4ed8",
          fill: "rgba(29, 78, 216, 0.0)",
          label: "board-outline",
        },
      ],
    }
  }

  return {
    rects: [
      {
        center: {
          x: (srj.bounds.minX + srj.bounds.maxX) / 2,
          y: (srj.bounds.minY + srj.bounds.maxY) / 2,
        },
        width: srj.bounds.maxX - srj.bounds.minX,
        height: srj.bounds.maxY - srj.bounds.minY,
        stroke: "#1d4ed8",
        fill: "rgba(29, 78, 216, 0.0)",
        label: "board-outline",
      },
    ],
  }
}

const getErrorCenter = (error: Record<string, unknown>) => {
  const center = error.center ?? error.pcb_center
  if (!center || typeof center !== "object") return undefined
  const maybeCenter = center as Record<string, unknown>
  return typeof maybeCenter.x === "number" && typeof maybeCenter.y === "number"
    ? { x: maybeCenter.x, y: maybeCenter.y }
    : undefined
}

const getDrcErrorKey = (error: Record<string, unknown>) => {
  if (typeof error.pcb_error_id === "string" && error.pcb_error_id.length > 0) {
    return `id:${error.pcb_error_id}`
  }

  const center = getErrorCenter(error)
  if (!center) return undefined

  const message = typeof error.message === "string" ? error.message : ""
  const type =
    typeof error.type === "string"
      ? error.type
      : typeof error.error_type === "string"
        ? error.error_type
        : "unknown"

  return [
    `center:${center.x.toFixed(3)},${center.y.toFixed(3)}`,
    `type:${type}`,
    `message:${message}`,
  ].join("|")
}

const createDrcIssueCircles = (
  initialSnapshot: DrcSnapshot,
  currentSnapshot: DrcSnapshot,
): NonNullable<GraphicsObject["circles"]> => {
  const currentIssueKeys = new Set(
    currentSnapshot.errors
      .map((error) => getDrcErrorKey(error))
      .filter((key): key is string => Boolean(key)),
  )

  return initialSnapshot.errors.flatMap((error) => {
    const center = getErrorCenter(error)
    const key = getDrcErrorKey(error)
    if (!center || !key) return []

    const fixed = !currentIssueKeys.has(key)

    return [
      {
        center,
        radius: 0.18,
        fill: fixed ? "rgba(22, 163, 74, 0.18)" : "rgba(147, 51, 234, 0.2)",
        stroke: fixed ? "#16a34a" : "#9333ea",
        label: fixed ? "fixed-initial-drc" : "initial-drc",
      },
    ]
  })
}

const routesToGraphics = (
  srj: SimpleRouteJson,
  routes: HighDensityRoute[],
  drcIssueCircles: NonNullable<GraphicsObject["circles"]> = [],
): GraphicsObject => {
  const boardOutlineGraphics = getBoardOutlineGraphics(srj)

  return {
    coordinateSystem: "cartesian",
    title: "Global DRC Force Improve Solver visualization",
    rects: [
      ...(boardOutlineGraphics.rects ?? []),
      ...srj.obstacles.map((obstacle) => ({
        center: obstacle.center,
        width: obstacle.width,
        height: obstacle.height,
        ccwRotationDegrees: obstacle.ccwRotationDegrees,
        fill:
          obstacle.connectedTo.length > 0 ? "rgba(2, 132, 199, 0.22)" : "#eee",
        stroke: "#334155",
        label: obstacle.connectedTo[0],
      })),
    ],
    polygons: boardOutlineGraphics.polygons,
    lines: routes.flatMap((route) =>
      route.route.slice(1).map((point, index) => {
        const previousPoint = route.route[index]
        if (!previousPoint) {
          return {
            points: [
              { x: point.x, y: point.y },
              { x: point.x, y: point.y },
            ],
            strokeColor: layerColor(point.z),
            strokeWidth: route.traceThickness,
            label: route.connectionName,
          }
        }
        return {
          points: [
            { x: previousPoint.x, y: previousPoint.y },
            { x: point.x, y: point.y },
          ],
          strokeColor: layerColor(point.z),
          strokeWidth: route.traceThickness,
          label: route.connectionName,
        }
      }),
    ),
    circles: [
      ...routes.flatMap((route) =>
        route.vias.map((via) => ({
          center: via,
          radius: route.viaDiameter / 2,
          fill: "rgba(15, 23, 42, 0.25)",
          stroke: "#0f172a",
          label: route.connectionName,
        })),
      ),
      ...drcIssueCircles,
    ],
    points: srj.connections.flatMap((connection) =>
      connection.pointsToConnect.map((point) => ({
        x: point.x,
        y: point.y,
        color: "#dc2626",
        label: connection.name,
      })),
    ),
  }
}

export class GlobalDrcForceImproveSolver extends BaseSolver {
  readonly srj: SimpleRouteJson
  readonly inputHdRoutes: HighDensityRoute[]
  readonly effort: number
  readonly drcEvaluator?: DrcEvaluator
  readonly configuredMaxIterations?: number
  readonly enableLargeBoardBroadFallback: boolean
  outputHdRoutes: HighDensityRoute[]
  private initialDrcIssueCount: number | undefined
  private broadForceAccepted = false
  private targetedForceAccepted = false
  private candidateAttempts = 0
  private errorCursor = 0
  private stalledIterations = 0
  private bestDrcIssueCountSeen: number | undefined
  private lastDrcCountImprovementCheckIteration = 0
  private drcCountPlateauChecks = 0
  private largeBoardBroadFallbackMisses = 0
  private outputSnapshot: DrcSnapshot | undefined
  private initialVisualizationSnapshot: DrcSnapshot | undefined

  constructor(params: GlobalDrcForceImproveSolverParams) {
    super()
    this.srj = params.srj
    this.inputHdRoutes = params.hdRoutes
    this.effort = params.effort ?? 1
    this.drcEvaluator = params.drcEvaluator
    this.configuredMaxIterations = params.maxIterations
    this.enableLargeBoardBroadFallback =
      params.enableLargeBoardBroadFallback ?? true
    this.outputHdRoutes = params.hdRoutes
    this.MAX_ITERATIONS =
      this.configuredMaxIterations ?? getBaseMaxIterations(this.effort)
  }

  override getConstructorParams() {
    return [
      {
        srj: this.srj,
        hdRoutes: this.inputHdRoutes,
        effort: this.effort,
        drcEvaluator: this.drcEvaluator,
        maxIterations: this.configuredMaxIterations,
        enableLargeBoardBroadFallback: this.enableLargeBoardBroadFallback,
      },
    ] as const
  }

  private updateStats(snapshot: DrcSnapshot) {
    this.stats = {
      initialDrcIssueCount: this.initialDrcIssueCount ?? snapshot.count,
      finalDrcIssueCount: snapshot.count,
      globalDrcForceImproveMaxIterations: this.MAX_ITERATIONS,
      globalDrcForceImproveBroadForceAccepted: this.broadForceAccepted,
      globalDrcForceImproveTargetedForceAccepted: this.targetedForceAccepted,
      globalDrcForceImproveCandidateAttempts: this.candidateAttempts,
      globalDrcForceImproveStalledIterations: this.stalledIterations,
      globalDrcForceImproveBestDrcIssueCountSeen:
        this.bestDrcIssueCountSeen ?? snapshot.count,
      globalDrcForceImproveDrcCountPlateauChecks: this.drcCountPlateauChecks,
      globalDrcForceImproveLargeBoardBroadFallbackMisses:
        this.largeBoardBroadFallbackMisses,
    }
  }

  private increaseMaxIterationsForDrcIssueCount(drcIssueCount: number) {
    if (this.configuredMaxIterations !== undefined) {
      this.MAX_ITERATIONS = this.configuredMaxIterations
      return
    }

    this.MAX_ITERATIONS = Math.max(
      this.MAX_ITERATIONS,
      getDrcScaledMaxIterations(drcIssueCount, this.effort),
      getRouteComplexityMinIterations(this.inputHdRoutes.length, drcIssueCount),
    )
  }

  private acceptSolvedRoutes(
    routes: HighDensityRoute[],
    snapshot: DrcSnapshot,
  ) {
    const traceRelaxedRoutes = applyTraceToPadClearanceRelaxation(
      this.srj,
      routes,
    )
    const relaxedRoutes = applyViaToPadClearanceRelaxation(
      this.srj,
      traceRelaxedRoutes,
    )
    const relaxedSnapshot =
      relaxedRoutes === routes
        ? snapshot
        : getDrcSnapshot(this.srj, relaxedRoutes, this.drcEvaluator)

    this.outputHdRoutes = relaxedRoutes
    this.outputSnapshot = relaxedSnapshot
    this.stalledIterations = 0
    this.updateStats(relaxedSnapshot)
    this.solved = true
  }

  private updateDrcCountPlateauState(snapshot: DrcSnapshot) {
    this.bestDrcIssueCountSeen ??= snapshot.count
    const initialDrcIssueCount = this.initialDrcIssueCount ?? snapshot.count
    const isLargeRouteBoard =
      this.inputHdRoutes.length > BROAD_FALLBACK_SMALL_ROUTE_LIMIT &&
      initialDrcIssueCount > 0
    const needsLargeBoardBroadFallbackWindow = isLargeRouteBoard

    if (
      (initialDrcIssueCount >= LARGE_DRC_COUNT_THRESHOLD ||
        needsLargeBoardBroadFallbackWindow) &&
      this.iterations < MIN_ITERATIONS_FOR_LARGE_BOARD_BROAD_FALLBACK
    ) {
      if (snapshot.count < this.bestDrcIssueCountSeen) {
        this.bestDrcIssueCountSeen = snapshot.count
      }
      if (
        isLargeRouteBoard &&
        this.largeBoardBroadFallbackMisses >=
          MAX_LARGE_BOARD_BROAD_FALLBACK_MISSES
      ) {
        this.solved = true
      }
      return
    }

    const improvementCheckInterval =
      getDrcCountImprovementCheckInterval(initialDrcIssueCount)

    if (
      this.iterations - this.lastDrcCountImprovementCheckIteration <
      improvementCheckInterval
    ) {
      return
    }

    this.lastDrcCountImprovementCheckIteration = this.iterations
    if (snapshot.count < this.bestDrcIssueCountSeen) {
      this.bestDrcIssueCountSeen = snapshot.count
      this.drcCountPlateauChecks = 0
      return
    }

    this.drcCountPlateauChecks += 1
    if (this.drcCountPlateauChecks >= MAX_DRC_COUNT_PLATEAU_CHECKS) {
      this.solved = true
    }
  }

  override _step() {
    let bestRoutes = this.outputHdRoutes
    let bestSnapshot =
      this.outputSnapshot ??
      getDrcSnapshot(this.srj, bestRoutes, this.drcEvaluator)
    if (this.initialDrcIssueCount === undefined) {
      this.initialDrcIssueCount = bestSnapshot.count
      this.bestDrcIssueCountSeen = bestSnapshot.count
      this.increaseMaxIterationsForDrcIssueCount(bestSnapshot.count)
    }

    if (bestSnapshot.count === 0) {
      this.acceptSolvedRoutes(bestRoutes, bestSnapshot)
      return
    }

    let bestIssueCount = bestSnapshot.count
    let bestIssueScore = bestSnapshot.issueScore
    let bestViaIssueCount = getViaDrcIssueCount(bestSnapshot)
    const centeredErrors = getCenteredErrors(bestSnapshot.errors)
    if (centeredErrors.length === 0) {
      this.acceptSolvedRoutes(bestRoutes, bestSnapshot)
      return
    }

    const maxCandidateAttemptsThisStep =
      getMaxTargetedCandidateAttemptsForEffort(this.effort)
    let candidateAttemptsThisStep = 0
    let acceptedCandidate = false
    let attemptedPeriodicLargeBoardBroadFallback = false
    const maxErrorsThisStep = Math.min(
      centeredErrors.length,
      Math.max(1, Math.ceil(this.effort)),
    )
    const startErrorIndex = this.errorCursor % centeredErrors.length

    for (
      let errorOffset = 0;
      errorOffset < maxErrorsThisStep &&
      candidateAttemptsThisStep < maxCandidateAttemptsThisStep;
      errorOffset += 1
    ) {
      const errorIndex = (startErrorIndex + errorOffset) % centeredErrors.length
      const error = centeredErrors[errorIndex]
      if (!error) continue

      this.errorCursor = (errorIndex + 1) % centeredErrors.length

      for (const scale of getForceScalesForEffort(this.effort)) {
        if (candidateAttemptsThisStep >= maxCandidateAttemptsThisStep) break

        const candidateRoutes = cloneRoutes(bestRoutes)
        const changed = applyDrcErrorForces(
          this.srj,
          candidateRoutes,
          [error],
          bestSnapshot.traceRouteIndexById,
          scale,
        )
        if (!changed) continue

        const materializedCandidateRoutes = materializeRoutes(candidateRoutes)
        candidateAttemptsThisStep += 1
        this.candidateAttempts += 1
        const candidateSnapshot = getDrcSnapshot(
          this.srj,
          materializedCandidateRoutes,
          this.drcEvaluator,
        )
        const candidateViaIssueCount = getViaDrcIssueCount(candidateSnapshot)

        if (
          isBetterDrcSnapshot(
            candidateSnapshot,
            candidateViaIssueCount,
            bestIssueCount,
            bestIssueScore,
            bestViaIssueCount,
          )
        ) {
          bestRoutes = materializedCandidateRoutes
          bestSnapshot = candidateSnapshot
          bestIssueCount = candidateSnapshot.count
          bestIssueScore = candidateSnapshot.issueScore
          bestViaIssueCount = candidateViaIssueCount
          this.targetedForceAccepted = true
          acceptedCandidate = true
          if (candidateSnapshot.count === 0) {
            this.acceptSolvedRoutes(bestRoutes, bestSnapshot)
            return
          }
          break
        }
      }

      if (acceptedCandidate) break
    }

    const canAffordBroadFallback =
      bestRoutes.length <= BROAD_FALLBACK_SMALL_ROUTE_LIMIT
    const largeBoardBroadFallbackCadence = getLargeBoardBroadFallbackCadence(
      centeredErrors.length,
    )
    const shouldTryPeriodicLargeBoardBroadFallback =
      this.enableLargeBoardBroadFallback &&
      this.MAX_ITERATIONS >= MIN_ITERATIONS_FOR_LARGE_BOARD_BROAD_FALLBACK &&
      !canAffordBroadFallback &&
      this.stalledIterations > 0 &&
      this.stalledIterations % largeBoardBroadFallbackCadence === 0
    if (
      !acceptedCandidate &&
      (canAffordBroadFallback ||
        (this.effort >= 2 && this.stalledIterations >= 2) ||
        shouldTryPeriodicLargeBoardBroadFallback)
    ) {
      attemptedPeriodicLargeBoardBroadFallback =
        shouldTryPeriodicLargeBoardBroadFallback
      const broadCandidateRoutes = applyBroadRepulsionForces(
        this.srj,
        bestRoutes,
        this.effort,
      )
      if (broadCandidateRoutes !== bestRoutes) {
        const broadCandidateSnapshot = getDrcSnapshot(
          this.srj,
          broadCandidateRoutes,
          this.drcEvaluator,
        )
        const broadCandidateViaIssueCount = getViaDrcIssueCount(
          broadCandidateSnapshot,
        )
        if (
          isBetterDrcSnapshot(
            broadCandidateSnapshot,
            broadCandidateViaIssueCount,
            bestIssueCount,
            bestIssueScore,
            bestViaIssueCount,
          )
        ) {
          bestRoutes = broadCandidateRoutes
          bestSnapshot = broadCandidateSnapshot
          bestIssueCount = broadCandidateSnapshot.count
          bestIssueScore = broadCandidateSnapshot.issueScore
          bestViaIssueCount = broadCandidateViaIssueCount
          this.broadForceAccepted = true
          acceptedCandidate = true
          if (broadCandidateSnapshot.count === 0) {
            this.acceptSolvedRoutes(bestRoutes, bestSnapshot)
            return
          }
        }
      }
    }

    if (acceptedCandidate) {
      this.largeBoardBroadFallbackMisses = 0
    } else if (attemptedPeriodicLargeBoardBroadFallback) {
      this.largeBoardBroadFallbackMisses += 1
    }

    this.outputHdRoutes = bestRoutes
    this.outputSnapshot = bestSnapshot
    this.stalledIterations = acceptedCandidate ? 0 : this.stalledIterations + 1
    this.updateDrcCountPlateauState(bestSnapshot)
    this.updateStats(bestSnapshot)
    if (this.solved || bestIssueCount === 0) {
      this.acceptSolvedRoutes(bestRoutes, bestSnapshot)
    }
  }

  override tryFinalAcceptance() {
    const snapshot =
      this.outputSnapshot ??
      getDrcSnapshot(this.srj, this.outputHdRoutes, this.drcEvaluator)
    this.acceptSolvedRoutes(this.outputHdRoutes, snapshot)
  }

  override getOutput() {
    return this.outputHdRoutes
  }

  private getInitialVisualizationSnapshot() {
    this.initialVisualizationSnapshot = getDrcSnapshot(
      this.srj,
      this.inputHdRoutes,
      this.drcEvaluator,
    )
    return this.initialVisualizationSnapshot
  }

  private getCurrentVisualizationSnapshot() {
    if (this.iterations === 0 && this.outputSnapshot === undefined) {
      return this.getInitialVisualizationSnapshot()
    }

    return (
      this.outputSnapshot ??
      getDrcSnapshot(this.srj, this.outputHdRoutes, this.drcEvaluator)
    )
  }

  override visualize(): GraphicsObject {
    const initialSnapshot = this.getInitialVisualizationSnapshot()
    const currentSnapshot = this.getCurrentVisualizationSnapshot()
    return routesToGraphics(
      this.srj,
      this.outputHdRoutes,
      createDrcIssueCircles(initialSnapshot, currentSnapshot),
    )
  }

  override preview(): GraphicsObject {
    return this.visualize()
  }
}
