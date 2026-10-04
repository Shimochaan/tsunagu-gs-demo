// Only generates SQL. Apply to NEW showcase databases, never integration/production.
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { showcaseSeed } from '../backend/showcase-seed.ts';
const dest=process.argv[2];
if(!dest?.startsWith('/tmp/')) throw Error('Pass a new /tmp directory for the isolated showcase SQL.');
await mkdir(dest,{recursive:true});
const ddl=(await readFile('backend/migrations/platform/0001_initial.sql','utf8')).match(/^CREATE TABLE "(?:account|user|session|verification|rateLimit)" .+;/gm)!;
const sets=showcaseSeed(ddl);
for(const [name,queries] of Object.entries(sets)) {
 const sql=queries.map(q=>{let i=0;return q.sql.replace(/\?/g,()=>{const v=q.params![i++];return v===null?'NULL':typeof v==='number'?String(v):"'"+v.replaceAll("'","''")+"'";})+';';}).join('\n');
 await writeFile(`${dest}/${name}.sql`,sql);
}
console.log('Generated synthetic-only SQL for platform/common/harness/studio.');
