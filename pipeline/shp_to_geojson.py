#!/usr/bin/env python3
"""Zipped shapefile → WGS84 GeoJSON for the helpline map layers.

Reads a .zip containing a shapefile (.shp/.dbf/.prj…), reprojects to plain
lat/lng (EPSG:4326) when the .prj says otherwise (county exports are often
Florida East State Plane), and writes a GeoJSON FeatureCollection.

Usage:
  py pipeline/shp_to_geojson.py <input.zip> <output.geojson>
  py pipeline/shp_to_geojson.py "%USERPROFILE%/Downloads/districts.zip" public/gis/districts.geojson
"""
import io, json, sys, zipfile, tempfile, pathlib

import shapefile  # pyshp
from pyproj import CRS, Transformer


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    zpath, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])

    with tempfile.TemporaryDirectory() as td:
        with zipfile.ZipFile(zpath) as z:
            z.extractall(td)
        shps = list(pathlib.Path(td).rglob('*.shp'))
        if not shps:
            sys.exit(f'no .shp found inside {zpath}')
        shp = shps[0]
        print(f'shapefile: {shp.name}')

        prj = shp.with_suffix('.prj')
        tf = None
        if prj.exists():
            crs = CRS.from_wkt(prj.read_text())
            print(f'source CRS: {crs.name}')
            if not crs.equals(CRS.from_epsg(4326)):
                tf = Transformer.from_crs(crs, CRS.from_epsg(4326), always_xy=True)
                print('reprojecting → EPSG:4326')
        else:
            print('no .prj — assuming coordinates are already lon/lat')

        r = shapefile.Reader(str(shp))
        fields = [f[0] for f in r.fields if f[0] != 'DeletionFlag']
        feats = []
        srs = list(r.iterShapeRecords())
        r.close()   # Windows: unreleased handles break the tempdir cleanup
        for sr in srs:
            geom = sr.shape.__geo_interface__
            if tf is not None:
                def rings(coords):
                    return [[list(tf.transform(x, y)) for x, y in ring] for ring in coords]
                if geom['type'] == 'Polygon':
                    geom = {'type': 'Polygon', 'coordinates': rings(geom['coordinates'])}
                elif geom['type'] == 'MultiPolygon':
                    geom = {'type': 'MultiPolygon',
                            'coordinates': [rings(p) for p in geom['coordinates']]}
            feats.append({'type': 'Feature',
                          'properties': dict(zip(fields, sr.record)),
                          'geometry': geom})

    out.parent.mkdir(parents=True, exist_ok=True)
    io.open(out, 'w', encoding='utf-8').write(
        json.dumps({'type': 'FeatureCollection', 'features': feats}))
    # sanity: bbox + count so a wrong projection is obvious immediately
    xs = [c[0] for f in feats for ring in
          (f['geometry']['coordinates'] if f['geometry']['type'] == 'Polygon'
           else [r for p in f['geometry']['coordinates'] for r in p]) for c in ring]
    ys = [c[1] for f in feats for ring in
          (f['geometry']['coordinates'] if f['geometry']['type'] == 'Polygon'
           else [r for p in f['geometry']['coordinates'] for r in p]) for c in ring]
    print(f'{len(feats)} features → {out}')
    print(f'fields: {fields}')
    print(f'bbox: lng {min(xs):.4f}..{max(xs):.4f} · lat {min(ys):.4f}..{max(ys):.4f}')
    if not (-81 < min(xs) < -79.9 and 25 < min(ys) < 26.5):
        print('⚠ bbox is NOT in the Miami area — projection likely wrong')


if __name__ == '__main__':
    main()
