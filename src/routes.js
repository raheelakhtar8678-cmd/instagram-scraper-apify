import { createPlaywrightRouter, Dataset } from 'crawlee';

export const router = createPlaywrightRouter();

// Helper to normalize IG numbers (e.g. 1.2k -> 1200)
const parseIGNumber = (str) => {
    if (!str) return 0;
    const cleanStr = str.replace(/,/g, '').toLowerCase().trim();

    // Handle "1.2k followers" or "1M likes"
    const numPart = cleanStr.split(' ')[0];
    if (numPart.includes('k')) return parseFloat(numPart) * 1000;
    if (numPart.includes('m')) return parseFloat(numPart) * 1000000;
    return parseInt(numPart.replace(/[^0-9]/g, '')) || 0;
};

router.addDefaultHandler(async ({ page, log, request, enqueueLinks }) => {
    log.info(`Processing ${request.url}`);

    // Check for login wall or rate limiting (often shows up as a heading)
    const isLogin = await page.evaluate(() => {
        const h2s = Array.from(document.querySelectorAll('h2'));
        return h2s.some(h => h.innerText.toLowerCase().includes('log in') || h.innerText.toLowerCase().includes('sign up'));
    });

    if (isLogin) {
        log.error('Hit login wall. This runner is being blocked. Cookies are highly recommended.');
        throw new Error('LOGIN_REQUIRED');
    }

    // Check for "Something went wrong" or "Page not available"
    const isError = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('something went wrong') || text.includes('link you followed may be broken');
    });

    if (isError) {
        log.error('Instagram reported an error or page not found. Retrying...');
        throw new Error('INSTAGRAM_ERROR');
    }

    // Check for cookie consent
    const cookieButton = await page.$('button:has-text("Allow all cookies"), button:has-text("Decline optional cookies")');
    if (cookieButton) await cookieButton.click();

    // Route based on URL pattern
    if (request.url.includes('/p/') || request.url.includes('/reels/')) {
        await handlePost({ page, log, request });
    } else if (request.url.includes('/explore/tags/')) {
        await handleHashtag({ page, log, request, enqueueLinks });
    } else if (request.url.includes('/explore/locations/')) {
        await handleLocation({ page, log, request, enqueueLinks });
    } else {
        await handleProfile({ page, log, request, enqueueLinks });
    }
});

