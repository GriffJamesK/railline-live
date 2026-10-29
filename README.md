# Rail Live

A live map of Amtrak trains across the United States. Train positions come from the
[Amtraker](https://amtraker.com) feed (a public decoder of Amtrak's Track Your Train data),
used under the [ODC-By 1.0](https://opendatacommons.org/licenses/by/1-0/) license and
refresh every 30 seconds. Between updates, trains glide along the real track network at their
reported speed.

Open `index.html` in a browser, or visit the GitHub Pages site for this repo.

- Scroll to zoom, drag to pan, click a train (or pick one from All trains) to fly to it and follow it.
- The sun/moon button switches between dark and light mode; the choice is remembered.
- Colors: teal on time, amber 15+ minutes late, coral 1+ hour late.
- Car counts are estimates by route; the feed doesn't report them.
- A ripple marks a train arriving at a stop. It needs evidence from the feed (the stop's status is
  "Station" or "Departed", or a position report has the train stopped at the stop). Add `#debug` to
  the address to see a log of each ping with what the feed said at that moment.

Data: [Amtraker](https://amtraker.com) (train positions, ODC-By; API docs at https://api.amtraker.com/docs), FRA (track and stations), AWS Terrain Tiles (elevation),
OpenFreeMap / © OpenStreetMap contributors (streets), Natural Earth, us-atlas.

`source/` holds the page template and the build script that generates the embedded map data.
