const fs = require('fs');
const path = require('path');
const https = require('https');

const ASSETS_DIR = path.join(__dirname, 'assets');

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
    const fileStream = fs.createWriteStream(filePath);

    https.get(file.url, (response) => {
        response.pipe(fileStream);
        fileStream.on('finish', () => {
            fileStream.close();
            console.log(`   ✅ Saved ${file.name}`);
        });
    }).on('error', (err) => {
        fs.unlink(filePath, () => {}); // Delete partial file
        console.error(`   ❌ Error downloading ${file.name}: ${err.message}`);
    });
});