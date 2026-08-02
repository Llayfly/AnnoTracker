'use strict';
// 批次自动采集 API —— POST 触发从平台拉取批次数据
const { collectBatches } = require('../lib/collector');
const { getDb, ensureInit } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('[api] 开始批次自动采集...');

    // 先清理已有的重复数据（保留每个 batch_id 的最新一条）
    await ensureInit();
    const db = getDb();
    try {
      await db.execute({
        sql: `DELETE FROM batches WHERE id NOT IN (
          SELECT MIN(id) FROM batches GROUP BY batch_id, annotator_label, date
        )`,
        args: [],
      });
      console.log('[api] 已清理重复批次数据');
    } catch (e) {
      console.error('[api] 清理重复数据失败:', e.message);
    }

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
