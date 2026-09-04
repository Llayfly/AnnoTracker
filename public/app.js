'use strict';
// 前端逻辑（新快照系统）：认证、查询、渲染、明细、手动录入、导出、刷新

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

const p = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;

// ===== 分组工具（大小写不敏感）=====
function getGroup(label) {
  const u = String(label || '').toUpperCase();
  if (u.startsWith('HBHC')) return 'HBHC';
  if (u.startsWith('HC')) return 'HC';
  if (u.startsWith('JS')) return 'JS';
  if (u.startsWith('S')) return 'S';
  if (u.startsWith('C')) return 'C';
  return 'other';
}

const groupConfig = {
  HC: { title: 'HC 组织', cls: 'group-hc' },
  C: { title: 'C 组织', cls: 'group-c' },
  HBHC: { title: 'HBHC 组织', cls: 'group-hbhc' },
  S: { title: 'S 组织', cls: 'group-s' },
  JS: { title: 'JS 组织', cls: 'group-js' },
  other: { title: '其他', cls: 'group-other' },
};

const r2 = (n) => Math.round(n * 100) / 100;

// 历史数据列（2026-08-22 及之前，原始时长 = 新任务 + 旧任务）
const OLD_COLUMNS = [
  { title: '排名', w: '40px' },
  { title: '标注员' },
  { title: '原始时长(h)', field: 'raw_hours' },
  { title: '新任务(h)', field: 'new_task_hours' },
  { title: '旧任务(h)', field: 'old_task_hours' },
  { title: '片段时长(h)', field: 'segment_hours' },
  {
    title: 'PASS占比',
    render: (r) => (Number(r.pass_ratio) || 0) + '%',
    total: (items) => {
      const s = items.reduce((a, r) => a + (Number(r.raw_hours) || 0), 0);
      const seg = items.reduce((a, r) => a + (Number(r.segment_hours) || 0), 0);
      return s > 0 ? Math.round(seg / s * 1000) / 10 + '%' : '0%';
    },
  },
  { title: '累计参考(h)', field: 'cumulative_reference_hours' },
  {
    title: '日均新任务(h)',
    render: (r) => (Number(r.daily_avg_raw_hours) || 0),
    total: (items) => {
      const totNew = items.reduce((a, r) => a + (Number(r.new_task_hours) || 0), 0);
      const maxDays = Math.max(...items.map((i) => Number(i.active_days) || 0), 1);
      return r2(totNew / maxDays);
    },
  },
];

// 新数据列（2026-08-23 起，原始时长 = 新任务之和）
const NEW_COLUMNS = [
  { title: '排名', w: '40px' },
  { title: '标注员' },
  { title: '原始时长(h)', field: 'raw_hours' },
  { title: '旧任务(h)', field: 'old_task_hours' },
  { title: '片段时长(h)', field: 'segment_hours' },
  {
    title: 'PASS占比',
    render: (r) => (Number(r.pass_ratio) || 0) + '%',
    total: (items) => {
      const s = items.reduce((a, r) => a + (Number(r.raw_hours) || 0), 0);
      const seg = items.reduce((a, r) => a + (Number(r.segment_hours) || 0), 0);
      return s > 0 ? Math.round(seg / s * 1000) / 10 + '%' : '0%';
    },
  },
  { title: '结算参考(h)', field: 'settlement_reference_hours' },
  { title: '日均新任务(h)', render: (r) => (Number(r.daily_avg_raw_hours) || 0), total: () => '-' },
];

