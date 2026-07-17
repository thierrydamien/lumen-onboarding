import { readFileSync } from "node:fs";
const src = readFileSync("/workspace/lumen-onboarding/src/lumen.jsx", "utf8");
// Robust extraction: top-level functions close with "}" at column 0.
function grab(name){ const sig="function "+name+"("; const a=src.indexOf(sig); if(a<0) throw new Error("not found "+name); const b=src.indexOf("\n}\n",a); if(b<0) throw new Error("no close "+name); return src.slice(a,b+2); }
const code = [grab("stripAll"), grab("procTopics")].join("\n");
const { procTopics, stripAll } = eval("(()=>{"+code+"; return {procTopics, stripAll};})()");
const clean = r => stripAll(procTopics(r).stripped);
const r = {};
// 1) The original screenshot case (flat JSON, escaped quotes in keywords).
{ const o={group:"Own brand",name:"The Grammys Brand",keywords:'Grammys OR "Grammy Awards"',comments:"Core brand topic."};
  const rep = "Intro:\n\nTOPIC_SUGGESTION"+JSON.stringify(o)+"\n\nOutro?";
  const pr = procTopics(rep);
  r.flat_parsed = pr.suggestions.length===1 && pr.suggestions[0].name==="The Grammys Brand" && pr.suggestions[0].rationale==="Core brand topic.";
  r.flat_no_leak = !/TOPIC_SUGGESTION/.test(clean(rep)) && !clean(rep).includes("{"); }
// 2) NEW: nested/quoted brace inside a value (the incomplete-fix hole).
{ const o={name:"Odd",keywords:'a {b} c OR "x{y}z"',comments:"has braces"};
  const rep = "Here:\nTOPIC_SUGGESTION"+JSON.stringify(o)+"\nEnd.";
  const pr = procTopics(rep);
  r.nested_parsed = pr.suggestions.length===1 && pr.suggestions[0].keywords.includes("{b}");
  r.nested_no_leak = !/TOPIC_SUGGESTION/.test(clean(rep)) && !/\{/.test(clean(rep)); }
// 3) NEW: colon prefix "TOPIC_SUGGESTION: {...}".
{ const rep = 'A\nTOPIC_SUGGESTION: {"name":"C","keywords":"k"}\nB';
  const pr = procTopics(rep);
  r.colon_parsed = pr.suggestions.length===1 && pr.suggestions[0].name==="C";
  r.colon_no_leak = !/TOPIC_SUGGESTION/.test(clean(rep)); }
// 4) NEW: unterminated (truncated) marker -> dropped, no leak.
{ const rep = 'Text before.\nTOPIC_SUGGESTION{"name":"D","keywords":"partial';
  r.trunc_no_leak = !/TOPIC_SUGGESTION/.test(clean(rep)) && clean(rep).includes("Text before"); }
// 5) Legacy pipe form still works.
{ const rep = 'X\nTOPIC_SUGGESTION|Nike|"nike"|competitor\nY';
  const pr = procTopics(rep);
  r.pipe_parsed = pr.suggestions.length===1 && pr.suggestions[0].name==="Nike";
  r.pipe_no_leak = !/TOPIC_SUGGESTION/.test(clean(rep)); }
// 6) Multiple suggestions in one reply.
{ const rep = "H\n"+["A","B","C"].map(n=>'TOPIC_SUGGESTION{"name":"'+n+'","keywords":"k"}').join("\n")+"\nT";
  r.multi = procTopics(rep).suggestions.length===3 && !/TOPIC_SUGGESTION/.test(clean(rep)); }
const PASS = Object.values(r).every(Boolean);
for (const [k,v] of Object.entries(r)) if(!v) console.log("FAIL:",k);
console.log(JSON.stringify({...r,PASS},null,2));
process.exit(PASS?0:1);
