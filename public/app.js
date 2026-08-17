'use strict';
// 前端逻辑：认证、查询、渲染、明细、导出、回填

// ===== 认证 =====
const TOKEN_KEY = 'am_token';
const USER_KEY = 'am_user';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function redirectToLogin() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  window.location.href = '/login.html';
}

async function authFetch(url, options) {
  const token = getToken();
  if (!token) {
    redirectToLogin();
    return;
  }
  const opts = options || {};
  opts.headers = Object.assign({}, opts.headers || {}, {
    Authorization: `Bearer ${token}`,
  });
  const res = await fetch(url, opts);
  if (res.status === 401) {
    redirectToLogin();
    return;
  }
  return res;
}

if (!getToken()) {
  redirectToLogin();
}

const currentUser = localStorage.getItem(USER_KEY);
if (currentUser) {
  document.getElementById('userBadge').textContent = `👤 ${currentUser}`;
}

// ===== 业务逻辑 =====
let currentRange = '1w';
let useCustom = false;

const $ = (id) => document.getElementById(id);

// ===== 分组工具 =====
function getGroup(label) {
  if (label.startsWith('HBHC')) return 'HBHC';
  if (label.startsWith('HC')) return 'HC';
  if (label.startsWith('C')) return 'C';
  return 'other';
}

const groupConfig = {
  HC: { title: 'HC 组织', cls: 'group-hc' },
  C: { title: 'C 组织', cls: 'group-c' },
  HBHC: { title: 'HBHC 组织', cls: 'group-hbhc' },
  other: { title: '其他', cls: 'group-other' },
};

// ===== 汇总数据（按 HC/C/S 分组 + 排行） =====
async function loadSummary() {
  const container = $('summaryContainer');
  container.innerHTML = '<p class="empty">加载中...</p>';
  let url = '/api/summary?';
  if (useCustom) {
    url += `start=${$('startDate').value}&end=${$('endDate').value}`;
  } else {
    url += `range=${currentRange}`;
  }
  const search = $('searchInput').value.trim();
  if (search) url += `&search=${encodeURIComponent(search)}`;

  try {
    const res = await authFetch(url);
    if (!res) return;
    const json = await res.json();
    $('rangeLabel').textContent = `（${json.range.start} 至 ${json.range.end}）`;
    $('totalCount').textContent = `共 ${json.count} 人`;
    if (!json.data.length) {
      container.innerHTML = '<p class="empty">暂无数据</p>';
      return;
    }

    // 先分配全局排名（所有组织一起排序）
    json.data.forEach((r, i) => { r._rank = i + 1; });

    // 按 HC/C/HBHC/其他 分组（保留全局排名）
    const groups = { HC: [], C: [], HBHC: [], other: [] };
    json.data.forEach((r) => {
      const g = getGroup(r.label);
      groups[g].push(r);
    });

    // 渲染每组表格（显示全局排名）
    let html = '';
    for (const [gkey, items] of Object.entries(groups)) {
      if (!items.length) continue;
      const cfg = groupConfig[gkey];
      html += `<div class="group-section">`;
      html += `<div class="group-title ${cfg.cls}">${cfg.title}（${items.length} 人）</div>`;
      html += `<div class="table-wrap"><table style="width:100%;font-size:13px;table-layout:fixed;border-collapse:collapse;">
        <thead><tr>
          <th style="width:40px;">排名</th>
          <th>标注员</th>
          <th>原始时长(h)</th>
          <th>新任务(h)</th>
          <th>片段时长(h)</th>
          <th>无片段(h)</th>
          <th>无片段等效(h)</th>
          <th>结算参考(h)</th>
          <th>PASS占比</th>
          <th>累计参考(h)</th>
          <th>日均新任务(h)</th>
          <th>活跃天</th>
        </tr></thead><tbody>`;

      items.forEach((r) => {
        const rank = r._rank;
        const rankCls = rank <= 3 ? `rank-${rank}` : '';
        html += `<tr data-label="${r.label}">
          <td class="rank-cell ${rankCls}">${rank}</td>
          <td><strong>${r.label}</strong></td>
          <td class="num">${r.raw_hours}</td>
          <td class="num">${r.new_task_hours}</td>
          <td class="num">${r.segment_hours}</td>
          <td class="num">${r.no_clip_hours}</td>
          <td class="num">${r.no_clip_equivalent_hours}</td>
          <td class="num">${r.settlement_reference_hours}</td>
          <td class="num">${r.pass_ratio}%</td>
          <td class="num">${r.cumulative_reference_hours}</td>
          <td class="num"><strong>${r.daily_avg_raw_hours}</strong></td>
          <td class="num">${r.active_days}</td>
        </tr>`;
      });

      // 组织合计
      const sum = (key) => items.reduce((s, r) => s + (Number(r[key]) || 0), 0);
      const totRaw = sum('raw_hours');
      const totNew = sum('new_task_hours');
      const totSeg = sum('segment_hours');
      const totNoClip = sum('no_clip_hours');
      const totNoEq = sum('no_clip_equivalent_hours');
      const totSettl = sum('settlement_reference_hours');
      const totCum = sum('cumulative_reference_hours');
      const totDays = sum('active_days');
      const avgPass = totRaw > 0 ? Math.round(totSeg / totRaw * 1000) / 10 : 0;
      const r2 = (n) => Math.round(n * 1000) / 1000;
      html += `<tr style="background:#f0f0f0;font-weight:700;border-top:2px solid #999;">
        <td></td>
        <td>${gkey} 合计</td>
        <td class="num">${r2(totRaw)}</td>
        <td class="num">${r2(totNew)}</td>
        <td class="num">${r2(totSeg)}</td>
        <td class="num">${r2(totNoClip)}</td>
        <td class="num">${r2(totNoEq)}</td>
        <td class="num">${r2(totSettl)}</td>
        <td class="num">${avgPass}%</td>
        <td class="num">${r2(totCum)}</td>
        <td class="num">${r2(totNew > 0 && totDays > 0 ? totNew / (Math.max(...items.map(i => i.active_days)) || 1) : 0)}</td>
        <td class="num">${totDays}</td>
      </tr>`;

      html += '</tbody></table></div></div>';
    }

    container.innerHTML = html || '<p class="empty">暂无数据</p>';
    container.querySelectorAll('tr[data-label]').forEach((tr) => {
      tr.addEventListener('click', () => openDetail(tr.dataset.label));
    });
  } catch (e) {
    container.innerHTML = `<p class="empty">加载失败: ${e.message}</p>`;
  }
}

