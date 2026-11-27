#!/usr/bin/env python3
"""Convert official, locally downloaded 2025 TIGER/Line ROADS ZIP files.
Requires pyshp (pip install pyshp). Does not fetch network data or upload anything.
"""
import argparse, hashlib, json, math, pathlib, re, tempfile, zipfile
import shapefile

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--output', required=True, type=pathlib.Path)
p.add_argument('archives', nargs='+', type=pathlib.Path)
args = p.parse_args()
features, sources = [], []
seen = set()
for archive in args.archives:
    m = re.fullmatch(r'tl_2025_(13\d{3})_roads\.zip', archive.name, re.I)
    if not m or m[1] in seen:
        raise SystemExit(f'Expected a unique official 2025 Georgia county ROADS archive: {archive.name}')
    seen.add(m[1])
    stem = archive.stem
    with zipfile.ZipFile(archive) as z, tempfile.TemporaryDirectory() as tmp:
        for ext in ['.shp','.shx','.dbf']:
            member=stem+ext
            if member not in z.namelist():
                raise SystemExit(f'Missing {member}')
            pathlib.Path(tmp,member).write_bytes(z.read(member))
        with shapefile.Reader(str(pathlib.Path(tmp,stem))) as reader:
            for item in reader.iterShapeRecords():
                attrs=item.record.as_dict()
                name=str(attrs.get('FULLNAME') or '').strip()
                if not name or not str(attrs.get('MTFCC') or '').startswith('S'): continue
                shape=item.shape
                if shape.shapeType not in (3,13,23) or len(shape.points)<2: continue
                bbox=list(shape.bbox)
                if len(bbox)!=4 or not all(math.isfinite(v) for v in bbox): continue
                if bbox[2]<-84.851 or bbox[0]>-83.999 or bbox[3]<33.349 or bbox[1]>34.201: continue
                indices=list(shape.parts)+[len(shape.points)]
                paths=[[[round(x,7),round(y,7)] for x,y in shape.points[a:b]] for a,b in zip(indices,indices[1:]) if b-a>=2]
                if paths: features.append({'streetName':name,'bbox':bbox,'paths':paths})
    sources.append({'countyFips':m[1],'file':archive.name,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()})
if not features or len(features)>500000:
    raise SystemExit('Empty or oversized road dataset; verify coverage and input files.')
args.output.parent.mkdir(parents=True,exist_ok=True)
if args.output.exists(): raise SystemExit('Output exists; choose a new output file for review.')
with args.output.open('x') as f: json.dump({'source':'US Census Bureau TIGER/Line 2025 ROADS','sources':sources,'features':features},f,separators=(',',':'),allow_nan=False)
print(f'Created {args.output} with {len(features)} road features from {len(sources)} counties. Validate local coverage and matching before deployment.')
