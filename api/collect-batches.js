'use strict';
// 批次自动采集 API —— POST 触发从平台拉取批次数据
const { collectBatches } = require('../lib/collector');
const { requireAuth } = require('../lib/auth');

module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('[api] 开始批次自动采集...');
    const result = await collectBatches();
    res.json({
      ok: true,
      ...result,
    });
  } catch (e) {
    console.error('[api] 批次采集失败:', e);
    res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});
