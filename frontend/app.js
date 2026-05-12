/**
 * SmartAnalysis Pro — Frontend Application Logic
 *
 * 5-tab architecture: Import | Analysis | Chat | Training | Sandbox
 * All state (schema, config, chat history, model weights) is preserved
 * across tab switches via the module-level variables below.
 */
(function () {
  "use strict";

  var $ = function (sel) { return document.querySelector(sel); };

  // =======================================================================
  // Global State
  // =======================================================================
  var currentSchema = null;
  var currentFilename = null;
  var analysisData = null;       // cached result from /advanced-analysis
  var chatLoading = false;
  var activeTab = "import";

  var STORAGE_KEYS = {
    apiKey: "smartanalysis_api_key",
    baseUrl: "smartanalysis_base_url",
    modelName: "smartanalysis_model_name",
  };
  var ALLOWED_EXTENSIONS = [".csv", ".xls", ".xlsx"];
  var MAX_FILE_SIZE = 50 * 1024 * 1024;
  var API_BASE = "http://localhost:8000";

  // =======================================================================
  // Tab Manager (with slide-in/out transitions)
  // =======================================================================

  var TAB_ORDER = ["import", "analysis", "chat", "training", "sandbox"];

  function switchTab(tabName) {
    if (activeTab === tabName) return;

    var oldIdx = TAB_ORDER.indexOf(activeTab);
    var newIdx = TAB_ORDER.indexOf(tabName);
    // forward: old slides out left, new enters from right
    var outDir = newIdx > oldIdx ? "left" : "right";
    var inDir  = newIdx > oldIdx ? "right" : "left";

    var oldPanel = $("#tab-" + activeTab);
    var newPanel = $("#tab-" + tabName);

    if (oldPanel && newPanel) {
      oldPanel.classList.add("tab-slide-out-" + outDir);
      oldPanel.addEventListener("animationend", function handler() {
        oldPanel.removeEventListener("animationend", handler);
        oldPanel.classList.add("hidden");
        oldPanel.classList.remove("tab-slide-out-" + outDir);
      }, { once: true });
    } else if (oldPanel) {
      oldPanel.classList.add("hidden");
    }

    newPanel.classList.remove("hidden");
    newPanel.classList.add("tab-slide-in-" + inDir);
    newPanel.addEventListener("animationend", function handler() {
      newPanel.removeEventListener("animationend", handler);
      newPanel.classList.remove("tab-slide-in-" + inDir);
    }, { once: true });

    // Update tab button states
    $$(".tab-btn").forEach(function (b) { b.classList.remove("active"); });
    var btn = document.querySelector('.tab-btn[data-tab="' + tabName + '"]');
    if (btn) btn.classList.add("active");

    activeTab = tabName;

    // Auto-load per-tab data
    if (tabName === "analysis" && currentFilename && !analysisData) loadAnalysis();
    if (tabName === "training" && currentSchema) populateTrainingSelectors();
    if (tabName === "chat") loadChatConfig();
    if (tabName === "sandbox") updateSandboxStatus();
  }

  function $$(sel) { return document.querySelectorAll(sel); }

  $("#tabBar").addEventListener("click", function (e) {
    var btn = e.target.closest(".tab-btn");
    if (!btn || btn.classList.contains("disabled")) return;
    switchTab(btn.dataset.tab);
  });

  // =======================================================================
  // Conditional Tab Unlocking (≥ 2 numeric columns)
  // =======================================================================

  function updateTabLocks(schema) {
    if (!schema || !schema.columns) return;
    var numCount = schema.columns.filter(function (c) { return c.dtype === "numeric"; }).length;
    var unlocked = numCount >= 2;
    var btnT = $("#tabBtnTraining");
    var btnS = $("#tabBtnSandbox");

    if (unlocked) {
      btnT.classList.remove("disabled");
      btnT.removeAttribute("data-tooltip");
      btnS.classList.remove("disabled");
      btnS.removeAttribute("data-tooltip");
    } else {
      btnT.classList.add("disabled");
      btnT.setAttribute("data-tooltip", "需要至少 2 列数值型数据才能进行模型训练（当前 " + numCount + " 列）");
      btnS.classList.add("disabled");
      btnS.setAttribute("data-tooltip", "需要至少 2 列数值型数据才能使用预测沙盘（当前 " + numCount + " 列）");
    }
  }

  // =======================================================================
  // Utility
  // =======================================================================

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // =======================================================================
  // Toast
  // =======================================================================

  function showToast(msg, dur) {
    if (!dur) dur = 4000;
    var c = $("#toastContainer"); if (!c) return;
    var t = document.createElement("div"); t.className = "toast";
    t.innerHTML = '<svg class="toast-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M12 3l9.66 16.5H2.34L12 3z"/></svg><span>' + escapeHtml(msg) + '</span>';
    c.appendChild(t);
    var timer = setTimeout(function () { dismissToast(t); }, dur);
    t._timer = timer;
    t.addEventListener("click", function () { clearTimeout(t._timer); dismissToast(t); });
  }

  function dismissToast(t) {
    if (t._removing) return; t._removing = true;
    t.classList.add("removing");
    t.addEventListener("animationend", function () { if (t.parentNode) t.parentNode.removeChild(t); });
  }

  // =======================================================================
  // TAB 1: File Upload & Schema
  // =======================================================================

  var uploadZone = $("#uploadZone"), fileInput = $("#fileInput");
  var uploadStatus = $("#uploadStatus"), loadingIndicator = $("#loadingIndicator");
  var sidebarOverview = $("#sidebarOverview"), sidebarColumns = $("#sidebarColumns");

  function validateFile(file) {
    if (!file) return { ok: false, error: "未检测到文件。" };
    var ext = "." + file.name.split(".").pop().toLowerCase();
    if (ALLOWED_EXTENSIONS.indexOf(ext) === -1) return { ok: false, error: "不支持的文件格式。" };
    if (file.size > MAX_FILE_SIZE) return { ok: false, error: "文件过大（上限 50 MB）。" };
    return { ok: true };
  }

  function uploadFile(file) {
    loadingIndicator.classList.remove("hidden");
    uploadZone.classList.add("uploading");
    var fd = new FormData(); fd.append("file", file);

    fetch(API_BASE + "/upload", { method: "POST", body: fd })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (b) { throw new Error(b.detail || "服务器错误"); });
        return r.json();
      })
      .then(function (schema) {
        loadingIndicator.classList.add("hidden");
        uploadZone.classList.remove("uploading");
        currentSchema = schema;
        currentFilename = schema.filename;
        analysisData = null;  // invalidate cache

        renderSidebar(schema);
        updateTabLocks(schema);
        showUploadStatus("解析完成 — " + schema.total_rows.toLocaleString() + " 行 × " + schema.total_columns + " 列", false);

        // Auto-switch to analysis tab
        switchTab("analysis");
      })
      .catch(function (err) {
        loadingIndicator.classList.add("hidden");
        uploadZone.classList.remove("uploading");
        showToast("上传失败：" + err.message);
        showUploadStatus("上传失败: " + err.message, true);
      });
  }

  function showUploadStatus(text, isErr) {
    uploadStatus.textContent = text;
    uploadStatus.className = "mt-4 text-sm " + (isErr ? "text-red-500" : "text-green-600");
    uploadStatus.classList.remove("hidden");
  }

  function renderSidebar(schema) {
    sidebarOverview.innerHTML =
      '<div class="grid grid-cols-2 gap-2 mb-3">' +
        '<div class="bg-gray-50 rounded-lg p-2.5 text-center">' +
          '<p class="text-base font-bold text-gray-900">' + schema.total_rows.toLocaleString() + '</p>' +
          '<p class="text-[10px] text-gray-400 uppercase">行数</p></div>' +
        '<div class="bg-gray-50 rounded-lg p-2.5 text-center">' +
          '<p class="text-base font-bold text-gray-900">' + schema.total_columns + '</p>' +
          '<p class="text-[10px] text-gray-400 uppercase">列数</p></div></div>';

    var h = '<h3 class="text-xs font-semibold text-gray-500 uppercase mt-3 mb-1.5">字段</h3><ul class="space-y-0.5">';
    schema.columns.forEach(function (c) {
      var tag = dtypeTag(c.dtype);
      var miss = "";
      if (c.missing_rate > 0) {
        var p = (c.missing_rate * 100).toFixed(1);
        miss = '<span class="missing-bar-track"><span class="missing-bar-fill" style="width:' + p + '%"></span></span>';
      }
      h += '<li class="flex items-center justify-between py-1 px-1.5 rounded text-xs hover:bg-gray-50">' +
             '<span class="text-gray-700 truncate mr-1">' + escapeHtml(c.name) + '</span>' +
             '<span class="flex items-center gap-1 flex-shrink-0">' + tag + miss + '</span></li>';
    });
    h += '</ul>';
    sidebarColumns.innerHTML = h;
  }

  function dtypeTag(dtype) {
    var l = dtype, cls = "bg-gray-100 text-gray-500";
    switch (dtype) {
      case "numeric": l = "数值"; cls = "bg-blue-50 text-blue-600"; break;
      case "categorical": l = "分类"; cls = "bg-purple-50 text-purple-600"; break;
      case "datetime": l = "日期"; cls = "bg-cyan-50 text-cyan-600"; break;
      case "text": l = "文本"; cls = "bg-amber-50 text-amber-600"; break;
      case "boolean": l = "布尔"; cls = "bg-emerald-50 text-emerald-600"; break;
    }
    return '<span class="inline-block text-[10px] px-1.5 py-0.5 rounded-full ' + cls + '">' + l + '</span>';
  }

  // Upload event bindings
  uploadZone.addEventListener("click", function (e) { if (e.target !== fileInput) fileInput.click(); });
  fileInput.addEventListener("change", function () {
    var f = fileInput.files[0]; if (!f) return;
    var v = validateFile(f); if (!v.ok) { showToast(v.error); return; }
    uploadFile(f);
  });
  uploadZone.addEventListener("dragover", function (e) { e.preventDefault(); uploadZone.classList.add("drag-over"); });
  uploadZone.addEventListener("dragleave", function () { uploadZone.classList.remove("drag-over"); });
  uploadZone.addEventListener("drop", function (e) {
    e.preventDefault(); uploadZone.classList.remove("drag-over");
    var f = e.dataTransfer.files[0]; if (!f) return;
    var v = validateFile(f); if (!v.ok) { showToast(v.error); return; }
    uploadFile(f);
  });
  ["dragenter","dragover","dragleave","drop"].forEach(function (ev) {
    document.body.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); });
  });

  // =======================================================================
  // TAB 2: Automated Analysis Dashboard
  // =======================================================================

  var analysisContent = $("#analysisContent"), analysisEmpty = $("#analysisEmpty");
  var chartInstances = {};  // {id: echartsInstance}

  function loadAnalysis() {
    if (!currentFilename) return;
    analysisEmpty.classList.add("hidden");
    analysisContent.classList.remove("hidden");

    // Show loading state in each chart box
    ["chartHistogram","chartHeatmap","chartCategory","chartTimeseries"].forEach(function (id) {
      var el = $("#" + id);
      if (el) el.innerHTML = '<div class="flex items-center justify-center h-64"><div class="spinner w-6 h-6"></div></div>';
    });

    fetch(API_BASE + "/advanced-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: currentFilename }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        analysisData = data;
        renderExploratoryTable(data.exploratory);
        renderHistogram(data.histograms);
        renderHeatmap(data.correlation);
        renderCategoryChart(data.categorical);
        renderTimeseriesChart(data.timeseries);
      })
      .catch(function (err) {
        showToast("分析加载失败：" + err.message);
        analysisEmpty.classList.remove("hidden");
        analysisContent.classList.add("hidden");
      });
  }

  $("#btnRefreshAnalysis").addEventListener("click", function () { analysisData = null; loadAnalysis(); });

  // --- Exploratory stats table ---
  function renderExploratoryTable(rows) {
    var el = $("#exploratoryTable");
    if (!rows || rows.length === 0) { el.innerHTML = '<p class="text-xs text-gray-400 p-2">无数值列可供统计。</p>'; return; }

    var keys = ["count","mean","std","min","q25","q50","q75","max","skewness","kurtosis"];
    var labels = ["计数","均值","标准差","最小值","Q25","中位数","Q75","最大值","偏度","峰度"];

    var h = '<table><thead><tr><th>字段</th>';
    for (var i = 0; i < keys.length; i++) h += '<th>' + labels[i] + '</th>';
    h += '</tr></thead><tbody>';
    for (var r = 0; r < rows.length; r++) {
      h += '<tr><td class="font-medium">' + escapeHtml(rows[r].column) + '</td>';
      for (var j = 0; j < keys.length; j++) {
        var v = rows[r][keys[j]];
        h += '<td>' + (v != null ? (typeof v === "number" ? v.toFixed(2) : v) : "—") + '</td>';
      }
      h += '</tr>';
    }
    h += '</tbody></table>';
    el.innerHTML = h;
  }

  // --- Histogram ---
  function renderHistogram(histData) {
    var cols = Object.keys(histData);
    var sel = $("#histogramSelector");
    sel.innerHTML = "";
    cols.forEach(function (c, i) {
      var chip = document.createElement("span");
      chip.className = "chart-col-chip" + (i === 0 ? " active" : "");
      chip.textContent = c;
      chip.addEventListener("click", function () {
        sel.querySelectorAll(".chart-col-chip").forEach(function (s) { s.classList.remove("active"); });
        chip.classList.add("active");
        renderSingleHistogram(c, histData[c]);
      });
      sel.appendChild(chip);
    });
    if (cols.length > 0) renderSingleHistogram(cols[0], histData[cols[0]]);
    else $("#chartHistogram").innerHTML = '<p class="text-xs flex items-center justify-center h-64" style="color:#94A3B8;">无可用数值列。</p>';
  }

  function renderSingleHistogram(col, hd) {
    disposeChart("chartHistogram");
    var dom = $("#chartHistogram"); dom.innerHTML = "";
    var c = echarts.init(dom);
    chartInstances["chartHistogram"] = c;
    c.setOption({
      tooltip: { trigger: "axis" },
      grid: { left: "8%", right: "4%", top: "8%", bottom: "8%" },
      xAxis: { type: "category", data: hd.bins.map(function (b) { return b.toFixed(1); }), axisLabel: { fontSize: 10, rotate: 30 } },
      yAxis: { type: "value", axisLabel: { fontSize: 10 } },
      series: [{ type: "bar", data: hd.counts, itemStyle: { color: "#0052CC", borderRadius: [2,2,0,0] } }],
    });
    observeResize(dom, c);
  }

  // --- Heatmap ---
  function renderHeatmap(corr) {
    disposeChart("chartHeatmap");
    var dom = $("#chartHeatmap"); dom.innerHTML = "";
    if (!corr.columns || corr.columns.length < 2) {
      dom.innerHTML = '<p class="text-xs text-gray-400 flex items-center justify-center h-64">数值列不足，无法计算相关性。</p>';
      return;
    }
    var data = [];
    for (var i = 0; i < corr.columns.length; i++) {
      for (var j = 0; j < corr.columns.length; j++) {
        data.push([j, i, corr.matrix[i][j]]);
      }
    }
    var c = echarts.init(dom);
    chartInstances["chartHeatmap"] = c;
    c.setOption({
      tooltip: { position: "top" },
      grid: { left: "15%", right: "5%", top: "5%", bottom: "15%" },
      xAxis: { type: "category", data: corr.columns, axisLabel: { fontSize: 10, rotate: 30 } },
      yAxis: { type: "category", data: corr.columns, axisLabel: { fontSize: 10 } },
      visualMap: { min: -1, max: 1, inRange: { color: ["#3B82F6","#E5E7EB","#EF4444"] }, textStyle: { fontSize: 10 }, left: "left" },
      series: [{ type: "heatmap", data: data, label: { show: true, fontSize: 10 } }],
    });
    observeResize(dom, c);
  }

  // --- Category pie ---
  function renderCategoryChart(catData) {
    var sel = $("#categorySelector"); sel.innerHTML = "";
    if (!catData || catData.length === 0) {
      $("#chartCategory").innerHTML = '<p class="text-xs text-gray-400 flex items-center justify-center h-64">无分类列。</p>';
      return;
    }
    catData.forEach(function (item, i) {
      var chip = document.createElement("span");
      chip.className = "chart-col-chip" + (i === 0 ? " active" : "");
      chip.textContent = item.column;
      chip.addEventListener("click", function () {
        sel.querySelectorAll(".chart-col-chip").forEach(function (s) { s.classList.remove("active"); });
        chip.classList.add("active");
        renderSinglePie(item);
      });
      sel.appendChild(chip);
    });
    renderSinglePie(catData[0]);
  }

  function renderSinglePie(item) {
    disposeChart("chartCategory");
    var dom = $("#chartCategory"); dom.innerHTML = "";
    var c = echarts.init(dom);
    chartInstances["chartCategory"] = c;
    c.setOption({
      tooltip: { trigger: "item" },
      series: [{
        type: "pie", radius: ["45%","70%"], center: ["50%","50%"],
        data: item.data.map(function (d) { return { name: String(d.name), value: d.value }; }),
        label: { fontSize: 10, formatter: "{b}" },
      }],
    });
    observeResize(dom, c);
  }

  // --- Timeseries ---
  function renderTimeseriesChart(ts) {
    disposeChart("chartTimeseries");
    var dom = $("#chartTimeseries"); dom.innerHTML = "";
    if (!ts || !ts.data || ts.data.length === 0) {
      dom.innerHTML = '<p class="text-xs text-gray-400 flex items-center justify-center h-64">无时间序列数据。</p>';
      return;
    }
    var c = echarts.init(dom);
    chartInstances["chartTimeseries"] = c;
    c.setOption({
      tooltip: { trigger: "axis" },
      grid: { left: "8%", right: "4%", top: "8%", bottom: "8%" },
      xAxis: { type: "category", data: ts.data.map(function (d) { return d.date; }), axisLabel: { fontSize: 10, rotate: 30 } },
      yAxis: { type: "value", axisLabel: { fontSize: 10 } },
      series: [{
        type: "line", data: ts.data.map(function (d) { return d.value; }),
        smooth: true, lineStyle: { color: "#0052CC", width: 2 },
        areaStyle: { color: "rgba(0,82,204,0.06)" },
      }],
    });
    observeResize(dom, c);
  }

  // --- Chart helpers ---
  function disposeChart(id) {
    if (chartInstances[id]) { chartInstances[id].dispose(); delete chartInstances[id]; }
  }
  function observeResize(dom, chart) {
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { chart.resize(); });
      ro.observe(dom);
    }
  }

  // Clean up all charts when switching away from analysis tab
  var origSwitchTab = switchTab;
  switchTab = function (tabName) {
    if (activeTab !== "analysis" && tabName !== activeTab) {
      Object.keys(chartInstances).forEach(function (k) { disposeChart(k); });
    }
    origSwitchTab(tabName);
  };

  // =======================================================================
  // TAB 3: Chat (inline API config)
  // =======================================================================

  var chatApiKey = $("#chatApiKey"), chatBaseUrl = $("#chatBaseUrl"), chatModelName = $("#chatModelName");
  var chatConfigStatus = $("#chatConfigStatus"), chatMessages = $("#chatMessages");
  var chatInput = $("#chatInput"), btnSend = $("#btnSend"), btnSaveChatConfig = $("#btnSaveChatConfig");

  function loadChatConfig() {
    chatApiKey.value = sessionStorage.getItem(STORAGE_KEYS.apiKey) || "";
    chatBaseUrl.value = sessionStorage.getItem(STORAGE_KEYS.baseUrl) || "";
    chatModelName.value = sessionStorage.getItem(STORAGE_KEYS.modelName) || "";
  }

  function saveChatConfig() {
    var ak = chatApiKey.value.trim(), bu = chatBaseUrl.value.trim(), mn = chatModelName.value.trim();
    if (!ak || !bu || !mn) {
      chatConfigStatus.textContent = "请填写所有字段"; chatConfigStatus.classList.remove("hidden","text-green-600");
      chatConfigStatus.classList.add("text-red-500"); return;
    }
    sessionStorage.setItem(STORAGE_KEYS.apiKey, ak);
    sessionStorage.setItem(STORAGE_KEYS.baseUrl, bu);
    sessionStorage.setItem(STORAGE_KEYS.modelName, mn);
    chatConfigStatus.textContent = "已保存 ✓";
    chatConfigStatus.classList.remove("hidden","text-red-500");
    chatConfigStatus.classList.add("text-green-600");
    setTimeout(function () { chatConfigStatus.classList.add("hidden"); }, 2000);
  }

  btnSaveChatConfig.addEventListener("click", saveChatConfig);

  var btnClearChatConfig = $("#btnClearChatConfig");
  btnClearChatConfig.addEventListener("click", function () {
    sessionStorage.removeItem(STORAGE_KEYS.apiKey);
    sessionStorage.removeItem(STORAGE_KEYS.baseUrl);
    sessionStorage.removeItem(STORAGE_KEYS.modelName);
    chatApiKey.value = "";
    chatBaseUrl.value = "";
    chatModelName.value = "";
    chatConfigStatus.textContent = "配置已清空 ✓";
    chatConfigStatus.classList.remove("hidden", "text-red-500");
    chatConfigStatus.classList.add("text-green-600");
    setTimeout(function () { chatConfigStatus.classList.add("hidden"); }, 2000);
  });

  function sendMessage() {
    if (chatLoading) return;
    var q = chatInput.value.trim(); if (!q) return;
    var ak = sessionStorage.getItem(STORAGE_KEYS.apiKey);
    var bu = sessionStorage.getItem(STORAGE_KEYS.baseUrl);
    var mn = sessionStorage.getItem(STORAGE_KEYS.modelName);
    if (!ak || !bu || !mn) { showToast("请先在左侧填写大模型配置并保存"); return; }
    if (!currentSchema) { showToast("请先在「数据接入」上传文件"); return; }

    appendChatBubble("user", q);
    chatInput.value = ""; autoResizeChat();
    chatLoading = true; btnSend.disabled = true;
    var typingEl = appendTyping();

    fetch(API_BASE + "/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, table_schema: currentSchema, api_key: ak, base_url: bu, model_name: mn }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        removeTyping(typingEl); chatLoading = false; btnSend.disabled = false;
        if (d.error) appendChatBubble("ai", d.error, { isError: true });
        else appendChatBubble("ai", d.answer);
        scrollChatBottom(); chatInput.focus();
      })
      .catch(function (err) {
        removeTyping(typingEl); chatLoading = false; btnSend.disabled = false;
        appendChatBubble("ai", "请求失败：" + (err.message || ""), { isError: true });
        scrollChatBottom(); chatInput.focus();
      });
  }

  function appendChatBubble(role, text, opts) {
    var el = document.createElement("div");
    el.className = "flex gap-3 " + (role === "user" ? "justify-end" : "");

    if (role === "user") {
      el.innerHTML = '<div class="rounded-2xl rounded-tr-md px-4 py-2.5 max-w-[75%]" style="background:#F1F5F9; color:#1E293B;"><p class="text-sm whitespace-pre-wrap" style="line-height:1.6;">' + escapeHtml(text) + '</p></div>';
    } else {
      var avatar = '<div class="w-8 h-8 rounded-full bg-brand flex items-center justify-center flex-shrink-0"><svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/></svg></div>';
      var isErr = opts && opts.isError;
      var bodyClass = isErr
        ? 'ai-bubble rounded-2xl rounded-tl-md px-4 py-3 max-w-[80%]" style="background:#FEF2F2; border:1px solid #FECACA;'
        : 'ai-bubble card rounded-2xl rounded-tl-md px-4 py-3 max-w-[80%]';
      var textStyle = isErr
        ? 'style="color:#991B1B; line-height:1.6;"'
        : 'style="color:#334155; line-height:1.6;"';
      var prefix = isErr ? '<span class="font-medium">出错</span><br/>' : '';
      el.innerHTML = avatar + '<div class="' + bodyClass + '"><p class="text-sm whitespace-pre-wrap" ' + textStyle + '>' + prefix + escapeHtml(text || "") + '</p></div>';
    }
    chatMessages.appendChild(el);
    scrollChatBottom();
  }

  function appendTyping() {
    var el = document.createElement("div"); el.className = "flex gap-3 typing-indicator-row";
    el.innerHTML = '<div class="w-8 h-8 rounded-full bg-brand flex items-center justify-center flex-shrink-0"><svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/></svg></div><div class="ai-bubble bg-white border border-gray-200 rounded-2xl rounded-tl-md px-4 py-3 shadow-sm"><div class="typing-dots"><span></span><span></span><span></span></div></div>';
    chatMessages.appendChild(el); scrollChatBottom(); return el;
  }

  function removeTyping(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }

  function scrollChatBottom() {
    requestAnimationFrame(function () { chatMessages.scrollTop = chatMessages.scrollHeight; });
  }

  function autoResizeChat() {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
  }

  chatInput.addEventListener("input", autoResizeChat);
  chatInput.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  btnSend.addEventListener("click", sendMessage);

  // =======================================================================
  // TAB 4: Model Training (inline)
  // =======================================================================

  var trainTargetCol = $("#trainTargetCol"), trainFeatureChips = $("#trainFeatureChips");
  var trainSelectError = $("#trainSelectError"), btnStartTrain = $("#btnStartTrain");
  var trainProgressArea = $("#trainProgressArea"), trainProgressPct = $("#trainProgressPct");
  var trainProgressFill = $("#trainProgressFill"), trainLogs = $("#trainLogs");
  var trainResultArea = $("#trainResultArea"), btnEnterSb = $("#btnEnterSandboxFromTrain");

  function populateTrainingSelectors() {
    if (!currentSchema) return;
    var numCols = currentSchema.columns.filter(function (c) { return c.dtype === "numeric"; });

    // --- target dropdown ---
    trainTargetCol.innerHTML = '<option value="">-- 请选择目标列（仅数值型） --</option>';
    numCols.forEach(function (c) {
      trainTargetCol.innerHTML += '<option value="' + escapeHtml(c.name) + '">' + escapeHtml(c.name) + '</option>';
    });

    // --- feature chips ---
    trainFeatureChips.innerHTML = "";
    numCols.forEach(function (c) {
      var chip = document.createElement("div");
      chip.className = "feature-chip";
      chip.textContent = c.name;
      chip.dataset.column = c.name;
      chip.dataset.selected = "false";
      chip.addEventListener("click", function () {
        var isSel = this.dataset.selected === "true";
        this.dataset.selected = isSel ? "false" : "true";
        this.classList.toggle("selected", !isSel);
      });
      trainFeatureChips.appendChild(chip);
    });
  }

  // --- Y-change: auto-remove Y from selected X if present ---
  trainTargetCol.addEventListener("change", function () {
    var y = trainTargetCol.value;
    if (!y) return;
    var chips = trainFeatureChips.querySelectorAll(".feature-chip");
    chips.forEach(function (chip) {
      if (chip.dataset.column === y && chip.dataset.selected === "true") {
        chip.dataset.selected = "false";
        chip.classList.remove("selected");
      }
    });
  });

  // --- Batch select / clear ---
  var btnSelectAllX = $("#btnSelectAllX");
  var btnClearAllX   = $("#btnClearAllX");

  btnSelectAllX.addEventListener("click", function () {
    var y = trainTargetCol.value;
    var chips = trainFeatureChips.querySelectorAll(".feature-chip");
    chips.forEach(function (chip) {
      if (chip.dataset.column !== y) {
        chip.dataset.selected = "true";
        chip.classList.add("selected");
      }
    });
  });

  btnClearAllX.addEventListener("click", function () {
    var chips = trainFeatureChips.querySelectorAll(".feature-chip");
    chips.forEach(function (chip) {
      chip.dataset.selected = "false";
      chip.classList.remove("selected");
    });
  });

  btnStartTrain.addEventListener("click", function () {
    var y = trainTargetCol.value;
    if (!y) { trainSelectError.textContent = "请选择目标变量 (Y)。"; trainSelectError.classList.remove("hidden"); return; }
    var checked = trainFeatureChips.querySelectorAll('[data-selected="true"]');
    if (checked.length === 0) { trainSelectError.textContent = "请至少选择一个影响因素 (X)。"; trainSelectError.classList.remove("hidden"); return; }
    trainSelectError.classList.add("hidden");
    var feats = []; checked.forEach(function (chip) { feats.push(chip.dataset.column); });
    runTraining(y, feats);
  });

  function runTraining(y, feats) {
    trainProgressArea.classList.remove("hidden");
    trainResultArea.classList.add("hidden"); btnEnterSb.classList.add("hidden");
    trainLogs.innerHTML = ""; trainProgressFill.style.width = "0%"; trainProgressPct.textContent = "0%";

    var steps = [
      { pct: 15, text: "正在清洗所选列…", delay: 300 },
      { pct: 35, text: "剔除缺失值与异常值…", delay: 350 },
      { pct: 55, text: "提取特征矩阵 (X) …", delay: 300 },
      { pct: 70, text: "拟合线性回归模型…", delay: 400 },
    ];
    var i = 0;
    function next() {
      if (i < steps.length) {
        var s = steps[i];
        trainProgressFill.style.width = s.pct + "%"; trainProgressPct.textContent = s.pct + "%";
        appendTrainLog(s.text); i++; setTimeout(next, s.delay);
      } else {
        appendTrainLog("正在与后端通信…");
        fetch(API_BASE + "/train", {
          method: "POST", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({ filename: currentFilename, target_col: y, feature_cols: feats }),
        })
          .then(function (r) {
            if (!r.ok) {
              return r.json().then(function (body) {
                throw new Error(body.detail || "服务器返回 " + r.status);
              });
            }
            return r.json();
          })
          .then(function (d) {
            trainProgressFill.style.width = "100%"; trainProgressPct.textContent = "100%";
            if (d.error) {
              appendTrainLog("失败: " + d.error, true);
              showTrainResultError(d.error);
            } else {
              appendTrainLog("训练成功！", false);
              showTrainResult(d);
            }
          })
          .catch(function (err) {
            trainProgressFill.style.width = "100%"; trainProgressPct.textContent = "100%";
            appendTrainLog(err.message || "未知错误", true);
            showTrainResultError(err.message || "未知错误");
          });
      }
    }
    next();
  }

  function appendTrainLog(text, isErr) {
    var line = document.createElement("p"); line.className = "train-log-line";
    line.textContent = (isErr ? "[ERROR] " : "[OK] ") + text;
    if (isErr) line.style.color = "#EF4444";
    trainLogs.appendChild(line); trainLogs.scrollTop = trainLogs.scrollHeight;
  }

  function showTrainResultError(msg) {
    trainResultArea.classList.remove("hidden");
    trainResultArea.innerHTML = '<div class="rounded-xl p-4 text-center" style="background:#FEF2F2; border:1px solid #FECACA;"><p class="text-sm" style="color:#991B1B;">' + escapeHtml(msg) + '</p></div>';
  }

  function showTrainResult(d) {
    var coefs = d.coefficients || {};
    var r2 = (d.r2_score != null) ? d.r2_score : 0;
    var nSamples = (d.n_samples != null) ? d.n_samples : 0;

    sessionStorage.setItem("sandbox_model", JSON.stringify({
      target: d.target || "", features: d.features || [], intercept: d.intercept || 0,
      coefficients: coefs, r2_score: r2, n_samples: nSamples,
      feature_stats: d.feature_stats || {},
    }));
    var r2c = r2 >= 0.7 ? "#059669" : r2 >= 0.4 ? "#D97706" : "#EF4444";
    var r2pct = Math.round(r2 * 100);

    var coefficients = d.coefficients || {};
    var coeffHtml = "";
    Object.keys(coefficients).forEach(function (k) {
      var v = coefficients[k], sign = v >= 0 ? "+" : "";
      coeffHtml += '<div class="flex justify-between items-center py-1.5 border-b border-gray-50 text-xs"><span class="text-gray-600 truncate mr-2">' + escapeHtml(k) + '</span><span class="font-mono font-medium ' + (v>=0?"text-emerald-600":"text-red-500") + '">' + sign + v.toFixed(4) + '</span></div>';
    });

    trainResultArea.classList.remove("hidden");
    trainResultArea.innerHTML =
      '<div class="text-center mb-4"><p class="text-xs text-gray-400 uppercase tracking-wider mb-2">模型健康度</p>' +
        '<div class="r2-gauge mx-auto mb-2"><svg width="64" height="64" viewBox="0 0 64 64"><circle class="r2-bg" cx="32" cy="32" r="28"/><circle class="r2-fill" cx="32" cy="32" r="28" stroke="' + r2c + '" stroke-dasharray="' + (Math.PI*56) + '" stroke-dashoffset="' + (Math.PI*56*(1-r2)) + '"/></svg><span class="r2-text" style="color:' + r2c + '">' + r2pct + '%</span></div>' +
        '<p class="text-xs text-gray-500">R² 决定系数（' + nSamples.toLocaleString() + ' 条有效数据）</p>' +
        (d.n_dropped > 0 ? '<p class="text-xs text-amber-500 mt-1">剔除 ' + d.n_dropped + ' 条 Y 缺失行</p>' : '') +
        (d.n_imputed > 0 ? '<p class="text-xs text-blue-500 mt-1">中位数填补 ' + d.n_imputed + ' 个 X 缺失单元格</p>' : '') +
      '</div>' +
      '<div class="rounded-xl p-3" style="background:#F8FAFC; border:1px solid #E2E8F0;"><p class="text-xs font-medium mb-2" style="color:#64748B;">回归方程: Y = ' + (d.intercept || 0).toFixed(4) + ' + Σ(βᵢ × Xᵢ)</p>' + coeffHtml + '</div>';
    btnEnterSb.classList.remove("hidden");
  }

  btnEnterSb.addEventListener("click", function () { switchTab("sandbox"); });

  // =======================================================================
  // TAB 5: What-If Simulation Sandbox — sliders + live prediction + ECharts gauge
  // =======================================================================

  var sandboxModel = null;         // {target, features, intercept, coefficients, r2_score, n_samples}
  var sandboxSliderValues = {};    // {featureName: currentValue}
  var sandboxChart = null;         // echarts instance
  var sandboxRafId = null;         // requestAnimationFrame id for batched chart updates

  var sandboxEmpty   = $("#sandboxEmpty");
  var sandboxActive  = $("#sandboxActive");
  var sandboxSliders = $("#sandboxSliders");
  var sandboxPredEl  = $("#sandboxPrediction");
  var sandboxTargetLabel = $("#sandboxTargetLabel");
  var sandboxFormulaEl   = $("#sandboxFormula");
  var sandboxChartDom    = $("#sandboxChart");
  var sandboxStatusEl    = $("#sandboxStatus");

  /** Compute Y = intercept + Σ(coefᵢ × valueᵢ) */
  function computePrediction() {
    if (!sandboxModel) return 0;
    var y = sandboxModel.intercept;
    var feats = sandboxModel.features;
    var coefs = sandboxModel.coefficients;
    for (var i = 0; i < feats.length; i++) {
      y += (sandboxSliderValues[feats[i]] || 0) * (coefs[feats[i]] || 0);
    }
    return y;
  }

  var countUpAnimId = null;
  var countUpCurrent = 0;

  /** Animate the prediction number from current to target over ~400ms. */
  function countUpTo(target) {
    if (countUpAnimId) cancelAnimationFrame(countUpAnimId);
    var from = countUpCurrent;
    var to = target;
    var duration = 400;  // ms
    var start = null;

    function easeOutCubic(t) {
      return 1 - Math.pow(1 - t, 3);
    }

    function step(ts) {
      if (!start) start = ts;
      var elapsed = ts - start;
      var progress = Math.min(elapsed / duration, 1);
      var eased = easeOutCubic(progress);
      var current = from + (to - from) * eased;
      countUpCurrent = current;
      sandboxPredEl.textContent = current.toFixed(2);
      if (progress < 1) {
        countUpAnimId = requestAnimationFrame(step);
      } else {
        countUpAnimId = null;
        countUpCurrent = to;
        sandboxPredEl.textContent = to.toFixed(2);
      }
    }

    countUpAnimId = requestAnimationFrame(step);
  }

  /** Update prediction: trigger CountUp animation + schedule chart update. */
  function updatePredictionDisplay() {
    var y = computePrediction();
    countUpTo(y);
    scheduleChartUpdate(y);
  }

  /** Batch chart updates via requestAnimationFrame for smooth dragging. */
  function scheduleChartUpdate(y) {
    if (sandboxRafId) cancelAnimationFrame(sandboxRafId);
    sandboxRafId = requestAnimationFrame(function () {
      sandboxRafId = null;
      updateGaugeChart(y);
    });
  }

  /** Push the current prediction value to the ECharts gauge. */
  function updateGaugeChart(value) {
    if (!sandboxChart || sandboxChart.isDisposed()) return;
    sandboxChart.setOption({
      series: [{ data: [{ value: parseFloat(value.toFixed(2)), name: sandboxModel.target }] }],
    });
  }

  /** Initialise the ECharts gauge chart. */
  /** Abbreviate large numbers for gauge labels (1,200 → "1.2K", 1,500,000 → "1.5M") */
  function abbrNum(n) {
    if (n == null) return "0";
    var abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (abs >= 1e4) return (n / 1e3).toFixed(1) + "K";
    return n.toFixed(0);
  }

  function initGaugeChart(basePrediction) {
    if (sandboxChart) { sandboxChart.dispose(); sandboxChart = null; }
    sandboxChartDom.innerHTML = "";
    if (typeof echarts === "undefined") return;

    sandboxChart = echarts.init(sandboxChartDom);

    // Dynamic max: 2× the prediction when all features are at their mean
    var gaugeMax = Math.max(Math.abs(basePrediction) * 2, 1);
    // Round up to a nice number
    var magnitude = Math.pow(10, Math.floor(Math.log10(gaugeMax)));
    gaugeMax = Math.ceil(gaugeMax / magnitude) * magnitude;

    var option = {
      series: [{
        type: "gauge",
        startAngle: 210,
        endAngle: -30,
        center: ["50%", "55%"],
        radius: "85%",
        min: 0,
        max: gaugeMax,
        splitNumber: 10,
        axisLine: {
          show: true,
          lineStyle: {
            width: 20,
            color: [
              [0.3, "#67C23A"],
              [0.6, "#409EFF"],
              [0.8, "#E6A23C"],
              [1,   "#F56C6C"],
            ],
          },
        },
        pointer: { length: "65%", width: 6, itemStyle: { color: "#0052CC" } },
        axisTick: { distance: -20, length: 8, lineStyle: { width: 1, color: "#94A3B8" } },
        splitLine: { distance: -26, length: 18, lineStyle: { width: 2, color: "#94A3B8" } },
        axisLabel: {
          color: "#94A3B8", distance: 35, fontSize: 10,
          formatter: function (v) { return abbrNum(v); },
        },
        anchor: { show: true, showAbove: true, size: 18, itemStyle: { borderWidth: 2, borderColor: "#0052CC" } },
        title: { show: true, offsetCenter: [0, "85%"], fontSize: 13, color: "#64748B" },
        detail: {
          valueAnimation: true,
          fontSize: 32,
          fontWeight: "bold",
          color: "#1E293B",
          offsetCenter: [0, "62%"],
          formatter: function (v) { return v.toFixed(2); },
        },
        data: [{ value: 0, name: sandboxModel ? sandboxModel.target : "" }],
      }],
    };

    sandboxChart.setOption(option);
  }

  /** Build slider cards for each feature in the model. */
  function buildSliderCards() {
    if (!sandboxModel) return;
    var feats = sandboxModel.features;
    var coefs = sandboxModel.coefficients;
    var stats = sandboxModel.feature_stats || {};
    var html = "";

    for (var i = 0; i < feats.length; i++) {
      var f = feats[i];
      var coef = coefs[f] || 0;
      var st = stats[f] || {};

      // Use real data bounds, fall back to ±100×|coef| if stats missing
      var minVal = (st.min != null) ? st.min : -Math.abs(coef) * 100;
      var maxVal = (st.max != null) ? st.max : Math.abs(coef) * 100;
      var meanVal = (st.mean != null) ? st.mean : 0;
      var range = maxVal - minVal || 1;
      var step = range / 100;  // 100 ticks across the range

      // Round step to a reasonable precision
      if (step < 0.001) step = 0.001;
      else if (step < 0.01) step = Math.round(step * 10000) / 10000;
      else if (step < 1) step = Math.round(step * 100) / 100;
      else step = Math.round(step * 10) / 10;

      // Default slider to mean
      sandboxSliderValues[f] = meanVal;

      html +=
        '<div class="card" style="padding:1rem 1.25rem;">' +
          '<div class="flex items-center justify-between mb-2">' +
            '<span class="text-sm font-semibold truncate mr-2" style="color:#1E293B;">' + escapeHtml(f) + '</span>' +
            '<span class="text-xs font-mono" style="color:' + (coef >= 0 ? "#059669" : "#EF4444") + ';">' +
              (coef >= 0 ? "+" : "") + coef.toFixed(4) +
            '</span>' +
          '</div>' +
          '<div class="flex items-center gap-3">' +
            '<input type="range" class="sandbox-slider" data-feature="' + escapeHtml(f) + '" ' +
              'min="' + minVal + '" max="' + maxVal + '" step="' + step + '" value="' + meanVal + '" ' +
              'style="flex:1; height:6px; -webkit-appearance:none; appearance:none; background:#E2E8F0; border-radius:3px; outline:none; cursor:pointer;" />' +
            '<input type="number" class="sandbox-number" data-feature="' + escapeHtml(f) + '" ' +
              'value="' + meanVal + '" step="' + step + '" min="' + minVal + '" max="' + maxVal + '" ' +
              'style="width:5.5rem; padding:0.375rem 0.5rem; font-size:0.8125rem; text-align:center; ' +
                     'border:1px solid #E2E8F0; border-radius:0.5rem; color:#1E293B; ' +
                     'font-variant-numeric:tabular-nums; outline:none;" />' +
          '</div>' +
        '</div>';
    }

    sandboxSliders.innerHTML = html;

    // Bind events to all sliders and number inputs
    sandboxSliders.querySelectorAll(".sandbox-slider").forEach(function (slider) {
      slider.addEventListener("input", function () {
        var feat = this.dataset.feature;
        var val = parseFloat(this.value);
        sandboxSliderValues[feat] = val;
        // Sync the number input
        var numInput = sandboxSliders.querySelector('.sandbox-number[data-feature="' + feat + '"]');
        if (numInput) numInput.value = val;
        updatePredictionDisplay();
      });
    });

    sandboxSliders.querySelectorAll(".sandbox-number").forEach(function (num) {
      num.addEventListener("input", function () {
        var feat = this.dataset.feature;
        var val = parseFloat(this.value) || 0;
        sandboxSliderValues[feat] = val;
        // Sync the range slider
        var slider = sandboxSliders.querySelector('.sandbox-slider[data-feature="' + feat + '"]');
        if (slider) slider.value = val;
        updatePredictionDisplay();
      });
    });
  }

  /** Load model, build UI, init chart. Called on tab switch or model change. */
  function initSandbox() {
    // No file uploaded → show empty state, ignore any cached model
    if (!currentSchema) {
      sandboxEmpty.classList.remove("hidden");
      sandboxActive.classList.add("hidden");
      sandboxStatusEl.textContent = "请先在「数据接入」上传表格，再前往「模型训练」完成模型拟合。";
      return;
    }

    var raw = sessionStorage.getItem("sandbox_model");
    if (!raw) {
      sandboxEmpty.classList.remove("hidden");
      sandboxActive.classList.add("hidden");
      sandboxStatusEl.textContent = "尚未训练模型 — 请在「模型训练」Tab 中完成训练后解锁。";
      return;
    }

    sandboxModel = JSON.parse(raw);
    sandboxSliderValues = {};
    if (sandboxChart) { sandboxChart.dispose(); sandboxChart = null; }

    sandboxEmpty.classList.add("hidden");
    sandboxActive.classList.remove("hidden");

    // Update labels
    sandboxTargetLabel.textContent = "目标：" + sandboxModel.target + "  |  R² = " + (sandboxModel.r2_score * 100).toFixed(1) + "%";
    sandboxFormulaEl.textContent = "Y = " + sandboxModel.intercept.toFixed(4) +
      sandboxModel.features.map(function (f) {
        var c = sandboxModel.coefficients[f] || 0;
        return (c >= 0 ? " + " : " - ") + Math.abs(c).toFixed(4) + " × " + f;
      }).join("");

    // Build slider cards
    buildSliderCards();

    // Compute initial prediction (all features at mean) to set gauge range
    var initY = computePrediction();
    initGaugeChart(initY);

    // Show initial value
    countUpCurrent = initY;
    sandboxPredEl.textContent = initY.toFixed(2);
    scheduleChartUpdate(initY);
  }

  // --- Reset-to-mean button ---
  var btnResetSliders = $("#btnResetSliders");
  if (btnResetSliders) {
    btnResetSliders.addEventListener("click", function () {
      if (!sandboxModel) return;
      var stats = sandboxModel.feature_stats || {};
      var sliders = sandboxSliders.querySelectorAll(".sandbox-slider");
      var nums = sandboxSliders.querySelectorAll(".sandbox-number");

      sliders.forEach(function (slider) {
        var feat = slider.dataset.feature;
        var st = stats[feat] || {};
        var meanVal = (st.mean != null) ? st.mean : 0;
        slider.value = meanVal;
        sandboxSliderValues[feat] = meanVal;
      });
      nums.forEach(function (num) {
        var feat = num.dataset.feature;
        var st = stats[feat] || {};
        var meanVal = (st.mean != null) ? st.mean : 0;
        num.value = meanVal;
      });
      updatePredictionDisplay();
    });
  }

  /** Called when switching to this tab. */
  function updateSandboxStatus() {
    // No file uploaded → always show empty state
    if (!currentSchema) {
      sandboxEmpty.classList.remove("hidden");
      sandboxActive.classList.add("hidden");
      sandboxStatusEl.textContent = "请先在「数据接入」上传表格，再前往「模型训练」完成模型拟合。";
      return;
    }

    var raw = sessionStorage.getItem("sandbox_model");
    if (raw) {
      sandboxModel = JSON.parse(raw);
      sandboxStatusEl.innerHTML =
        '<span class="text-green-600 font-medium">模型已就绪</span> — ' +
        '目标: ' + escapeHtml(sandboxModel.target) + ' | ' +
        'R²: ' + (sandboxModel.r2_score * 100).toFixed(1) + '% | ' +
        '特征: ' + sandboxModel.features.join(", ");
      initSandbox();
    } else {
      sandboxEmpty.classList.remove("hidden");
      sandboxActive.classList.add("hidden");
      sandboxStatusEl.textContent = "尚未训练模型 — 请在「模型训练」Tab 中完成训练后解锁。";
    }
  }

  // Clean up chart on window resize
  window.addEventListener("resize", function () {
    if (sandboxChart && !sandboxChart.isDisposed()) sandboxChart.resize();
  });

  // -- Settings gear in header → navigate to Tab 3 (LLM config) ----------
  var btnOpenSettings = $("#btnOpenSettings");
  if (btnOpenSettings) {
    btnOpenSettings.addEventListener("click", function () { switchTab("chat"); });
  }

  // =======================================================================
  // Init
  // =======================================================================
  function init() {
    loadChatConfig();
    console.log("[SmartAnalysis] 5-tab architecture ready. API: " + API_BASE);
  }
  init();
})();
