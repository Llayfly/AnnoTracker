// ========== 全局状态 ==========
let currentRange = '1d';
let currentSearch = '';
let allData = [];
let autoRefreshTimer = null;

// ========== API 调用 ==========

async function fetchAPI(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API错误: ${response.status}`);
  return response.json();
}

async function loadStats() {
  const chartArea = document.getElementById('chart-area');
  chartArea.innerHTML = '<div class="chart-loading">加载中...</div>';

  try {
    let url = `/api/stats?range=${currentRange}`;
    if (currentSearch) {
      url += `&annotator=${encodeURIComponent(currentSearch)}`;
    }

    const data = await fetchAPI(url);
    allData = data.annotators || [];

    // 渲染统计卡片
    const s = data.summary || {};
    document.getElementById('card-total').textContent = s.total_annotators || 0;
    document.getElementById('card-red').textContent = s.red_count || 0;
    document.getElementById('card-blue').textContent = s.blue_count || 0;
    document.getElementById('card-green').textContent = s.green_count || 0;

    // 更新图表标题
    if (s.date_range) {
      document.getElementById('chart-title').textContent =
        `标注员工作统计（${s.date_range.start} 至 ${s.date_range.end}）`;
    }

    renderChart();
    updateLastRefresh();
  } catch (error) {
    console.error('加载数据失败:', error);
    chartArea.innerHTML = `<div class="chart-loading">加载失败: ${error.message}<br>请确认服务器已启动并已连接数据平台</div>`;
  }
}

async function loadHealth() {
  try {
    const data = await fetchAPI('/api/health');
    if (data.status === 'ok') {
      const time = new Date(data.timestamp).toLocaleString('zh-CN');
      document.getElementById('last-update').textContent = `平台连接正常 | ${time}`;
    } else {
      document.getElementById('last-update').textContent = `平台连接异常: ${data.error || '未知'}`;
    }
  } catch (e) {
    document.getElementById('last-update').textContent = '服务器状态未知';
  }
}

async function loadLogs() {
  try {
    const logs = await fetchAPI('/api/logs?limit=20');
    const tbody = document.getElementById('logs-tbody');
    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;padding:20px;">暂无日志</td></tr>';
      return;
    }
    tbody.innerHTML = logs.map(log => `
      <tr>
        <td>${new Date(log.created_at).toLocaleString('zh-CN')}</td>
        <td>${log.date}</td>
        <td class="${log.status === 'success' ? 'status-success' : 'status-error'}">${log.status === 'success' ? '成功' : '失败'}</td>
        <td>${log.annotator_count || 0}</td>
        <td>${log.error_message || '-'}</td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('加载日志失败:', e);
  }
}

// ========== 柱状图渲染 ==========

