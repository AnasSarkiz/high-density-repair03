import { BaseSolver } from "../BaseSolver"
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
}
