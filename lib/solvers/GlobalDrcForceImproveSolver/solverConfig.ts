import type { SimpleRouteJson } from "../../types"

const BASE_MAX_TARGETED_CANDIDATE_ATTEMPTS = 2
const BASE_MAX_ITERATIONS_PER_EFFORT = 48
const DEEP_ERROR_FORCE_SCALES = [1, 1.75, -1] as const
const FAST_ERROR_FORCE_SCALES = [1, 1.75] as const
const LARGE_DRC_COUNT_IMPROVEMENT_CHECK_INTERVAL = 8
const LOW_DRC_COUNT_IMPROVEMENT_CHECK_INTERVAL = 1
const MAX_ITERATIONS_PER_DRC_ERROR = 8 / 3
const MIN_MAX_ITERATIONS = 48
const SMALL_DRC_COUNT_IMPROVEMENT_CHECK_INTERVAL = 2

export const POSITION_EPSILON = 1e-6
export const COORDINATE_EPSILON = 1e-3
export const MAX_ERROR_MOVE = 0.14
export const BROAD_FORCE_PASSES = 12
export const BROAD_MAX_MOVE = 0.035
export const BROAD_FALLBACK_SMALL_ROUTE_LIMIT = 120
export const MIN_ITERATIONS_FOR_LARGE_BOARD_BROAD_FALLBACK = 192
export const CLEARANCE_SLACK = 0.015
export const VIA_PAIR_REPAIR_MAX_MOVE = 0.16
export const TRACE_PAD_REPAIR_MAX_MOVE = 0.3
export const PREFERRED_TRACE_TO_PAD_CLEARANCE = 0.16
export const getTraceToPadEdgeClearance = (srj: SimpleRouteJson) =>
  srj.minTraceToPadEdgeClearance ?? PREFERRED_TRACE_TO_PAD_CLEARANCE
export const getViaEdgeToPadEdgeClearance = (srj: SimpleRouteJson) =>
  srj.minViaEdgeToPadEdgeClearance ?? srj.defaultObstacleMargin ?? 0.1
export const LARGE_DRC_COUNT_THRESHOLD = 20
export const MAX_DRC_COUNT_PLATEAU_CHECKS = 2
export const MAX_LARGE_BOARD_BROAD_FALLBACK_MISSES = 2
export const BROAD_SPATIAL_CELL_SIZE_MIN = 1

export const getBaseMaxIterations = (effort: number) =>
  Math.max(
    MIN_MAX_ITERATIONS,
    Math.round(BASE_MAX_ITERATIONS_PER_EFFORT * Math.max(1, effort)),
  )

export const getDrcScaledMaxIterations = (
  drcIssueCount: number,
  effort: number,
) =>
  Math.max(
    getBaseMaxIterations(effort),
    Math.ceil(
      drcIssueCount * MAX_ITERATIONS_PER_DRC_ERROR * Math.max(1, effort),
    ),
  )

export const getRouteComplexityMinIterations = (
  routeCount: number,
  drcIssueCount: number,
) =>
  routeCount > BROAD_FALLBACK_SMALL_ROUTE_LIMIT && drcIssueCount > 0
    ? MIN_ITERATIONS_FOR_LARGE_BOARD_BROAD_FALLBACK
    : MIN_MAX_ITERATIONS

export const getLargeBoardBroadFallbackCadence = (
  centeredDrcIssueCount: number,
) => Math.max(16, Math.min(64, centeredDrcIssueCount * 2))

export const getDrcCountImprovementCheckInterval = (
  initialDrcIssueCount: number,
) =>
  initialDrcIssueCount >= LARGE_DRC_COUNT_THRESHOLD
    ? LARGE_DRC_COUNT_IMPROVEMENT_CHECK_INTERVAL
    : initialDrcIssueCount <= 2
      ? LOW_DRC_COUNT_IMPROVEMENT_CHECK_INTERVAL
      : SMALL_DRC_COUNT_IMPROVEMENT_CHECK_INTERVAL

export const getForceScalesForEffort = (effort: number) =>
  effort >= 2 ? DEEP_ERROR_FORCE_SCALES : FAST_ERROR_FORCE_SCALES

export const getMaxTargetedCandidateAttemptsForEffort = (effort: number) =>
  Math.max(
    1,
    Math.round(BASE_MAX_TARGETED_CANDIDATE_ATTEMPTS * Math.max(1, effort)),
  )
