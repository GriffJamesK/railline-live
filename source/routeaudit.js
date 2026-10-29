const fs = require('fs');
const geoFile = process.argv[2] || 'geo.js';
const geo = JSON.parse(fs.readFileSync(geoFile, 'utf8').replace(/^const GEO=/, '').replace(/;\s*$/, ''));
const src = fs.readFileSync('/home/user/railline-live/source/main.js', 'utf8');
const a = src.indexOf('// Track graph'), b = src.indexOf('// ---------- consist estimates');
const stub = `const GEO = arguments[0]; const Q = GEO.q; function dec(arr){const out=new Float32Array(arr.length);let x=0,y=0;for(let i=0;i<arr.length;i+=2){x+=arr[i];y+=arr[i+1];out[i]=x*Q;out[i+1]=y*Q;}return out;}`;
const api = new Function(stub + src.slice(a, b) + '; return { stations, dijkstra };')(geo);
const routes = JSON.parse(fs.readFileSync('routes.json'));
let legs = 0, straight = 0, missing = new Set(), offnet = new Set(); const bad = [];
for (const [name, codes] of Object.entries(routes)) for (let i = 1; i < codes.length; i++) {
  const A = api.stations[codes[i - 1]], B = api.stations[codes[i]];
  if (!A) missing.add(codes[i - 1]); if (!B) missing.add(codes[i]); if (!A || !B) continue;
  legs++;
  if (A.node < 0) offnet.add(codes[i - 1]); if (B.node < 0) offnet.add(codes[i]);
  const sl = Math.hypot(B.x - A.x, B.y - A.y), p = A.node >= 0 && B.node >= 0 ? api.dijkstra(A.node, B.node) : null;
  const ok = p && p.len < sl * 2.2 + 40;
  if (!ok) { straight++; bad.push(`${name}: ${codes[i - 1]}→${codes[i]} (${sl.toFixed(0)} km straight, track ${p ? p.len.toFixed(0) + ' km' : 'none'})`); }
  else if (p.len > sl * 1.6 + 15) bad.push(`  (long detour) ${name}: ${codes[i - 1]}→${codes[i]} ${sl.toFixed(0)} km straight vs ${p.len.toFixed(0)} km track`);
}
console.log(`${geoFile}: ${legs} legs checked, ${straight} fall back to straight lines`);
bad.forEach(l => console.log('  ' + l));
if (missing.size) console.log('  codes not in station data (skipped):', [...missing].join(' '));
if (offnet.size) console.log('  stations off the track network:', [...offnet].join(' '));