// ===== 明细 =====
async function openDetail(label) {
  $('detailTitle').textContent = `${label} 每日明细`;
  $('detailBody').innerHTML = '<tr><td colspan="9" class="empty">加载中...</td></tr>';
  $('detailModal').classList.add('show');
  let url = `/api/detail/${encodeURIComponent(label)}?`;
  if (useCustom) {
    url += `start=${$('startDate').value}&end=${$('endDate').value}`;
  } else {
    url += `range=${currentRange}`;
  }
  try {
    const res = await authFetch(url);
    if (!res) return;
    const json = await res.json();
    $('detailMeta').textContent =
      `原始标签: ${json.raw_label} · 平台累计参考: ${json.cumulative_reference_alltime_hours} h`;
    if (!json.daily.length) {
      $('detailBody').innerHTML = '<tr><td colspan="9" class="empty">该区间暂无数据</td></tr>';
      return;
    }
    $('detailBody').innerHTML = json.daily.map((d) => `
      <tr>
        <td>${d.date}</td>
        <td class="num">${d.raw_hours}</td>
        <td class="num">${d.new_task_hours}</td>
        <td class="num">${d.segment_hours}</td>
        <td class="num">${d.no_clip_hours}</td>
        <td class="num">${d.no_clip_equivalent_hours}</td>
        <td class="num">${d.settlement_reference_hours}</td>
        <td class="num">${d.pass_ratio}%</td>
        <td class="num">${d.cumulative_reference_hours}</td>
      </tr>
    `).join('');
  } catch (e) {
    $('detailBody').innerHTML = `<tr><td colspan="9" class="empty">加载失败: ${e.message}</td></tr>`;
  }
}

// ===== 导出 CSV =====
function exportCSV() {
  const token = getToken();
  if (!token) {
    redirectToLogin();
    return;
  }
  let url = '/api/export?';
  if (useCustom) {
    url += `start=${$('startDate').value}&end=${$('endDate').value}`;
  } else {
    url += `range=${currentRange}`;
  }
  const search = $('searchInput').value.trim();
  if (search) url += `&search=${encodeURIComponent(search)}`;
  url += `&token=${encodeURIComponent(token)}`;
  window.location.href = url;
}

// ===== 刷新(触发采集) =====
async function refreshData() {
  const btn = $('refreshBtn');
  btn.textContent = '采集中...'; btn.disabled = true;
  try {
    await authFetch('/api/collect', { method: 'POST' });
    setTimeout(() => { loadSummary(); loadStatus(); }, 5000);
  } catch (e) {
    alert('触发采集失败: ' + e.message);
  } finally {
    setTimeout(() => { btn.textContent = '刷新数据'; btn.disabled = false; }, 5000);
  }
}

