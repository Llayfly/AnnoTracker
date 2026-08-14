'use strict';
// 薪资计算页面逻辑

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
  if (!token) { redirectToLogin(); return; }
  const opts = options || {};
  opts.headers = Object.assign({}, opts.headers || {}, { Authorization: `Bearer ${token}` });
  const res = await fetch(url, opts);
  if (res.status === 401) { redirectToLogin(); return; }
  return res;
}

if (!getToken()) {
  redirectToLogin();
}

const currentUser = localStorage.getItem(USER_KEY);
if (currentUser) {
  document.getElementById('userBadge').textContent = `👤 ${currentUser}`;
}

const $ = (id) => document.getElementById(id);

const GROUP_TITLES = { HC: 'HC 组织', C: 'C 组织', S: 'S 组织', OTHER: '其他' };

function renderGroup(groupKey, rows) {
  if (!rows.length) return '';

  // 计算小计
  const totalRaw = rows.reduce((s, r) => s + r.salary_raw, 0);
  const totalSettlement = rows.reduce((s, r) => s + r.salary_settlement, 0);
  const totalRawHours = rows.reduce((s, r) => s + r.raw_hours, 0);
  const totalSettlementHours = rows.reduce((s, r) => s + r.settlement_hours, 0);

  const rowsHtml = rows.map((r) => {
    const rawClass = r.recommended === 'raw' ? 'salary-high' : 'salary-low';
    const settleClass = r.recommended === 'settlement' ? 'salary-high' : 'salary-low';
    return `
      <tr class="${r.priority ? 'priority-row' : ''}">
        <td>${r.label}</td>
        <td class="num">${r.raw_hours}</td>
        <td class="num">${r.settlement_hours}</td>
        <td class="num">${r.new_task_hours}</td>
        <td class="num">${r.active_days}</td>
        <td class="num ${rawClass}">¥${r.salary_raw}</td>
        <td class="num ${settleClass}">¥${r.salary_settlement}</td>
        <td class="num" style="color:${r.salary_diff >= 0 ? '#2e7d32' : '#c62828'};">
          ${r.salary_diff >= 0 ? '+' : ''}¥${r.salary_diff}
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div class="group-section">
      <div class="group-title group-${groupKey.toLowerCase()}">
        ${GROUP_TITLES[groupKey]} <span class="group-count">(${rows.length}人)</span>
      </div>
      <div class="table-wrap">
        <table class="salary-table">
          <thead>
            <tr>
              <th>标注员</th>
              <th>原始时长(h)</th>
              <th>结算参考(h)</th>
              <th>新任务(h)</th>
              <th>活跃天</th>
              <th>方式一<br/><small>原始阶梯</small></th>
              <th>方式二<br/><small>结算32/h</small></th>
              <th>差额<br/><small>二-一</small></th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
            <tr class="total-row">
              <td>小计</td>
              <td class="num">${Math.round(totalRawHours * 100) / 100}</td>
              <td class="num">${Math.round(totalSettlementHours * 100) / 100}</td>
              <td class="num">-</td>
              <td class="num">-</td>
              <td class="num">¥${Math.round(totalRaw * 100) / 100}</td>
              <td class="num">¥${Math.round(totalSettlement * 100) / 100}</td>
              <td class="num" style="color:${totalSettlement - totalRaw >= 0 ? '#2e7d32' : '#c62828'};">
                ${totalSettlement - totalRaw >= 0 ? '+' : ''}¥${Math.round((totalSettlement - totalRaw) * 100) / 100}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function loadSalary() {
  const container = $('salaryContainer');
  container.innerHTML = '<p class="empty">加载中...</p>';

  const start = $('startDate').value;
  const end = $('endDate').value;
  if (!start || !end) {
    container.innerHTML = '<p class="empty">请选择日期范围</p>';
    return;
  }

  const url = `/api/salary?start=${start}&end=${end}`;
  try {
    const res = await authFetch(url);
    if (!res) return;
    const json = await res.json();

    $('totalCount').textContent = `${json.count} 人`;

    let totalRaw = 0, totalSettlement = 0;
    const groups = json.groups;
    for (const key of ['HC', 'C', 'S', 'OTHER']) {
      for (const r of groups[key]) {
        totalRaw += r.salary_raw;
        totalSettlement += r.salary_settlement;
      }
    }
    $('totalSalaryRaw').textContent = `¥${Math.round(totalRaw * 100) / 100}`;
    $('totalSalarySettlement').textContent = `¥${Math.round(totalSettlement * 100) / 100}`;

    let html = '';
    for (const key of ['HC', 'C', 'S', 'OTHER']) {
      if (groups[key] && groups[key].length) {
        html += renderGroup(key, groups[key]);
      }
    }
    container.innerHTML = html || '<p class="empty">暂无数据</p>';
  } catch (e) {
    container.innerHTML = `<p class="empty">加载失败: ${e.message}</p>`;
  }
}

function setThisMonth() {
  const today = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('startDate').value = `${today.getFullYear()}-${p(today.getMonth() + 1)}-01`;
  $('endDate').value = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
}

// 事件绑定
$('applyBtn').addEventListener('click', loadSalary);
$('thisMonthBtn').addEventListener('click', () => { setThisMonth(); loadSalary(); });
$('logoutBtn').addEventListener('click', redirectToLogin);

// 初始化：默认本月
setThisMonth();
loadSalary();
