(() => {
  let buffer = [];
  let es = null;
  let connectionId = null;
  let lastSeq = 0;
  let rtsState = true;
  let dtrState = true;

  const $ = (id) => document.getElementById(id);
  const framesEl = $("frames");

  function setStatus(text) { $("statusLine").textContent = text; }

  function setConnected(on, id) {
    connectionId = id || null;
    $("dot").className = "dot" + (on ? " on" : "");
    $("connLabel").textContent = on ? "已连接 " + (id || "") : "未连接";
    $("btnConnect").disabled = on;
    $("btnDisconnect").disabled = !on;
    $("btnSend").disabled = !on;
    $("btnApply").disabled = !on;
    $("btnDtr").disabled = !on;
    $("btnRts").disabled = !on;
    $("btnBreak").disabled = !on;
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function fmtTime(iso) {
    try {
      const d = new Date(iso);
      const p = (n, w) => String(n).padStart(w || 2, "0");
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + "." + p(d.getMilliseconds(), 3);
    } catch (e) {
      return iso;
    }
  }

  function prettyHex(raw) {
    return (raw || "").toUpperCase().replace(/(.{2})/g, "$1 ").trim();
  }

  function sanitizeAscii(s) {
    let out = "";
    for (const ch of String(s || "")) {
      const c = ch.codePointAt(0);
      out += (c >= 32 && c < 127) ? ch : ".";
    }
    return out;
  }

  function render(list) {
    if (!list.length) {
      framesEl.innerHTML = '<div class="empty">无匹配帧</div>';
      return;
    }
    const showAscii = $("showAscii").checked;
    const html = list.slice(-800).map((m) => {
      const dir = m.direction === "tx" ? "TX" : "RX";
      const cls = m.direction === "tx" ? "tx" : "rx";
      const hex = prettyHex(m.raw);
      const ascii = sanitizeAscii(m.data);
      return '<div class="row ' + cls + '">' +
        '<span class="t">' + esc(fmtTime(m.timestamp)) + "</span>" +
        '<span class="dir ' + cls + '">' + dir + "</span>" +
        '<span class="n">' + m.length + "B</span>" +
        '<span><span class="hex">' + esc(hex) + "</span>" +
        (showAscii ? '<span class="ascii">  ' + esc(ascii) + "</span>" : "") +
        "</span></div>";
    }).join("");
    framesEl.innerHTML = html;
    if ($("follow").checked) framesEl.scrollTop = framesEl.scrollHeight;
  }

  function applyFilters() {
    const dir = $("filterDir").value;
    const hx = $("filterHex").value.replace(/\s+/g, "").toUpperCase();
    const tx = $("filterText").value;
    let list = buffer;
    if (dir !== "all") list = list.filter((m) => m.direction === dir);
    if (hx) list = list.filter((m) => (m.raw || "").toUpperCase().includes(hx));
    if (tx) list = list.filter((m) => (m.data || "").includes(tx));
    render(list);
    $("seqLabel").textContent = "seq " + lastSeq;
    $("countLabel").textContent = list.length + " frames";
  }

  function onFrame(m) {
    buffer.push(m);
    if (buffer.length > 5000) buffer = buffer.slice(-5000);
    if (m.seq > lastSeq) lastSeq = m.seq;
    applyFilters();
  }

  async function api(path, body, method) {
    method = method || "GET";
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || res.statusText || "request failed");
    }
    return data;
  }

  async function refreshPorts() {
    try {
      const data = await api("/api/ports");
      const dl = $("portList");
      dl.innerHTML = data.ports.map((p) =>
        '<option value="' + esc(p.path) + '">' + esc(p.manufacturer || "") + "</option>"
      ).join("");
      setStatus("端口 " + data.ports.length + " 个");
    } catch (e) {
      setStatus("刷新端口失败: " + e.message);
    }
  }

  function connectSse(sinceSeq) {
    if (es) { es.close(); es = null; }
    let url = "/events/stream?sinceSeq=" + (sinceSeq || 0);
    if (connectionId) url += "&connectionId=" + encodeURIComponent(connectionId);
    es = new EventSource(url);
    es.addEventListener("frame", (ev) => {
      try { onFrame(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
    });
    es.addEventListener("close", () => {
      setConnected(false, null);
      setStatus("连接已关闭");
    });
    es.onerror = () => {
      setStatus("SSE 重连中…");
    };
  }

  async function connect() {
    const path = $("path").value.trim();
    if (!path) { setStatus("请填写端口"); return; }
    setStatus("连接中…");
    try {
      const data = await api("/api/connect", {
        path,
        baudRate: Number($("baud").value),
        dataBits: Number($("dataBits").value),
        stopBits: Number($("stopBits").value),
        parity: $("parity").value,
        encoding: $("encoding").value,
        protocol: $("protocol").value,
        delimiter: $("delimiter").value || undefined,
        dtr: $("dtr").checked,
        rts: $("rts").checked,
      }, "POST");
      buffer = [];
      lastSeq = 0;
      setConnected(true, data.connectionId);
      dtrState = $("dtr").checked;
      rtsState = $("rts").checked;
      connectSse(0);
      setStatus("已连接 " + data.info.config.path + " @ " + data.info.config.baudRate);
      applyFilters();
    } catch (e) {
      setConnected(false, null);
      setStatus("连接失败: " + e.message);
    }
  }

  async function disconnect() {
    try { await api("/api/disconnect", {}, "POST"); } catch (e) { /* ignore */ }
    if (es) { es.close(); es = null; }
    setConnected(false, null);
    setStatus("已断开");
  }

  async function send() {
    const data = $("sendData").value;
    if (!data) return;
    try {
      const r = await api("/api/write", { data, encoding: $("encoding").value }, "POST");
      setStatus("已发送 " + r.bytesWritten + "B");
    } catch (e) {
      setStatus("发送失败: " + e.message);
    }
  }

  async function applyConfig() {
    try {
      await api("/api/config", {
        baudRate: Number($("baud").value),
        encoding: $("encoding").value,
        protocol: $("protocol").value,
        delimiter: $("delimiter").value || undefined,
      }, "POST");
      setStatus("配置已应用");
    } catch (e) {
      setStatus("应用失败: " + e.message);
    }
  }

  async function setSignals(patch) {
    try {
      await api("/api/signals", patch, "POST");
      setStatus("信号 " + JSON.stringify(patch));
    } catch (e) {
      setStatus("信号失败: " + e.message);
    }
  }

  $("btnRefresh").onclick = refreshPorts;
  $("btnConnect").onclick = connect;
  $("btnDisconnect").onclick = disconnect;
  $("btnSend").onclick = send;
  $("btnClear").onclick = () => { buffer = []; applyFilters(); };
  $("btnApply").onclick = applyConfig;
  ["filterDir", "filterHex", "filterText", "showAscii", "follow"].forEach((id) => {
    $(id).addEventListener("input", applyFilters);
    $(id).addEventListener("change", applyFilters);
  });
  $("btnDtr").onclick = () => {
    dtrState = !dtrState;
    $("dtr").checked = dtrState;
    setSignals({ dtr: dtrState });
  };
  $("btnRts").onclick = () => {
    rtsState = !rtsState;
    $("rts").checked = rtsState;
    setSignals({ rts: rtsState });
  };
  $("btnBreak").onclick = async () => {
    await setSignals({ break: true });
    setTimeout(() => setSignals({ break: false }), 50);
  };
  $("sendData").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  });

  (async () => {
    try {
      const h = await api("/api/health");
      if (h.activeConnectionId) {
        setConnected(true, h.activeConnectionId);
        const st = await api("/api/status");
        if (st.active) {
          $("path").value = st.active.config.path || "";
          $("baud").value = String(st.active.config.baudRate || 115200);
        }
        connectSse(0);
        setStatus("已附着现有连接");
      }
    } catch (e) { /* ignore */ }
    refreshPorts();
  })();
})();
