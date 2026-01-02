import { Actor } from 'apify';

export async function generateReport() {
    console.log('Generating premium HTML report...');
    const dataset = await Actor.openDataset();
    const { items } = await dataset.getData();

    const stats = {
        profiles: items.filter(i => i.type === 'profile').length,
        posts: items.filter(i => i.type === 'post').length,
        hashtags: items.filter(i => i.type === 'hashtag').length,
        locations: items.filter(i => i.type === 'location').length,
        totalFollowers: items.filter(i => i.type === 'profile').reduce((acc, p) => acc + (p.followersCount || 0), 0),
        totalLikes: items.filter(i => i.type === 'post').reduce((acc, p) => acc + (p.likesCount || 0), 0)
    };

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Instagram Scraper Pro - Analytics Report</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --primary: #FF3040;
            --secondary: #8E2DE2;
            --bg: #0f172a;
            --card-bg: rgba(30, 41, 59, 0.7);
            --text: #f8fafc;
        }
        body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
            color: var(--text);
            margin: 0;
            padding: 2rem;
            min-height: 100vh;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 3rem;
            padding: 1.5rem;
            background: var(--card-bg);
            backdrop-filter: blur(12px);
            border-radius: 24px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1.5rem;
            margin-bottom: 3rem;
        }
        .stat-card {
            background: var(--card-bg);
            padding: 1.5rem;
            border-radius: 24px;
            text-align: center;
            border: 1px solid rgba(255, 255, 255, 0.1);
            transition: transform 0.3s ease;
        }
        .stat-card:hover { transform: translateY(-5px); }
        .stat-value { font-size: 2rem; font-weight: 800; color: var(--primary); }
        .stat-label { color: #94a3b8; font-size: 0.8rem; margin-top: 0.5rem; text-transform: uppercase; letter-spacing: 1px; }
        
        .grid { display: grid; grid-template-columns: 2fr 1fr; gap: 2rem; }
        .card {
            background: var(--card-bg);
            padding: 2rem;
            border-radius: 24px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            overflow-x: auto;
        }
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
        th { text-align: left; color: #94a3b8; padding: 1rem; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
        td { padding: 1rem; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
        .profile-pic { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; }
        
        .badge {
            padding: 0.25rem 0.75rem;
            border-radius: 99px;
            font-size: 0.8rem;
            background: rgba(255, 48, 64, 0.2);
            color: var(--primary);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1 style="margin:0; font-size: 1.8rem;">Instagram Scraper Pro</h1>
                <p style="margin:0; color: #94a3b8;">Enhanced Analytics & Data Dashboard</p>
            </div>
            <div class="badge">v0.2 Enterprise</div>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value">${stats.profiles}</div>
                <div class="stat-label">Profiles</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.posts}</div>
                <div class="stat-label">Posts</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.hashtags}</div>
                <div class="stat-label">Hashtags</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.locations}</div>
                <div class="stat-label">Locations</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.totalFollowers.toLocaleString()}</div>
                <div class="stat-label">Total Reach</div>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <h2>Entity Overview</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Name/User</th>
                            <th>Type</th>
                            <th>Metrics</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${items.slice(0, 15).map(i => `
                            <tr>
                                <td style="display:flex; align-items:center; gap:1rem;">
                                    ${i.profilePic ? `<img src="${i.profilePic}" class="profile-pic" onerror="this.src='https://via.placeholder.com/40'">` : ''}
                                    <span>${i.username || i.tagName || i.locationName || i.url.split('/').pop()}</span>
                                </td>
                                <td><span style="opacity:0.7">${i.type}</span></td>
                                <td>${i.followersCount ? i.followersCount.toLocaleString() + ' followers' : (i.likesCount ? i.likesCount.toLocaleString() + ' likes' : '-')}</td>
                                <td><span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #10b981;">Scraped</span></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            <div class="card">
                <h2>Distribution</h2>
                <canvas id="contentChart"></canvas>
                <div style="margin-top: 2rem; padding: 1rem; background: rgba(0,0,0,0.2); border-radius: 12px;">
                    <h4 style="margin:0; color: var(--primary);">System Status</h4>
                    <p style="font-size: 0.8rem; color: #94a3b8; margin-bottom: 0;">Resilient Engine Active</p>
                    <p style="font-size: 0.8rem; color: #94a3b8; margin-top: 4px;">Proxy Rotation Enabled</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        const ctx = document.getElementById('contentChart').getContext('2d');
        new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Profiles', 'Posts', 'Hashtags', 'Locations'],
                datasets: [{
                    data: [${stats.profiles}, ${stats.posts}, ${stats.hashtags}, ${stats.locations}],
                    backgroundColor: ['#FF3040', '#8E2DE2', '#22D3EE', '#F59E0B'],
                    borderWidth: 0
                }]
            },
            options: {
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { color: '#f8fafc', font: { family: 'Plus Jakarta Sans'} }
                    }
                }
            }
        });
    </script>
</body>
</html>
    `;

    await Actor.setValue('REPORT', html, { contentType: 'text/html' });
    console.log('Enhanced Premium Report saved to Key-Value Store as REPORT.html');
}
