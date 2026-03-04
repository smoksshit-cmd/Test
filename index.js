(() => {
"use strict";

const MODULE_KEY = "janitor_import";

function ctx(){
    return SillyTavern.getContext();
}

/* ---------------- UI ---------------- */

function createUI(){

if($("#janitor_import_btn").length) return;

$("body").append(`
<div id="janitor_import_panel">

<div class="janitor_title">
📥 Janitor Import
</div>

<input id="janitor_url"
placeholder="Paste Janitor script/lore URL">

<button id="janitor_import_btn" class="menu_button">
Import
</button>

<div id="janitor_status"></div>

</div>
`);

$("#janitor_import_btn").on("click", startImport);

}

/* ---------------- Status ---------------- */

function setStatus(text){

$("#janitor_status").text(text);

}

/* ---------------- Import ---------------- */

async function startImport(){

const url = $("#janitor_url").val().trim();

if(!url){

toastr.warning("Enter a Janitor link");
return;

}

try{

setStatus("Parsing link...");

const id = extractId(url);

if(!id) throw new Error("Invalid Janitor URL");

setStatus("Downloading data...");

const data = await fetchJanitorData(id);

setStatus("Converting lorebook...");

const lorebook = convertToST(data);

setStatus("Saving to SillyTavern...");

await saveLorebook(lorebook);

setStatus("Done");

toastr.success("Lorebook imported");

}catch(err){

console.error(err);

setStatus("Error");

toastr.error(err.message);

}

}

/* ---------------- Extract ID ---------------- */

function extractId(url){

const m = url.match(/scripts\/([a-z0-9\-]+)/i);

if(!m) return null;

return m[1];

}

/* ---------------- Fetch ---------------- */

async function fetchJanitorData(id){

/* try API */

try{

const res = await fetch(
`https://janitorai.com/api/scripts/${id}`
);

if(res.ok){

return await res.json();

}

}catch(e){}

/* fallback page parsing */

const page = await fetch(
`https://janitorai.com/scripts/${id}`
);

const html = await page.text();

const jsonMatch =
html.match(/"script":(\{.*?\})/s);

if(!jsonMatch){

throw new Error("Could not find script data");

}

return JSON.parse(jsonMatch[1]);

}

/* ---------------- Convert ---------------- */

function convertToST(janitor){

const lore = {

name: janitor.name || "Janitor Lorebook",

entries: []

};

const entries =
janitor.entries ||
janitor.lorebook ||
[];

for(const e of entries){

lore.entries.push({

uid: crypto.randomUUID(),

key: e.keywords || e.triggers || [],

comment: e.name || "",

content: e.content || e.text || "",

order: 100,

constant: false,

selective: true

});

}

return lore;

}

/* ---------------- Save ---------------- */

async function saveLorebook(lore){

await fetch("/api/worldinfo/create", {

method:"POST",

headers:{
"Content-Type":"application/json"
},

body:JSON.stringify(lore)

});

}

/* ---------------- Init ---------------- */

jQuery(async () => {

console.log("[Janitor Importer] Loaded");

createUI();

});

})();