function renderChart() {
  const chartArea = document.getElementById('chart-area');

  if (allData.length === 0) {
    chartArea.innerHTML = '<div class="chart-loading">暂无数据</div>';
    return;
  }

  // 计算最大值用于Y轴刻度
  const maxHours = Math.max(...allData.map(a => parseFloat(a.total_raw_hours) || 0));
  const niceMax = niceCeil(maxHours);

  // 生成Y轴刻度（5格）
  const gridSteps = 5;
  const stepValue = niceMax / gridSteps;
  let gridHTML = '<div class="bar-chart-grid">';
  for (let i = gridSteps; i >= 0; i--) {
    const val = (stepValue * i).toFixed(1);
    gridHTML += `<div class="grid-line"><span>${val}h</span></div>`;
  }
  gridHTML += '</div>';

  // 生成柱子
  let barsHTML = '';
  for (const a of allData) {
    const totalHours = parseFloat(a.total_raw_hours) || 0;
    const newTaskHours = parseFloat(a.total_new_task_hours) || 0;
    const oldTaskHours = parseFloat(a.total_old_task_hours) || 0;

    // 柱子高度百分比（基于niceMax）
    const totalHeightPct = niceMax > 0 ? (totalHours / niceMax) * 100 : 0;
    const newTaskPct = totalHours > 0 ? (newTaskHours / totalHours) * 100 : 0;
    const oldTaskPct = totalHours > 0 ? (oldTaskHours / totalHours) * 100 : 0;

    const alertClass = `alert-${a.alert_level}`;
    const alertText = a.alert_level === 'red' ? '预警' : a.alert_level === 'blue' ? '正常' : '活跃';

    barsHTML += `
      <div class="bar-col ${alertClass}" onclick="showDetail('${a.annotator_label}')">
        <div class="bar-tooltip">
          <div class="bar-tooltip-row"><span class="t-label">标注员</span><span class="t-value">${a.annotator_label}</span></div>
          <div class="bar-tooltip-row"><span class="t-label">新增任务</span><span class="t-value">${newTaskHours.toFixed(2)}h</span></div>
          <div class="bar-tooltip-row"><span class="t-label">旧任务</span><span class="t-value">${oldTaskHours.toFixed(2)}h</span></div>
          <div class="bar-tooltip-row"><span class="t-label">原始总时长</span><span class="t-value">${totalHours.toFixed(2)}h</span></div>
          <div class="bar-tooltip-row"><span class="t-label">日均时长</span><span class="t-value">${a.avg_daily_hours || '0.00'}h</span></div>
          <div class="bar-tooltip-row"><span class="t-label">活跃天数</span><span class="t-value">${a.active_days || 0}天</span></div>
          <div class="bar-tooltip-row"><span class="t-label">状态</span><span class="t-value">${alertText}</span></div>
        </div>
        <div class="bar-stack" style="height: ${totalHeightPct}%">
          <div class="bar-new-task" style="height: ${newTaskPct}%"></div>
          <div class="bar-old-task" style="height: ${oldTaskPct}%"></div>
        </div>
        <div class="bar-total-label">${totalHours.toFixed(1)}h</div>
        <div class="bar-label">${a.annotator_label}</div>
      </div>
    `;
  }

  chartArea.innerHTML = `
    <div class="bar-chart" style="padding-left: 50px;">
      ${gridHTML}
      ${barsHTML}
    </div>
  `;
}

// 向上取整到漂亮的数字
function niceCeil(value) {
  if (value <= 0) return 10;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  let niceNormalized;
  if (normalized <= 1) niceNormalized = 1;
  else if (normalized <= 2) niceNormalized = 2;
  else if (normalized <= 5) niceNormalized = 5;
  else niceNormalized = 10;
  // 如果原始值刚好是整数倍，不额外加余量
  const result = niceNormalized * magnitude;
  return result >= value ? result : result * 2;
}

// ========== 详情弹窗（柱状图） ==========

