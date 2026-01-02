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
    maxConcurrentCrawls: 2, // Instagram is strict
    requestHandler: router,
    headless: true,
    
    // Inject cookies if provided
    async preNavigationHooks({ page, session }) {
        if (loginCookies && Array.isArray(loginCookies) && loginCookies.length > 0) {
            await page.context().addCookies(loginCookies);
        }
    },
});

// Prepare Request List
const requestList = await Actor.openRequestList(null, startUrls);
const requestQueue = await Actor.openRequestQueue();

// Handle Search if provided
if (search) {
    const searchUrl = `https://www.instagram.com/explore/tags/${search}/`; // simplified entry
     // Actually for search implementation we need to search and then enqueue profiles/tags.
     // For now, let's treat the search term as a hashtag search start.
     await requestQueue.addRequest({
         url: `https://www.instagram.com/explore/tags/${search}/`,
         userData: { label: 'HASHTAG', limit: searchLimit }
     });
}

// Add start URLs with default labels
// Logic to detect URL type would go here or inside the router. 
// For now, we rely on router pattern matching.

await crawler.run([
    ...startUrls,
    ...(search ? [`https://www.instagram.com/explore/tags/${search}/`] : [])
]);

// Generate Report
if (enhanceReport) {
    await generateReport();
}

await Actor.exit();