// 渲染一组标注员：柱状图 + 分组织表格
function renderGroups(rows, opts) {
  if (!rows.length) return '';
  rows.forEach((r, i) => { r._rank = i + 1; });
  const groups = { HC: [], C: [], HBHC: [], S: [], JS: [], other: [] };
  rows.forEach((r) => { groups[getGroup(r.label)].push(r); });

  const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2).replace(/\.?0+$/, '');

  let html = '';
  for (const [gkey, items] of Object.entries(groups)) {
    if (!items.length) continue;
    const cfg = groupConfig[gkey];
    html += `<div class="group-section">`;
    html += `<div class="group-title ${cfg.cls}">${cfg.title}（${items.length} 人）</div>`;

    // 柱状图：历史数据 = 新任务(蓝)+旧任务(黄)双色堆叠；新数据 = 单色；时长写进柱内
    const split = !!opts.split;
    const chartField = opts.chartField || 'raw_hours';
    const totalOf = (i) => split
      ? (Number(i.new_task_hours) || 0) + (Number(i.old_task_hours) || 0)
      : (Number(i[chartField]) || 0);
    const chartItems = items.slice().sort((a, b) => totalOf(b) - totalOf(a));
    const maxV = Math.max(...chartItems.map(totalOf), 0.001);

    html += `<div class="group-chart">`;
    if (split) {
      html += `<div class="chart-legend"><span><i class="lg-new"></i>新任务(h)</span><span><i class="lg-old"></i>旧任务(h)</span></div>`;
    }
    html += chartItems.map((r) => {
      if (split) {
        const vNew = Number(r.new_task_hours) || 0;
        const vOld = Number(r.old_task_hours) || 0;
        const pctNew = Math.max(Math.round(vNew / maxV * 100), vNew > 0 ? 2 : 0);
        const pctOld = Math.max(Math.round(vOld / maxV * 100), vOld > 0 ? 2 : 0);
        return `<div class="chart-row" title="${r.label} ${opts.chartTitle}：新任务 ${f2(vNew)}h / 旧任务 ${f2(vOld)}h">
          <span class="chart-label">${r.label}</span>
          <div class="chart-track">
            <div class="chart-bar bar-new" style="width:${pctNew}%">${pctNew >= 12 ? `<span class="bar-label">${f2(vNew)}h</span>` : ''}</div>
            <div class="chart-bar bar-old" style="width:${pctOld}%">${pctOld >= 14 ? `<span class="bar-label">${f2(vOld)}h</span>` : ''}</div>
          </div>
          <span class="chart-value"><span class="cv-new">新 ${f2(vNew)}</span><span class="cv-old">旧 ${f2(vOld)}</span></span>
        </div>`;
      }
      const v = Number(r[chartField]) || 0;
      const pct = Math.max(Math.round(v / maxV * 100), v > 0 ? 2 : 0);
      return `<div class="chart-row" title="${r.label} ${opts.chartTitle} ${f2(v)} h">
        <span class="chart-label">${r.label}</span>
        <div class="chart-track"><div class="chart-bar bar-new" style="width:${pct}%">${pct >= 14 ? `<span class="bar-label">${f2(v)}h</span>` : ''}</div></div>
        <span class="chart-value"><span class="cv-new">${f2(v)}h</span></span>
      </div>`;
    }).join('');
    html += `</div>`;

    // 表格
    html += `<div class="table-wrap"><table style="width:100%;font-size:13px;table-layout:fixed;border-collapse:collapse;">
      <thead><tr>`;
    html += opts.columns.map((c) => `<th style="${c.w ? 'width:' + c.w + ';' : ''}">${c.title}</th>`).join('');
    html += `</tr></thead><tbody>`;

    items.forEach((r) => {
      const rank = r._rank;
      const rankCls = rank <= 3 ? `rank-${rank}` : '';
      html += `<tr data-label="${r.label}">`;
      html += `<td class="rank-cell ${rankCls}">${rank}</td>`;
      html += `<td><strong>${r.label}</strong></td>`;
      for (const c of opts.columns.slice(2)) {
        html += `<td class="num">${c.render ? c.render(r) : r[c.field]}</td>`;
      }
      html += `</tr>`;
    });

    // 组织合计
    html += `<tr style="background:#f0f0f0;font-weight:700;border-top:2px solid #999;">
      <td></td><td>${gkey} 合计</td>`;
    for (const c of opts.columns.slice(2)) {
      if (c.total) {
        html += `<td class="num">${c.total(items)}</td>`;
      } else if (c.field) {
        html += `<td class="num">${r2(items.reduce((s, r) => s + (Number(r[c.field]) || 0), 0))}</td>`;
      } else {
        html += `<td class="num"></td>`;
      }
    }
    html += `</tr>`;

    html += '</tbody></table></div></div>';
  }
  return html;
}

