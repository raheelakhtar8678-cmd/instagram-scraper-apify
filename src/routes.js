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
    await page.waitForTimeout(3000);

    // "Deep Scraping" - Scroll multiple times to trigger lazy loading
    log.info('Executing deep scroll for post discovery...');
    for (let i = 0; i < 5; i++) {
        await page.evaluate(() => window.scrollBy(0, 1200));
        await page.waitForTimeout(1000);
    }

    const data = await page.evaluate((usernameFallback) => {
        const getText = (selector) => document.querySelector(selector)?.innerText?.trim();
        const getHref = (selector) => document.querySelector(selector)?.getAttribute('href');
        const getSrc = (selector) => document.querySelector(selector)?.getAttribute('src');

        // Extract stats from Meta Tag (Ultra Reliable Fallback)
        const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
        // Format example: "13.5M Followers, 2,345 Following, 4,567 Posts - See Instagram photos and videos from..."
        const metaParts = metaDesc.split(' - ')[0].split(',');

        const findMetaStat = (label) => {
            const part = metaParts.find(p => p.toLowerCase().includes(label));
            return part ? part.trim().split(' ')[0] : null;
        };

        // Aggressive In-Page stat finding
        const findStat = (labels) => {
            const allSpans = Array.from(document.querySelectorAll('span, li, a'));
            for (const label of labels) {
                const el = allSpans.find(e => e.innerText.toLowerCase().includes(label));
                if (el) {
                    const text = el.innerText.toLowerCase();
                    const value = text.split(label)[0].trim();
                    if (value && /[\d.,KkMm]/.test(value)) return value;
                    const numberSpan = el.querySelector('span, b, strong');
                    if (numberSpan) return numberSpan.innerText.trim();
                }
            }
            return null;
        };

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
            postsCountRaw: findMetaStat('posts') || findStat(['posts']),
            followersCountRaw: findMetaStat('followers') || findStat(['followers']),
            followingCountRaw: findMetaStat('following') || findStat(['following']),
            isPrivate,
            isVerified: !!document.querySelector('svg[aria-label="Verified"]'),
            descriptionMeta: metaDesc
        };
    }, usernameFromUrl);

    // Normalize stats
    data.followersCount = parseIGNumber(data.followersCountRaw);
    data.followingCount = parseIGNumber(data.followingCountRaw);
    data.postsCount = parseIGNumber(data.postsCountRaw);

    log.info(`Extracted profile ${data.username}: ${data.followersCount} followers (Private: ${data.isPrivate})`);

    if (!data.isPrivate) {
        log.info('Enqueuing posts for deep scraping...');
        await enqueueLinks({
            selector: 'a[href*="/p/"], a[href*="/reels/"]',
            label: 'POST',
            limit: 30,
        });
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
