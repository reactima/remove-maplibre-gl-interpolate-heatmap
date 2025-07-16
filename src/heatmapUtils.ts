import { MaplibreInterpolateHeatmapLayer } from 'maplibre-gl-interpolate-heatmap'
import type { FootTrafficWithTimeSeries } from './types'

export function createSmartInterpolatedHeatmap(dataset: FootTrafficWithTimeSeries) {
  const values = dataset.features.map(f => f.properties.avg_busyness || 0)
  const data = dataset.features.map(f => ({
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    val: f.properties.avg_busyness || 0,
  }))

  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length

  let p: number
  let framebufferFactor: number
  const avgRatio = avg / maxValue
  if (avgRatio < 0.2) {
    p = 2
    framebufferFactor = 0.4
  } else if (avgRatio > 0.6) {
    p = 4
    framebufferFactor = 0.6
  } else {
    p = 3
    framebufferFactor = 0.5
  }

  console.log('Heatmap parameters:', {  p, framebufferFactor, minValue, maxValue, avg, avgRatio });

  return new MaplibreInterpolateHeatmapLayer({
    data,
    id: 'foot-traffic-heatmap',
    opacity: 0.7,
    minValue,
    maxValue,
    p,
    framebufferFactor,
    valueToColor: `
      vec3 valueToColor(float value) {
        if (value < 0.3) {
          return vec3(0.0, 0.0, 1.0 - value);
        } else if (value < 0.7) {
          return vec3(value * 2.0 - 0.6, 1.0, 0.0);
        } else {
          return vec3(1.0, 1.0 - value, 0.0);
        }
      }
    `,
  })
}
