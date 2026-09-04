const db = require('../lib/db');
const { secondsToHours, getAlertLevel, getDateRange } = require('../lib/helpers');

module.exports = async (req, res) => {
  try {
    const { startDate, endDate, annotator, range } = req.query;

    let start, end;
    if (startDate && endDate) {
      start = startDate;
      end = endDate;
    } else {
      const dr = getDateRange(range);
      start = dr.start;
      end = dr.end;
    }

    const aggregated = await db.getAggregatedStats(start, end);

    let filtered = aggregated;
    if (annotator) {
      const search = annotator.toLowerCase();
      filtered = aggregated.filter(a =>
        (a.annotator_label || '').toLowerCase().includes(search) ||
        (a.annotator_name || '').toLowerCase().includes(search)
      );
    }

    const result = filtered.map(a => {
      const avgDailyHours = (parseFloat(a.avg_daily_raw_duration) || 0) / 3600;
      const cumulativeRef = a.latest_cumulative_reference ? (parseFloat(a.latest_cumulative_reference) / 3600).toFixed(2) : '0.00';
      return {
        ...a,
        total_raw_hours: secondsToHours(parseFloat(a.total_raw_duration) || 0),
        total_segment_hours: secondsToHours(parseFloat(a.total_segment_duration) || 0),
        total_no_clip_hours: secondsToHours(parseFloat(a.total_no_clip_duration) || 0),
        total_no_clip_equivalent_hours: secondsToHours(parseFloat(a.total_no_clip_equivalent) || 0),
        total_new_task_hours: secondsToHours(parseFloat(a.total_new_task_duration) || 0),
        total_old_task_hours: secondsToHours(parseFloat(a.total_old_task_duration) || 0),
        total_settlement_hours: secondsToHours(parseFloat(a.total_settlement_reference) || 0),
        latest_cumulative_reference_hours: cumulativeRef,
        avg_daily_hours: avgDailyHours.toFixed(2),
        active_days: parseInt(a.active_days) || 0,
        alert_level: getAlertLevel(parseFloat(a.avg_daily_raw_duration) || 0),
      };
    });

    const summary = {
      total_annotators: result.length,
      red_count: result.filter(r => r.alert_level === 'red').length,
      blue_count: result.filter(r => r.alert_level === 'blue').length,
      green_count: result.filter(r => r.alert_level === 'green').length,
      date_range: { start, end },
    };

    res.status(200).json({ summary, annotators: result });
  } catch (error) {
    console.error('[API /stats] Error:', error);
    res.status(500).json({ error: error.message });
  }
};
