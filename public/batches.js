'use strict';
// 批次管理前端逻辑

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

const statusClass = {
  '已分发': 'st-distributed',
  '待审核': 'st-pending',
  '已通过': 'st-passed',
  '需修改': 'st-rejected',
  '已驳回': 'st-rejected',
  '已废弃': 'st-abandoned',
};

// 获取分组
function getGroup(label) {
  if (label.startsWith('HC')) return 'HC';
  if (label.startsWith('C')) return 'C';
  if (label.startsWith('S')) return 'S';
  return 'other';
}

const groupConfig = {
  HC: { title: 'HC 开头账号', cls: 'section-hc' },
  C: { title: 'C 开头账号', cls: 'section-c' },
  S: { title: 'S 开头账号', cls: 'section-s' },
  other: { title: '其他账号', cls: 'section-other' },
};

// ===== 加载批次列表 =====
async function loadBatches() {
  const listDiv = $('batchList');
  listDiv.innerHTML = '<p class="empty">加载中...</p>';

  let url = '/api/batches?';
  const params = [];
  const filterDate = $('filterDate').value;
  const filterStatus = $('filterStatus').value;
  const filterGroup = $('filterGroup').value;
  if (filterDate) params.push(`date=${filterDate}`);
  if (filterStatus) params.push(`status=${encodeURIComponent(filterStatus)}`);
  if (filterGroup) params.push(`group=${filterGroup}`);
  url += params.join('&');

  try {
    const res = await authFetch(url);
    if (!res) return;
    const json = await res.json();
    if (!json.data.length) {
      listDiv.innerHTML = '<p class="empty">暂无批次记录，请在上方添加</p>';
      $('summaryBar').innerHTML = '';
      return;
    }

    // 汇总
    const summary = {};
    json.data.forEach((b) => { summary[b.status] = (summary[b.status] || 0) + 1; });
    $('summaryBar').innerHTML = Object.entries(summary).map(([k, v]) =>
      `<span class="summary-chip ${statusClass[k] || ''}">${k}: ${v}</span>`
    ).join('') + `<span class="summary-chip" style="background:#f5f5f5;color:#616161;">合计: ${json.count}</span>`;

    // 按日期分组（不按组织分组，按日期倒序）
    const byDate = {};
    json.data.forEach((b) => {
      if (!byDate[b.date]) byDate[b.date] = [];
      byDate[b.date].push(b);
    });

    let html = '';
    const sortedDates = Object.keys(byDate).sort().reverse();
    for (const date of sortedDates) {
      html += `<h3 style="margin:12px 0 6px;font-size:14px;color:#666;">${date}（${byDate[date].length} 条）</h3>`;
      html += renderBatchTable(byDate[date]);
    }

    listDiv.innerHTML = html || '<p class="empty">暂无批次记录</p>';

    // 绑定编辑/删除按钮
    listDiv.querySelectorAll('.btn-edit').forEach((btn) => {
      btn.addEventListener('click', () => openEdit(btn.dataset.id));
    });
    listDiv.querySelectorAll('.btn-del').forEach((btn) => {
      btn.addEventListener('click', () => delBatch(btn.dataset.id));
    });
  } catch (e) {
    listDiv.innerHTML = `<p class="empty">加载失败: ${e.message}</p>`;
  }
}

