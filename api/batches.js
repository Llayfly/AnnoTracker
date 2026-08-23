'use strict';
// 批次管理 API —— GET 列表 / POST 新增 / PUT 更新 / DELETE 删除
const { getDb, ensureInit } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// GET /api/batches?date=YYYY-MM-DD&group=HC|C&status=需修改&annotator=HC3
// POST /api/batches  body: { batch_id, annotator_label, project_type, status, review_result, reviewer, round, progress_current, progress_total, date, note }
// PUT /api/batches?id=xxx  body: { ...fields }
// DELETE /api/batches?id=xxx
module.exports = requireAuth(async (req, res) => {
  await ensureInit();
  const db = getDb();

  // ===== GET: 获取批次列表 =====
  if (req.method === 'GET') {
    try {
      const { date, group, status, annotator } = req.query;
      let sql = 'SELECT * FROM batches WHERE 1=1';
      const args = [];

      if (date) {
        sql += ' AND date = ?';
        args.push(date);
      }
      if (status) {
        sql += ' AND status = ?';
        args.push(status);
      }
      if (annotator) {
        sql += ' AND annotator_label LIKE ?';
        args.push(`%${annotator}%`);
      }
      if (group) {
        if (group === 'HC') {
          sql += " AND annotator_label LIKE 'HC%'";
        } else if (group === 'C') {
          sql += " AND (annotator_label LIKE 'C%' AND annotator_label NOT LIKE 'HC%')";
        } else if (group === 'S') {
          sql += " AND annotator_label LIKE 'S%'";
        }
      }
      sql += ' ORDER BY date DESC, CAST(batch_id AS INTEGER) DESC';

      const result = await db.execute({ sql, args });
      res.json({ count: result.rows.length, data: result.rows });
    } catch (e) {
      console.error('[api] batches GET error:', e);
      res.status(500).json({ error: e.message });
    }
    return;
  }

  // ===== POST: 新增批次 =====
  if (req.method === 'POST') {
    try {
      const b = req.body || {};
      if (!b.annotator_label) return res.status(400).json({ error: '标注员不能为空' });
      if (!b.date) return res.status(400).json({ error: '日期不能为空' });

      const now = new Date().toISOString();
      await db.execute({
        sql: `INSERT INTO batches
          (batch_id, annotator_label, project_type, status, review_result, reviewer,
           round, progress_current, progress_total, date, note, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          b.batch_id || null,
          b.annotator_label,
          b.project_type || '',
          b.status || '已分发',
          b.review_result || null,
          b.reviewer || null,
          parseInt(b.round) || 0,
          parseInt(b.progress_current) || 0,
          parseInt(b.progress_total) || 0,
          b.date,
          b.note || '',
          now, now,
        ],
      });
      res.json({ ok: true, message: '批次已添加' });
    } catch (e) {
      console.error('[api] batches POST error:', e);
      res.status(500).json({ error: e.message });
    }
    return;
  }

  // ===== PUT: 更新批次 =====
  if (req.method === 'PUT') {
    try {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: '缺少 id 参数' });
      const b = req.body || {};
      const now = new Date().toISOString();

      const fields = [];
      const args = [];
      const allowed = ['batch_id', 'annotator_label', 'project_type', 'status', 'review_result',
        'reviewer', 'round', 'progress_current', 'progress_total', 'date', 'note'];

      for (const f of allowed) {
        if (b[f] !== undefined) {
          fields.push(`${f} = ?`);
          args.push(f === 'round' || f === 'progress_current' || f === 'progress_total'
            ? (parseInt(b[f]) || 0) : b[f]);
        }
      }
      fields.push('updated_at = ?');
      args.push(now);
      args.push(id);

      await db.execute({
        sql: `UPDATE batches SET ${fields.join(', ')} WHERE id = ?`,
        args,
      });
      res.json({ ok: true, message: '批次已更新' });
    } catch (e) {
      console.error('[api] batches PUT error:', e);
      res.status(500).json({ error: e.message });
    }
    return;
  }

  // ===== DELETE: 删除批次 =====
  if (req.method === 'DELETE') {
    try {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: '缺少 id 参数' });
      await db.execute({ sql: 'DELETE FROM batches WHERE id = ?', args: [id] });
      res.json({ ok: true, message: '批次已删除' });
    } catch (e) {
      console.error('[api] batches DELETE error:', e);
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
});
