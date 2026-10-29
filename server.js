require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const https   = require('https');
const path    = require('path');

const app = express();

app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

app.post('/api/contact', (req, res) => {
  const { name, email, subject, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ ok: false, error: 'Name, email and message required' });
  }

  const safe = {
    name:    escapeHtml(name),
    email:   escapeHtml(email),
    subject: subject ? escapeHtml(subject) : '—',
    message: escapeHtml(message).replace(/\n/g, '<br>')
  };

  const payload = JSON.stringify({
    sender:      { name: 'MS Production House', email: process.env.FROM_EMAIL },
    to:          [{ email: process.env.TO_EMAIL, name: 'Sabir Ali' }],
    replyTo:     { email: email, name: name },
    subject:     subject ? `Portfolio: ${subject}` : `Portfolio Message from ${name}`,
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;background:#f8fafc;border-radius:12px">
        <div style="background:linear-gradient(90deg,#f97316,#dc6a0a);padding:16px;border-radius:8px;margin-bottom:16px">
          <h2 style="color:#fff;margin:0">New Portfolio Message</h2>
        </div>
        <p><strong>Name:</strong> ${safe.name}</p>
        <p><strong>Email:</strong> <a href="mailto:${safe.email}">${safe.email}</a></p>
        <p><strong>Subject:</strong> ${safe.subject}</p>
        <p><strong>Message:</strong><br>${safe.message}</p>
      </div>`
  });

  const options = {
    method:   'POST',
    hostname: 'api.brevo.com',
    path:     '/v3/smtp/email',
    headers: {
      'api-key':        process.env.BREVO_API_KEY,
      'Content-Type':   'application/json',
      'accept':         'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    let body = '';
    apiRes.on('data', chunk => body += chunk);
    apiRes.on('end', () => {
      if (apiRes.statusCode >= 200 && apiRes.statusCode < 300) {
        console.log('Email sent successfully from:', name);
        res.json({ ok: true, message: 'Email sent successfully' });
      } else {
        console.error('Brevo error:', apiRes.statusCode, body);
        res.status(500).json({ ok: false, error: 'Failed to send email' });
      }
    });
  });

  apiReq.on('error', (err) => {
    console.error('Request error:', err.message);
    res.status(500).json({ ok: false, error: 'Network error' });
  });

  apiReq.setTimeout(20000, () => {
    apiReq.destroy(new Error('Request timeout'));
  });

  apiReq.write(payload);
  apiReq.end();
});

app.use((req, res) => res.status(404).type('text').send('Page not found'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));