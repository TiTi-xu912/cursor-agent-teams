const state = {
  teams: [],
  selectedId: new URLSearchParams(location.search).get("team"),
  selected: null,
};

const $ = (selector) => document.querySelector(selector);
const teamList = $("#team-list");
const workspace = $("#workspace");
const empty = $("#empty");
const template = $("#team-button-template");

const statusLabels = {
  draft: "草案",
  running: "运行中",
  halted: "已停止",
  completed: "已完成",
  archived: "已归档",
  idle: "空闲",
  offline: "离线",
  failed: "异常",
  removed: "已移除",
  pending: "等待",
  claimed: "已领取",
  in_progress: "执行中",
  cancelled: "已取消",
};

async function refresh() {
  try {
    const response = await fetch("/api/teams", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.teams = await response.json();
    $("#connection").textContent = "本地状态已连接";
    renderTeamList();

    if (!state.selectedId && state.teams.length) {
      state.selectedId = state.teams[0].id;
    }
    if (state.selectedId) await loadTeam(state.selectedId);
    else showEmpty();
  } catch (error) {
    $("#connection").textContent = `状态读取失败：${error.message}`;
  }
}

async function loadTeam(teamId) {
  try {
    const response = await fetch(`/api/teams/${encodeURIComponent(teamId)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.selected = await response.json();
    state.selectedId = teamId;
    history.replaceState(null, "", `?team=${encodeURIComponent(teamId)}`);
    renderTeamList();
    renderTeam();
  } catch (error) {
    $("#connection").textContent = `团队读取失败：${error.message}`;
  }
}

function renderTeamList() {
  teamList.replaceChildren();
  for (const team of state.teams) {
    const button = template.content.firstElementChild.cloneNode(true);
    button.dataset.status = team.status;
    button.setAttribute("aria-current", String(team.id === state.selectedId));
    button.querySelector("strong").textContent = team.name;
    button.querySelector("small").textContent =
      statusLabels[team.status] ?? team.status;
    button.querySelector(".team-button-count").textContent =
      String(team.memberCount).padStart(2, "0");
    button.addEventListener("click", () => loadTeam(team.id));
    teamList.append(button);
  }
}

function renderTeam() {
  const team = state.selected;
  if (!team) return showEmpty();
  empty.hidden = true;
  workspace.hidden = false;

  $("#team-id").textContent = team.id;
  $("#team-name").textContent = team.name;
  $("#team-goal").textContent = team.goal;
  const status = $("#team-status");
  status.dataset.status = team.status;
  status.textContent = statusLabels[team.status] ?? team.status;
  $("#updated-at").textContent = formatDate(team.updatedAt);

  const counts = Object.fromEntries([
    "pending",
    "claimed",
    "in_progress",
    "completed",
    "failed",
    "cancelled",
  ].map((key) => [key, 0]));
  for (const task of team.tasks) counts[task.status] += 1;
  $("#count-pending").textContent = counts.pending;
  $("#count-running").textContent = counts.claimed + counts.in_progress;
  $("#count-completed").textContent = counts.completed;
  $("#count-failed").textContent = counts.failed + counts.cancelled;

  renderMembers(team);
  renderTasks(team);
}

function renderMembers(team) {
  const board = $("#member-board");
  board.replaceChildren();
  const taskNames = new Map(team.tasks.map((task) => [task.id, task.subject]));
  for (const member of team.members) {
    const article = document.createElement("article");
    article.className = "member-strip";
    article.dataset.status = member.status;

    const topline = element("div", "member-topline");
    topline.append(
      textElement("h4", member.name),
      textElement("span", statusLabels[member.status] ?? member.status, "member-state"),
    );
    article.append(
      topline,
      textElement("p", member.role, "member-role"),
      textElement("span", member.model, "member-model"),
    );
    const assignment = member.currentTaskId
      ? `当前：${taskNames.get(member.currentTaskId) ?? member.currentTaskId}`
      : "当前：等待派工";
    article.append(textElement("p", assignment, "member-task"));
    board.append(article);
  }
}

function renderTasks(team) {
  const board = $("#task-board");
  board.replaceChildren();
  const sequence = new Map(team.tasks.map((task) => [task.id, task.sequence]));
  const members = new Map(team.members.map((member) => [member.id, member.name]));

  for (const task of [...team.tasks].sort((a, b) => a.sequence - b.sequence)) {
    const article = document.createElement("article");
    article.className = "task-strip";

    article.append(
      textElement("div", String(task.sequence).padStart(2, "0"), "task-sequence"),
    );

    const copy = element("div", "task-copy");
    copy.append(
      textElement("span", task.kind, "task-kind"),
      textElement("h4", task.subject),
      textElement("p", task.description),
    );

    const routing = element("div", "task-routing");
    const taskState = textElement(
      "span",
      statusLabels[task.status] ?? task.status,
      "task-state",
    );
    taskState.dataset.status = task.status;
    const routes = element("div", "route-tags");
    if (task.dependencies.length) {
      for (const dependency of task.dependencies) {
        routes.append(
          textElement(
            "span",
            `← ${String(sequence.get(dependency) ?? "?").padStart(2, "0")}`,
            "route-tag",
          ),
        );
      }
    } else {
      routes.append(textElement("span", "起始任务", "route-tag no-route"));
    }
    if (task.assignee) {
      routes.append(
        textElement(
          "span",
          members.get(task.assignee) ?? task.assignee,
          "route-tag",
        ),
      );
    }
    routing.append(taskState, routes);
    article.append(copy, routing);
    board.append(article);
  }
}

function showEmpty() {
  empty.hidden = false;
  workspace.hidden = true;
}

function element(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textElement(tag, text, className) {
  const node = element(tag, className);
  node.textContent = text;
  return node;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

$("#refresh").addEventListener("click", refresh);
refresh();
setInterval(refresh, 2500);