const handleProfile = async ({ page, log, request, enqueueLinks }) => {
    const url = request.url;
    const usernameFromUrl = url.split('/').filter(Boolean).pop();
    log.info(`Scraping profile: ${url} (Username: ${usernameFromUrl})`);

    // Give the page time to start loading
    await page.waitForTimeout(4000);

    // "Deep Scraping" - Scroll multiple times to trigger lazy loading
    log.info('Executing deep scroll for post discovery...');
    for (let i = 0; i < 6; i++) {
        await page.evaluate(() => window.scrollBy(0, 1500));
        await page.waitForTimeout(1000);
    }

    const data = await page.evaluate((usernameFallback) => {
        const getText = (selector) => document.querySelector(selector)?.innerText?.trim();
        const getHref = (selector) => document.querySelector(selector)?.getAttribute('href');
        const getSrc = (selector) => document.querySelector(selector)?.getAttribute('src');

        // MULTI-LAYERED STATS EXTRACTION
        let followersRaw = null, followingRaw = null, postsRaw = null;

        // Layer 1: JSON-LD (Ultra Reliable)
        try {
            const ldJson = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
                .map(s => JSON.parse(s.innerText || '{}'))
                .find(j => j.mainEntityofPage);

            const interactionStats = ldJson?.mainEntityofPage?.interactionStatistic;
            if (Array.isArray(interactionStats)) {
                interactionStats.forEach(stat => {
                    const count = stat.userInteractionCount;
                    const type = stat.interactionType;
                    if (type?.includes('FollowAction')) followersRaw = count.toString();
                    if (type?.includes('WriteAction')) postsRaw = count.toString();
                });
            }
        } catch (e) { }

        // Layer 2: Meta Description Brute Force (Regex)
        const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
        if (!followersRaw || !postsRaw) {
            // General pattern: [Num] [Word], [Num] [Word]...
            // Sometimes: 552K Followers, 116 Following, 1,048 Posts
            // We look for any number followed by a word before a comma/dash
            const matches = metaDesc.match(/([\d.,KkMm]+)\s*([A-Za-z]+)(?=\s*[,|-])/g);
            if (matches) {
                matches.forEach(m => {
                    const lower = m.toLowerCase();
                    const val = m.match(/[\d.,KkMm]+/)[0];
                    if (lower.includes('follower')) followersRaw = val;
                    if (lower.includes('following')) followingRaw = val;
                    if (lower.includes('post')) postsRaw = val;
                });
            }
            // Absolute fallback regex
            if (!followersRaw) followersRaw = metaDesc.match(/([\d.,KkMm]+)\s*Followers/i)?.[1];
            if (!postsRaw) postsRaw = metaDesc.match(/([\d.,KkMm]+)\s*Posts/i)?.[1];
        }

        // Layer 3: In-Page Selectors
        const findStat = (labels) => {
            const allSpans = Array.from(document.querySelectorAll('span, li, a, b, strong'));
            for (const label of labels) {
                const el = allSpans.find(e => e.innerText.toLowerCase().includes(label));
                if (el) {
                    const text = el.innerText.toLowerCase();
                    const value = text.split(label)[0].trim();
                    if (value && /[\d.,KkMm]/.test(value)) return value;
                    const childNum = el.querySelector('span, b, strong')?.innerText?.trim();
                    if (childNum) return childNum;
                }
            }
            return null;
        };

        if (!followersRaw) followersRaw = findStat(['followers']);
        if (!followingRaw) followingRaw = findStat(['following']);
        if (!postsRaw) postsRaw = findStat(['posts']);

        // Check for private
        const bodyText = document.body.innerText.toLowerCase();
        const isPrivate = bodyText.includes('this account is private') ||
            !!Array.from(document.querySelectorAll('h2')).find(h => h.innerText.toLowerCase().includes('private'));

        return {
            username: getText('header h2') || getText('h2') || usernameFallback,
            fullName: getText('header section h1') || getText('h1') || getText('header section > div:last-child h1'),
            biography: Array.from(document.querySelectorAll('header section div, main section div')).find(d => d.innerText.length > 5 && !d.querySelector('h1'))?.innerText?.trim(),
            externalUrl: getHref('header a[role="link"][target="_blank"]') || getHref('main a[role="link"][target="_blank"]'),
            profilePic: getSrc('header img') || getSrc('img[alt*="profile"]'),
            postsCountRaw: postsRaw,
            followersCountRaw: followersRaw,
            followingCountRaw: followingRaw,
            isPrivate,
            isVerified: !!document.querySelector('svg[aria-label="Verified"]'),
        };
    }, usernameFromUrl);

    // Normalize stats
    data.followersCount = parseIGNumber(data.followersCountRaw);
    data.followingCount = parseIGNumber(data.followingCountRaw);
    data.postsCount = parseIGNumber(data.postsCountRaw);

    log.info(`Extracted profile ${data.username}: ${data.followersCount} followers (Private: ${data.isPrivate})`);

    if (!data.isPrivate) {
        log.info('Enqueuing posts for deep scraping...');
        // Standard enqueuing
        const { enqueued } = await enqueueLinks({
            selector: 'a[href*="/p/"], a[href*="/reels/"]',
            label: 'POST',
            limit: 30,
        });

        // Brute force link discovery fallback
        if (enqueued === 0) {
            log.warning('Standard enqueuing found 0 posts. Attempting brute-force link discovery...');
            const manualLinks = await page.$$eval('a[href*="/p/"], a[href*="/reels/"]', (els) => els.map(a => a.href));
            log.info(`Found ${manualLinks.length} posts via brute-force. Adding to queue...`);
            for (const link of manualLinks.slice(0, 30)) {
                await Dataset.openRequestQueue().then(q => q.addRequest({ url: link, userData: { label: 'POST' } }));
            }
        } else {
            log.info(`Successfully enqueued ${enqueued} posts.`);
        }
    }

    await Dataset.pushData({
        type: 'profile',
        url,
        ...data,
        VIEW_PREMIUM_REPORT: `https://api.apify.com/v2/key-value-stores/${process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID}/records/REPORT.html`,
        scrapedAt: new Date().toISOString(),
    });
};

