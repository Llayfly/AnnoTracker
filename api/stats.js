const platformApi = require('../lib/platformApi');
const { secondsToHours, getAlertLevel, getDateRange } = require('../lib/helpers');
const { requireAuth } = require('../lib/auth');

module.exports = requireAuth(async (req, res) => {
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

    // Fetch data from platform API for each day in the range
    const allDayData = await platformApi.fetchRangeStats(start, end);

    // Aggregate data per annotator
    const annotatorMap = {};
    for (const dayData of allDayData) {
      if (!dayData.success) continue;
      for (const row of dayData.dailyRows) {
        const label = row.annotator_label;
        if (!annotatorMap[label]) {
          annotatorMap[label] = {
            annotator_label: label,
            annotator_name: row.annotator_name,
            organization: row.organization,
            active_days: 0,
            total_raw_duration: 0,
            total_segment_duration: 0,
            total_no_clip_duration: 0,
            total_no_clip_equivalent: 0,
            total_new_task_duration: 0,
            total_old_task_duration: 0,
            total_settlement_reference: 0,
            latest_cumulative_reference: 0,
            first_active_date: dayData.day,
            last_active_date: dayData.day,
          };
        }
        const a = annotatorMap[label];
        a.active_days++;
        a.total_raw_duration += row.raw_duration_seconds || 0;
        a.total_segment_duration += row.segment_duration_seconds || 0;
        a.total_no_clip_duration += row.no_clip_duration_seconds || 0;
        a.total_no_clip_equivalent += row.no_clip_equivalent_seconds || 0;
        a.total_new_task_duration += row.new_task_raw_duration_seconds || 0;
        a.total_old_task_duration += row.old_task_raw_duration_seconds || 0;

        // Update settlement data (use latest day's values)
        const settlement = dayData.settlementMap[label];
        if (settlement) {
          a.total_settlement_reference = settlement.settlement_reference || 0;
          a.latest_cumulative_reference = settlement.cumulative_reference || 0;
        }

        if (dayData.day < a.first_active_date) a.first_active_date = dayData.day;
        if (dayData.day > a.last_active_date) a.last_active_date = dayData.day;
      }
    }

    // Convert to array and calculate averages
    let aggregated = Object.values(annotatorMap).map(a => {
      a.avg_daily_raw_duration = a.active_days > 0 ? a.total_raw_duration / a.active_days : 0;
      return a;
    });

    // Filter by annotator search
    let filtered = aggregated;
    if (annotator) {
      const search = annotator.toLowerCase();
      filtered = aggregated.filter(a =>
        (a.annotator_label || '').toLowerCase().includes(search) ||
        (a.annotator_name || '').toLowerCase().includes(search)
      );
    }

    // Sort by total raw duration descending
    filtered.sort((a, b) => b.total_raw_duration - a.total_raw_duration);

    // Format results
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
});
