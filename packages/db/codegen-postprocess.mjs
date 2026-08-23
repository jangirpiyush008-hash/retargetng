// Post-processes kysely-codegen output:
//  - int8/numeric are parsed to JS numbers by our pg type parsers (see client.ts)
//  - partition child tables (xxx_default, xxx_YYYYMM) are removed from the DB interface
import { readFileSync, writeFileSync } from 'node:fs';
const file = new URL('./src/types.ts', import.meta.url);
let src = readFileSync(file, 'utf8');
src = src.replace(
  /export type Int8 = ColumnType<string, [^;]+;/,
  'export type Int8 = ColumnType<number, bigint | number | string, bigint | number | string>;',
);
src = src.replace(/export type Numeric = ColumnType<string, [^;]+;/, 'export type Numeric = ColumnType<number, number | string, number | string>;');
// drop partition tables from DB interface + their interfaces
const partRe = /^(\w+)_(default|\d{6})$/;
src = src.replace(/export interface DB \{([\s\S]*?)\n\}/, (m, body) => {
  const lines = body.split('\n').filter((l) => {
    const mm = l.match(/^\s+(\w+): /);
    return !(mm && partRe.test(mm[1]));
  });
  return `export interface DB {${lines.join('\n')}\n}`;
});
src = src.replace(/export interface (\w+) \{[\s\S]*?\n\}\n\n/g, (m, name) => {
  // interface names are PascalCase of table names; detect partition suffix
  if (/Default$/.test(name) || /\d{6}$/.test(name)) return '';
  return m;
});
writeFileSync(file, src);
console.log('post-processed types.ts');
