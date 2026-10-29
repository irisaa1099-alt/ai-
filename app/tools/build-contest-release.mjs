/** Whitelist release builder; never includes database, keys or third-party character presets. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
const app=path.resolve(import.meta.dirname,'..'),repo=path.dirname(app),out=path.resolve(process.argv[2]||'');
if(!process.argv[2]||fs.existsSync(out)||out.startsWith(repo+path.sep))throw Error('Provide a new output directory outside the project');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const manifest=[];
function copy(rel,dest=rel){const src=path.join(app,rel),target=path.join(out,'app',dest);fs.mkdirSync(path.dirname(target),{recursive:true});const bytes=fs.readFileSync(src);fs.writeFileSync(target,bytes);manifest.push({path:'app/'+dest,source:'app/'+rel,sha256:sha(bytes)})}
for(const dir of ['core','ui','voice','styles','licenses','examples','models'])for(const entry of fs.readdirSync(path.join(app,dir)))if(fs.statSync(path.join(app,dir,entry)).isFile())copy(dir+'/'+entry);
for(const rel of ['server.mjs','local-start.mjs','index.html','icon.svg','sw.js','manifest.webmanifest','.env.example','data/models.js','data/contest-templates.js'])copy(rel);
copy('data/contest-templates.js','data/templates.js');
for(const name of ['LOCAL-MODEL.md','CONTEST-REPRODUCE.md','CORE-EXPERIENCE-2026-10-25.md','MEMORY-REVISION-2026-10-25.md','BUGFIX-2026-10-25.md','BUGFIX-2026-10-24.md','MEMORY-PROVENANCE.md','RECENT-EXPERIENCES.md'])copy('docs/'+name);
copy('docs/CONTEST-REPRODUCE.md','README.md');
for(const name of ['contestcheck.mjs','securitycheck.mjs','memorycheck.mjs','groupbudgetcheck.mjs','optimizationcheck.mjs','providercheck.mjs','recentcheck.mjs','cdp.mjs','memory-eval.mjs','core-eval.mjs','groupcheck.mjs','werewolfcheck.mjs','game-sessioncheck.mjs','memory-revision.test.mjs','mock-llm.mjs'])copy('tools/'+name);
for(const name of fs.readdirSync(path.join(app,'tools/core-eval')))if(!name.includes('.local.')&&fs.statSync(path.join(app,'tools/core-eval',name)).isFile())copy('tools/core-eval/'+name);
for(const name of fs.readdirSync(path.join(app,'tools/memory-eval')))if(!name.includes('.local.')&&fs.statSync(path.join(app,'tools/memory-eval',name)).isFile())copy('tools/memory-eval/'+name);
for(const name of ['NOTICE.md','LICENSE','.gitignore'])if(fs.existsSync(path.join(repo,name))){const bytes=fs.readFileSync(path.join(repo,name));fs.writeFileSync(path.join(out,name),bytes);manifest.push({path:name,source:name,sha256:sha(bytes)})}
const base=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
manifest.sort((a,b)=>a.path.localeCompare(b.path));const result={release:'quliao-aic-20261025-r3',gitBase:base,workingTreeChanges:execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim(),coreUnmodifiedByPackaging:true,templateReplacement:'app/data/contest-templates.js -> app/data/templates.js',sourceSha256:sha(JSON.stringify(manifest)),files:manifest};
fs.writeFileSync(path.join(out,'RELEASE_MANIFEST.json'),JSON.stringify(result,null,2)+'\n');fs.writeFileSync(path.join(out,'SHA256SUMS'),manifest.map(x=>`${x.sha256}  ${x.path}`).join('\n')+'\n');
console.log(JSON.stringify({out,files:manifest.length,sha256:result.sourceSha256}));
