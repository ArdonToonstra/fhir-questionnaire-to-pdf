const fs = require('fs');
const path = require('path');
const https = require('https');

const ASSETS_DIR = path.join(__dirname, 'assets');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit per asset file

// Security: Validate downloaded content
function validateDownload(url, data) {
    if (data.length > MAX_FILE_SIZE) {
        throw new Error(`Downloaded file from ${url} exceeds size limit`);
    }
    
    if (data.length === 0) {
        throw new Error(`Downloaded file from ${url} is empty`);
    }
    
    // Basic content validation based on expected file types
    if (url.includes('.js') && !data.includes('function') && !data.includes('var') && !data.includes('const')) {
        console.warn(`Warning: Downloaded JS file from ${url} may not be valid JavaScript`);
    }
    
    if (url.includes('.css') && !data.includes('{') && !data.includes('}')) {
        console.warn(`Warning: Downloaded CSS file from ${url} may not be valid CSS`);
    }
}

// The files we need to run LForms offline
const FILES = [
    {
        url: 'https://lhcforms-static.nlm.nih.gov/lforms-versions/36.3.2/webcomponent/styles.css',
        name: 'lhc-forms.css'
    },
    {
        url: 'https://lhcforms-static.nlm.nih.gov/lforms-versions/36.3.2/webcomponent/assets/lib/zone.min.js',
        name: 'zone.min.js'
    },
    {
        url: 'https://lhcforms-static.nlm.nih.gov/lforms-versions/36.3.2/webcomponent/lhc-forms.js',
        name: 'lhc-forms.js'
    },
    {
        url: 'https://lhcforms-static.nlm.nih.gov/lforms-versions/36.3.2/fhir/R4/lformsFHIR.min.js',
        name: 'lformsFHIR.min.js'
    }
];

if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR);
}

console.log("⬇️  Downloading LForms assets...");

FILES.forEach(file => {
    const filePath = path.join(ASSETS_DIR, file.name);
    let downloadData = Buffer.alloc(0);
    
    https.get(file.url, {
        timeout: 30000, // 30 second timeout
        headers: {
            'User-Agent': 'questionnaire-response-pdf/1.0.0'
        }
    }, (response) => {
        // Security: Validate response
        if (response.statusCode !== 200) {
            console.error(`   ❌ HTTP ${response.statusCode} for ${file.name}`);
            return;
        }
        
        // Security: Check content length
        const contentLength = parseInt(response.headers['content-length'] || '0');
        if (contentLength > MAX_FILE_SIZE) {
            console.error(`   ❌ File ${file.name} too large: ${contentLength} bytes`);
            return;
        }
        
        response.on('data', (chunk) => {
            downloadData = Buffer.concat([downloadData, chunk]);
            
            // Security: Check size during download
            if (downloadData.length > MAX_FILE_SIZE) {
                console.error(`   ❌ File ${file.name} exceeded size limit during download`);
                response.destroy();
                return;
            }
        });
        
        response.on('end', () => {
            try {
                // Security: Validate downloaded content
                validateDownload(file.url, downloadData.toString());
                
                // Write file securely
                fs.writeFileSync(filePath, downloadData, { mode: 0o644 });
                console.log(`   ✅ Saved ${file.name} (${downloadData.length} bytes)`);
            } catch (err) {
                fs.unlink(filePath, () => {}); // Delete invalid file
                console.error(`   ❌ Validation failed for ${file.name}: ${err.message}`);
            }
        });
        
    }).on('error', (err) => {
        fs.unlink(filePath, () => {}); // Delete partial file
        console.error(`   ❌ Error downloading ${file.name}: ${err.message}`);
    }).on('timeout', () => {
        console.error(`   ❌ Timeout downloading ${file.name}`);
    });
});