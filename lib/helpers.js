// 共享工具函数

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function secondsToHours(seconds) {
  return (seconds / 3600).toFixed(2);
}

function getAlertLevel(avgDailySeconds) {
  const hours = avgDailySeconds / 3600;
  if (hours < 3) return 'red';
  if (hours <= 5) return 'blue';
  return 'green';
}

function getDateRange(range) {
  const today = new Date();
  let start, end;

  if (range) {
    end = formatDate(today);
    const startDay = new Date(today);
    switch (range) {
      case '1d': startDay.setDate(startDay.getDate() - 0); break;
      case '3d': startDay.setDate(startDay.getDate() - 2); break;
      case '1w': startDay.setDate(startDay.getDate() - 6); break;
      case '15d': startDay.setDate(startDay.getDate() - 14); break;
      case '1m': startDay.setMonth(startDay.getMonth() - 1); break;
      default: startDay.setDate(startDay.getDate() - 6);
    }
    start = formatDate(startDay);
  } else {
    end = formatDate(today);
    const startDay = new Date(today);
    startDay.setDate(startDay.getDate() - 6);
    start = formatDate(startDay);
  }

  return { start, end };
}

module.exports = { formatDate, secondsToHours, getAlertLevel, getDateRange };
