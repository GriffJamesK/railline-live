# Railline Live

A live map of Amtrak trains across the United States. Train positions come from the
[Amtraker](https://amtraker.com) feed (a public decoder of Amtrak's Track Your Train data) and
refresh every 30 seconds. Between updates, trains glide along the real track network at their
reported speed.

Open `index.html` in a browser, or visit the GitHub Pages site for this repo.

- Scroll to zoom, drag to pan, click a train to follow it.
- Colors: teal on time, amber 15+ minutes late, coral 1+ hour late.
- Car counts are estimates by route; the feed doesn't report them.

Data: Amtraker (positions), FRA (track and stations), AWS Terrain Tiles (elevation),
OpenFreeMap / © OpenStreetMap contributors (streets), Natural Earth, us-atlas.

`source/` holds the page template and the build script that generates the embedded map data.
