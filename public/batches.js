'use strict';
// 批次管理前端逻辑 v20260904：二级导航 / 状态彩标 / 筛选查询 / 统计卡 / 前端分页

const TOKEN_KEY = 'am_token';
const USER_KEY = 'am_user';

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function redirectToLogin() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  window.location.href = '/login.html';
}

async function authFetch(url, options) {
  const token = getToken();
  if (!token) { redirectToLogin(); return; }
  const opts = options || {};
  opts.headers = Object.assign({}, opts.headers || {}, { Authorization: `Bearer ${token}` });
  const res = await fetch(url, opts);
  if (res.status === 401) { redirectToLogin(); return; }
  return res;
}

if (!getToken()) { redirectToLogin(); }

const currentUser = localStorage.getItem(USER_KEY);
if (currentUser) { document.getElementById('userBadge').textContent = `👤 ${currentUser}`; }

const $ = (id) => document.getElementById(id);

// 状态枚举（平台英文已由后端映射为中文）
const STATUS_ORDER = ['已分发', '待审核', '预审核通过', '通过', '需修改', '已废弃'];
const statusClass = {
  '已分发': 'blue',
  '待审核': 'orange',
  '预审核通过': 'purple',
  '通过': 'green',
  '需修改': 'red warn',
  '已废弃': 'gray',
};
const statusColor = {
  '已分发': 'blue',
  '待审核': 'orange',
  '预审核通过': 'purple',
  '通过': 'green',
  '需修改': 'red',
  '已废弃': '',
};

// UTC ISO → 本地 YYYY/MM/DD HH:MM
function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let allBatches = [];
const state = { page: 1, pageSize: 100, filtered: [] };

// ===== 全量加载（内存筛选 + 分页）=====
async function loadAll() {
  $('batchBody').innerHTML = '<tr><td colspan="10" class="empty">加载中...</td></tr>';
  try {
    const res = await authFetch('/api/batches');
    if (!res) return;
    const json = await res.json();
    allBatches = (json.data || []).slice();
    buildProjectOptions();
    applyFilter();
  } catch (e) {
    $('batchBody').innerHTML = `<tr><td colspan="10" class="empty">加载失败: ${e.message}</td></tr>`;
  }
}

function buildProjectOptions() {
  const set = new Set(allBatches.map((b) => b.project_type).filter(Boolean));
  const sel = $('filterProject');
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部项目</option>' +
    [...set].sort().map((x) => `<option>${x}</option>`).join('');
  if (cur && set.has(cur)) sel.value = cur;
}

