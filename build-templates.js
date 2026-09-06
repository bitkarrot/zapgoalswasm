const fs = require('fs')
const path = require('path')
const {compile} = require('@vue/compiler-dom')

function build(name, globalName) {
  const source = fs.readFileSync(path.join(__dirname, 'templates', `${name}.html`), 'utf8')
  const match = source.match(/<div id="q-app"[^>]*>([\s\S]*?)<\/div>\s*<script/i)
  if (!match) throw new Error(`Missing #q-app template in ${name}.html`)
  const result = compile(match[1].trim(), {mode: 'function', prefixIdentifiers: true})
  fs.writeFileSync(path.join(__dirname, 'static', 'js', `${name}-template.js`), `window.${globalName}=function(){\n${result.code}\n}\n`)
}

build('index', 'ZAPGOALS_INDEX_RENDER')
build('public', 'ZAPGOALS_PUBLIC_RENDER')
