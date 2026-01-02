# Instagram Scraper Pro - Premium Apify Actor

A powerful, high-performance Instagram scraper designed for professional data extraction. Scrape profiles, posts, hashtags, and more with ease.

## 🚀 Features

- **Profile Scraping**: Get bio, follower counts, following, posts count, and more.
- **Post & Reel Extraction**: Download captions, timestamps, images, and engagement stats.
- **Location & Place Analytics**: Scrape location-specific posts and reach.
- **Hashtag Tracking**: Analyze tags to see top posts and total reach.
- **Premium Analytics Report**: Automatically generates a stunning HTML dashboard (saved to Key-Value Store).
- **Infinite Scroll Support**: Automatically loads more content for deep dives.
- **Deep Error Recovery**: Detects "Something went wrong" or login walls and recovers gracefully.
- **Login via Cookies**: Robust support for session-based scraping to bypass blocks.
- **Proxy Ready**: Built-in support for Apify Proxy (Residential recommended).


## 🛠️ How to Use

1.  **Input URLs**: Provide profile, post, or hashtag URLs in the `Start URLs` field.
2.  **Search**: (Optional) Enter a search query to find relevant tags/profiles.
3.  **Authentication**: For best results, use an extension (like "EditThisCookie") to export your Instagram cookies and paste them into the `Login Cookies` input.
4.  **Run**: Click "Start" and watch the data come in.

## 📊 Output

Data is saved to a **Dataset** in JSON format.
Additionally, check the **Key-Value Store** for a file named `REPORT.html` to see a beautiful visual summary of your run.

## 💡 Why this scraper?

Unlike basic scrapers, **Instagram Scraper Pro** focus on data quality and user experience. The integrated HTML report gives you an instant "miles better" visualization of your results without needing external tools.

## 🛡️ Best Practices

- Use **Residential Proxies** for high-volume scraping.
- Avoid scraping the same profile too fast; set the `Max Results` limit reasonably.
- Use cookies to browse as a logged-in user if you need to access private data or avoid "login required" redirects.