function renderBatchTable(items) {
  let html = `<div class="table-wrap"><table class="batch-table">
    <thead><tr>
      <th style="width:70px;">批次ID</th>
      <th style="width:70px;">标注员</th>
      <th style="width:110px;">项目类型</th>
      <th style="width:70px;">状态</th>
      <th style="width:70px;">审核结果</th>
      <th style="width:70px;">审核人</th>
      <th style="width:45px;">轮次</th>
      <th style="width:70px;">进度</th>
      <th style="text-align:left;">备注</th>
      <th style="width:90px;">操作</th>
    </tr></thead><tbody>`;
  for (const b of items) {
    const sc = statusClass[b.status] || '';
    html += `<tr>
      <td>${b.batch_id || '-'}</td>
      <td><strong>${b.annotator_label}</strong></td>
      <td>${b.project_type || '-'}</td>
      <td><span class="batch-status ${sc}">${b.status}</span></td>
      <td>${b.review_result || '—'}</td>
      <td>${b.reviewer || '—'}</td>
      <td style="text-align:center;">${b.round}</td>
      <td class="progress-cell">${b.progress_current}/${b.progress_total}</td>
      <td style="text-align:left;white-space:normal;word-break:break-word;">${b.note || ''}</td>
      <td>
        <button class="btn-edit" data-id="${b.id}">编辑</button>
        <button class="btn-del" data-id="${b.id}">删除</button>
      </td>
    </tr>`;
  }
  html += '</tbody></table></div>';
  return html;
}

// ===== 添加批次 =====
async function addBatch() {
  const body = {
    batch_id: $('f_batch_id').value.trim(),
    annotator_label: $('f_annotator').value.trim(),
    project_type: $('f_project').value,
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
      // 清空表单
      $('f_batch_id').value = '';
      $('f_annotator').value = '';
      $('f_note').value = '';
      $('f_progress_current').value = '0';
      $('f_progress_total').value = '0';
      $('f_round').value = '0';
      loadBatches();
    } else {
      alert('添加失败: ' + (json.error || '未知错误'));
    }
  } catch (e) {
    alert('请求失败: ' + e.message);
  }
}

// ===== 编辑批次 =====
async function openEdit(id) {
  // 获取数据填入编辑表单
  let url = '/api/batches?';
  const params = [];
  if ($('filterDate').value) params.push(`date=${$('filterDate').value}`);
  if ($('filterStatus').value) params.push(`status=${encodeURIComponent($('filterStatus').value)}`);
  if ($('filterGroup').value) params.push(`group=${$('filterGroup').value}`);
  url += params.join('&');

  try {
    const res = await authFetch(url);
    if (!res) return;
    const json = await res.json();
    const b = json.data.find((x) => String(x.id) === String(id));
    if (!b) { alert('未找到批次'); return; }

    $('e_id').value = b.id;
    $('e_batch_id').value = b.batch_id || '';
    $('e_annotator').value = b.annotator_label || '';
    $('e_project').value = b.project_type || '';
    $('e_status').value = b.status || '已分发';
    $('e_review_result').value = b.review_result || '';
    $('e_reviewer').value = b.reviewer || '';
    $('e_round').value = b.round || 0;
    $('e_progress_current').value = b.progress_current || 0;
    $('e_progress_total').value = b.progress_total || 0;
    $('e_date').value = b.date || '';
    $('e_note').value = b.note || '';

    $('editModal').classList.add('show');
  } catch (e) {
    alert('加载失败: ' + e.message);
  }
}

async function saveEdit() {
  const id = $('e_id').value;
  const body = {
    batch_id: $('e_batch_id').value.trim(),
    annotator_label: $('e_annotator').value.trim(),
    project_type: $('e_project').value,
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
      loadBatches();
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
      loadBatches();
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
      loadBatches();
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
$('filterBtn').addEventListener('click', loadBatches);
$('clearFilterBtn').addEventListener('click', () => {
  $('filterDate').value = '';
  $('filterStatus').value = '';
  $('filterGroup').value = '';
  loadBatches();
});
$('logoutBtn').addEventListener('click', redirectToLogin);
$('closeEdit').addEventListener('click', () => $('editModal').classList.remove('show'));
$('editModal').addEventListener('click', (e) => {
  if (e.target === $('editModal')) $('editModal').classList.remove('show');
});
$('saveEditBtn').addEventListener('click', saveEdit);

// ===== 初始化 =====
const today = new Date();
const p = (n) => String(n).padStart(2, '0');
const todayStr = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
$('f_date').value = todayStr;

loadBatches();
