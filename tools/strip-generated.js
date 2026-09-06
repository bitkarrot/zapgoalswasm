const fs = require('fs')
const path = require('path')

const file = path.join(__dirname, '..', 'static', 'js', 'bitcoin-connect.js')
fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/[ \t]+$/gm, ''))
