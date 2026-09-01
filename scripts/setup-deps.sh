#!/bin/sh
# 项目迁出 deepseek-harness 检出后的依赖重建:
# 把 package.json 中的 link: 目标改写为 $DSH_CHECKOUT 下的对应包,并安装 node_modules。
# 用法: DSH_CHECKOUT=/path/to/deepseek-harness scripts/setup-deps.sh
set -e
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DSH_CHECKOUT=${DSH_CHECKOUT:?set DSH_CHECKOUT to your deepseek-harness checkout}
STORE="$PROJECT_ROOT/node_modules/.pnpm-store"
node - "$PROJECT_ROOT/package.json" "$DSH_CHECKOUT" <<'EOF'
const fs = require('node:fs')
const [pkgPath, checkout] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const targets = {
  '@deepseek-ai/schemastery': 'vendor/schemastery',
  '@deepseek-ai/dsh-atomic-write': 'packages/util/atomic-write',
  '@deepseek-ai/dsh-home-paths': 'packages/util/home-paths',
  '@deepseek-ai/dsh-invariants': 'packages/runtime-diagnostics/invariants',
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/dsh-host-webserver': 'packages/host/webserver',
  '@deepseek-ai/dsh-app-boot': 'packages/boot/app-boot',
}
for (const [name, rel] of Object.entries(targets)) {
  if (!pkg.dependencies[name]) throw new Error(`dependency ${name} missing from package.json`)
  pkg.dependencies[name] = `link:${checkout}/${rel}`
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log('rewrote link: dependencies to', checkout)
EOF
cd "$PROJECT_ROOT"
pnpm install --prod --ignore-scripts --store-dir "$STORE"
echo "dependencies installed into $PROJECT_ROOT/node_modules"
