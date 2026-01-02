import { Actor } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration } from 'crawlee';
import { router } from './routes.js';
import { generateReport } from './report.js';

await Actor.init();

const input = await Actor.getInput() || {};
const {
    startUrls = [],
    search,
    proxy,
    resultsLimit = 20,
    searchLimit = 5,
    loginCookies,
    enhanceReport = true
} = input;

// Create proxy configuration
const proxyConfiguration = await Actor.createProxyConfiguration(proxy);

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    useSessionPool: true,
    persistCookiesPerSession: true,
    maxConcurrency: 2, // Instagram is strict
    requestHandler: router,
    headless: true,

    // Inject cookies if provided
    preNavigationHooks: [
        async ({ page }) => {
            if (loginCookies && Array.isArray(loginCookies) && loginCookies.length > 0) {
                const sanitizedCookies = loginCookies.map(cookie => {
                    const { sameSite, ...rest } = cookie;
                    const sanitized = { ...rest };
                    if (sameSite) {
                        const ss = sameSite.toLowerCase();
                        if (ss === 'strict') sanitized.sameSite = 'Strict';
                        else if (ss === 'lax') sanitized.sameSite = 'Lax';
                        else if (ss === 'none') sanitized.sameSite = 'None';
                    }
                    return sanitized;
                });
                await page.context().addCookies(sanitizedCookies);
            }
        },
    ],
});



// Prepare initial requests
const requests = [];

// Add Search if provided
if (search) {
    requests.push({
        url: `https://www.instagram.com/explore/tags/${search}/`,
        userData: { label: 'HASHTAG', limit: searchLimit }
    });
}

// Add start URLs and ensure they are clean
for (const req of startUrls) {
    if (typeof req === 'string') {
        requests.push({ url: req });
    } else if (req && typeof req === 'object') {
        // Aggressively strip 'id' and other internal fields that Crawlee's addRequests might reject
        const { id, ...cleanReq } = req;
        requests.push(cleanReq);
    }
}

// Run the crawler with the clean list of requests
// Crawlee will automatically use the default RequestQueue
await crawler.run(requests);

// Analytics & Report Summary
const dataset = await Actor.openDataset();
const { itemCount } = await dataset.getInfo();
console.log(`----------------------------------------------------------------`);
console.log(`📊 FINAL SYNC COMPLETE: ${itemCount} items scraped.`);
console.log(`----------------------------------------------------------------`);

if (enhanceReport) {
    if (itemCount > 0) {
        await generateReport();
        console.log('✅ PREMIUM REPORT GENERATED!');
        console.log(`🔗 View here: https://api.apify.com/v2/key-value-stores/${process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID}/records/REPORT.html`);
    } else {
        console.log('⚠️ No items were scraped. Skipping report generation.');
        console.log('💡 Tip: Try providing login cookies or checking if the profile is private.');

        // Save a "No Data" report so the link at least shows something helpful
        await Actor.setValue('REPORT', '<h1>No Data Scraped</h1><p>The scraper finished without finding any items. This is usually due to a login wall or a temporary block by Instagram.</p>', { contentType: 'text/html' });
    }
}

await Actor.exit();
