// Bundles main, preload and the renderer pages with esbuild.
const esbuild = require('esbuild');
const path = require('path');
const root = path.join(__dirname, '..');
const version = 'v' + require('../package.json').version;
const common = { bundle: true, sourcemap: true, logLevel: 'warning', define: { __APP_VERSION__: JSON.stringify(version) } };
Promise.all([
  esbuild.build({ ...common, entryPoints: [path.join(root, 'src/main/main.ts')], outfile: path.join(root, 'dist/main/main.js'), platform: 'node', target: 'node22', external: ['electron'] }),
  esbuild.build({ ...common, entryPoints: [path.join(root, 'src/preload.ts')], outfile: path.join(root, 'dist/preload.js'), platform: 'node', target: 'node22', external: ['electron'] }),
  esbuild.build({ ...common, entryPoints: { app: path.join(root, 'src/ui/app.ts'), settings: path.join(root, 'src/ui/settings.ts') }, outdir: path.join(root, 'dist/ui'), platform: 'browser', format: 'iife', target: 'chrome130' }),
]).then(() => console.log('built', version), () => process.exit(1));
