import type { HighDensityRoute } from "../../types/high-density-types"

export type Point = { x: number; y: number }

export type Bounds2D = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type MutableRoute = HighDensityRoute & {
  route: Array<HighDensityRoute["route"][number]>
  vias: Array<HighDensityRoute["vias"][number]>
}

export type ViaNode = {
  routeIndex: number
  rootConnectionName: string
  pointIndexes: number[]
  zLayers: number[]
  x: number
  y: number
  radius: number
  movable: boolean
}

export type Segment = {
  routeIndex: number
  rootConnectionName: string
  startIndex: number
  endIndex: number
  start: Point
  end: Point
  z: number
  radius: number
}
