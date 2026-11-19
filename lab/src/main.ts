// BlueCurl Surf Lab entry point.
import { Lab } from './app.ts';

const lab = new Lab(document.getElementById('app')!);
(window as unknown as { __lab: Lab }).__lab = lab;
lab.start().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;position:fixed;top:40px;left:8px">${String(e)}</pre>`);
});
