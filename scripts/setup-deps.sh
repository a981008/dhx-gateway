#!/bin/sh
# (re)bind the link: dependencies to a deepseek-harness checkout and install
# node_modules. Targets are written as RELATIVE paths so package.json stays
# committable; the canonical layout is dhx-gateway as a sibling of the
# checkout (../deepseek-harness), any other parent works too.
# 用法: DSH_CHECKOUT=/path/to/deepseek-harness scripts/setup-deps.sh
set -e
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DSH_CHECKOUT=${DSH_CHECKOUT:?set DSH_CHECKOUT to your deepseek-harness checkout}
DSH_CHECKOUT=$(cd "$DSH_CHECKOUT" && pwd)
STORE="$PROJECT_ROOT/node_modules/.pnpm-store"
node - "$PROJECT_ROOT/package.json" "$DSH_CHECKOUT" <<'EOF'
const fs = require('node:fs')
const path = require('node:path')
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
  const abs = path.join(checkout, rel)
  if (!fs.existsSync(path.join(abs, 'package.json'))) {
    throw new Error(`not a deepseek-harness checkout (missing ${abs})`)
  }
  pkg.dependencies[name] = `link:${path.relative(path.dirname(pkgPath), abs)}`
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log('rewrote link: dependencies relative to', checkout)
EOF
cd "$PROJECT_ROOT"
pnpm install --prod --ignore-scripts --store-dir "$STORE"
echo "dependencies installed into $PROJECT_ROOT/node_modules"
