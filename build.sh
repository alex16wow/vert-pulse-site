#!/bin/bash
set -e
cd /home/claude/vert/site
mkdir -p node_modules && ln -sfn /home/claude/mrdoob/three.js node_modules/three
/opt/npm-tools/node_modules/esbuild/bin/esbuild src/main.js --bundle --format=iife --minify --target=es2020 --outfile=bundle.js --alias:three/addons=three/examples/jsm --log-level=warning
python3 - <<'PY'
b=open('bundle.js').read().replace('</script','<\\/script')
s=open('shell.html').read().replace('%%SCRIPT%%','<script>\n'+b+'\n</script>')
open('index.html','w').write(s)
open('test.html','w').write("<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'></head><body>"+s+"</body></html>")
PY
ls -la index.html
