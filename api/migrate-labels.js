'use strict';
// POST /api/migrate-labels —— 一次性迁移标注员标签
// 将旧标签改名（如 HC13→C13, HC9→C9），保留所有历史数据
const { getDb, ensureInit } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

// 需要迁移的标签映射（旧→新）
const LABEL_MIGRATIONS = [
  { old: 'HC13', new: 'C13' },
  { old: 'HC9', new: 'C9' },
  { old: 'HC09', new: 'C09' },
];

module.exports = requireAuth(async (req, res) => {
  try {
    await ensureInit();
    const db = getDb();
    const results = [];

    for (const { old: oldLabel, new: newLabel } of LABEL_MIGRATIONS) {
      // 检查旧标签是否存在
      const oldResult = await db.execute({
        sql: 'SELECT id, label, raw_label FROM annotators WHERE label = ?',
        args: [oldLabel],
      });
      if (!oldResult.rows.length) {
        results.push({ old: oldLabel, new: newLabel, status: 'skip', message: '旧标签不存在' });
        continue;
      }
      const oldId = oldResult.rows[0].id;

      // 检查新标签是否已存在
      const newResult = await db.execute({
        sql: 'SELECT id FROM annotators WHERE label = ?',
        args: [newLabel],
      });

      if (newResult.rows.length) {
        // 新标签已存在，需要合并：把旧标签的数据迁移到新标签
        const newId = newResult.rows[0].id;
        
        // 迁移 daily_stats（遇到冲突时用新数据覆盖）
        await db.batch([
          { sql: 'UPDATE daily_stats SET annotator_id = ? WHERE annotator_id = ?', args: [newId, oldId] },
          { sql: 'UPDATE annotator_cumulative SET annotator_id = ? WHERE annotator_id = ?', args: [newId, oldId] },
        ], 'write');

        // 删除旧标注员记录
        await db.execute({ sql: 'DELETE FROM annotators WHERE id = ?', args: [oldId] });
        
        results.push({ old: oldLabel, new: newLabel, status: 'merged', oldId, newId, message: '已合并到现有标签' });
      } else {
        // 新标签不存在，直接改名
        await db.execute({
          sql: 'UPDATE annotators SET label = ?, updated_at = ? WHERE id = ?',
          args: [newLabel, new Date().toISOString(), oldId],
        });
        results.push({ old: oldLabel, new: newLabel, status: 'renamed', oldId, message: '已改名' });
      }
    }

    res.json({ ok: true, results });
  } catch (e) {
    console.error('[api] migrate-labels error:', e);
    res.status(500).json({ error: e.message });
  }
});