// ===== 汇总数据 =====
async function loadSummary() {
  const container = $('summaryContainer');
  container.innerHTML = '<p class="empty">加载中...</p>';
  let url = '/api/snapshot?';
  if (useCustom) {
    url += `start=${$('startDate').value}&end=${$('endDate').value}`;
  } else {
    const { start, end } = getDisplayRange();
    url += `start=${start}&end=${end}`;
  }
  const search = $('searchInput').value.trim();
  if (search) url += `&search=${encodeURIComponent(search)}`;
  const period = $('periodFilter').value;
  if (period && period !== 'all') url += `&period=${period}`;

  try {
    const res = await authFetch(url);
    if (!res) return;
    const json = await res.json();
    if (!json) {
      container.innerHTML = '<p class="empty">暂无数据</p>';
      return;
    }
    $('rangeLabel').textContent = `（${json.range.start} 至 ${json.range.end}）`;
    const oldRows = json.old || [];
    const newRows = json.new || [];
    $('totalCount').textContent = `共 ${oldRows.length + newRows.length} 人`;

    let html = '';
    if (oldRows.length) {
      html += `<div class="section-divider old">历史数据（2026-08-22 及之前）· 原始时长 = 新任务 + 旧任务</div>`;
      html += renderGroups(oldRows, {
        chartField: 'new_task_hours',
        chartTitle: '历史',
        split: true,
        columns: OLD_COLUMNS,
      });
    }
    if (newRows.length) {
      html += `<div class="section-divider new">新数据（2026-08-23 起）· 原始时长 = 新任务之和</div>`;
      html += renderGroups(newRows, {
        chartField: 'raw_hours',
        chartTitle: '原始时长',
        columns: NEW_COLUMNS,
      });
    }
    if (!html) {
      container.innerHTML = '<p class="empty">该区间暂无数据</p>';
      return;
    }
    container.innerHTML = html;
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
  $('detailBody').innerHTML = '<tr><td colspan="8" class="empty">加载中...</td></tr>';
  $('detailModal').classList.add('show');
  let url = `/api/snapshot?mode=detail&label=${encodeURIComponent(label)}&`;
  if (useCustom) {
    url += `start=${$('startDate').value}&end=${$('endDate').value}`;
  } else {
    const { start, end } = getDisplayRange();
    url += `start=${start}&end=${end}`;
  }
  try {
    const res = await authFetch(url);
    if (!res) return;
    const json = await res.json();
    if (!json || !json.daily) {
      $('detailBody').innerHTML = `<tr><td colspan="8" class="empty">${(json && json.error) ? '加载失败: ' + json.error : '该区间暂无数据'}</td></tr>`;
      return;
    }
    $('detailMeta').textContent = `原始标签: ${json.raw_label} · 区间 ${json.range.start} ~ ${json.range.end}`;
    if (!json.daily.length) {
      $('detailBody').innerHTML = '<tr><td colspan="8" class="empty">该区间暂无数据</td></tr>';
      return;
    }
    $('detailBody').innerHTML = json.daily.map((d) => {
      const srcText = d.source === 'old' ? '历史' : (d.source === 'manual' ? '手动' : '自动');
      const srcCls = d.source === 'old' ? 'src-old' : (d.source === 'manual' ? 'src-manual' : 'src-auto');
      return `
        <tr>
          <td>${d.date}</td>
          <td class="num"><strong>${d.raw_hours}</strong></td>
          <td class="num">${d.new_task_hours}</td>
          <td class="num">${d.old_task_hours}</td>
          <td class="num">${d.segment_hours}</td>
          <td class="num">${d.pass_ratio}%</td>
          <td class="num">${d.settlement_reference_hours}</td>
          <td><span class="src-badge ${srcCls}">${srcText}</span></td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    $('detailBody').innerHTML = `<tr><td colspan="8" class="empty">加载失败: ${e.message}</td></tr>`;
  }
}

// ===== 导出 CSV =====
function exportCSV() {
  const token = getToken();
  if (!token) {
    redirectToLogin();
    return;
  }
  let url = '/api/snapshot?mode=export&';
  if (useCustom) {
    url += `start=${$('startDate').value}&end=${$('endDate').value}`;
  } else {
    const { start, end } = getDisplayRange();
    url += `start=${start}&end=${end}`;
  }
  const search = $('searchInput').value.trim();
  if (search) url += `&search=${encodeURIComponent(search)}`;
  const period = $('periodFilter').value;
  if (period && period !== 'all') url += `&period=${period}`;
  url += `&token=${encodeURIComponent(token)}`;
  window.location.href = url;
}

// ===== 日期区间 =====
function getDisplayRange() {
  if (useCustom) {
    return { start: $('startDate').value, end: $('endDate').value };
  }
  const today = new Date();
  const days = { '1d': 1, '3d': 3, '1w': 7, '15d': 15, '1m': 30 }[currentRange] || 7;
  const sd = new Date(today);
  sd.setDate(sd.getDate() - (days - 1));
  return { start: fmt(sd), end: fmt(today) };
}

// ===== 刷新(触发采集) =====
async function refreshData() {
  const btn = $('refreshBtn');
  btn.textContent = '采集中...'; btn.disabled = true;
  try {
    const res = await authFetch('/api/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res || !res.ok) {
      let msg = '网络错误';
      try {
        const ct = (res && res.headers.get('content-type')) || '';
        if (ct.includes('application/json')) {
          const j = await res.json();
          msg = j.error || `HTTP ${res.status}`;
        } else {
          msg = `服务异常（HTTP ${res.status}），请稍后重试`;
        }
      } catch (e) {
        msg = `服务异常（HTTP ${res.status}）`;
      }
      alert('采集失败: ' + msg);
      return;
    }
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    loadSummary();
    loadStatus();
    alert(json.message || '采集完成');
  } catch (e) {
    alert('触发采集失败: ' + e.message);
  } finally {
    btn.textContent = '刷新数据';
    btn.disabled = false;
  }
}

// ===== 手动录入 =====
function openManualModal() {
  $('mDate').value = fmt(new Date());
  $('mLabel').value = '';
  $('mNew').value = '';
  $('mOld').value = '';
  $('mSeg').value = '';
  $('mNoClip').value = '';
  $('mPass').value = '';
  $('manualResult').innerHTML = '';
  $('manualModal').classList.add('show');
}

async function saveManual() {
  const body = {
    date: $('mDate').value,
    label: $('mLabel').value.trim(),
    newTaskHours: $('mNew').value,
    oldTaskHours: $('mOld').value,
    segmentHours: $('mSeg').value,
    noClipHours: $('mNoClip').value,
    passSegmentHours: $('mPass').value,
  };
  if (!body.date || !body.label) {
    $('manualResult').innerHTML = '<span style="color:red;">请填写日期和标注员</span>';
    return;
  }
  try {
    const res = await authFetch('/api/snapshot?mode=manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res) return;
    const json = await res.json();
    if (!res.ok) {
      $('manualResult').innerHTML = `<span style="color:red;">保存失败: ${json.error || '未知错误'}</span>`;
      return;
    }
    $('manualResult').innerHTML = `<span style="color:green;">✓ ${json.message}</span>`;
    loadSummary();
  } catch (e) {
    $('manualResult').innerHTML = `<span style="color:red;">保存失败: ${e.message}</span>`;
  }
}

async function deleteManual() {
  const body = {
    date: $('mDate').value,
    label: $('mLabel').value.trim(),
  };
  if (!body.date || !body.label) {
    $('manualResult').innerHTML = '<span style="color:red;">请填写日期和标注员</span>';
    return;
  }
  if (!confirm(`确认删除 ${body.label} ${body.date} 的快照记录？`)) return;
  try {
    const res = await authFetch('/api/snapshot?mode=manual', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res) return;
    const json = await res.json();
    $('manualResult').innerHTML = json.ok
      ? `<span style="color:green;">✓ ${json.message}</span>`
      : `<span style="color:red;">删除失败: ${json.error || '未知错误'}</span>`;
    loadSummary();
  } catch (e) {
    $('manualResult').innerHTML = `<span style="color:red;">删除失败: ${e.message}</span>`;
  }
}

// ===== 状态栏 =====
async function loadStatus() {
  try {
    const res = await authFetch('/api/status');
    if (!res) return;
    const json = await res.json();
    if (!json) return;
    const dot = $('statusDot');
    const txt = $('statusText');
    if (json.collecting) {
      dot.className = 'dot busy';
      txt.textContent = '正在采集数据...';
    } else {
      dot.className = 'dot live';
      const last = json.recent_logs && json.recent_logs[0];
      const dr = json.date_range || {};
      const odr = json.old_date_range || {};
      const rangeText = (odr.min ? `历史 ${odr.min}~${odr.max} · ` : '') + `新数据 ${dr.min || '-'}~${dr.max || '-'}`;
      txt.textContent = last
        ? `${rangeText} · 共 ${json.annotator_count} 人 · 最近采集 ${fmtTime(last.created_at)}`
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

$('periodFilter').addEventListener('change', loadSummary);

$('exportBtn').addEventListener('click', exportCSV);
$('refreshBtn').addEventListener('click', refreshData);
$('logoutBtn').addEventListener('click', logout);
$('closeModal').addEventListener('click', () => $('detailModal').classList.remove('show'));
$('detailModal').addEventListener('click', (e) => {
  if (e.target === $('detailModal')) $('detailModal').classList.remove('show');
});

// 手动录入事件
$('manualBtn').addEventListener('click', openManualModal);
$('closeManual').addEventListener('click', () => $('manualModal').classList.remove('show'));
$('manualModal').addEventListener('click', (e) => {
  if (e.target === $('manualModal')) $('manualModal').classList.remove('show');
});
$('mSave').addEventListener('click', saveManual);
$('mDelete').addEventListener('click', deleteManual);

// ===== 初始化 =====
const today = new Date();
const weekAgo = new Date(today);
weekAgo.setDate(weekAgo.getDate() - 6);
$('startDate').value = fmt(weekAgo);
$('endDate').value = fmt(today);

loadSummary();
loadStatus();
setInterval(loadStatus, 60000);
