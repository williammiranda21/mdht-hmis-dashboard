# GIS boundary layers for the Helpline call map

Drop GeoJSON files here and the matching layer toggle on
`/dashboard/helpline` → **Call map** starts working — no code changes.

| file | layer |
|---|---|
| `districts.geojson` | City of Miami Commission Districts |
| `zipcodes.geojson` | ZIP codes (ZCTAs) |
| `census_tracts.geojson` | Census tracts |

Requirements:

- **GeoJSON** `FeatureCollection` of `Polygon` / `MultiPolygon` features
- **WGS84 lon/lat (EPSG:4326)** — plain latitude/longitude. County shapefiles
  are often in Florida East State Plane (EPSG:2236) and must be reprojected
  first (`ogr2ogr -t_srs EPSG:4326 out.geojson in.shp`, or ask Claude).
- Feature labels are read from the first of: `NAME`, `DISTRICT`, `ZIPCODE`,
  `ZIP`, `GEOID`, `TRACT`, `COMMISSIONER` (hover a boundary to see it).

These are public boundary files — no PII — safe to commit.
