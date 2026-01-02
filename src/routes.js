import { createPlaywrightRouter, Dataset } from 'crawlee';

export const router = createPlaywrightRouter();

// Helper to normalize IG numbers (e.g. 1.2k -> 1200)
const parseIGNumber = (str) => {
    if (!str) return 0;
    const cleanStr = str.replace(/,/g, '').toLowerCase();
    if (cleanStr.includes('k')) return parseFloat(cleanStr) * 1000;
    if (cleanStr.includes('m')) return parseFloat(cleanStr) * 1000000;
    return parseInt(cleanStr.replace(/[^0-9]/g, '')) || 0;
};

router.addDefaultHandler(async ({ page, log, request, enqueueLinks }) => {
    log.info(`Processing ${request.url}`);

    // Check for login wall or rate limiting
    const loginWall = await page.$('h2:has-text("Log in to Instagram")');
    if (loginWall) {
        log.error('Hit login wall. Suggesting session cookies in input.');
        throw new Error('LOGIN_REQUIRED');
    }

    // Check for "Something went wrong"
    const errorText = await page.$('text="Something went wrong"');
    if (errorText) {
        log.error('Instagram reported an error. Retrying...');
        throw new Error('INSTAGRAM_ERROR');
    }

    // Check for cookie consent
    const cookieButton = await page.$('button:has-text("Allow all cookies")');
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
    log.info(`Scraping profile: ${url}`);

    await page.waitForSelector('header', { timeout: 15000 }).catch(() => { });

    const data = await page.evaluate(() => {
        const getText = (selector) => document.querySelector(selector)?.innerText?.trim();
        const getHref = (selector) => document.querySelector(selector)?.getAttribute('href');
        const getSrc = (selector) => document.querySelector(selector)?.getAttribute('src');

        return {
            username: getText('header h2'),
            fullName: getText('header section > div:nth-child(2) span'),
            biography: getText('header section > div:nth-child(3) span'),
            externalUrl: getHref('header section > div:nth-child(3) a'),
            profilePic: getSrc('header img'),
            postsCountRaw: getText('header ul li:nth-child(1) span'),
            followersCountRaw: getText('header ul li:nth-child(2) span'),
            followingCountRaw: getText('header ul li:nth-child(3) span'),
            isPrivate: !!Array.from(document.querySelectorAll('h2')).find(h => h.innerText.includes('This account is private')),
            isVerified: !!document.querySelector('header h2 svg[aria-label="Verified"]'),
        };
    });

    // Normalize stats
    data.followersCount = parseIGNumber(data.followersCountRaw);
    data.followingCount = parseIGNumber(data.followingCountRaw);
    data.postsCount = parseIGNumber(data.postsCountRaw);

    log.info(`Extracted profile ${data.username}: ${data.followersCount} followers`);

    if (!data.isPrivate) {
        await enqueueLinks({
            selector: 'a[href*="/p/"]',
            label: 'POST',
            limit: 15,
        });
    }

    await Dataset.pushData({
        type: 'profile',
        url,
        ...data,
        scrapedAt: new Date().toISOString(),
    });
};

const handlePost = async ({ page, log, request }) => {
    log.info(`Scraping post: ${request.url}`);

    await page.waitForSelector('article', { timeout: 15000 }).catch(() => { });

    const postData = await page.evaluate(() => {
        const getText = (selector) => document.querySelector(selector)?.innerText?.trim();

        const article = document.querySelector('article');
        const caption = article?.querySelector('h1')?.innerText || article?.querySelector('div[role="button"] + div span')?.innerText;
        const timestamp = article?.querySelector('time')?.getAttribute('datetime');
        const images = Array.from(article?.querySelectorAll('img') || []).map(img => img.src).filter(src => !src.includes('profile'));

        // Extract comments (first few visible)
        const comments = Array.from(document.querySelectorAll('ul li:not(:first-child)')).slice(0, 10).map(li => ({
            user: li.querySelector('h3')?.innerText,
            text: li.querySelector('span:not([role])')?.innerText,
        })).filter(c => c.user && c.text);

        const likesElement = Array.from(document.querySelectorAll('section span')).find(s => s.innerText.includes('likes') || s.innerText.includes('views'));

        return {
            caption,
            timestamp,
            images,
            likesRaw: likesElement?.innerText,
            owner: document.querySelector('header a')?.innerText,
            comments,
        };
    });

    postData.likesCount = parseIGNumber(postData.likesRaw);

    await Dataset.pushData({
        type: 'post',
        url: request.url,
        ...postData,
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
        scrapedAt: new Date().toISOString(),
    });
};
