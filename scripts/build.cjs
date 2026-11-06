'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const source = read('src/main.user.js').replace(/\/\* @include ([a-z-]+) \*\//g, (_, name) =>
  read(`src/${name}.js`).replace('module.exports = ', 'return '));
const output = path.join(root, 'dist/nhjcxy-course-autoplay.user.js');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(output, 'utf8') !== source) throw new Error('dist differs from source; run npm run build');
  console.log('dist matches source');
} else {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, source);
  console.log('Built dist/nhjcxy-course-autoplay.user.js');
}
