# Independent Atlanta street data (production build input)

The approved pilot file is `data/tiger-roads.json`, generated from U.S. Census Bureau TIGER/Line 2025 ROADS for Fulton (13121) and DeKalb (13089). It contains 29,278 named road features, clipped to the application's geographic bounding box. These are road lines, not house-number ranges, city boundaries or road ownership. The Census Bureau does not endorse PatchUp; data may be incomplete or inaccurate. See [location provenance](../docs/LOCATION_PROVENANCE.md).

The generated JSON (~12 MB) is deliberately ignored by Git. The reviewed artifact must be distributed to builders or regenerated from the exact source inputs. Do not add private photos or Google address results to this directory. From repository root, copy the approved artifact into `data/tiger-roads.json` and run:

```sh
shasum -a 256 -c data/tiger-roads.sha256  # macOS
# Linux / Cloud Shell: sha256sum -c data/tiger-roads.sha256
```

Approved SHA-256: `8702296124cd1635b6d14c23ce2c7cdca8a3e228101cab5c42982b9849214d49`. Docker refuses missing or mismatching data. If regeneration produces different bytes, review the result and update the checksum only in a separate reviewed PR; do not bypass the check.

## Regeneration

Official source: https://www2.census.gov/geo/tiger/TIGER2025/ROADS/ . Download these archives into a separate directory; verify SHA-256 before conversion:

| Archive | SHA-256 |
| --- | --- |
| tl_2025_13121_roads.zip | 5fe1a0b0d951036aa13dbfb3877f949711488ff8a88ac76e3ff6d0e323e4a080 |
| tl_2025_13089_roads.zip | f4f3cb524a136a2cb81bf0bc0f56f770c557094e1129e4bee0b066108e9e0c6a |

Use Python in a dedicated virtual environment with pyshp installed from a trusted package source. From repository root, after confirming the official ZIP hashes, run (replace the input paths):

```sh
python scripts/prepare-tiger-roads.py --output data/tiger-roads.json /path/to/tl_2025_13121_roads.zip /path/to/tl_2025_13089_roads.zip
```

The converter refuses to overwrite existing output. Exact reproduction can depend on the Python/pyshp versions and input order; prefer the already verified artifact if bytes differ. The source ZIPs are not included. Build source uploads must explicitly include the JSON and checksum even though Git ignores the JSON. Synthetic matching checks are not real-world accuracy evidence; validate roads/intersections and ambiguous GPS points before release.
