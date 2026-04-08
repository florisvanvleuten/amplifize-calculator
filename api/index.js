/**
 * Amplifize Calculator — Unified API
 * POST /api/index
 *
 * type: "keywords" → Google Ads API keyword research + Claude AI funnel keywords
 * type: "lead"     → Save lead to Google Sheets + email notification
 */

// ─── CORS ─────────────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ─── GOOGLE ADS — KEYWORD IDEAS ───────────────────────────────────────────────
async function fetchGoogleAdsKeywords(seedKeywords, country) {
  const GEO_TARGETS = {
    NL:'2528', US:'2840', UK:'2826', DE:'2276',
    AU:'2036', CA:'2124', FR:'2250', BE:'2056', ES:'2724', IT:'2380',
  };

  // Step 1: get access token from refresh token
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  const { access_token } = await tokenResp.json();
  if (!access_token) throw new Error('Failed to get Google access token');

  // Step 2: call KeywordPlanIdea service
  const customerId = process.env.GOOGLE_CUSTOMER_ID.replace(/-/g, '');
  const geoTarget  = GEO_TARGETS[country] || '2840';

  const resp = await fetch(
    `https://googleads.googleapis.com/v16/customers/${customerId}:generateKeywordIdeas`,
    {
      method: 'POST',
      headers: {
        'Authorization':           `Bearer ${access_token}`,
        'developer-token':         process.env.GOOGLE_DEVELOPER_TOKEN,
        'login-customer-id':       customerId,
        'Content-Type':            'application/json',
      },
      body: JSON.stringify({
        keywordSeed:        { keywords: seedKeywords },
        geoTargetConstants: [`geoTargetConstants/${geoTarget}`],
        language:           'languageConstants/1000',
        keywordPlanNetwork: 'GOOGLE_SEARCH',
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Google Ads API error: ${err}`);
  }

  const data    = await resp.json();
  const results = data.results || [];
  if (!results.length) return null;

  const cpcs = results
    .map(r => r.keywordIdeaMetrics?.averageCpcMicros)
    .filter(Boolean)
    .map(v => v / 1_000_000);

  const avgCpc = cpcs.length
    ? cpcs.reduce((a, b) => a + b, 0) / cpcs.length
    : null;

  return {
    avgCpc:       avgCpc ? Math.round(avgCpc * 100) / 100 : null,
    keywordCount: results.length,
    topKeywords:  results
      .sort((a, b) =>
        (b.keywordIdeaMetrics?.avgMonthlySearches || 0) -
        (a.keywordIdeaMetrics?.avgMonthlySearches || 0)
      )
      .slice(0, 15)
      .map(r => ({
        keyword: r.text,
        volume:  r.keywordIdeaMetrics?.avgMonthlySearches || 0,
        cpc:     (r.keywordIdeaMetrics?.averageCpcMicros || 0) / 1_000_000,
        competition: r.keywordIdeaMetrics?.competition || 'UNKNOWN',
      })),
  };
}

// ─── SITE CRAWLER ─────────────────────────────────────────────────────────────
async function crawlSite(url) {
  if (!url) return '';
  try {
    const resp = await Promise.race([
      fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AmplifizeBot/1.0)' },
      }),
      new Promise((_, reject) => setTimeout(() => reject(), 5000)),
    ]);
    const html = await resp.text();
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);
  } catch {
    return '';
  }
}

// ─── CLAUDE AI KEYWORDS ───────────────────────────────────────────────────────
async function generateClaudeKeywords(nicheName, country, url, siteContent, googleKeywords) {
  const googleContext = googleKeywords?.topKeywords?.length
    ? `Real Google Ads keyword data for this market:\n${googleKeywords.topKeywords.map(k => `- "${k.keyword}" (${k.volume}/mo searches, €${k.cpc.toFixed(2)} CPC)`).join('\n')}`
    : '';

  const siteContext = siteContent
    ? `Website content:\n"""\n${siteContent}\n"""`
    : url ? `Website URL (could not crawl): ${url}` : '';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{
        role:    'user',
        content: `You are a Google Ads keyword strategist for ecommerce.

${siteContext}

${googleContext}

Niche: ${nicheName}
Country: ${country}

Generate exactly 15 specific Google Ads search keywords — 5 per funnel stage.
- Write real keywords shoppers actually type, no placeholders
- Use brand/product signals from website content where available
- Prioritise high-intent terms from the Google data where available
- Max 6 words per keyword

Respond ONLY with this exact JSON, nothing else:
{"tof":["kw1","kw2","kw3","kw4","kw5"],"mof":["kw1","kw2","kw3","kw4","kw5"],"bof":["kw1","kw2","kw3","kw4","kw5"]}

TOF = awareness, broad informational, discovery
MOF = comparison, reviews, "best X for Y"
BOF = purchase intent, buy now, brand + transactional`,
      }],
    }),
  });

  if (!resp.ok) throw new Error('Claude API error');
  const data = await resp.json();
  const raw  = data.content?.[0]?.text?.trim() || '';
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── GOOGLE SHEETS ────────────────────────────────────────────────────────────
async function saveToSheets(lead) {
  const sheetsUrl = process.env.SHEETS_WEBHOOK_URL;
  if (!sheetsUrl) return;
  try {
    await fetch(sheetsUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(lead),
    });
  } catch (err) {
    console.error('Sheets error:', err.message);
  }
}

// ─── EMAIL ────────────────────────────────────────────────────────────────────
async function sendNotificationEmail(lead) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;

  try {
    await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'Amplifize Calculator <calculator@amplifize.nl>',
        to:      ['floris@amplifize.nl'],
        subject: `🎯 New lead: ${lead.firstName} — ${lead.niche} — €${lead.budget}/mo`,
        html: `
          <div style="font-family:sans-serif;max-width:500px;color:#0f1117;">
            <img src="https://framerusercontent.com/images/YuaGQ7LdU0LThop11K2XxberfY.png?width=800"
                 style="height:28px;margin-bottom:20px;" alt="Amplifize">
            <h2 style="font-size:18px;margin-bottom:16px;">New calculator lead 🎉</h2>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr><td style="padding:6px 0;color:#5a5e72;width:140px;">Name</td><td><strong>${lead.firstName}</strong></td></tr>
              <tr><td style="padding:6px 0;color:#5a5e72;">Email</td><td><a href="mailto:${lead.email}">${lead.email}</a></td></tr>
              <tr><td style="padding:6px 0;color:#5a5e72;">Phone</td><td>${lead.phone || '—'}</td></tr>
              <tr><td style="padding:6px 0;color:#5a5e72;">Website</td><td>${lead.websiteUrl || '—'}</td></tr>
              <tr><td style="padding:6px 0;color:#5a5e72;">Niche</td><td>${lead.niche}</td></tr>
              <tr><td style="padding:6px 0;color:#5a5e72;">Country</td><td>${lead.country}</td></tr>
              <tr><td style="padding:6px 0;color:#5a5e72;">Budget/mo</td><td><strong>€${Number(lead.budget).toLocaleString()}</strong></td></tr>
              <tr><td style="padding:6px 0;color:#5a5e72;">AOV</td><td>€${Number(lead.aov).toLocaleString()}</td></tr>
              <tr style="background:#eef0ff;">
                <td style="padding:8px;color:#597aff;font-weight:600;">Est. Revenue</td>
                <td style="padding:8px;font-size:20px;font-weight:700;color:#3d5ce0;">€${Number(lead.revenue).toLocaleString()}</td>
              </tr>
              <tr><td style="padding:6px 0;color:#5a5e72;">ROAS</td><td><strong>${lead.roas}x</strong></td></tr>
              <tr><td style="padding:6px 0;color:#5a5e72;">Clicks</td><td>${Number(lead.clicks).toLocaleString()}</td></tr>
              <tr><td style="padding:6px 0;color:#5a5e72;">Conversions</td><td>${Number(lead.conversions).toLocaleString()}</td></tr>
            </table>
            <div style="margin-top:24px;">
              <a href="https://link.advenz.nl/widget/booking/LvW4XebnT8tDmXPassQj"
                 style="background:#597aff;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;">
                Book a call with ${lead.firstName} →
              </a>
            </div>
          </div>`,
      }),
    });
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};

  // ── KEYWORDS ──
  if (body.type === 'keywords') {
    const { url, nicheName, country } = body;

    try {
      // Crawl site + fetch Google Ads data in parallel
      const [siteContent, googleKeywords] = await Promise.allSettled([
        crawlSite(url),
        (async () => {
          // Extract seed keywords from URL domain + niche
          const domain = url ? new URL(url).hostname.replace('www.', '').split('.')[0] : '';
          const seeds  = [nicheName, domain].filter(Boolean).slice(0, 5);
          return fetchGoogleAdsKeywords(seeds, country);
        })(),
      ]);

      const content  = siteContent.status  === 'fulfilled' ? siteContent.value  : '';
      const gKeywords = googleKeywords.status === 'fulfilled' ? googleKeywords.value : null;

      const keywords = await generateClaudeKeywords(nicheName, country, url, content, gKeywords);

      return res.json({
        ...keywords,
        googleData: gKeywords ? {
          avgCpc:       gKeywords.avgCpc,
          keywordCount: gKeywords.keywordCount,
        } : null,
        source: gKeywords ? 'google_ads_api' : 'benchmark',
      });
    } catch (err) {
      console.error('Keywords error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── LEAD ──
  if (body.type === 'lead') {
    // Fire and forget — don't block response
    Promise.allSettled([
      saveToSheets(body),
      sendNotificationEmail(body),
    ]);
    return res.json({ success: true });
  }

  return res.status(400).json({ error: 'Unknown request type' });
}
