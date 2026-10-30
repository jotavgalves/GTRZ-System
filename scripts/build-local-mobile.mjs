import { build } from 'esbuild';
import { writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const generated = path.join(root, 'apps/desktop/resources/lan');
await mkdir(generated, { recursive: true });
const bundle = await build({
  entryPoints: [path.join(root, 'apps/cloud-sync/src/cashier-page.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const moduleUrl =
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64');
const { cashierPage } = await import(moduleUrl);
let html = await cashierPage({ environment: 'production' }).text();
html = html.replace(
  'const uuid=()=>crypto.randomUUID();',
  `const uuid=()=>crypto.randomUUID?crypto.randomUUID():(()=>{const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,v=>v.toString(16).padStart(2,'0')).join('');return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-')})();`,
);
// LAN connectivity is tested against the PC, never inferred from WAN/browser status.
html = html.replaceAll('navigator.onLine', 'true');
html = html.replace(
  '</body>',
  `<script>
streams=function(){stopStreams();state.streamGeneration++;const refresh=()=>{if(!state.operator)return;void refreshSessionAndData().then(()=>online(true,'PC local · vendas gravadas')).catch(()=>online(false,'PC indisponível · venda preservada'))};refresh();state.sessionRefreshTimer=setInterval(refresh,2000)};
window.addEventListener('offline',()=>{if(state.operator)streams()});
</script></body>`,
);
await writeFile(path.join(generated, 'cashier.html'), html);
console.log('Mobile local gerado em ' + pathToFileURL(generated));