async function showDetail(label) {
  const modal = document.getElementById('detail-modal');
  const title = document.getElementById('modal-title');
  const summary = document.getElementById('modal-summary');
  const chartArea = document.getElementById('detail-chart-area');

  title.textContent = `标注员 ${label} 每日详情`;
  chartArea.innerHTML = '<div class="chart-loading">加载中...</div>';
  modal.style.display = 'flex';

  try {
    const data = await fetchAPI(`/api/stats/${encodeURIComponent(label)}?startDate=&endDate=`);
    const stats = data.daily_stats || [];

    // 汇总信息
    const totalRaw = stats.reduce((sum, s) => sum + (s.raw_duration_seconds || 0), 0);
    const totalNewTask = stats.reduce((sum, s) => sum + (s.new_task_raw_duration_seconds || 0), 0);
    const totalOldTask = stats.reduce((sum, s) => sum + (s.old_task_raw_duration_seconds || 0), 0);
    const avgDaily = stats.length > 0 ? totalRaw / stats.length / 3600 : 0;

    summary.innerHTML = `
      <div class="summary-item">
        <div class="label">活跃天数</div>
        <div class="value">${stats.length}</div>
      </div>
      <div class="summary-item">
        <div class="label">原始总时长</div>
        <div class="value">${(totalRaw / 3600).toFixed(2)} h</div>
      </div>
      <div class="summary-item">
        <div class="label">新增任务</div>
        <div class="value">${(totalNewTask / 3600).toFixed(2)} h</div>
      </div>
      <div class="summary-item">
        <div class="label">旧任务</div>
        <div class="value">${(totalOldTask / 3600).toFixed(2)} h</div>
      </div>
      <div class="summary-item">
        <div class="label">日均时长</div>
        <div class="value">${avgDaily.toFixed(2)} h</div>
      </div>
    `;

    if (stats.length === 0) {
      chartArea.innerHTML = '<div class="chart-loading">暂无数据</div>';
      return;
    }

    // 按日期升序排列（旧到新，左到右）
    stats.sort((a, b) => a.date.localeCompare(b.date));

    // 计算最大值
    const maxHours = Math.max(...stats.map(s => parseFloat(s.raw_hours) || 0));
    const niceMax = niceCeil(maxHours);

    // 生成Y轴刻度
    const gridSteps = 5;
    const stepValue = niceMax / gridSteps;
    let gridHTML = '<div class="bar-chart-grid">';
    for (let i = gridSteps; i >= 0; i--) {
      const val = (stepValue * i).toFixed(1);
      gridHTML += `<div class="grid-line"><span>${val}h</span></div>`;
    }
    gridHTML += '</div>';

    // 生成每日柱子
    let barsHTML = '';
    for (const s of stats) {
      const totalHours = parseFloat(s.raw_hours) || 0;
      const newTaskHours = parseFloat(s.new_task_hours) || 0;
      const oldTaskHours = parseFloat(s.old_task_hours) || 0;

      const totalHeightPct = niceMax > 0 ? (totalHours / niceMax) * 100 : 0;
      const newTaskPct = totalHours > 0 ? (newTaskHours / totalHours) * 100 : 0;
      const oldTaskPct = totalHours > 0 ? (oldTaskHours / totalHours) * 100 : 0;

      const alertClass = `alert-${s.alert_level}`;
      const alertText = s.alert_level === 'red' ? '预警' : s.alert_level === 'blue' ? '正常' : '活跃';

      // 日期短格式 MM-DD
      const shortDate = s.date.substring(5);

      barsHTML += `
        <div class="bar-col ${alertClass}">
          <div class="bar-tooltip">
            <div class="bar-tooltip-row"><span class="t-label">日期</span><span class="t-value">${s.date}</span></div>
            <div class="bar-tooltip-row"><span class="t-label">新增任务</span><span class="t-value">${newTaskHours.toFixed(2)}h</span></div>
            <div class="bar-tooltip-row"><span class="t-label">旧任务</span><span class="t-value">${oldTaskHours.toFixed(2)}h</span></div>
            <div class="bar-tooltip-row"><span class="t-label">原始时长</span><span class="t-value">${totalHours.toFixed(2)}h</span></div>
            <div class="bar-tooltip-row"><span class="t-label">片段时长</span><span class="t-value">${(s.segment_hours || '0.00')}h</span></div>
            <div class="bar-tooltip-row"><span class="t-label">状态</span><span class="t-value">${alertText}</span></div>
          </div>
          <div class="bar-stack" style="height: ${totalHeightPct}%">
            <div class="bar-new-task" style="height: ${newTaskPct}%"></div>
            <div class="bar-old-task" style="height: ${oldTaskPct}%"></div>
          </div>
          <div class="bar-total-label">${totalHours.toFixed(1)}h</div>
          <div class="bar-label">${shortDate}</div>
        </div>
      `;
    }

    chartArea.innerHTML = `
      <div class="detail-bar-chart" style="padding-left: 50px;">
        ${gridHTML}
        ${barsHTML}
      </div>
    `;
  } catch (error) {
    chartArea.innerHTML = `<div class="chart-loading">加载失败: ${error.message}</div>`;
  }
}

function closeModal() {
  document.getElementById('detail-modal').style.display = 'none';
}

document.getElementById('detail-modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeModal();
});

// ========== 交互功能 ==========

function selectRange(range) {
  currentRange = range;
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.range === range);
  });
  document.getElementById('custom-start').value = '';
  document.getElementById('custom-end').value = '';
  loadStats();
}

