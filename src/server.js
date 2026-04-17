const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

let pool;
async function getPool() {
  if (!pool) { const { Pool } = require('pg'); pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false }); }
  return pool;
}
async function initDB() {
  try {
    const db = await getPool();
    await db.query(`
      CREATE TABLE IF NOT EXISTS clients (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, email VARCHAR(255) UNIQUE NOT NULL, channel_name VARCHAR(255), channel_id VARCHAR(100), niche VARCHAR(255), created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS client_dna (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE UNIQUE, tone VARCHAR(100), target_audience TEXT, content_pillars TEXT, brand_voice TEXT, competitors TEXT, keywords TEXT, extra_notes TEXT, youtube_api_key VARCHAR(200), channel_id VARCHAR(100), updated_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS content_tracker (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, title VARCHAR(500), niche VARCHAR(255), search_volume INTEGER DEFAULT 0, competition VARCHAR(50), suggested_angle TEXT, status VARCHAR(50) DEFAULT 'sugerido', created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS generated_content (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, video_topic TEXT, titles TEXT, description TEXT, chapters TEXT, tags TEXT, email_content TEXT, thumb_brief TEXT, thumb_prompt TEXT, roteiro TEXT, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS youtube_cache (id SERIAL PRIMARY KEY, cache_key VARCHAR(500) UNIQUE, data JSONB, cached_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS channel_reports (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, report_type VARCHAR(50), data JSONB, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS drafts (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, field_key VARCHAR(100) NOT NULL, content TEXT, updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(client_id, field_key));
      ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS roteiro TEXT;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS channel_id VARCHAR(100);
      ALTER TABLE client_dna ADD COLUMN IF NOT EXISTS youtube_api_key VARCHAR(200);
      ALTER TABLE client_dna ADD COLUMN IF NOT EXISTS channel_id VARCHAR(100);
    `);
    console.log('DB OK');
  } catch(e) { console.log('DB init error:', e.message); setTimeout(initDB, 5000); }
}
async function claudeCall(messages, systemPrompt = '', maxTokens = 4000) {
  const fetch = require('node-fetch');
  const resp = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: maxTokens, system: systemPrompt, messages }) });
  return resp.json();
}
async function youtubeGet(endpoint, params = {}, apiKey = null) {
  const fetch = require('node-fetch');
  const key = apiKey || process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error('YouTube API Key não configurada. Configure no DNA do cliente.');
  const qs = new URLSearchParams({ ...params, key });
  const resp = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`);
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}
async function getCached(db, cacheKey) {
  try { const r = await db.query("SELECT data FROM youtube_cache WHERE cache_key=$1 AND cached_at > NOW() - INTERVAL '6 hours'", [cacheKey]); return r.rows[0]?.data || null; } catch { return null; }
}
async function setCache(db, cacheKey, data) {
  try { await db.query("INSERT INTO youtube_cache (cache_key,data) VALUES ($1,$2) ON CONFLICT (cache_key) DO UPDATE SET data=$2, cached_at=NOW()", [cacheKey, JSON.stringify(data)]); } catch {}
}
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/clients', async (req, res) => { try { const db = await getPool(); res.json((await db.query('SELECT id,name,email,channel_name,channel_id,niche,created_at FROM clients ORDER BY created_at DESC')).rows); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/clients', async (req, res) => { const { name, email, channel_name, channel_id, niche } = req.body; try { const db = await getPool(); res.json((await db.query('INSERT INTO clients (name,email,channel_name,channel_id,niche) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, email, channel_name, channel_id||null, niche])).rows[0]); } catch(e) { res.status(500).json({ error: e.message }); } });
app.patch('/api/clients/:id', async (req, res) => { const { name, email, channel_name, channel_id, niche } = req.body; try { const db = await getPool(); res.json((await db.query('UPDATE clients SET name=$1,email=$2,channel_name=$3,channel_id=$4,niche=$5 WHERE id=$6 RETURNING *', [name, email, channel_name, channel_id||null, niche, req.params.id])).rows[0]); } catch(e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/clients/:id', async (req, res) => { try { const db = await getPool(); await db.query('DELETE FROM clients WHERE id=$1', [req.params.id]); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/clients/:id/dna', async (req, res) => { try { const db = await getPool(); res.json((await db.query('SELECT * FROM client_dna WHERE client_id=$1', [req.params.id])).rows[0] || null); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/clients/:id/dna', async (req, res) => {
  const { tone, target_audience, content_pillars, brand_voice, competitors, keywords, extra_notes, youtube_api_key, channel_id } = req.body;
  try {
    const db = await getPool();
    const r = await db.query(`INSERT INTO client_dna (client_id,tone,target_audience,content_pillars,brand_voice,competitors,keywords,extra_notes,youtube_api_key,channel_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (client_id) DO UPDATE SET tone=$2,target_audience=$3,content_pillars=$4,brand_voice=$5,competitors=$6,keywords=$7,extra_notes=$8,youtube_api_key=$9,channel_id=$10,updated_at=NOW() RETURNING *`, [req.params.id, tone, target_audience, content_pillars, brand_voice, competitors, keywords, extra_notes, youtube_api_key||null, channel_id||null]);
    if (channel_id) await db.query('UPDATE clients SET channel_id=$1 WHERE id=$2', [channel_id, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/clients/:id/tracker', async (req, res) => { try { const db = await getPool(); res.json((await db.query('SELECT * FROM content_tracker WHERE client_id=$1 ORDER BY created_at DESC', [req.params.id])).rows); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/clients/:id/tracker', async (req, res) => { const { title, niche, search_volume, competition, suggested_angle } = req.body; try { const db = await getPool(); res.json((await db.query('INSERT INTO content_tracker (client_id,title,niche,search_volume,competition,suggested_angle) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [req.params.id, title, niche, search_volume||0, competition, suggested_angle])).rows[0]); } catch(e) { res.status(500).json({ error: e.message }); } });
app.patch('/api/tracker/:id', async (req, res) => { try { const db = await getPool(); res.json((await db.query('UPDATE content_tracker SET status=$1 WHERE id=$2 RETURNING *', [req.body.status, req.params.id])).rows[0]); } catch(e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/tracker/:id', async (req, res) => { try { const db = await getPool(); await db.query('DELETE FROM content_tracker WHERE id=$1', [req.params.id]); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/clients/:id/content', async (req, res) => { try { const db = await getPool(); res.json((await db.query('SELECT * FROM generated_content WHERE client_id=$1 ORDER BY created_at DESC LIMIT 50', [req.params.id])).rows); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/clients/:id/content', async (req, res) => { const { video_topic, titles, description, chapters, tags, email_content, thumb_brief, thumb_prompt, roteiro } = req.body; try { const db = await getPool(); res.json((await db.query('INSERT INTO generated_content (client_id,video_topic,titles,description,chapters,tags,email_content,thumb_brief,thumb_prompt,roteiro) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [req.params.id, video_topic, titles, description, chapters, tags, email_content, thumb_brief, thumb_prompt, roteiro||null])).rows[0]); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/clients/:id/drafts', async (req, res) => { try { const db = await getPool(); const r = await db.query('SELECT field_key, content, updated_at FROM drafts WHERE client_id=$1', [req.params.id]); const drafts = {}; r.rows.forEach(row => { drafts[row.field_key] = { content: row.content, updated_at: row.updated_at }; }); res.json(drafts); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/clients/:id/drafts', async (req, res) => { const { field_key, content } = req.body; if (!field_key) return res.status(400).json({ error: 'field_key required' }); try { const db = await getPool(); await db.query("INSERT INTO drafts (client_id,field_key,content) VALUES ($1,$2,$3) ON CONFLICT (client_id,field_key) DO UPDATE SET content=$3,updated_at=NOW()", [req.params.id, field_key, content]); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/clients/:id/drafts', async (req, res) => { try { const db = await getPool(); await db.query('DELETE FROM drafts WHERE client_id=$1', [req.params.id]); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/clients/:id/youtube/key-status', async (req, res) => { try { const db = await getPool(); const dna = await db.query('SELECT youtube_api_key FROM client_dna WHERE client_id=$1', [req.params.id]); res.json({ hasKey: !!(dna.rows[0]?.youtube_api_key || process.env.YOUTUBE_API_KEY), source: dna.rows[0]?.youtube_api_key ? 'client_dna' : process.env.YOUTUBE_API_KEY ? 'global_env' : 'none' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/clients/:id/youtube/channel', async (req, res) => {
  try {
    const db = await getPool();
    const client = (await db.query('SELECT * FROM clients WHERE id=$1', [req.params.id])).rows[0];
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const dnaRow = await db.query('SELECT youtube_api_key, channel_id FROM client_dna WHERE client_id=$1', [req.params.id]);
    const clientYtKey = dnaRow.rows[0]?.youtube_api_key || null;
    let chId = dnaRow.rows[0]?.channel_id || client.channel_id;
    const channel_name = client.channel_name;
    if (!chId && !channel_name) return res.status(400).json({ error: 'Configure o Channel ID no DNA do cliente' });
    const cacheKey = 'channel_' + (chId || channel_name);
    const cached = await getCached(db, cacheKey);
    if (cached) return res.json({ ...cached, fromCache: true });
    if (!chId) { const search = await youtubeGet('search', { q: channel_name, type: 'channel', part: 'id', maxResults: 1 }, clientYtKey); chId = search.items?.[0]?.id?.channelId; if (!chId) return res.status(404).json({ error: 'Canal não encontrado' }); await db.query('UPDATE clients SET channel_id=$1 WHERE id=$2', [chId, req.params.id]); }
    const [chData, videosData] = await Promise.all([youtubeGet('channels', { id: chId, part: 'snippet,statistics', maxResults: 1 }, clientYtKey), youtubeGet('search', { channelId: chId, part: 'id', order: 'viewCount', type: 'video', maxResults: 10 }, clientYtKey)]);
    const ch = chData.items?.[0];
    if (!ch) return res.status(404).json({ error: 'Dados do canal não encontrados' });
    const videoIds = videosData.items?.map(v => v.id?.videoId).filter(Boolean).join(',');
    let topVideos = [];
    if (videoIds) { const vData = await youtubeGet('videos', { id: videoIds, part: 'snippet,statistics', maxResults: 10 }, clientYtKey); topVideos = (vData.items||[]).map(v => ({ id: v.id, title: v.snippet.title, views: parseInt(v.statistics.viewCount||0), likes: parseInt(v.statistics.likeCount||0), comments: parseInt(v.statistics.commentCount||0), publishedAt: v.snippet.publishedAt, thumbnail: v.snippet.thumbnails?.medium?.url })).sort((a,b)=>b.views-a.views); }
    const result = { channelId: chId, title: ch.snippet.title, description: ch.snippet.description, thumbnail: ch.snippet.thumbnails?.high?.url, stats: { subscribers: parseInt(ch.statistics.subscriberCount||0), views: parseInt(ch.statistics.viewCount||0), videos: parseInt(ch.statistics.videoCount||0) }, topVideos, avgViewsTop10: topVideos.length ? Math.round(topVideos.reduce((a,v)=>a+v.views,0)/topVideos.length) : 0 };
    await setCache(db, cacheKey, result);
    await db.query('INSERT INTO channel_reports (client_id,report_type,data) VALUES ($1,$2,$3)', [req.params.id, 'channel_analysis', JSON.stringify(result)]);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/clients/:id/youtube/ai-analysis', async (req, res) => {
  try {
    const db = await getPool();
    const [clientR, dnaR] = await Promise.all([db.query('SELECT * FROM clients WHERE id=$1',[req.params.id]), db.query('SELECT * FROM client_dna WHERE client_id=$1',[req.params.id])]);
    const client = clientR.rows[0]; const dna = dnaR.rows[0]; const { channelData } = req.body;
    const prompt = `Analyze this YouTube channel and provide strategic insights in Portuguese (Brazil).\nChannel: ${channelData.title} | Subscribers: ${channelData.stats.subscribers.toLocaleString()} | Views: ${channelData.stats.views.toLocaleString()} | Videos: ${channelData.stats.videos}\nTop Videos: ${channelData.topVideos.slice(0,5).map((v,i)=>`${i+1}. "${v.title}" ${v.views.toLocaleString()} views`).join(' | ')}\nClient: niche=${client.niche||'N/A'}, keywords=${dna?.keywords||'N/A'}\nReturn JSON only: {"health_score":75,"health_label":"Bom","growth_status":"Em crescimento","engagement_rate":"4.2%","strengths":["p1","p2","p3"],"weaknesses":["p1"],"opportunities":["o1","o2","o3"],"recommended_topics":["t1","t2","t3","t4","t5"],"posting_frequency":"2x/semana","seo_gaps":["g1","g2"],"next_actions":["a1","a2","a3"]}`;
    const data = await claudeCall([{ role:'user', content: prompt }], '', 2000);
    res.json(JSON.parse(data.content[0].text.replace(/```json|```/g,'').trim()));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/youtube/benchmark', async (req, res) => {
  try {
    const { niche, keywords, client_id } = req.body;
    if (!niche) return res.status(400).json({ error: 'niche required' });
    let benchYtKey = null;
    if (client_id) { try { const db2 = await getPool(); const dnaK = await db2.query('SELECT youtube_api_key FROM client_dna WHERE client_id=$1', [client_id]); benchYtKey = dnaK.rows[0]?.youtube_api_key || null; } catch {} }
    const db = await getPool();
    const cacheKey = ('benchmark_'+niche+'_'+(keywords||'')).toLowerCase().replace(/\s+/g,'_');
    const cached = await getCached(db, cacheKey);
    if (cached) return res.json({ ...cached, fromCache: true });
    const query = keywords ? niche+' '+keywords : niche;
    const [topVideos, trendingVideos] = await Promise.all([youtubeGet('search', { q: query, part: 'id', order: 'viewCount', type: 'video', maxResults: 10, relevanceLanguage: 'en', regionCode: 'US' }, benchYtKey), youtubeGet('search', { q: query, part: 'id', order: 'date', type: 'video', maxResults: 5, publishedAfter: new Date(Date.now()-30*24*60*60*1000).toISOString() }, benchYtKey)]);
    const allIds = [...(topVideos.items||[]).map(v=>v.id?.videoId),...(trendingVideos.items||[]).map(v=>v.id?.videoId)].filter(Boolean);
    const vDetails = allIds.length ? await youtubeGet('videos', { id: allIds.join(','), part: 'snippet,statistics', maxResults: 15 }, benchYtKey) : { items: [] };
    const videos = (vDetails.items||[]).map(v => ({ id: v.id, title: v.snippet.title, channel: v.snippet.channelTitle, views: parseInt(v.statistics.viewCount||0), likes: parseInt(v.statistics.likeCount||0) })).sort((a,b)=>b.views-a.views);
    const avgViews = Math.round(videos.slice(0,10).reduce((a,v)=>a+v.views,0)/(videos.slice(0,10).length||1));
    const aiPrompt = `YouTube SEO expert. Niche: "${niche}" keywords: ${keywords||'none'}.\nTop videos: ${videos.slice(0,6).map((v,i)=>`${i+1}. "${v.title}" by ${v.channel} ${v.views.toLocaleString()} views`).join(' | ')}\nReturn ENGLISH ONLY JSON: {"niche_overview":"...","market_size":"...","avg_views_top10":${avgViews},"top_channels":[{"name":"...","strength":"..."}],"winning_title_patterns":["p1","p2","p3","p4"],"trending_topics":["t1","t2","t3","t4","t5"],"content_formats":["f1","f2","f3"],"best_keywords":["k1","k2","k3","k4","k5","k6"],"audience_demographics":"...","competition_level":"Medium","entry_difficulty":"Moderate","monetization_potential":"High","growth_trend":"Growing","opportunities":["o1","o2","o3"],"threats":["t1","t2"],"recommended_strategy":"...","content_cadence":"..."}`;
    const aiData = await claudeCall([{ role:'user', content: aiPrompt }], '', 2500);
    const analysis = JSON.parse(aiData.content[0].text.replace(/```json|```/g,'').trim());
    const result = { niche, query, topVideos: videos.slice(0,10), analysis, generatedAt: new Date().toISOString() };
    await setCache(db, cacheKey, result);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/generate', async (req, res) => { try { res.json(await claudeCall(req.body.messages, req.body.system||'', 4000)); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/config/status', (req, res) => { res.json({ anthropic: !!process.env.ANTHROPIC_API_KEY, youtube: !!process.env.YOUTUBE_API_KEY }); });
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.listen(PORT, async () => { console.log(`Studio 1i porta ${PORT}`); await initDB(); });
