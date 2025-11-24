const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const SOURCE_DIR = path.join(__dirname, 'questionnaires');

// --- GLOBAL MAPS ---
const resourceMap = new Map(); 

// 1. SETUP & LOAD
if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`❌ Error: Source directory '${SOURCE_DIR}' does not exist.`);
    process.exit(1);
}

function loadResources() {
    const files = fs.readdirSync(SOURCE_DIR).filter(f => f.endsWith('.json'));
    console.log(`📦 Loading ${files.length} resources from ${SOURCE_DIR}...`);

    files.forEach(file => {
        try {
            const raw = fs.readFileSync(path.join(SOURCE_DIR, file), 'utf8');
            const json = JSON.parse(raw);
            const items = json.resourceType === 'Bundle' && json.entry ? json.entry.map(e => e.resource) : [json];

            items.forEach(r => {
                if (!r || !r.url) return;
                
                resourceMap.set(r.url, r);
                resourceMap.set(r.url.split('|')[0], r);
            });
        } catch (e) {
            console.warn(`   ⚠️ Error reading ${file}: ${e.message}`);
        }
    });
    console.log(`   ✅ Indexed ${resourceMap.size} canonical URLs.`);
}

// 2. EXPANSION LOGIC
function getOptionsFromValueSet(vsUrl) {
    const cleanUrl = vsUrl.split('|')[0];
    const vs = resourceMap.get(cleanUrl);

    if (!vs) {
        // console.warn(`      ⚠️  MISSING ValueSet: ${cleanUrl}`);
        return null;
    }

    let options = [];

    if (vs.expansion && vs.expansion.contains) {
        options = vs.expansion.contains.map(c => ({
            valueCoding: { system: c.system, code: c.code, display: c.display }
        }));
    }
    else if (vs.compose && vs.compose.include) {
        vs.compose.include.forEach(inc => {
            if (inc.concept) {
                inc.concept.forEach(c => {
                    options.push({
                        valueCoding: { system: inc.system, code: c.code, display: c.display }
                    });
                });
            }
            else if (inc.system && !inc.concept) {
                const cs = resourceMap.get(inc.system);
                if (cs && cs.concept) {
                    cs.concept.forEach(c => {
                        options.push({
                            valueCoding: { system: inc.system, code: c.code, display: c.display }
                        });
                    });
                }
            }
        });
    }
    return options.length > 0 ? options : null;
}

function processItems(items) {
    if (!items) return;

    items.forEach(item => {
        if (item.item) processItems(item.item);

        if (item.answerValueSet) {
            const options = getOptionsFromValueSet(item.answerValueSet);
            if (options) {
                item.answerOption = options;
                delete item.answerValueSet; 
            }
        }
    });
}

// 3. RUNNER (IN-PLACE)
function expandAll() {
    loadResources();

    console.log("\n🚀 Expanding Questionnaires (In-Place)...");
    
    const questionnaires = Array.from(resourceMap.values()).filter(r => r.resourceType === 'Questionnaire');
    let count = 0;

    questionnaires.forEach(q => {
        const newQ = JSON.parse(JSON.stringify(q));
        processItems(newQ.item);

        // Find the original filename if possible, or generate one
        // Since we loaded from files, we assume we are overwriting them.
        // But wait - resourceMap values don't know their filename.
        // We need to map URL back to Filename or just re-scan.
        // Simpler approach: We re-scan the directory to match file->json
    });
    
    // Re-scan directory to ensure we write back to the CORRECT file
    const files = fs.readdirSync(SOURCE_DIR).filter(f => f.endsWith('.json'));
    
    files.forEach(file => {
        try {
            const filePath = path.join(SOURCE_DIR, file);
            const raw = fs.readFileSync(filePath, 'utf8');
            const json = JSON.parse(raw);
            
            // If it's a Questionnaire, process and overwrite
            if (json.resourceType === 'Questionnaire') {
                processItems(json.item);
                fs.writeFileSync(filePath, JSON.stringify(json, null, 2));
                count++;
            }
            // If it's a Bundle containing a Questionnaire
            else if (json.resourceType === 'Bundle' && json.entry) {
                let changed = false;
                json.entry.forEach(e => {
                    if (e.resource && e.resource.resourceType === 'Questionnaire') {
                        processItems(e.resource.item);
                        changed = true;
                    }
                });
                if (changed) {
                    fs.writeFileSync(filePath, JSON.stringify(json, null, 2));
                    count++;
                }
            }
        } catch (e) {
            console.error(`Error processing ${file}: ${e.message}`);
        }
    });

    console.log(`\n✨ Done! Updated ${count} files in /questionnaires`);
}

expandAll();