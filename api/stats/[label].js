const db = require('../../lib/db');
const { secondsToHours, getAlertLevel, formatDate } = require('../../lib/helpers');

module.exports = async (req, res) => {
  try {
    const { label } = req.query;
    const { startDate, endDate } = req.query;

    let start, end;
    const today = new Date();

    if (startDate && endDate) {
      start = startDate;
      end = endDate;
    } else {
      end = formatDate(today);
      const startDay = new Date(today);
      startDay.setDate(startDay.getDate() - 29);
      start = formatDate(startDay);
    }

    const dailyData = await db.getDailyStatsByDateRange(start, end, label);

    const formatted = dailyData.map(d => ({
      ...d,
      raw_hours: secondsToHours(parseFloat(d.raw_duration_seconds) || 0),
      segment_hours: secondsToHours(parseFloat(d.segment_duration_seconds) || 0),
      no_clip_hours: secondsToHours(parseFloat(d.no_clip_duration_seconds) || 0),
      no_clip_equivalent_hours: secondsToHours(parseFloat(d.no_clip_equivalent_seconds) || 0),
      new_task_hours: secondsToHours(parseFloat(d.new_task_raw_duration_seconds) || 0),
      old_task_hours: secondsToHours(parseFloat(d.old_task_raw_duration_seconds) || 0),
      settlement_hours: secondsToHours(parseFloat(d.settlement_reference) || 0),
      alert_level: getAlertLevel(parseFloat(d.raw_duration_seconds) || 0),
    }));

    res.status(200).json({
      annotator: label,
      daily_stats: formatted,
      date_range: { start, end },
    });
  } catch (error) {
    console.error('[API /stats/:label] Error:', error);
    res.status(500).json({ error: error.message });
  }
};
