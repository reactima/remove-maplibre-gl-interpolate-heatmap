import type { Feature, FeatureCollection, Point } from 'geojson'

export interface TimeSeriesEntry {
  t: string
  hourly_busyness: number
}

export interface FootTrafficProperties {
  venue_id: string
  venue_name: string
  avg_busyness: number
  median_busyness: number
  max_busyness: number
  timeSeries: TimeSeriesEntry[]
}

export type FootTrafficFeature = Feature<Point, FootTrafficProperties>

export interface FootTrafficWithTimeSeries
  extends FeatureCollection<Point, FootTrafficProperties> {
  features: FootTrafficFeature[]
}
