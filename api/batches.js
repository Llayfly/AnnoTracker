const fetch = require('node-fetch');
const platformApi = require('../lib/platformApi');

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Auth check
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }

  try {
    const token = await platformApi.getToken();
    const config = {
      baseUrl: process.env.PLATFORM_BASE_URL || 'https://data-platform.synapath.com',
      organization: process.env.PLATFORM_ORGANIZATION || 'HC',
    };

    // Parse query params
    const { limit, offset, status, annotator, organization, label_project_id } = req.query;

    const params = new URLSearchParams();
    params.append('limit', limit || '200');
    if (offset) params.append('offset', offset);
    if (status) params.append('status', status);
    if (annotator) params.append('annotator', annotator);
    params.append('organization', organization || config.organization);
    if (label_project_id) params.append('label_project_id', label_project_id);

    const url = `${config.baseUrl}/api/v1/dispatch/batches?${params.toString()}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('[API batches] Platform error:', response.status, text);
      return res.status(response.status).json({
        error: `平台API错误: ${response.status}`,
        detail: text
      });
    }

    const data = await response.json();

    // Normalize response format
    let batches = [];
    if (Array.isArray(data)) {
      batches = data;
    } else if (data.batches) {
      batches = data.batches;
    } else if (data.items) {
      batches = data.items;
    } else if (data.data) {
      batches = Array.isArray(data.data) ? data.data : (data.data.batches || data.data.items || []);
    } else if (data.results) {
      batches = data.results;
    }

    return res.status(200).json({
      batches: batches,
      total: data.total || data.count || batches.length,
      raw: data,
    });
  } catch (error) {
    console.error('[API batches] Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
