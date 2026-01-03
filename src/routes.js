import { createPlaywrightRouter, Dataset } from 'crawlee';
import { Actor } from 'apify';

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
        const bodyText = document.body.innerText.toLowerCase();
        return h2s.some(h => h.innerText.toLowerCase().includes('log in') || h.innerText.toLowerCase().includes('sign up')) ||
            bodyText.includes('log in to see') || bodyText.includes('sign up to see');
    });

    if (isLogin) {
        log.error('Hit login wall. This runner is being blocked. Cookies are highly recommended.');
        // Save screenshot for login wall
        const screenshotBuf = await page.screenshot().catch(() => null);
        if (screenshotBuf) await Actor.setValue('LOGIN_WALL_SCREENSHOT', screenshotBuf, { contentType: 'image/png' });
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
    const cookieButton = await page.$('button:has-text("Allow all cookies"), button:has-text("Decline optional cookies"), button:has-text("Accept")');
    if (cookieButton) await cookieButton.click().catch(() => { });

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

    // Resilient Wait: Initially wait for the page to be meaningful
    await page.waitForTimeout(4000);

    // Skeleton Detection & Reload Strategy
    const isSkeleton = await page.evaluate(() => {
        const text = document.body.innerText.trim();
        return text.length < 200 || text.toLowerCase().includes('loading');
    });

    if (isSkeleton) {
        log.warning('Detected skeleton page. Attempting refresh to force hydration...');
        await page.reload({ waitUntil: 'networkidle' }).catch(() => { });
        await page.waitForTimeout(6000);
    }

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

    // Ultimate Fallback for Stats: Scrape from raw HTML
    if (!data.followersCountRaw || data.followersCountRaw === '0') {
        const content = await page.content();
        const followersMatch = content.match(/"edge_followed_by":\s*\{\s*"count":\s*(\d+)/) || content.match(/"followers_count":\s*(\d+)/);
        const postsMatch = content.match(/"edge_owner_to_timeline_media":\s*\{\s*"count":\s*(\d+)/) || content.match(/"media_count":\s*(\d+)/);
        if (followersMatch) data.followersCountRaw = followersMatch[1];
        if (postsMatch) data.postsCountRaw = postsMatch[1];
    }

    // Normalize stats
    data.followersCount = parseIGNumber(data.followersCountRaw);
    data.followingCount = parseIGNumber(data.followingCountRaw);
    data.postsCount = parseIGNumber(data.postsCountRaw);

    log.info(`Extracted profile ${data.username}: ${data.followersCount} followers (Private: ${data.isPrivate})`);

    // Diagnostic on failure
    if (data.followersCount === 0 && !data.isPrivate) {
        log.error('FAILED TO EXTRACT STATS on public profile. Saving diagnostic screenshot...');
        const screenshotBuf = await page.screenshot({ fullPage: true }).catch(() => null);
        if (screenshotBuf) await Actor.setValue('DIAGNOSTIC_SCREENSHOT', screenshotBuf, { contentType: 'image/png' });
    }

    if (!data.isPrivate) {
        log.info('Enqueuing posts for deep scraping...');
        // Standard enqueuing
        const { processedRequests } = await enqueueLinks({
            selector: 'a[href*="/p/"], a[href*="/reels/"]',
            label: 'POST',
            limit: 30,
        });

        const enqueuedCount = processedRequests?.length || 0;

        // BRUTE FORCE LINK HARVESTING (Layer 4)
        if (enqueuedCount === 0) {
            log.warning('Standard enqueuing found 0 posts. Harvesting links from raw HTML...');
            const html = await page.content();
            // Regex to find all /p/CODE/ or instagram.com/p/CODE/ links
            const postPattern = /\/(?:p|reels|reels\/audio|stories)\/([\w_-]{5,15})\//g;
            const discoveredCodes = new Set();
            let match;
            while ((match = postPattern.exec(html)) !== null) {
                discoveredCodes.add(match[1]);
            }

            const discoveredUrls = Array.from(discoveredCodes).map(code => `https://www.instagram.com/p/${code}/`);
            log.info(`Harvested ${discoveredUrls.length} post candidate URLs from raw HTML. Enqueuing...`);

            if (discoveredUrls.length > 0) {
                await enqueueLinks({
                    urls: discoveredUrls.slice(0, 30),
                    label: 'POST',
                });
            } else {
                log.error('Even raw HTML harvesting found 0 posts. Saving raw dump for debugging...');
                await Actor.setValue('RAW_HTML_DUMP', html, { contentType: 'text/html' });
            }
        } else {
            log.info(`Successfully enqueued ${enqueuedCount} posts.`);
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