// ===== 回填历史数据 =====
async function doBackfill() {
  const start = $('backfillStart').value;
  const end = $('backfillEnd').value;
  const resultDiv = $('backfillResult');
  const btn = $('doBackfill');

  if (!start || !end) {
    resultDiv.innerHTML = '<span style="color: red;">请选择起止日期</span>';
    return;
  }
  if (start > end) {
    resultDiv.innerHTML = '<span style="color: red;">起始日期不能晚于结束日期</span>';
    return;
  }

  // 检查日期范围不超过7天
  const diffDays = Math.ceil((new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24)) + 1;
  if (diffDays > 7) {
    resultDiv.innerHTML = '<span style="color: red;">每次最多回填7天，请缩小日期范围</span>';
    return;
  }

  btn.disabled = true;
  btn.textContent = '回填中...';
  resultDiv.innerHTML = `<span style="color: #666;">正在回填 ${start} 至 ${end}（共${diffDays}天），请耐心等待...</span>`;

  try {
    const res = await authFetch(`/api/backfill?start=${start}&end=${end}`);
    if (!res) return;
    const json = await res.json();
    if (json.ok) {
      resultDiv.innerHTML = `
        <div style="color: green; margin-bottom: 8px;">✓ ${json.message}</div>
        <div style="font-size: 12px; color: #999;">${(json.results || []).map(r => `${r.date}: ${r.count}人${r.error ? ' (错误: ' + r.error + ')' : ''}`).join('；')}</div>
      `;
      setTimeout(() => { loadSummary(); loadStatus(); }, 2000);
    } else {
      resultDiv.innerHTML = `<span style="color: red;">✗ ${json.error}</span>`;
    }
  } catch (e) {
    resultDiv.innerHTML = `<span style="color: red;">✗ 请求失败: ${e.message}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '开始回填';
  }
}

// ===== 状态栏 =====
async function loadStatus() {
  try {
    const res = await authFetch('/api/status');
    if (!res) return;
    const json = await res.json();
    const dot = $('statusDot');
    const txt = $('statusText');
    if (json.collecting) {
      dot.className = 'dot busy';
      txt.textContent = '正在采集数据...';
    } else {
      dot.className = 'dot live';
      const last = json.recent_logs && json.recent_logs[0];
      txt.textContent = last
        ? `数据 ${json.date_range.min} ~ ${json.date_range.max} · 共 ${json.annotator_count} 人 · 最近采集 ${fmtTime(last.created_at)}`
        : `共 ${json.annotator_count} 人`;
    }
    $('footStatus').textContent = `服务器时间: ${fmtTime(json.server_time)}`;
  } catch (e) {
    $('statusText').textContent = '状态获取失败';
  }
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function logout() {
  redirectToLogin();
}

// ===== 事件绑定 =====
$('rangeBtns').addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  document.querySelectorAll('#rangeBtns button').forEach((b) => b.classList.remove('active'));
  e.target.classList.add('active');
  currentRange = e.target.dataset.range;
  useCustom = false;
  loadSummary();
});

$('applyCustom').addEventListener('click', () => {
  if (!$('startDate').value || !$('endDate').value) {
    alert('请选择起止日期');
    return;
  }
  document.querySelectorAll('#rangeBtns button').forEach((b) => b.classList.remove('active'));
  useCustom = true;
  loadSummary();
});

let searchTimer;
$('searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadSummary, 350);
});

$('exportBtn').addEventListener('click', exportCSV);
$('refreshBtn').addEventListener('click', refreshData);
$('logoutBtn').addEventListener('click', logout);
$('closeModal').addEventListener('click', () => $('detailModal').classList.remove('show'));
$('detailModal').addEventListener('click', (e) => {
  if (e.target === $('detailModal')) $('detailModal').classList.remove('show');
});

// 回填弹窗事件
$('backfillBtn').addEventListener('click', () => {
  // 默认填入最近7天
  const today = new Date();
  const week = new Date(today);
  week.setDate(week.getDate() - 6);
  const p = (n) => String(n).padStart(2, '0');
  $('backfillStart').value = `${week.getFullYear()}-${p(week.getMonth() + 1)}-${p(week.getDate())}`;
  $('backfillEnd').value = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  $('backfillResult').innerHTML = '';
  $('backfillModal').classList.add('show');
});
$('closeBackfill').addEventListener('click', () => $('backfillModal').classList.remove('show'));
$('backfillModal').addEventListener('click', (e) => {
  if (e.target === $('backfillModal')) $('backfillModal').classList.remove('show');
});
$('doBackfill').addEventListener('click', doBackfill);

// ===== 初始化 =====
const today = new Date();
const p = (n) => String(n).padStart(2, '0');
const todayStr = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
$('startDate').value = todayStr;
$('endDate').value = todayStr;

loadSummary();
loadStatus();
setInterval(loadStatus, 60000);
