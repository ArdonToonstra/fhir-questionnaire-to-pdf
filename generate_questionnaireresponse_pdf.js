const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const INPUT_DIR = path.join(__dirname, 'input');
const OUTPUT_DIR = path.join(__dirname, 'output');
const QUESTIONNAIRE_DIR = path.join(__dirname, 'questionnaires'); // Back to original folder
const ASSETS_DIR = path.join(__dirname, 'assets');
const TEMPLATE_PATH = path.join(__dirname, 'template.html');
const LOG_FILE = path.join(OUTPUT_DIR, 'log.txt');

// --- LOGGING ---
function setupOutputFolder() {
    if (fs.existsSync(OUTPUT_DIR)) {
        console.log("🧹 Cleaning old output...");
        fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(OUTPUT_DIR);
}

function log(message, type = 'INFO') {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const consoleMsg = type === 'ERROR' ? `   ❌ ${message}` : `   ${message}`;
    const fileMsg = `[${timestamp}] [${type}] ${message}\n`;

    if (type === 'HEADER') console.log(`\n${message}`);
    else console.log(consoleMsg);

    try { fs.appendFileSync(LOG_FILE, fileMsg); } catch (e) {}
}

// --- SECURITY & VALIDATION ---
function validateJsonFile(filePath) {
    const stats = fs.statSync(filePath);
    const maxSize = 50 * 1024 * 1024; // 50MB limit
    
    if (stats.size > maxSize) {
        throw new Error(`File ${path.basename(filePath)} exceeds maximum size of ${maxSize / (1024 * 1024)}MB`);
    }
    
    if (stats.size === 0) {
        throw new Error(`File ${path.basename(filePath)} is empty`);
    }
}

function sanitizeFilename(filename) {
    // Remove file extension first
    const nameWithoutExt = filename.replace(/\.json$/, '');
    
    // Replace invalid characters with dashes and convert to lowercase
    let cleaned = nameWithoutExt.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
    
    // Remove multiple consecutive dashes and trim
    cleaned = cleaned.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    
    // Ensure filename is not empty and not too long
    if (!cleaned || cleaned.length === 0) {
        cleaned = 'unnamed-file';
    }
    
    if (cleaned.length > 100) {
        cleaned = cleaned.substring(0, 100).replace(/-+$/, '');
    }
    
    // Validate final filename
    const allowedPattern = /^[a-zA-Z0-9._-]+$/;
    if (!allowedPattern.test(cleaned)) {
        throw new Error(`Invalid filename after sanitization: ${cleaned}`);
    }
    
    return cleaned;
}

// --- LOADERS ---
const questionnaireMap = new Map();

function loadLibraries() {
    if (!fs.existsSync(QUESTIONNAIRE_DIR)) {
        console.error("❌ Questionnaires folder missing.");
        process.exit(1);
    }

    const files = fs.readdirSync(QUESTIONNAIRE_DIR).filter(file => file.endsWith('.json'));
    log(`Loading ${files.length} definitions from /questionnaires...`, 'INFO');

    files.forEach(file => {
        try {
            const filePath = path.join(QUESTIONNAIRE_DIR, file);
            
            // Validate questionnaire file
            try {
                validateJsonFile(filePath);
            } catch (e) {
                log(`Skipping invalid file ${file}: ${e.message}`, 'WARN');
                return;
            }
            
            const raw = fs.readFileSync(filePath, 'utf8');
            const json = JSON.parse(raw);
            
            const items = json.resourceType === 'Bundle' && json.entry ? json.entry.map(e => e.resource) : [json];
            items.forEach(r => {
                if (r.resourceType === 'Questionnaire' && r.url) {
                    questionnaireMap.set(r.url, r);
                    questionnaireMap.set(r.url.split('|')[0], r);
                }
            });
        } catch (e) { log(`Failed to load Q: ${file}`, 'WARN'); }
    });
}

function normalizeFHIRData(jsonData) {
    let resources = [];
    if (jsonData.resourceType === 'Bundle' && jsonData.entry) resources = jsonData.entry.map(e => e.resource).filter(r => r);
    else resources = [jsonData];

    let patient = resources.find(r => r.resourceType === 'Patient');
    let carePlan = resources.find(r => r.resourceType === 'CarePlan');
    const questionnaireResponses = resources.filter(r => r.resourceType === 'QuestionnaireResponse');
    const qResponse = questionnaireResponses[0]; // Use first QR for backwards compatibility
    let questionnaire = resources.find(r => r.resourceType === 'Questionnaire');

    // If no Patient resource found in Bundle, create a placeholder that will trigger QR fallback
    if (!patient) {
        patient = { resourceType: "Patient", name: null }; // null name will trigger QR fallback
    }
    
    // If no CarePlan resource found in Bundle, create a placeholder
    if (!carePlan) {
        carePlan = { resourceType: "CarePlan", category: null }; // null category will trigger fallback
    }

    if (!questionnaire && qResponse && qResponse.questionnaire) {
        const ref = qResponse.questionnaire;
        questionnaire = questionnaireMap.get(ref) || questionnaireMap.get(ref.split('|')[0]);
    }

    if (qResponse && !questionnaire) {
        log(`Definition not found for ${qResponse.questionnaire}`, 'WARN');
        // Return minimal stub to allow processing to continue (Sanitizer will log warnings)
        questionnaire = { resourceType: "Questionnaire", status: "active", item: [] };
    }
    
    return { 
        fileName: jsonData.id || 'report', 
        patient, 
        carePlan, 
        questionnaire, 
        questionnaireResponse: qResponse,
        questionnaireResponses // Include all QRs for potential future use
    };
}

(async () => {
    setupOutputFolder();
    if (!fs.existsSync(INPUT_DIR)) fs.mkdirSync(INPUT_DIR);

    if (!fs.existsSync(path.join(ASSETS_DIR, 'lhc-forms.js'))) {
        log("CRITICAL: Assets missing. Run 'node download_assets.js' first.", 'ERROR');
        process.exit(1);
    }

    console.log("🚀 Starting FHIR PDF Generator...");
    loadLibraries();

    const browser = await puppeteer.launch({ 
        headless: "new", 
        args: [
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor', 
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });
    const page = await browser.newPage();
    
    page.on('console', async msg => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
            const args = await Promise.all(msg.args().map(arg => arg.jsonValue().catch(() => '')));
            const text = args.length ? args.join(' ') : msg.text();
            if (text.includes('LFORMS_CRASH')) log(`[CRASH] ${text.replace('LFORMS_CRASH:', '')}`, 'ERROR');
            else if (text.includes('[Sanitizer Removed]')) log(`${text}`, 'WARN');
            else if (text.includes('[Normalizer]')) log(`${text}`, 'INFO');
        }
    });

    const files = fs.readdirSync(INPUT_DIR).filter(file => file.endsWith('.json'));

    for (const file of files) {
        try {
            const filePath = path.join(INPUT_DIR, file);
            
            // Security: Validate file before processing
            validateJsonFile(filePath);
            
            const rawJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            log(`Processing: ${file}`, 'HEADER');
            
            const processedData = normalizeFHIRData(rawJson);

            if (!processedData.questionnaireResponses || processedData.questionnaireResponses.length === 0) {
                log("Skipping: No QuestionnaireResponse found.", 'WARN');
                continue;
            }

            // Prepare combined data with all QRs and their questionnaires
            const combinedQRData = [];
            for (let i = 0; i < processedData.questionnaireResponses.length; i++) {
                const currentQR = processedData.questionnaireResponses[i];
                log(`  Processing QR ${i + 1}/${processedData.questionnaireResponses.length}: ${currentQR.questionnaire}`, 'INFO');

                // Find the appropriate questionnaire for this QR
                let questionnaire = null;
                if (currentQR.questionnaire) {
                    const ref = currentQR.questionnaire;
                    questionnaire = questionnaireMap.get(ref) || questionnaireMap.get(ref.split('|')[0]);
                }

                if (!questionnaire) {
                    log(`  Definition not found for ${currentQR.questionnaire}`, 'WARN');
                    questionnaire = { resourceType: "Questionnaire", status: "active", item: [] };
                }

                combinedQRData.push({
                    questionnaireResponse: currentQR,
                    questionnaire: questionnaire,
                    title: questionnaire.title || currentQR.questionnaire?.split('/').pop().split('|')[0] || `Questionnaire ${i + 1}`
                });
            }

            // Create combined data structure
            const combinedData = {
                ...processedData,
                combinedQuestionnaires: combinedQRData,
                isMultipleQR: combinedQRData.length > 1
            };

            await page.goto(`file://${TEMPLATE_PATH}`, { waitUntil: 'domcontentloaded' });
            
            await page.addStyleTag({ path: path.join(ASSETS_DIR, 'lhc-forms.css') });
            await page.addScriptTag({ path: path.join(ASSETS_DIR, 'zone.min.js') });
            await page.addScriptTag({ path: path.join(ASSETS_DIR, 'lhc-forms.js') });
            await page.addScriptTag({ path: path.join(ASSETS_DIR, 'lformsFHIR.min.js') });

            try { await page.waitForFunction(() => window.LForms, { timeout: 3000 }); } catch (e) {}

            await page.evaluate((data) => { window.renderFromData(data); }, combinedData);

            try { await page.waitForSelector('#render-complete', { timeout: 15000 }); } 
            catch (e) { log("Render timeout.", 'ERROR'); continue; }

            // Generate secure filename
            const outName = sanitizeFilename(file);
            
            await page.pdf({
                path: path.join(OUTPUT_DIR, `${outName}.pdf`),
                format: 'A4',
                printBackground: true,
                margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' }
            });

            log(`Saved: ${outName}.pdf (${combinedQRData.length} questionnaire${combinedQRData.length > 1 ? 's' : ''})`, 'SUCCESS');

        } catch (error) {
            // Security: Limit error information disclosure
            const sanitizedError = error.message.length > 200 ? 
                error.message.substring(0, 200) + '... (truncated)' : 
                error.message;
            log(`System Error processing ${file}: ${sanitizedError}`, 'ERROR');
        }
    }

    await browser.close();
    console.log("\n✨ All done! Check output/log.txt for details.");
})();