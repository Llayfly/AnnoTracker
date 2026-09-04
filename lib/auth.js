const crypto = require('crypto');

const SECRET = process.env.AUTH_SECRET || 'anno-tracker-secret-2024';
const TOKEN_EXPIRY_HOURS = 24;

// Generate a signed token
function generateToken(username) {
  const payload = {
    username,
    exp: Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('hex');
  return `${data}.${sig}`;
}

// Verify a token, returns { valid: boolean, username?: string }
function verifyToken(token) {
  if (!token) return { valid: false };
  try {
    const [data, sig] = token.split('.');
    if (!data || !sig) return { valid: false };

    const expectedSig = crypto.createHmac('sha256', SECRET).update(data).digest('hex');
    if (sig !== expectedSig) return { valid: false };

    const payload = JSON.parse(Buffer.from(data, 'base64').toString());
    if (Date.now() > payload.exp) return { valid: false };

    return { valid: true, username: payload.username };
  } catch {
    return { valid: false };
  }
}

// Express-style middleware for Vercel serverless functions
function requireAuth(handler) {
  return async (req, res) => {
    // Extract token from Authorization header or cookie
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
    if (!token && req.headers.cookie) {
      const cookies = req.headers.cookie.split(';').map(c => c.trim());
      for (const c of cookies) {
        if (c.startsWith('auth_token=')) {
          token = c.substring('auth_token='.length);
          break;
        }
      }
    }

    const result = verifyToken(token);
    if (!result.valid) {
      return res.status(401).json({ error: '未登录或登录已过期', needLogin: true });
    }

    return handler(req, res);
  };
}

module.exports = { generateToken, verifyToken, requireAuth };
