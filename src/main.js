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
                await page.context().addCookies(loginCookies);
            }
        },
    ],
});


// Prepare Request Queue
const requestQueue = await Actor.openRequestQueue();

// Handle Search if provided
if (search) {
    await requestQueue.addRequest({
        url: `https://www.instagram.com/explore/tags/${search}/`,
        userData: { label: 'HASHTAG', limit: searchLimit }
    });
}

// Add start URLs to the queue
for (const request of startUrls) {
    if (typeof request === 'string') {
        await requestQueue.addRequest({ url: request });
    } else {
        // Strip ID if it exists to avoid validation error
        const { id, ...cleanRequest } = request;
        await requestQueue.addRequest(cleanRequest);
    }
}

await crawler.run(requestQueue);

// Generate Report
if (enhanceReport) {
    await generateReport();
}

await Actor.exit();
