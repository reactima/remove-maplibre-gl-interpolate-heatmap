import { useEffect, useRef } from 'react'
import maplibre from 'maplibre-gl'
import { createSmartInterpolatedHeatmap } from './heatmapUtils'
import footTrafficRaw from './data/foottraffic.geojson?raw'
import type { FootTrafficWithTimeSeries } from './types'

export default function App() {
  const mapContainer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const dataset = JSON.parse(footTrafficRaw) as FootTrafficWithTimeSeries

    // compute centroid of all points
    let lng = 0
    let lat = 0
    dataset.features.forEach((f) => {
      lng += f.geometry.coordinates[0]
      lat += f.geometry.coordinates[1]
    })
    lng /= dataset.features.length
    lat /= dataset.features.length

    const map = new maplibre.Map({
      container: mapContainer.current!,
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: [lng, lat],
      zoom: 12,
    })

    map.on('load', () => {
      const heatmap = createSmartInterpolatedHeatmap(dataset)
      map.addLayer(heatmap as any)
    })

    return () => map.remove()
  }, [])

  return <div ref={mapContainer} className="h-full" />
}