function applyFilter() {
  const status = $('filterStatus').value;
  const project = $('filterProject').value;
  const kw = $('filterKeyword').value.trim().toLowerCase();
  let list = allBatches.filter((b) => {
    if (status && b.status !== status) return false;
    if (project && b.project_type !== project) return false;
    if (kw) {
      const hay = [b.batch_id, b.annotator_label, b.project_type, b.task_combination].join(' ').toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
  state.filtered = list;
  state.page = 1;
  renderStats(list.length);
  renderTable(list);
}

// ===== 统计卡（点击可立即筛选对应状态）=====
function renderStats(total) {
  const count = {};
  allBatches.forEach((b) => { count[b.status] = (count[b.status] || 0) + 1; });
  const current = $('filterStatus').value;
  const card = (label, val, color, statusKey) => {
    const active = statusKey === undefined ? !current : current === statusKey;
    return `<div class="batch-stat-card${active ? ' active' : ''}" data-status="${statusKey === undefined ? '' : statusKey}">
      <div class="label">${label}</div><div class="value ${color || ''}">${val}</div></div>`;
  };
  let html = card('筛选结果', total);
  STATUS_ORDER.forEach((s) => { html += card(s, count[s] || 0, statusColor[s], s); });
  $('statsBar').innerHTML = html;
}

// ===== 表格渲染 =====
function renderTable(list) {
  $('resultCount').textContent = `共 ${list.length} 条`;
  const totalPages = Math.max(1, Math.ceil(list.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * state.pageSize;
  const pageItems = list.slice(start, start + state.pageSize);
  const tbody = $('batchBody');

  if (!pageItems.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">暂无批次记录，请点击「从平台自动采集批次」或手动添加</td></tr>';
    $('pager').innerHTML = '';
    return;
  }

  tbody.innerHTML = pageItems.map((b) => {
    const needFix = b.status === '需修改';
    const reviewHtml = b.review_result === '通过' ? '<span class="review-ok">通过</span>'
      : b.review_result === '需修改' ? '<span class="review-fix">需修改</span>'
      : '—';
    return `<tr class="${needFix ? 'row-need-fix' : ''}">
      <td><span class="batch-id">${b.batch_id || '-'}</span></td>
      <td>${b.project_type || '-'}</td>
      <td title="${(b.task_combination || '').replace(/"/g, '&quot;')}"><span class="batch-tc">${b.task_combination || '-'}</span></td>
      <td><span class="badge ${statusClass[b.status] || 'gray'}">${b.status || '-'}</span></td>
      <td>${reviewHtml}</td>
      <td>${b.reviewer || '-'}</td>
      <td><strong>${b.annotator_label}</strong></td>
      <td class="num">${b.round ?? 0}</td>
      <td class="batch-created">${fmtTime(b.platform_created_at || b.created_at)}</td>
      <td class="center">
        <button class="op-btn" data-edit="${b.id}">编辑</button>
        <button class="op-btn danger" data-del="${b.id}">删除</button>
      </td>
    </tr>`;
  }).join('');

  let pager = `<span>第 ${state.page} / ${totalPages} 页</span>`;
  pager += `<button ${state.page <= 1 ? 'disabled' : ''} data-pg="${state.page - 1}">上一页</button>`;
  pager += `<button ${state.page >= totalPages ? 'disabled' : ''} data-pg="${state.page + 1}">下一页</button>`;
  pager += `<span>每页 ${state.pageSize} 条</span>`;
  $('pager').innerHTML = pager;
}

// ===== 添加批次 =====
async function addBatch() {
  const body = {
    batch_id: $('f_batch_id').value.trim(),
    annotator_label: $('f_annotator').value.trim(),
    project_type: $('f_project').value,
    task_combination: $('f_task_combination').value.trim(),
    status: $('f_status').value,
    review_result: $('f_review_result').value,
    reviewer: $('f_reviewer').value.trim(),
    round: $('f_round').value,
    progress_current: $('f_progress_current').value,
    progress_total: $('f_progress_total').value,
    date: $('f_date').value,
    note: $('f_note').value.trim(),
  };

  if (!body.annotator_label) { alert('请填写标注员'); return; }
  if (!body.date) { alert('请选择日期'); return; }

  try {
    const res = await authFetch('/api/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res) return;
    const json = await res.json();
    if (json.ok) {
      alert('添加成功');
      $('f_batch_id').value = '';
      $('f_annotator').value = '';
      $('f_task_combination').value = '';
      $('f_note').value = '';
      $('f_progress_current').value = '0';
      $('f_progress_total').value = '0';
      $('f_round').value = '0';
      $('addFormPanel').style.display = 'none';
      $('toggleAddForm').textContent = '＋ 手动添加';
      loadAll();
    } else {
      alert('添加失败: ' + (json.error || '未知错误'));
    }
  } catch (e) {
    alert('请求失败: ' + e.message);
  }
}

// ===== 编辑批次 =====
function openEdit(id) {
  const b = allBatches.find((x) => String(x.id) === String(id));
  if (!b) { alert('未找到批次'); return; }
  $('e_id').value = b.id;
  $('e_batch_id').value = b.batch_id || '';
  $('e_annotator').value = b.annotator_label || '';
  $('e_project').value = b.project_type || '';
  $('e_task_combination').value = b.task_combination || '';
  $('e_status').value = b.status || '已分发';
  $('e_review_result').value = b.review_result || '';
  $('e_reviewer').value = b.reviewer || '';
  $('e_round').value = b.round || 0;
  $('e_progress_current').value = b.progress_current || 0;
  $('e_progress_total').value = b.progress_total || 0;
  $('e_date').value = b.date || '';
  $('e_note').value = b.note || '';
  $('editResult').textContent = '';
  $('editModal').classList.add('show');
}

async function saveEdit() {
  const id = $('e_id').value;
  const body = {
    batch_id: $('e_batch_id').value.trim(),
    annotator_label: $('e_annotator').value.trim(),
    project_type: $('e_project').value,
    task_combination: $('e_task_combination').value.trim(),
    status: $('e_status').value,
    review_result: $('e_review_result').value,
    reviewer: $('e_reviewer').value.trim(),
    round: $('e_round').value,
    progress_current: $('e_progress_current').value,
    progress_total: $('e_progress_total').value,
    date: $('e_date').value,
    note: $('e_note').value.trim(),
  };

  try {
    const res = await authFetch(`/api/batches?id=${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res) return;
    const json = await res.json();
    if (json.ok) {
      $('editModal').classList.remove('show');
      loadAll();
    } else {
      alert('保存失败: ' + (json.error || '未知错误'));
    }
  } catch (e) {
    alert('请求失败: ' + e.message);
  }
}

// ===== 删除批次 =====
async function delBatch(id) {
  if (!confirm('确定删除这条批次记录吗？')) return;
  try {
    const res = await authFetch(`/api/batches?id=${id}`, { method: 'DELETE' });
    if (!res) return;
    const json = await res.json();
    if (json.ok) {
      loadAll();
    } else {
      alert('删除失败: ' + (json.error || '未知错误'));
    }
  } catch (e) {
    alert('请求失败: ' + e.message);
  }
}

// ===== 自动采集批次 =====
async function autoCollect() {
  const btn = $('autoCollectBtn');
  const status = $('collectStatus');
  btn.disabled = true;
  btn.textContent = '采集中...';
  btn.style.background = '#999';
  status.innerHTML = '<span style="color:#1565c0;">正在从平台拉取批次数据，请稍候...</span>';

  try {
    const res = await authFetch('/api/collect-batches', { method: 'POST' });
    if (!res) return;
    const json = await res.json();
    if (json.ok) {
      const summary = json.status_summary ? Object.entries(json.status_summary)
        .map(([k, v]) => `${k}: ${v}`).join('，') : '';
      status.innerHTML = `<span style="color:#2e7d32;">✓ ${json.message}${summary ? '（' + summary + '）' : ''}</span>`;
      loadAll();
    } else {
      status.innerHTML = `<span style="color:#c62828;">✗ 采集失败: ${json.error || '未知错误'}</span>`;
    }
  } catch (e) {
    status.innerHTML = `<span style="color:#c62828;">✗ 请求失败: ${e.message}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '从平台自动采集批次';
    btn.style.background = '#1565c0';
  }
}

// ===== 事件绑定 =====
$('addBatchBtn').addEventListener('click', addBatch);
$('autoCollectBtn').addEventListener('click', autoCollect);
$('statsBar').addEventListener('click', (e) => {
  const el = e.target.closest('.batch-stat-card');
  if (!el) return;
  const status = el.dataset.status || '';
  $('filterStatus').value = status;
  applyFilter();
});
$('filterBtn').addEventListener('click', applyFilter);
$('clearFilterBtn').addEventListener('click', () => {
  $('filterStatus').value = '';
  $('filterProject').value = '';
  $('filterKeyword').value = '';
  applyFilter();
});
let kwTimer;
$('filterKeyword').addEventListener('input', () => {
  clearTimeout(kwTimer);
  kwTimer = setTimeout(applyFilter, 350);
});
$('filterStatus').addEventListener('change', applyFilter);
$('filterProject').addEventListener('change', applyFilter);

$('toggleAddForm').addEventListener('click', () => {
  const p = $('addFormPanel');
  const show = p.style.display === 'none';
  p.style.display = show ? 'block' : 'none';
  $('toggleAddForm').textContent = show ? '－ 收起添加' : '＋ 手动添加';
});
$('cancelAddBtn').addEventListener('click', () => {
  $('addFormPanel').style.display = 'none';
  $('toggleAddForm').textContent = '＋ 手动添加';
});

$('batchBody').addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-edit]');
  if (editBtn) { openEdit(editBtn.dataset.edit); return; }
  const delBtn = e.target.closest('[data-del]');
  if (delBtn) { delBatch(delBtn.dataset.del); }
});
$('pager').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pg]');
  if (!btn || btn.disabled) return;
  state.page = parseInt(btn.dataset.pg, 10);
  renderTable(state.filtered);
});

$('logoutBtn').addEventListener('click', redirectToLogin);
$('closeEdit').addEventListener('click', () => $('editModal').classList.remove('show'));
$('editModal').addEventListener('click', (e) => {
  if (e.target === $('editModal')) $('editModal').classList.remove('show');
});
$('saveEditBtn').addEventListener('click', saveEdit);

// ===== 初始化 =====
const today = new Date();
const p2 = (n) => String(n).padStart(2, '0');
$('f_date').value = `${today.getFullYear()}-${p2(today.getMonth() + 1)}-${p2(today.getDate())}`;

loadAll();
