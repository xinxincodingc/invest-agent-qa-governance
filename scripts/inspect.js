const E=require('../src/engine/evaluate');
(async()=>{const d=E.loadData();const {results}=await E.evaluateAll({data:d});
const g=Object.fromEntries(d.gold.map(x=>[x.log_id,x.defects]));
const ids=process.argv.slice(2);
if(!ids.length){const fp=results.filter(r=>r.verdict!=='pass'&&!(g[r.id]||[]).length);
 const c={};fp.forEach(r=>{const k=r.verdict+':'+r.checks.filter(x=>x.status==='fail'||x.status==='unverifiable').map(x=>x.metric).join('+');c[k]=(c[k]||[]);c[k].push(r.id)});console.log(Object.fromEntries(Object.entries(c).map(([k,v])=>[k,v.length+' '+v.slice(0,3)])));return}
for(const id of ids){const r=results.find(x=>x.id===id);console.log(id,'gold',g[id],'pred',r.issues,r.verdict);console.log(r.answer);r.checks.filter(c=>c.status!=='pass'&&c.status!=='na').forEach(c=>console.log('  ',c.metric,c.status,c.detail))}
})();
