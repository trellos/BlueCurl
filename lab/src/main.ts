// BlueCurl Surf Lab entry point.
import { Lab } from './app.ts';
import { BoardSystem } from './boardSystem.ts';
import { RiderSystem } from './riderSystem.ts';

const lab = new Lab(document.getElementById('app')!);
const board = new BoardSystem();
lab.addSystem(board);
const rider = new RiderSystem(board);
lab.addSystem(rider);
(window as unknown as { __lab: Lab }).__lab = lab;
lab.start().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;position:fixed;top:40px;left:8px">${String(e)}</pre>`);
});
