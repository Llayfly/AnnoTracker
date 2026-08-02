'use strict';
// 前端逻辑：认证、查询、渲染、明细、导出

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

// 带认证的 fetch 封装，自动添加 Authorization 头，401 时跳转登录
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

// 页面加载时检查登录状态
if (!getToken()) {
  redirectToLogin();
}

// 显示用户名
const currentUser = localStorage.getItem(USER_KEY);
if (currentUser) {
  document.getElementById('userBadge').textContent = `👤 ${currentUser}`;
}

// ===== 业务逻辑 =====
let currentRange = '1w';
let useCustom = false;

const $ = (id) => document.getElementById(id);
const levelText = { red: '预警', blue: '正常', green: '活跃' };

// ===== 汇总数据 =====
async function loadSummary() {
  const body = $('summaryBody');
  body.innerHTML = '<tr><td colspan="10" class="empty">加载中...</td></tr>';
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
      body.innerHTML = '<tr><td colspan="10" class="empty">暂无数据</td></tr>';
      return;
    }
    body.innerHTML = json.data.map((r) => `
      <tr class="row-${r.level}" data-label="${r.label}">
        <td><strong>${r.label}</strong></td>
        <td class="num">${r.raw_hours}</td>
        <td class="num">${r.segment_hours}</td>
        <td class="num">${r.no_clip_hours}</td>
        <td class="num">${r.no_clip_equivalent_hours}</td>
        <td class="num">${r.settlement_reference_hours}</td>
        <td class="num">${r.cumulative_reference_hours}</td>
        <td class="num"><strong>${r.daily_avg_raw_hours}</strong></td>
        <td class="num">${r.active_days}</td>
        <td><span class="badge ${r.level}">${levelText[r.level]}</span></td>
      </tr>
    `).join('');
    // 绑定点击事件
    body.querySelectorAll('tr[data-label]').forEach((tr) => {
      tr.addEventListener('click', () => openDetail(tr.dataset.label));
    });
  } catch (e) {
    body.innerHTML = `<tr><td colspan="10" class="empty">加载失败: ${e.message}</td></tr>`;
  }
}

// ===== 明细 =====
async function openDetail(label) {
  $('detailTitle').textContent = `${label} 每日明细`;
  $('detailBody').innerHTML = '<tr><td colspan="7" class="empty">加载中...</td></tr>';
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
      `原始标签: ${json.raw_label} · 区间累计参考: ${json.latest_cumulative_reference_hours} h`;
    if (!json.daily.length) {
      $('detailBody').innerHTML = '<tr><td colspan="7" class="empty">该区间暂无数据</td></tr>';
      return;
    }
    $('detailBody').innerHTML = json.daily.map((d) => `
      <tr>
        <td>${d.date}</td>
        <td class="num">${d.raw_hours}</td>
        <td class="num">${d.segment_hours}</td>
        <td class="num">${d.no_clip_hours}</td>
        <td class="num">${d.no_clip_equivalent_hours}</td>
        <td class="num">${d.settlement_reference_hours}</td>
        <td class="num">${d.cumulative_reference_hours}</td>
      </tr>
    `).join('');
  } catch (e) {
    $('detailBody').innerHTML = `<tr><td colspan="7" class="empty">加载失败: ${e.message}</td></tr>`;
  }
}

// ===== 导出 CSV（通过 token 查询参数下载）=====
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
    // 等待几秒后重新加载
    setTimeout(() => { loadSummary(); loadStatus(); }, 5000);
  } catch (e) {
    alert('触发采集失败: ' + e.message);
  } finally {
    setTimeout(() => { btn.textContent = '刷新数据'; btn.disabled = false; }, 5000);
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

// ===== 登出 =====
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

// ===== 初始化 =====
// 默认日期填今天
const today = new Date();
const p = (n) => String(n).padStart(2, '0');
const todayStr = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
$('startDate').value = todayStr;
$('endDate').value = todayStr;

loadSummary();
loadStatus();
setInterval(loadStatus, 60000);
