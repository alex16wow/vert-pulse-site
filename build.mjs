import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

const result = await build({
  entryPoints: ['src/main.js'], bundle: true, format: 'iife',
  minify: true, target: 'es2020', write: false,
});
const script = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const shell = await readFile('shell.html', 'utf8');
await writeFile('index.html', shell.replace('%%SCRIPT%%', () => `<script>\n${script}\n</script>`));