const handlePost = async ({ page, log, request }) => {
    log.info(`Scraping post: ${request.url}`);

    await page.waitForSelector('article', { timeout: 15000 }).catch(() => { });

    const postData = await page.evaluate(() => {
        const article = document.querySelector('article');

        // Improved caption finding: find the first meaningful span that's not in the header
        const spans = Array.from(article?.querySelectorAll('span') || []);
        const captionElement = spans.find(s => s.innerText.trim().length > 5 && !s.closest('header'));
        const caption = captionElement?.innerText?.trim();

        const timestamp = article?.querySelector('time')?.getAttribute('datetime');
        const images = Array.from(article?.querySelectorAll('img') || [])
            .map(img => img.src)
            .filter(src => !src.includes('profile') && !src.includes('150x150') && !src.includes('s150x150'));

        // Extract comments (first few visible)
        const comments = Array.from(document.querySelectorAll('ul li')).slice(1, 11).map(li => ({
            user: li.querySelector('h3, a')?.innerText?.trim(),
            text: li.querySelector('span:not([role])')?.innerText?.trim(),
        })).filter(c => c.user && c.text);

        const likesElement = Array.from(document.querySelectorAll('section span')).find(s => s.innerText.includes('likes') || s.innerText.includes('views'));

        return {
            caption,
            timestamp,
            images,
            likesRaw: likesElement?.innerText,
            owner: document.querySelector('header a')?.innerText?.trim(),
            comments,
        };
    });

    postData.likesCount = parseIGNumber(postData.likesRaw);

    await Dataset.pushData({
        type: 'post',
        url: request.url,
        ...postData,
        reportUrl: `https://api.apify.com/v2/key-value-stores/${process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID}/records/REPORT.html`,
        scrapedAt: new Date().toISOString(),
    });
};

const handleHashtag = async ({ page, log, request, enqueueLinks }) => {
    log.info(`Scraping hashtag: ${request.url}`);

    await page.waitForSelector('header h1', { timeout: 15000 }).catch(() => { });

    const tagInfo = await page.evaluate(() => {
        const postsSpan = Array.from(document.querySelectorAll('header span')).find(s => s.innerText.includes('posts'));
        return {
            tagName: document.querySelector('header h1')?.innerText,
            postsCountRaw: postsSpan?.innerText,
        };
    });

    tagInfo.postsCount = parseIGNumber(tagInfo.postsCountRaw);

    await enqueueLinks({
        selector: 'a[href*="/p/"]',
        label: 'POST',
        limit: 20,
    });

    await Dataset.pushData({
        type: 'hashtag',
        url: request.url,
        ...tagInfo,
        reportUrl: `https://api.apify.com/v2/key-value-stores/${process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID}/records/REPORT.html`,
        scrapedAt: new Date().toISOString(),
    });
};

const handleLocation = async ({ page, log, request, enqueueLinks }) => {
    log.info(`Scraping location: ${request.url}`);

    await page.waitForSelector('header h1', { timeout: 15000 }).catch(() => { });

    const locInfo = await page.evaluate(() => ({
        locationName: document.querySelector('header h1')?.innerText,
        address: document.querySelector('header address')?.innerText,
    }));

    await enqueueLinks({
        selector: 'a[href*="/p/"]',
        label: 'POST',
        limit: 20,
    });

    await Dataset.pushData({
        type: 'location',
        url: request.url,
        ...locInfo,
        reportUrl: `https://api.apify.com/v2/key-value-stores/${process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID}/records/REPORT.html`,
        scrapedAt: new Date().toISOString(),
    });
};
