import { readFileSync } from "node:fs";
const src = readFileSync("/workspace/lumen-onboarding/src/lumen.jsx", "utf8");
function grab(sig){ const start=src.indexOf(sig); if(start<0) throw new Error("not found: "+sig); let i=src.indexOf("{",start),d=0; for(;i<src.length;i++){ if(src[i]==="{")d++; else if(src[i]==="}"){ d--; if(!d){ i++; break; } } } return src.slice(start,i); }
const code = [grab("function stripAll(t)"), grab("function procTopics(t)")].join("\n");
const { procTopics, stripAll } = eval("(()=>{"+code+"; return {procTopics, stripAll};})()");

// Reconstruct the EXACT reply from the screenshot. JSON.stringify guarantees the
// same \" escaping the model emits inside the JSON string values.
const objs = [
  {group:"Own brand",name:"The Grammys Brand",keywords:'Grammys OR "Grammy Awards" OR GRAMMYs OR #GRAMMYs OR #Grammys',urls:"",hashtags:"#GRAMMYs #Grammys",comments:"Core brand topic covering ceremony, nominations, and year-round mentions. Exclusion check needed."},
  {group:"Competitor",name:"Awards Show Landscape",keywords:'"Billboard Music Awards" OR BBMAs OR iHeartRadio OR VMAs OR "MTV Video Music Awards" OR Oscars OR Emmys OR "American Music Awards" OR AMAs OR "BET Awards"',urls:"",hashtags:"#BBMAs #iHeartAwards #VMAs #Oscars #Emmys #AMAs #BETAwards",comments:"Tracks all seven named competitor shows for competitive intelligence."},
  {group:"Industry/Trend",name:"Music Industry Trends",keywords:'"music industry" OR "new music" OR "album release" OR "music streaming" OR "record label"',urls:"",hashtags:"#NewMusic #MusicIndustry",comments:"Supports the industry insights goal mentioned."},
];
const reply = "Perfect — I've got seven. Based on everything you've told me, here are my first three topic suggestions:\n\n"
  + objs.map(o => "TOPIC_SUGGESTION" + JSON.stringify(o)).join("\n\n")
  + "\n\nIs there anything missing, or shall I add a dedicated event monitoring topic for the telecast itself?";

const r = {};
const { suggestions, stripped } = procTopics(reply);
const clean = stripAll(stripped);
r.parsed_3 = suggestions.length === 3;
r.names_ok = suggestions.map(s=>s.name).join("|") === "The Grammys Brand|Awards Show Landscape|Music Industry Trends";
r.keywords_kept = /Grammy Awards/.test(suggestions[0].keywords) && /BET Awards/.test(suggestions[1].keywords);
r.rationale_from_comments = suggestions[0].rationale.startsWith("Core brand topic");
r.no_marker_leak = !/TOPIC_SUGGESTION/.test(clean) && !/"group"/.test(clean) && !/keywords/.test(clean) && !clean.includes("{");
r.prose_kept = clean.includes("here are my first three topic suggestions") && clean.includes("Is there anything missing");

// Legacy pipe form still works.
const legacy = 'Here are topics:\nTOPIC_SUGGESTION|Nike|"nike" OR @nike|Your top competitor\nAnything else?';
const lp = procTopics(legacy);
r.legacy_pipe_ok = lp.suggestions.length === 1 && lp.suggestions[0].name === "Nike" && !/TOPIC_SUGGESTION/.test(stripAll(lp.stripped));

// Malformed JSON must still be stripped (no leak), even if it yields no card.
const bad = "Intro.\nTOPIC_SUGGESTION{not valid json}\nOutro.";
const bp = procTopics(bad);
r.malformed_stripped = !/TOPIC_SUGGESTION/.test(stripAll(bp.stripped)) && stripAll(bp.stripped).includes("Intro") && stripAll(bp.stripped).includes("Outro");

console.log("--- clean visible message ---\n" + clean + "\n--------------------------------");
const PASS = Object.values(r).every(Boolean);
for (const [k,v] of Object.entries(r)) if(!v) console.log("FAIL:", k);
console.log(JSON.stringify({ ...r, PASS }, null, 2));
process.exit(PASS ? 0 : 1);
