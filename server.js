require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const https   = require('https');
const path    = require('path');

const app = express();

app.set('trust proxy', 1);
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: true, limit: '20kb' }));

// Duplicate URL: /index.html → / (one canonical address for Google)
app.get('/index.html', (req, res) => res.redirect(301, '/'));

app.get('/', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Only public files are served — server.js, package.json etc. stay private
app.use('/images', express.static(path.join(__dirname, 'images'), { maxAge: '30d' }));
['robots.txt', 'sitemap.xml', 'googlea3fbdfbcf5ac3d47.html'].forEach((file) => {
  app.get('/' + file, (req, res) => res.sendFile(path.join(__dirname, file)));
});

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const clean = (value, max) => String(value || '').trim().slice(0, max);

// Small promise wrapper around https.request
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`${options.hostname} ${res.statusCode}: ${data.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error(`${options.hostname} timeout`)));
    if (body) req.write(body);
    req.end();
  });
}

// ── Channels ────────────────────────────────────────────────

function sendEmail(lead) {
  if (!process.env.BREVO_API_KEY || !process.env.TO_EMAIL) return null;

  const safe = {
    name:    escapeHtml(lead.name),
    email:   escapeHtml(lead.email || '—'),
    phone:   escapeHtml(lead.phone || '—'),
    subject: escapeHtml(lead.subject || '—'),
    message: escapeHtml(lead.message).replace(/\n/g, '<br>')
  };

  const payload = JSON.stringify({
    sender:      { name: 'Bitali Aaly', email: process.env.FROM_EMAIL },
    to:          [{ email: process.env.TO_EMAIL, name: 'Sabir Ali' }],
    replyTo:     lead.email ? { email: lead.email, name: lead.name } : undefined,
    subject:     lead.subject ? `Website: ${lead.subject}` : `Website message from ${lead.name}`,
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;background:#f8fafc;border-radius:12px">
        <div style="background:linear-gradient(90deg,#f97316,#dc6a0a);padding:16px;border-radius:8px;margin-bottom:16px">
          <h2 style="color:#fff;margin:0">New Website Message</h2>
        </div>
        <p><strong>Name:</strong> ${safe.name}</p>
        <p><strong>Email:</strong> ${safe.email}</p>
        <p><strong>Phone:</strong> ${safe.phone}</p>
        <p><strong>Subject:</strong> ${safe.subject}</p>
        <p><strong>Message:</strong><br>${safe.message}</p>
      </div>`
  });

  return request({
    method:   'POST',
    hostname: 'api.brevo.com',
    path:     '/v3/smtp/email',
    headers: {
      'api-key':        process.env.BREVO_API_KEY,
      'Content-Type':   'application/json',
      'accept':         'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);
}

function whatsappText(lead) {
  return [
    `New website message — ${lead.source}`,
    `Name: ${lead.name}`,
    lead.phone ? `Phone: ${lead.phone}` : null,
    lead.email ? `Email: ${lead.email}` : null,
    lead.subject ? `Subject: ${lead.subject}` : null,
    '',
    lead.message
  ].filter((line) => line !== null).join('\n');
}

// Option A — CallMeBot (free): sends a WhatsApp message to your own number.
// Needs WHATSAPP_PHONE (e.g. 923414717517) and CALLMEBOT_APIKEY.
function sendCallMeBot(lead) {
  const { WHATSAPP_PHONE: phone, CALLMEBOT_APIKEY: apikey } = process.env;
  if (!phone || !apikey) return null;
  const query = new URLSearchParams({ phone, apikey, text: whatsappText(lead) });
  return request({ method: 'GET', hostname: 'api.callmebot.com', path: `/whatsapp.php?${query}` });
}

// Option B — official WhatsApp Cloud API (Meta). Needs WA_TOKEN, WA_PHONE_ID and
// WHATSAPP_PHONE. With WA_TEMPLATE set, an approved template whose body has one
// {{1}} variable is used (works at any time); without it a plain text message is
// sent, which Meta only delivers inside the 24-hour customer-service window.
function sendMetaCloud(lead) {
  const { WA_TOKEN: token, WA_PHONE_ID: phoneId, WHATSAPP_PHONE: to, WA_TEMPLATE: template } = process.env;
  if (!token || !phoneId || !to) return null;

  const text = whatsappText(lead).replace(/\n+/g, ' | ').slice(0, 1000);
  const message = template
    ? { type: 'template', template: {
        name: template,
        language: { code: process.env.WA_TEMPLATE_LANG || 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text }] }]
      } }
    : { type: 'text', text: { body: whatsappText(lead) } };

  const payload = JSON.stringify({ messaging_product: 'whatsapp', to, ...message });
  return request({
    method:   'POST',
    hostname: 'graph.facebook.com',
    path:     `/${process.env.WA_API_VERSION || 'v21.0'}/${phoneId}/messages`,
    headers: {
      'Authorization':  `Bearer ${token}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);
}

// Sends the lead on every configured channel; succeeds if at least one works.
async function notify(lead) {
  const channels = { email: sendEmail(lead), whatsapp: sendMetaCloud(lead) || sendCallMeBot(lead) };
  const active = Object.entries(channels).filter(([, job]) => job);
  if (!active.length) throw new Error('No delivery channel configured');

  const results = await Promise.allSettled(active.map(([, job]) => job));
  const sent = [];
  results.forEach((result, i) => {
    const name = active[i][0];
    if (result.status === 'fulfilled') sent.push(name);
    else console.error(`${name} failed:`, result.reason.message);
  });
  if (!sent.length) throw new Error('All channels failed');
  return sent;
}

// ── Spam protection: honeypot + simple per-IP rate limit ────

const hits = new Map();
const LIMIT = 5, WINDOW = 10 * 60 * 1000;
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW);
  list.push(now);
  hits.set(ip, list);
  return list.length > LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) if (!list.some((t) => now - t < WINDOW)) hits.delete(ip);
}, WINDOW).unref();

function handle(source) {
  return async (req, res) => {
    const body = req.body || {};
    if (body.website) return res.json({ ok: true }); // honeypot: bots fill hidden field

    const lead = {
      source,
      name:    clean(body.name, 80),
      email:   clean(body.email, 120),
      phone:   clean(body.phone, 30),
      subject: clean(body.subject, 120),
      message: clean(body.message, 2000)
    };

    if (!lead.name || !lead.message || (!lead.email && !lead.phone)) {
      return res.status(400).json({ ok: false, error: 'Please add your name, a message and an email or phone number.' });
    }
    if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    }
    if (rateLimited(req.ip)) {
      return res.status(429).json({ ok: false, error: 'Too many messages. Please try again in a few minutes.' });
    }

    try {
      const sent = await notify(lead);
      console.log(`Lead from ${lead.name} sent via ${sent.join(', ')}`);
      res.json({ ok: true, sent });
    } catch (err) {
      console.error('Lead not delivered:', err.message);
      res.status(500).json({ ok: false, error: 'Could not send right now. Please try WhatsApp instead.' });
    }
  };
}

app.post('/api/contact', handle('Contact form'));
app.post('/api/message', handle('Chat widget'));

app.use((req, res) => res.status(404).type('text').send('Page not found'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
