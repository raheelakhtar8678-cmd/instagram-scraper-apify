import { Actor } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration, Dataset } from 'crawlee';
import { router } from './routes.js';
import { generateReport } from './report.js';

await Actor.init();

const input = await Actor.getInput() || {};
const {
    startUrls = [],
    search,
    proxy,
    maxPostsPerProfile = 15,
    maxConcurrency = 2,
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
    maxConcurrency, // Honor user input
    requestHandler: router,
    headless: true,

    // Mobile Safari Emulation
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: [
                    { name: 'safari', minVersion: 15 },
                    { name: 'chrome', minVersion: 100 },
                ],
                devices: ['mobile'],
                operatingSystems: ['ios', 'android'],
            },
        },
    },

    // Resilient Navigation
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 300,

    // Inject cookies if provided
    preNavigationHooks: [
        async ({ page, request }) => {
            // Mobile Device Emulation
            await page.setViewportSize({ width: 390, height: 844 }); // iPhone 13
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
            });

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
        userData: { label: 'HASHTAG', limit: searchLimit, maxPosts: maxPostsPerProfile }
    });
}

// Push a "Direct Link" item to the dataset so it appears first in the Output tab
await Dataset.pushData({
    type: 'SUMMARY',
    VIEW_PREMIUM_REPORT: `https://api.apify.com/v2/key-value-stores/${process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID}/records/REPORT.html`,
    message: '🔗 Click the link above to view your premium visual dashboard!',
    scrapedAt: new Date().toISOString(),
});

// Add start URLs and ensure they are clean
for (const req of startUrls) {
    if (typeof req === 'string') {
        requests.push({ url: req, userData: { maxPosts: maxPostsPerProfile } });
    } else if (req && typeof req === 'object') {
        // Aggressively strip 'id' and other internal fields that Crawlee's addRequests might reject
        const { id, ...cleanReq } = req;
        cleanReq.userData = { ...cleanReq.userData, maxPosts: maxPostsPerProfile };
        requests.push(cleanReq);
    }
}

// Run the crawler with the clean list of requests
// Crawlee will automatically use the default RequestQueue
await crawler.run(requests);

// Analytics & Report Summary
const dataset = await Dataset.open();
const { itemCount } = await dataset.getInfo();
console.log(`----------------------------------------------------------------`);
console.log(`📊 FINAL SYNC COMPLETE: ${itemCount} items scraped.`);
console.log(`----------------------------------------------------------------`);

if (enhanceReport) {
    // Only generate if we have at least one real item besides the SUMMARY
    if (itemCount > 1) {
        await generateReport();
        console.log('✅ PREMIUM REPORT GENERATED!');
        console.log(`🔗 View here: https://api.apify.com/v2/key-value-stores/${process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID}/records/REPORT.html`);
    } else {
        console.log('⚠️ No real profile data was scraped. Saving fallback dashboard.');
        const fallbackHtml = `<html><body style="font-family:sans-serif; padding:40px; text-align:center;">
            <h1>Dashboard Pending</h1>
            <p>No profile data has been scraped yet. If this run finished, it means the scraper was likely blocked by Instagram's login wall.</p>
            <p><strong>Tip:</strong> Try providing Login Cookies in the actor input.</p>
        </body></html>`;
        await Actor.setValue('REPORT', fallbackHtml, { contentType: 'text/html' });
    }
}

await Actor.exit();
