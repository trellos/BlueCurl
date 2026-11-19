// BlueCurl Surf Lab entry point.
import { Lab } from './app.ts';
import { BoardSystem } from './boardSystem.ts';
import { RiderSystem } from './riderSystem.ts';
import { StreamSystem } from './streamSystem.ts';
import { OverlaySystem } from './debug/overlays.ts';
import { runMetrics, type MetricsOptions } from './debug/metrics.ts';

const lab = new Lab(document.getElementById('app')!);
const board = new BoardSystem();
const rider = new RiderSystem(board);
const stream = new StreamSystem(rider);
const overlays = new OverlaySystem(rider, stream);
// order matters: stream packets apply before the rider's tick
lab.addSystem(board);
lab.addSystem(stream);
lab.addSystem(rider);
lab.addSystem(overlays);

const w = window as unknown as { __lab: Lab & { metrics?: (o: MetricsOptions) => unknown; rider?: RiderSystem } };
w.__lab = lab;
w.__lab.rider = rider;
w.__lab.metrics = (o: MetricsOptions) => runMetrics(lab, rider, overlays, stream, o);
lab.start().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;position:fixed;top:40px;left:8px">${String(e)}</pre>`);
});