function handleSearch() {
  const input = document.getElementById('search-input');
  currentSearch = input.value.trim();
  loadStats();
}

function customRangeSearch() {
  const start = document.getElementById('custom-start').value;
  const end = document.getElementById('custom-end').value;

  if (start && end) {
    currentRange = '';
    document.querySelectorAll('.range-btn').forEach(btn => btn.classList.remove('active'));

    const chartArea = document.getElementById('chart-area');
    chartArea.innerHTML = '<div class="chart-loading">加载中...</div>';

    let url = `/api/stats?startDate=${start}&endDate=${end}`;
    if (currentSearch) url += `&annotator=${encodeURIComponent(currentSearch)}`;

    fetchAPI(url).then(data => {
      allData = data.annotators || [];
      const s = data.summary || {};
      document.getElementById('card-total').textContent = s.total_annotators || 0;
      document.getElementById('card-red').textContent = s.red_count || 0;
      document.getElementById('card-blue').textContent = s.blue_count || 0;
      document.getElementById('card-green').textContent = s.green_count || 0;
      document.getElementById('chart-title').textContent =
        `标注员工作统计（${start} 至 ${end}）`;
      renderChart();
      updateLastRefresh();
    }).catch(error => {
      chartArea.innerHTML = `<div class="chart-loading">加载失败: ${error.message}</div>`;
    });
  }
}

// ========== 手动刷新 ==========

async function manualRefresh() {
  const btn = document.getElementById('refresh-btn');
  btn.textContent = '刷新中...';
  btn.disabled = true;

  try {
    await loadStats();
    await loadHealth();
  } catch (error) {
    console.error('刷新失败:', error);
    alert('刷新失败: ' + error.message);
  } finally {
    btn.textContent = '刷新';
    btn.disabled = false;
  }
}

function updateLastRefresh() {
  const now = new Date();
  document.getElementById('last-update').textContent =
    `最后更新: ${now.toLocaleTimeString('zh-CN')}`;
}

// ========== CSV 导出 ==========

function exportCSV() {
  if (allData.length === 0) {
    alert('暂无数据可导出');
    return;
  }

  const headers = [
    '标注员', '新增任务(h)', '旧任务(h)', '原始时长(h)', '片段时长(h)', '无片段时长(h)',
    '无片段等效(h)', '结算参考(h)', '累计参考(h)', '日均时长(h)',
    '活跃天数', '状态'
  ];

  const rows = allData.map(a => {
    const cumulativeHours = a.latest_cumulative_reference_hours || '0';
    const alertText = a.alert_level === 'red' ? '预警' : a.alert_level === 'blue' ? '正常' : '活跃';
    return [
      a.annotator_label || '',
      a.total_new_task_hours || '0',
      a.total_old_task_hours || '0',
      a.total_raw_hours || '0',
      a.total_segment_hours || '0',
      a.total_no_clip_hours || '0',
      a.total_no_clip_equivalent_hours || '0',
      a.total_settlement_hours || '0',
      cumulativeHours,
      a.avg_daily_hours || '0',
      a.active_days || '0',
      alertText
    ].join(',');
  });

  const csv = '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `标注员统计_${new Date().toISOString().split('T')[0]}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

// ========== 日志展开/收起 ==========

function toggleLogs() {
  const content = document.getElementById('logs-content');
  const h3 = content.previousElementSibling;
  if (content.style.display === 'none') {
    content.style.display = 'block';
    h3.textContent = h3.textContent.replace('▶', '▼');
    loadLogs();
  } else {
    content.style.display = 'none';
    h3.textContent = h3.textContent.replace('▼', '▶');
  }
}

// ========== 自动刷新 ==========

function startAutoRefresh() {
  autoRefreshTimer = setInterval(async () => {
    console.log('[AutoRefresh] 自动刷新数据...');
    await loadStats();
  }, 10 * 60 * 1000);
}

// ========== 初始化 ==========

window.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadHealth();
  startAutoRefresh();
});
