(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // 下面这些英文名字是程序内部用的，界面上一律显示成中文。
  const AGENT_LABELS = {
    auto: '自动选择',
    'zhipu-glm': '智谱 GLM（联网）',
    'bailian-qwen': '阿里云通义千问（联网）',
    'openai-thirdparty': 'OpenAI / 第三方（联网）',
    'local-llama': '本机免费模型（断网可用）',
    'self-hosted-graph': '公司自研 AI 服务',
    'offline-draft': '离线起草助手',
    'builtin-offline': '内置兜底助手（不用联网）',
    'offline-template': '本地模板话术',
  };
  const TOOL_LABELS = {
    file_search: '查找资料文件',
    quote_lookup: '查询报价表',
    library_search: '检索我的资料库',
    case_search: '查找成功案例',
    image_match_quote: '按客户图片查报价',
  };
  const INTENT_LABELS = {
    complaint: '投诉 / 索赔 / 质量问题',
    payment: '付款方式 / 账期',
    leadtime: '问交期 / 发货时间',
    sample: '索要样品',
    media: '要图片 / 证书 / 资料',
    case: '要看成功案例',
    price: '问价格 / 报价 / 折扣',
    followup: '跟进 / 催单 / 回访',
    greeting: '寒暄 / 一般询问',
  };
  const cnAgent = (id) => AGENT_LABELS[id] || id || '内置助手';
  const cnTool = (name) => TOOL_LABELS[name] || name || '未知操作';

  // 工具清单是接口协议的一部分，名字必须保持英文，改动会导致网关认不出来。
  // parameters 必须写全：内置模板助手不挑，但智谱 / OpenAI 这类正规接口少了它会直接报「参数有误」。
  const TOOLS = [
    {
      type: 'function',
      function: {
        name: 'file_search', description: '按型号+资料类型检索客服资料库',
        parameters: {
          type: 'object',
          properties: {
            sku: { type: 'string', description: '产品型号或产品名' },
            kind: { type: 'string', enum: ['image', 'quote', 'cert', 'case'] },
            keyword: { type: 'string' },
          },
          required: ['sku'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'quote_lookup', description: '读取报价表价格/MOQ/交期',
        parameters: {
          type: 'object',
          properties: { sku: { type: 'string', description: '产品型号' } },
          required: ['sku'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'library_search',
        description: '在已整理的客服资料库里按型号、产品名、系列或关键词检索真实价格、货期、规格与来源行号',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '型号、产品名、系列或任意关键词' },
            limit: { type: 'number', description: '最多返回几条，默认 8' },
          },
          required: ['keyword'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'case_search', description: '检索成功案例库',
        parameters: {
          type: 'object',
          properties: { country: { type: 'string' }, product: { type: 'string' }, keyword: { type: 'string' } },
        },
      },
    },
  ];

  // 后台服务完全连不上时用的兜底话术，绝不编造价格和文件名。
  // 格式与网关一致：外文正文 / 中文翻译 / 中文说明，复制时只取第一段。
  const OFFLINE_TEMPLATES = [
    {
      match: /报价|价格|price|quote|moq|交期/i,
      draft: [
        '【回复稿】',
        'Hi, thank you for your inquiry. We are confirming the price and lead time internally and will send you a verified quotation shortly.',
        '',
        '【中文翻译】',
        '您好，感谢您的询价。我们正在内部核实价格和交期，稍后会发给您一份核实过的报价。',
        '',
        '【中文说明】',
        '后台服务没连上，现在用的是本地模板。这里没有写任何价格，请自己查报价表核对后再回复客户。',
      ].join('\n'),
    },
    {
      match: /图|图片|photo|image|证书|cert/i,
      draft: [
        '【回复稿】',
        'Hi, we are collecting the product photos and certificates you requested and will share them shortly.',
        '',
        '【中文翻译】',
        '您好，我们正在整理您需要的产品图片和证书，稍后就发给您。',
        '',
        '【中文说明】',
        '后台服务没连上，没有检索资料库。请不要编造附件文件名，自己去资料文件夹里找。',
      ].join('\n'),
    },
    {
      match: /.*/,
      draft: [
        '【回复稿】',
        'Hi, thank you for your message. We have received it and will get back to you shortly with a complete reply.',
        '',
        '【中文翻译】',
        '您好，感谢来信，我们已经收到，稍后会给您一份完整回复。',
        '',
        '【中文说明】',
        '后台服务没连上，用的是本地兜底模板，请自己补充业务信息。',
      ].join('\n'),
    },
  ];

  /**
   * 回复稿分块解析（与 packages/core/src/draft.ts 的 splitDraft 保持同一套规则）。
   * 界面靠它把「能发给客户的外文正文」和「只给客服看的中文」分开：
   * clean 进剪贴板，translation / notes 只显示在灰底区域。
   */
  const MARKS = {
    draft: '【回复稿】',
    translation: '【中文翻译】',
    notes: '【中文说明】',
    sources: '【资料来源】',
  };
  const ALL_MARKS = [MARKS.draft, MARKS.translation, MARKS.notes, MARKS.sources];

  function parseDraft(text) {
    // 与服务端 splitDraft 同步：去掉模型偶尔吐出的思考标签，并只保留第一份三段结构
    text = String(text ?? '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<\/?think\s*>/gi, '')
      .trim();
    const first = text.indexOf(MARKS.draft);
    if (first >= 0) {
      const second = text.indexOf(MARKS.draft, first + MARKS.draft.length);
      if (second >= 0) text = text.slice(0, second).trimEnd();
    }
    const parts = { draft: [], translation: [], notes: [] };
    let current = 'draft';
    let structured = false;
    let pos = 0;
    while (pos < text.length) {
      let next = -1;
      let mark = '';
      for (const m of ALL_MARKS) {
        const i = text.indexOf(m, pos);
        if (i >= 0 && (next < 0 || i < next)) { next = i; mark = m; }
      }
      if (next < 0) { parts[current].push(text.slice(pos)); break; }
      parts[current].push(text.slice(pos, next));
      structured = true;
      current = mark === MARKS.draft ? 'draft' : mark === MARKS.translation ? 'translation' : 'notes';
      if (current === 'notes') parts.notes.push(mark);
      pos = next + mark.length;
    }
    const join = (arr) => arr.join('').replace(/^[\r\n]+|[\r\n]+$/g, '').trim();
    let clean = join(parts.draft);
    if (!structured) clean = text.trim();
    if (!clean && text.trim()) clean = text.trim();
    return { clean, translation: join(parts.translation), notes: join(parts.notes) };
  }

  const state = {
    mode: 'browser',
    gatewayUrl: location.origin,
    token: localStorage.getItem('tcs_token') || 'dev-client-token-change-me',
    sessionId: 's_' + Date.now(),
    draft: '',          // 网关返回的完整文本（含中文翻译与注解）
    cleanDraft: '',     // 只有外文正文，复制按钮和确认发送只用它
    translation: '',
    notes: '',
    restartArmed: false,
    meta: null,
    attachments: [],
    toolLines: [],
    needConfirm: false,
    confirmed: false,
    generating: false,
    requestId: null,
    recordId: null,
    ws: null,
    // 图文聊天：待发送的客户图片（最多 4 张）、每张各自的比对结果、当前查看的那张
    images: [],            // [{ uid, name, dataUrl, result, pickedId, status, error }]
    activeImageUid: '',
    outImages: [],         // 本次生成后「可随稿发给客户」的产品图快照
    outThreadDone: false,  // 本轮是否已把带图回复写进会话记录（防重复气泡）
    originalCache: {},     // 资料库图片 id → 原图 dataURL，避免重复解几百 MB 的 xlsx
    imageStatus: null,
    previewOffset: 0,
    previewLoaded: false,
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toast(msg, isErr) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 4200);
  }
  function setStatus(kind, text) {
    const el = $('statusBadge');
    el.className = 'badge badge-' + kind;
    el.textContent = text;
  }

  function renderDraft() {
    if (!state.draft) {
      $('draft').innerHTML = '<span class="placeholder">还没有回复稿，先粘贴客户消息再点「生成回复稿」</span>';
      $('translationBox').classList.add('hidden');
      $('notesBox').classList.add('hidden');
      $('translation').textContent = '';
      $('notes').textContent = '';
      state.cleanDraft = '';
      state.translation = '';
      state.notes = '';
      return;
    }
    const parts = parseDraft(state.draft);
    // 服务端已按同一套标记切好，优先信服务端（外部 AI 输出格式不规整时更保险）
    if (state.meta && state.meta.clean_draft) parts.clean = state.meta.clean_draft;
    if (state.meta && state.meta.translation) parts.translation = state.meta.translation;
    state.cleanDraft = parts.clean;
    state.translation = parts.translation;
    state.notes = parts.notes;

    // 敏感数字只在外文正文里高亮；中文区用 textContent，避免把注解当成 HTML 执行
    const html = esc(parts.clean).replace(
      /(USD\s?\d[\d.,]*|\$\s?\d[\d.,]*|\bMOQ\b[^,\n。]*|交期[^，。\n]*|价格[^，。\n]*|报价[^，。\n]*|账期[^，。\n]*|索赔[^，。\n]*|\b\d+\s*days\b|生效\s*\d{4}-\d{2}-\d{2})/gi,
      '<span class="sensitive">$&</span>',
    );
    $('draft').innerHTML = html;
    $('draft').scrollTop = $('draft').scrollHeight;
    $('translation').textContent = parts.translation;
    $('notes').textContent = parts.notes;
    $('translationBox').classList.toggle('hidden', !parts.translation);
    $('notesBox').classList.toggle('hidden', !parts.notes);
  }

  function renderMeta() {
    const m = state.meta;
    if (!m) return;
    const tools = (m.tools_called || [])
      .map((t) => `${esc(cnTool(t.name))}${t.ok ? '' : ' · 未命中'}${t.file ? ` · ${esc(t.file)}${t.row ? ` 第 ${t.row} 行` : ''}` : ''}`)
      .join('　');
    const chips = [
      m.price_sensitive ? '<span class="chip warn">含价格 / 交期，请核对</span>' : '<span class="chip">普通内容</span>',
      m.need_human_confirm ? '<span class="chip warn">必须人工确认</span>' : '<span class="chip">可自行复核</span>',
      m.sticky ? '<span class="chip">本次会话固定同一个 AI</span>' : '',
    ].join('');
    $('meta').innerHTML =
      `<div><b>本次由</b> ${esc(cnAgent(m.agent))} <b>起草</b> · <b>用时</b> ${Number(m.latency_ms || 0)} 毫秒</div>` +
      `<div><b>查过的资料</b> ${tools || '没有查资料'}</div>` +
      (m.failover && m.failover.length ? `<div><b>没能连上的 AI</b> ${esc(m.failover.map(cnAgent).join('、'))}（已自动换用可用的）</div>` : '') +
      (m.intent ? `<div><b>客户在问</b> ${esc(INTENT_LABELS[m.intent] || m.intent)}（话术库按这个场景优化）</div>` : '') +
      (m.suggestion_id ? `<div><b>学习记录编号</b> ${esc(m.suggestion_id)}</div>` : '') +
      `<div style="margin-top:4px">${chips}</div>` +
      (['builtin-offline', 'offline-draft', 'offline-template'].includes(m.agent)
        ? '<div class="banner" style="margin-top:8px">当前是<b>内置模板助手</b>（本机规则模板），不是联网 AI，所以措辞比较固定。<b>右上角「连接器：已连上」说的是 WorkBuddy，不代表这封稿是 WorkBuddy 写的。</b>想让本窗口也用真 AI：在黑窗口菜单 <b>5 → 2</b> 填智谱密钥，左上角会变成「智谱 GLM：已连上」。也可以点「<b>交给 WorkBuddy 写</b>」把指令粘到 WorkBuddy 对话里。标记「记成功 / 记失败」也能让模板越来越贴合你的说法。</div>'
        : '');
    $('meta').classList.remove('hidden');
  }

  function renderAttachments() {
    const rows = [];
    for (const f of state.attachments) {
      const d = f.data || {};
      if (d.source_path || d.file) {
        rows.push({ label: '报价来源', path: `${d.file || d.source_path}${d.row ? ` · 第 ${d.row} 行` : ''}${d.effective_date ? ` · 生效 ${d.effective_date}` : ''}` });
      }
      if (Array.isArray(d.files)) for (const x of d.files) rows.push({ label: '资料文件', path: x.path });
      if (Array.isArray(d.cases)) for (const c of d.cases) rows.push({ label: '入库案例', path: `${c.id} · ${c.country}/${c.product}` });
      if (!f.ok && d.hint) rows.push({ label: '提示', path: d.hint });
      if (d.error) rows.push({ label: '错误', path: d.error });
    }
    if (!rows.length) {
      $('attachments').classList.add('hidden');
      return;
    }
    $('attachments').innerHTML =
      '<div class="attach-title">数据来源（点「复制」可拿到文件位置，方便自己核对）</div>' +
      rows.map((r) => `<div class="attach-row"><span><b>${esc(r.label)}</b> <span class="attach-path">${esc(r.path)}</span></span><button data-path="${esc(r.path)}">复制</button></div>`).join('');
    $('attachments').classList.remove('hidden');
  }

  function renderTools() {
    $('tools').innerHTML = state.toolLines.length
      ? '<div class="attach-title">AI 查资料的过程</div>' + state.toolLines.map((l) => `<div class="tool-line">${esc(l)}</div>`).join('')
      : '';
    $('tools').classList.toggle('hidden', !state.toolLines.length);
  }

  function applyConfirm() {
    const need = Boolean(state.meta && state.meta.need_human_confirm);
    state.needConfirm = need;
    $('confirmWarning').classList.toggle('hidden', !need);
    $('btnSend').disabled = !state.cleanDraft || (need && !state.confirmed);
    $('btnCopy').disabled = !state.cleanDraft;
    const canRate = Boolean(state.recordId);
    $('btnMarkSuccess').disabled = !canRate;
    $('btnMarkFailure').disabled = !canRate;
  }

  function finish(ok) {
    state.generating = false;
    $('btnGenerate').disabled = false;
    $('streamState').textContent = ok ? '生成完成' : '生成失败';
    // 生成完就把「我方回复稿 + 命中的产品图」放进会话记录：图片在聊天框里真正输出出来
    if (ok && state.outImages.length && !state.outThreadDone) {
      state.outThreadDone = true;
      appendMessage('draft', 'AI 回复稿 · 附产品图', state.cleanDraft || '', {
        images: state.outImages.map((m) => ({ src: m.缩略图, caption: m.型号 || '产品图' })),
      });
    }
    applyConfirm();
  }

  function handleFrame(frame) {
    switch (frame.type) {
      case 'delta':
        state.draft += frame.content || '';
        renderDraft();
        break;
      case 'tool_call':
        state.toolLines.push(`→ 正在${cnTool(frame.name)}：${JSON.stringify(frame.args || {})}`);
        renderTools();
        break;
      case 'tool_result':
        state.attachments.push(frame);
        state.toolLines.push(`← ${cnTool(frame.name)}：${frame.ok ? '找到了' : '没找到'}`);
        renderAttachments();
        renderTools();
        break;
      case 'meta':
        state.meta = frame.x_meta;
        state.recordId = frame.x_meta.suggestion_id || null;
        renderDraft(); // 用服务端切好的 clean_draft 覆盖一次，确保复制内容绝对干净
        renderMeta();
        applyConfirm();
        break;
      case 'done':
        break;
      case 'error':
        toast('生成失败：' + (frame.message || '请稍后重试'), true);
        break;
      case 'stream_end':
        renderDraft();
        finish(true);
        break;
      default:
        break;
    }
  }

  /** 会话面板右侧的条数提示；顺便提醒「这一块可以自己上下滑」 */
  function updateThreadCount() {
    const el = $('threadCount');
    if (!el) return;
    const n = $('thread').querySelectorAll('.msg').length;
    el.textContent = n
      ? `${n} 条消息 · 在此区域内上下滑动`
      : '0 条 · 消息多时在此区域内滑动';
  }

  /** 全屏看图：聊天气泡、待发送缩略图、资料库预览共用这一层 */
  function showLightbox(src) {
    if (!src) return;
    $('imageLightboxImg').src = src;
    $('imageLightbox').classList.remove('hidden');
  }

  function appendMessage(kind, head, body, extra) {
    const historical = !!(extra && extra.historical);
    const empty = $('thread').querySelector('.thread-empty');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'msg' + (kind === 'push' ? ' push' : '') + (historical ? ' history' : '');
    const h = document.createElement('div');
    h.className = 'msg-head';
    const a = document.createElement('span');
    a.textContent = head;
    const b = document.createElement('span');
    b.textContent = historical ? (extra.at || '历史') : new Date().toLocaleTimeString('zh-CN', { hour12: false });
    h.append(a, b);
    const content = document.createElement('div');
    content.className = 'msg-body';
    content.textContent = body;
    div.append(h, content);
    // 图片消息：文字下面挂真实图片缩略图，点一下放大；存档里只写「附 N 张图片」，不塞 base64
    const imgs = (extra && extra.images) || [];
    if (imgs.length) {
      const gallery = document.createElement('div');
      gallery.className = 'msg-images';
      imgs.forEach((it) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'msg-image';
        btn.title = it.caption || '点开看大图';
        const img = document.createElement('img');
        img.src = it.src;
        img.alt = it.caption || '聊天图片';
        img.loading = 'lazy';
        btn.appendChild(img);
        if (it.caption) {
          const cap = document.createElement('span');
          cap.textContent = it.caption;
          btn.appendChild(cap);
        }
        btn.onclick = () => showLightbox(it.src);
        gallery.appendChild(btn);
      });
      div.appendChild(gallery);
    }
    if (extra && extra.suggestion) {
      const btn = document.createElement('button');
      btn.className = 'link-btn';
      btn.textContent = '把建议放入回复稿';
      btn.onclick = () => {
        state.draft = extra.suggestion;
        state.meta = extra.x_meta || null;
        renderDraft();
        if (state.meta) renderMeta();
        applyConfirm();
        $('pushDot').classList.add('hidden');
      };
      div.appendChild(btn);
    }
    const thread = $('thread');
    thread.prepend(div);
    // 新消息插在最前面，回到顶部保证最新一条始终可见；滚动只发生在这块区域内
    thread.scrollTop = 0;
    updateThreadCount();
    // 勾选存档后，每条新聊天自动进客户档案；历史回显不重复写
    if (!historical) recordChat(kind, head, imgs.length ? `${body}\n[附 ${imgs.length} 张图片]` : body);
  }

  function handlePush(frame) {
    if (frame.event !== 'wechat_message') return;
    const d = frame.data || {};
    state.sessionId = d.session_id || state.sessionId;
    $('sessionLabel').textContent = '本次会话：' + state.sessionId;
    $('pushDot').classList.remove('hidden');
    appendMessage('push', `企业微信新消息 · ${d.from || '客户'}`, d.text || '', { suggestion: d.suggestion, x_meta: d.x_meta });
  }

  /** 浏览器预览可能被代理到别的端口，逐个探测可用的后台服务 */
  async function resolveGateway() {
    const candidates = [
      localStorage.getItem('tcs_gateway'),
      location.protocol.startsWith('http') ? location.origin : '',
      'http://127.0.0.1:8787',
    ].filter(Boolean);
    for (const base of candidates) {
      try {
        const r = await fetch(base + '/v1/health');
        if (r.ok) return base;
      } catch (_) {}
    }
    return candidates[candidates.length - 1];
  }

  async function initConfig() {
    if (window.bridge && window.bridge.mode === 'electron') {
      state.mode = 'electron';
      const c = await window.bridge.getConfig();
      state.gatewayUrl = c.gatewayUrl;
      state.token = '';
      window.bridge.onFrame(({ requestId, frame }) => {
        if (requestId === state.requestId) handleFrame(frame);
      });
      window.bridge.onPush(handlePush);
      window.bridge.onShortcut((d) => {
        if (d.kind === 'clipboard' && d.text) {
          $('input').value = d.text;
          toast('已把剪贴板内容放进输入框');
        }
      });
      if (window.bridge.onRestarted) {
        window.bridge.onRestarted(() => toast('程序已重启完成，连接已重新建立'));
      }
      $('gatewayUrlInput').value = state.gatewayUrl;
      $('gatewayUrlInput').disabled = true;
      $('tokenInput').placeholder = '由程序自动保管，界面上看不到';
      $('tokenInput').disabled = true;
    } else {
      state.mode = 'browser';
      state.gatewayUrl = await resolveGateway();
      state.token = localStorage.getItem('tcs_token') || 'dev-client-token-change-me';
      $('gatewayUrlInput').value = state.gatewayUrl;
      $('tokenInput').value = state.token;
      connectWS();
    }
  }

  function connectWS() {
    if (state.mode !== 'browser') return;
    let socket;
    try {
      const url = `${state.gatewayUrl.replace(/^http/, 'ws')}/ws/stream?token=${encodeURIComponent(state.token)}`;
      socket = new WebSocket(url);
      state.ws = socket;
      socket.onmessage = (ev) => {
        try {
          const f = JSON.parse(String(ev.data));
          if (f.type === 'push') handlePush(f);
        } catch (_) {}
      };
      socket.onclose = () => {
        if (state.ws === socket) setTimeout(connectWS, 3000);
      };
      socket.onerror = () => {
        try { socket.close(); } catch (_) {}
      };
    } catch (_) {}
  }

  async function loadAgents(refresh) {
    try {
      let j;
      if (state.mode === 'electron' && window.bridge) {
        j = await window.bridge.getAgents(!!refresh);
        if (j.error) throw new Error(j.error);
      } else {
        const r = await fetch(`${state.gatewayUrl}/v1/agents${refresh ? '?refresh=1' : ''}`, { headers: { Authorization: `Bearer ${state.token}` } });
        if (!r.ok) throw new Error('服务响应异常');
        j = await r.json();
      }
      const sel = $('agentSelect');
      sel.innerHTML = '<option value="auto">自动选择（推荐）</option>';
      const list = j.data || [];
      for (const a of list) {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = `${cnAgent(a.id)}（${a.healthy ? '已连上' : '暂不可用'}）`;
        opt.title = a.healthy ? '这个 AI 现在能正常工作' : '没有配置密钥、没联网，或服务没启动';
        sel.appendChild(opt);
      }
      // 右上角状态要一眼看出「第三方 AI 到底连没连上」。
      // 注意：旁边那个「连接器：已连上」说的是 WorkBuddy，不是这边的 AI，两者不是一回事。
      const BUILTIN = ['builtin-offline', 'offline-draft', 'offline-template'];
      const online = list.filter((a) => a.healthy && !BUILTIN.includes(a.id));
      const available = list.filter((a) => a.healthy).length;
      if (online.length) {
        const names = online.map((a) => cnAgent(a.id).replace(/（.*?）/g, '')).join('、');
        setStatus('ok', `${names}：已连上（可用 ${available} 个）`);
      } else {
        setStatus('wait', '仅内置助手可用（外部 AI 未连接）');
      }
    } catch (e) {
      setStatus('err', '服务未启动');
    }
  }

  function offlineFallback(text, e) {
    setStatus('err', '服务未启动');
    $('offlineBanner').classList.remove('hidden');
    const tpl = OFFLINE_TEMPLATES.find((t) => t.match.test(text)) || OFFLINE_TEMPLATES[2];
    state.draft = tpl.draft;
    state.meta = { agent: 'offline-template', latency_ms: 0, tools_called: [], price_sensitive: false, need_human_confirm: false };
    renderDraft();
    renderMeta();
    finish(true);
    toast('后台服务没连上，已自动切换为本地模板话术（不会编造价格）', true);
  }

  function resetResult() {
    state.draft = '';
    state.meta = null;
    state.recordId = null;
    state.attachments = [];
    state.toolLines = [];
    state.confirmed = $('confirmBox').checked;
    $('learnMsg').classList.add('hidden');
    $('confirmWarning').classList.add('hidden');
    $('meta').classList.add('hidden');
    $('attachments').classList.add('hidden');
    $('tools').classList.add('hidden');
    $('outImages').classList.add('hidden');
    $('outImagesGrid').innerHTML = '';
    state.outImages = [];
    state.outThreadDone = false;
    $('streamState').textContent = '正在逐字生成…';
    renderDraft();
    applyConfirm();
  }

  async function generate() {
    let text = $('input').value.trim();
    const imgs = state.images.slice();
    // 只发图、没打字也算一次询价，给模型一句能读懂的中文说明
    if (!text && imgs.length) text = `客户发来 ${imgs.length} 张产品图片，想问这几款的价格和货期。`;
    if (!text) return toast('请把客户消息粘贴到输入框，或直接 Ctrl+V 贴一张客户图片', true);
    if (state.generating) return;
    state.generating = true;
    $('btnGenerate').disabled = true;
    resetResult();
    // 图文一起进会话记录；同一批图反复生成时不重复贴气泡
    const fresh = imgs.filter((it) => !it.inThread);
    appendMessage('customer', '客户消息 · 本次会话', text, {
      images: fresh.map((it) => ({ src: it.dataUrl, caption: it.name })),
    });
    imgs.forEach((it) => { it.inThread = true; });
    // 客户外文原话同步翻成中文，只出现在右侧对照栏；绝不进回复稿，也不发给客户
    if (!/^客户发来 \d+ 张产品图片/.test(text)) translateCustomer(text);

    const agent = $('agentSelect').value;
    // 图片比对结果当作「工具返回的真实数据」注入，模型据此写稿，不靠看图猜型号
    const fullText = text + imageContextText();
    const payload = {
      model: agent,
      messages: [{ role: 'user', content: fullText }],
      stream: true,
      temperature: 0.4,
      tools: TOOLS,
      context: {
        session_id: state.sessionId,
        customer: {
          country: $('countryInput').value.trim(),
          type: 'trader',
          stage: $('stageSelect').value,
          name: $('nameInput').value.trim(),
        },
        channel: 'wechat',
        locale: $('localeSelect').value,
        scenario: $('stageSelect').value,
      },
      agent_hint: agent === 'auto' ? undefined : { preferred: agent, fallback: ['builtin-offline'] },
    };

    // 把已确认型号对应的真实产品图摆到回复稿下面，供客服复制 / 另存后发给客户
    state.outImages = collectOutImages();
    renderOutImages();

    if (state.mode === 'electron' && window.bridge) {
      try {
        state.requestId = await window.bridge.suggestStream(payload);
      } catch (e) {
        offlineFallback(text, e);
      }
      return;
    }

    try {
      const r = await fetch(`${state.gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok || !r.body) throw new Error('服务响应异常，错误码 ' + r.status);
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let ended = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { ended = true; break; }
          try { handleFrame(JSON.parse(data)); } catch (_) {}
        }
        if (ended) break;
      }
      handleFrame({ type: 'stream_end' });
    } catch (e) {
      offlineFallback(text, e);
    }
  }

  async function copyToClipboard(text) {
    if (state.mode === 'electron' && window.bridge) return window.bridge.copy({ text: text });
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return { ok: true };
    }
  }

  async function logSent() {
    if (state.mode === 'electron' && window.bridge) {
      return window.bridge.logSent({ session_id: state.sessionId, operator: 'desktop' });
    }
    try {
      await fetch(`${state.gatewayUrl}/v1/audit/sent`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: state.sessionId, operator: 'desktop-preview', confirmed: true }),
      });
    } catch (_) {}
  }

  async function onSend() {
    if (!state.cleanDraft) return;
    if (state.needConfirm && !state.confirmed) return toast('请先勾选「我已人工核对」', true);
    const confirmed = !state.needConfirm || state.confirmed;
    try {
      // 进剪贴板的永远只有外文正文：中文翻译和注解绝不能发给客户
      if (state.mode === 'electron' && window.bridge) {
        await window.bridge.confirmSend({ text: state.cleanDraft, confirmed: confirmed });
      } else {
        await copyToClipboard(state.cleanDraft);
      }
      // 我方回复稿也进会话记录，并随存档一起写进客户档案（标注「已复制待发送」）
      appendMessage('draft', '我方回复稿 · 已复制待发送', state.cleanDraft);
      await logSent();
      toast(state.outImages.length
        ? '已复制外文正文；产品图请用回复稿下方的「复制图片」逐张复制后粘贴到微信（剪贴板一次只放一样）'
        : '已复制外文正文，请自己粘贴到微信发送（不含中文翻译和注解，程序不会自动发送）');
    } catch (e) {
      toast('操作被拒绝：' + (e.message || e), true);
    }
  }

  /* ==================== WorkBuddy 连接检查 + 话术学习闭环 ==================== */

  /** 统一调用网关：桌面窗口版的连接口令只在主进程，界面永远碰不到 */
  async function callApi(pathname, method = 'GET', body) {
    if (state.mode === 'electron' && window.bridge && window.bridge.api) {
      const j = await window.bridge.api({ path: pathname, method, body });
      if (j && j.error) throw new Error(j.error);
      return j;
    }
    const r = await fetch(state.gatewayUrl + pathname, {
      method,
      headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error('后台服务返回错误（错误码 ' + r.status + '）');
    return await r.json();
  }

  /* ==================== 右侧中文对照栏：客户消息翻译 ==================== */
  let transSeq = 0;

  /** 把客户外文原话翻成简体中文，只显示在右侧栏；不进回复稿、不进剪贴板、不发给客户。 */
  async function translateCustomer(text) {
    const body = String(text || '').trim();
    const out = $('customerTrans');
    const hint = $('customerTransHint');
    const btn = $('btnTranslateCustomer');
    if (!body) { toast('请先把客户消息粘贴到输入框', true); return; }
    const seq = ++transSeq;
    out.textContent = '正在翻译…';
    out.classList.add('busy');
    hint.classList.add('hidden');
    btn.disabled = true;
    try {
      const r = await callApi('/v1/translate', 'POST', { text: body });
      if (seq !== transSeq) return; // 新一次生成已经开始，丢掉这次的过期结果
      if (r && r.ok && r.translation) {
        out.textContent = r.translation;
        hint.textContent = r.hint || '';
        hint.classList.toggle('hidden', !r.hint);
      } else {
        out.textContent = '暂时没有中文译文。';
        hint.textContent = (r && r.hint) || '翻译没成功，请点「翻译这句」重试。';
        hint.classList.remove('hidden');
      }
    } catch (e) {
      if (seq !== transSeq) return;
      out.textContent = '暂时没有中文译文。';
      hint.textContent = '翻译没成功：' + (e && e.message ? e.message : e) + '。请确认后台服务在运行。';
      hint.classList.remove('hidden');
    } finally {
      if (seq === transSeq) {
        out.classList.remove('busy');
        btn.disabled = false;
      }
    }
  }

  /* ==================== 右栏手动翻译：中文 → 英文，只进剪贴板不进回复稿 ==================== */
  let manualTransSeq = 0;

  /** 客服手动输入中文翻成英文：结果只留在右栏，绝不写进回复稿、绝不自动发送。 */
  async function translateManual() {
    const input = $('manualTranslateInput');
    const out = $('manualTranslateResult');
    const hint = $('manualTranslateHint');
    const btn = $('btnManualTranslate');
    const copyBtn = $('btnManualCopy');
    if (!input || !out || !hint || !btn || !copyBtn) return;
    const body = String(input.value || '').trim();
    if (!body) { toast('请先输入要翻译的中文', true); input.focus(); return; }

    const seq = ++manualTransSeq;
    out.textContent = '正在翻译…';
    out.classList.remove('placeholder');
    out.classList.add('busy');
    hint.classList.add('hidden');
    btn.disabled = true;
    copyBtn.disabled = true;
    state.manualTranslation = '';
    try {
      const r = await callApi('/v1/translate', 'POST', { text: body, target: 'en' });
      if (seq !== manualTransSeq) return; // 又点了一次翻译，丢掉这次的过期结果
      if (r && r.ok && r.translation) {
        state.manualTranslation = String(r.translation);
        out.textContent = r.translation;
        hint.textContent = r.hint || '';
        hint.classList.toggle('hidden', !r.hint);
        copyBtn.disabled = false;
      } else {
        out.textContent = '暂时没有英文译文。';
        out.classList.add('placeholder');
        hint.textContent = (r && r.hint) || '翻译没成功，请点「翻译成英文」重试。';
        hint.classList.remove('hidden');
      }
    } catch (e) {
      if (seq !== manualTransSeq) return;
      out.textContent = '暂时没有英文译文。';
      out.classList.add('placeholder');
      hint.textContent = '翻译没成功：' + (e && e.message ? e.message : e) + '。请确认后台服务在运行。';
      hint.classList.remove('hidden');
    } finally {
      if (seq === manualTransSeq) {
        out.classList.remove('busy');
        btn.disabled = false;
      }
    }
  }

  /** 只复制英文译文；复制成功后仍由客服自己在微信里粘贴、点发送。 */
  async function copyManualTranslation() {
    const text = state.manualTranslation;
    if (!text) { toast('先翻译出英文再复制', true); return; }
    try {
      const r = await copyToClipboard(text);
      if (r && r.ok === false) throw new Error('剪贴板不可用');
      toast('英文译文已复制到剪贴板');
    } catch (_) {
      toast('复制没成功，请手动选中译文复制', true);
    }
  }

  /* ==================== 客户带图询价：图片比对 + 资料库 hover 预览 ==================== */
  /*
   * 速度：图片先在浏览器里压到 1280px，再送到本机网关算 dHash / pHash / 颜色特征，
   *       和已经建好的 3000+ 张报价表内嵌图指纹逐条比，全程本地、毫秒级、不联网。
   * 精准：结果给的是「最像的几张 + 型号 + 出厂价 + 来源文件/工作表/行号」，
   *       客服点一下确认采用哪一款，程序绝不替人拍板，也绝不自动发消息给客户。
   */
  const IMG_PAGE = 24;

  function curSymbol(cur) {
    return cur === 'USD' ? '$' : cur === 'EUR' ? '€' : '¥';
  }
  function priceText(m) {
    if (m.价格 == null) return '原表未填价格';
    return `${curSymbol(m.币种)}${m.价格原文 || m.价格} ${m.币种 || ''}`.trim();
  }
  function setImageMsg(text, isErr) {
    const el = $('imageMatchMsg');
    if (!text) { el.classList.add('hidden'); return; }
    el.textContent = text;
    el.className = 'image-match-msg' + (isErr ? ' err' : '');
    el.classList.remove('hidden');
  }

  async function refreshImageStatus() {
    try {
      const s = await callApi('/v1/images/status');
      state.imageStatus = s;
      if (s.ok && s.统计) {
        $('imageIndexHint').textContent = `已收录 ${s.统计.图片数} 张产品图 · ${s.统计.有关联型号} 张能对上型号`;
        $('imagePopStat').textContent = `共 ${s.统计.图片数} 张 · ${s.统计.有关联型号} 张有型号`;
      } else {
        $('imageIndexHint').textContent = '还没建图片索引，鼠标停在左边按钮上可一键重建';
        $('imagePopStat').textContent = '尚未建立图片索引';
      }
    } catch (_) {
      $('imageIndexHint').textContent = '图片索引状态读不到（后台服务没开？）';
      $('imagePopStat').textContent = '状态读取失败';
    }
  }

  /** File → 1280px 白底 jpeg 的 dataURL：透明底补白，和报价表白底产品图口径一致 */
  function readAndShrink(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读不到这张图片'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('图片格式打不开，请另存为 jpg / png 再试'));
        img.onload = () => {
          try {
            const max = 1280;
            const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
            const w = Math.max(1, Math.round(img.naturalWidth * scale));
            const h = Math.max(1, Math.round(img.naturalHeight * scale));
            const cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            const ctx = cv.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            resolve(cv.toDataURL('image/jpeg', 0.86));
          } catch (e) { reject(e); }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  const MAX_INPUT_IMAGES = 4;

  /** 当前在看哪一张客户图：候选卡片、放大都跟它走 */
  function activeImage() {
    return state.images.find((x) => x.uid === state.activeImageUid) || state.images[0] || null;
  }

  /** 输入框上方挂着的待发送图：可切换主图、看大图、单张移除 */
  function renderPendingImage() {
    const box = $('pendingImage');
    const list = state.images;
    box.classList.toggle('hidden', !list.length);
    $('btnClearImage').classList.toggle('hidden', !list.length);
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = list.map((it) => {
      const n = (it.result && it.result.候选 || []).length;
      const desc = it.status === 'matching' ? '正在比对…'
        : it.status === 'error' ? `比对失败：${it.error || ''}`
        : n ? `命中 ${n} 个候选${it.pickedId ? ' · 已选型号' : ' · 待人工确认'}` : '库里没找到相似图';
      const cls = it.status === 'error' || (it.status === 'done' && !n) ? 'err' : it.status === 'done' ? 'ok' : '';
      return `<div class="ci-item${it.uid === state.activeImageUid ? ' active' : ''}" data-uid="${esc(it.uid)}" title="点卡片切换当前候选">` +
        `<button type="button" class="ci-thumb" data-act="view" title="点开看大图"><img src="${esc(it.dataUrl)}" alt="${esc(it.name)}" /></button>` +
        '<div class="ci-meta">' +
        `<div class="ci-name" title="${esc(it.name)}">${esc(it.name)}</div>` +
        `<div class="ci-state ${cls}" title="${esc(desc)}">${esc(desc)}</div>` +
        '</div>' +
        '<button type="button" class="ci-del" data-act="del" title="移除这张图片">×</button>' +
        '</div>';
    }).join('');
  }

  function renderMatches() {
    const box = $('imageMatches');
    const cur = activeImage();
    const list = (cur && cur.result && cur.result.候选) || [];
    if (!list.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
    box.innerHTML = list.map((m) => {
      const cls = m.置信度 === '高' ? 'conf-high' : m.置信度 === '中' ? 'conf-mid' : 'conf-low';
      const src = `${m.工作表 || '独立图片'}${m.行号 ? ' · 第 ' + m.行号 + ' 行' : ''}`;
      return `<button type="button" class="img-card${m.id === cur.pickedId ? ' picked' : ''}" data-id="${esc(m.id)}" title="${esc(m.hint)}">` +
        `<img src="${esc(m.缩略图)}" alt="${esc(m.型号 || '候选产品图')}" />` +
        '<div class="img-card-body">' +
        `<div class="img-sku">${esc(m.型号 || (m.名称 ? m.名称 + '（同行产品名）' : '（未关联型号）'))}<span class="img-conf ${cls}">${esc(m.置信度)} ${Math.round((m.相似度 || 0) * 100)}%</span></div>` +
        `<div class="img-price">${esc(priceText(m))}</div>` +
        `<div class="img-src" title="${esc(m.文件)}">${esc(src)}</div>` +
        '</div></button>';
    }).join('');
    box.classList.remove('hidden');
  }

  function renderImageSummary() {
    const list = state.images;
    if (!list.length) { setImageMsg(''); return; }
    const done = list.filter((x) => x.status === 'done');
    const errs = list.filter((x) => x.status === 'error');
    const hits = done.filter((x) => (x.result && x.result.候选 || []).length);
    const trimmed = done.filter((x) => x.result && x.result.已裁白边).length;
    const parts = [];
    if (list.some((x) => x.status === 'matching')) parts.push('正在与资料库比对…');
    if (trimmed) parts.push(`${trimmed} 张带表格白边 / 边框，已自动裁边后比对`);
    if (done.some((x) => x.result && x.result.重复图提示)) parts.push('有图在原表多行重复出现（价格可能不同），请打开原表核对');
    if (hits.length) parts.push(`${hits.length} 张图命中候选，请在下面点卡片确认型号`);
    if (done.length - hits.length) parts.push(`${done.length - hits.length} 张没找到相似图（不会猜型号或价格）`);
    if (errs.length) parts.push(`${errs.length} 张比对失败，请检查后台服务和图片索引`);
    setImageMsg(parts.join('；'), errs.length > 0);
  }

  /** 单张图：本机指纹比对；只有中 / 高置信才默认采用，低置信必须人来点 */
  async function matchOne(it) {
    it.status = 'matching';
    renderPendingImage();
    renderImageSummary();
    try {
      const r = await callApi('/v1/images/match', 'POST', { image: it.dataUrl, limit: 5 });
      it.result = r;
      const first = (r.候选 || [])[0];
      it.pickedId = first && first.置信度 !== '低' ? first.id : '';
      it.status = 'done';
    } catch (e) {
      it.status = 'error';
      it.error = String((e && e.message) || e);
      it.result = { ok: false, 候选: [], hint: '图片比对没成功：' + it.error };
    }
    if (!state.activeImageUid) state.activeImageUid = it.uid;
    renderPendingImage();
    renderMatches();
    renderImageSummary();
    syncOutImages();
  }

  /** 从 File / 剪贴板 / 拖拽加图：先压到 1280px，再逐张比对（不并发撑爆本机网关） */
  async function addImageFiles(files, defaultName) {
    const picked = Array.from(files || []).filter((f) => f && (f.type || '').startsWith('image/'));
    if (!picked.length) return toast('没读到图片，请贴一张 png / jpg 截图，或拖入图片文件', true);
    const room = MAX_INPUT_IMAGES - state.images.length;
    if (room <= 0) return toast(`一次最多 ${MAX_INPUT_IMAGES} 张，先移除几张再加`, true);
    if (picked.length > room) toast(`一次最多 ${MAX_INPUT_IMAGES} 张，这次只加了前 ${room} 张`, true);
    setImageMsg('正在压缩图片并与资料库里的产品图比对…', false);
    for (const f of picked.slice(0, room)) {
      try {
        const dataUrl = await readAndShrink(f);
        const it = {
          uid: `im_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: f.name || defaultName || '客户图片',
          dataUrl, result: null, pickedId: '', status: 'matching', error: '', inThread: false,
        };
        state.images.push(it);
        if (!state.activeImageUid) state.activeImageUid = it.uid;
        renderPendingImage();
        await matchOne(it);
      } catch (e) {
        toast('这张图片读不了：' + ((e && e.message) || e), true);
      }
    }
    // 带图 = 新的一轮核对，之前勾的「已人工核对」一律作废
    state.confirmed = false;
    $('confirmBox').checked = false;
    applyConfirm();
  }

  function removeImage(uid) {
    state.images = state.images.filter((x) => x.uid !== uid);
    if (state.activeImageUid === uid) state.activeImageUid = (state.images[0] || {}).uid || '';
    renderPendingImage();
    renderMatches();
    renderImageSummary();
    syncOutImages();
  }

  function clearPickedImage() {
    state.images = [];
    state.activeImageUid = '';
    state.outImages = [];
    $('pendingImage').classList.add('hidden');
    $('pendingImage').innerHTML = '';
    $('imageMatches').classList.add('hidden');
    $('imageMatches').innerHTML = '';
    $('imageMatchMsg').classList.add('hidden');
    $('btnClearImage').classList.add('hidden');
    $('outImages').classList.add('hidden');
    $('outImagesGrid').innerHTML = '';
    $('imageFile').value = '';
  }

  /* -------------------- 图片输出：报价表里的真实原图 -------------------- */

  /** 只把「客服已确认采用」的候选列为可发给客户的产品图；低置信绝不自动进清单 */
  function collectOutImages() {
    const map = new Map();
    for (const it of state.images) {
      const list = (it.result && it.result.候选) || [];
      const picked = list.find((m) => m.id === it.pickedId);
      if (picked && !map.has(picked.id)) map.set(picked.id, picked);
    }
    return [...map.values()].slice(0, 6);
  }

  function syncOutImages() {
    state.outImages = collectOutImages();
    renderOutImages();
  }

  function renderOutImages() {
    const box = $('outImages');
    const grid = $('outImagesGrid');
    // 只有带图询价、且已开始起草回复之后才展示，纯文字回复不冒出空区块
    if (!state.images.length || (!state.generating && !state.draft)) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const list = state.outImages || [];
    const unmatched = state.images.filter((it) => it.status !== 'matching' && !(it.result && it.result.候选 || []).length).length;
    $('outImagesHint').textContent = list.length
      ? `已确认 ${list.length} 款 · 来自你的报价表${unmatched ? ` · 另有 ${unmatched} 张客户图没匹配到` : ''}`
      : '这次没有确认任何型号';
    if (!list.length) {
      grid.innerHTML = `<div class="out-images-empty">${esc(
        unmatched
          ? '客户图片没匹配到资料库产品图，或候选置信度太低，需要人工点候选卡片确认。程序不会替你猜型号或价格。'
          : '选一张客户图片并点候选卡片确认型号后，这里会列出可发给客户的产品图。',
      )}</div>`;
      return;
    }
    grid.innerHTML = list.map((m) => {
      const src = `${m.工作表 || '独立图片'}${m.行号 ? ' · 第 ' + m.行号 + ' 行' : ''}`;
      return `<div class="out-card" data-id="${esc(m.id)}">` +
        `<img class="out-card-img" src="${esc(m.缩略图)}" alt="${esc(m.型号 || '产品图')}" data-act="view" title="点开看报价表原图" />` +
        `<div class="out-card-sku" title="${esc(m.hint)}">${esc(m.型号 || '（未关联型号）')}</div>` +
        `<div class="out-card-price">${esc(priceText(m))}</div>` +
        `<div class="out-card-src" title="${esc(m.文件)}">${esc(src)}</div>` +
        '<div class="out-card-actions">' +
        '<button type="button" data-act="copy" title="把这张产品图复制进剪贴板，可直接粘到微信">复制图片</button>' +
        '<button type="button" data-act="save" title="把报价表里的原图另存到电脑">另存为</button>' +
        '</div></div>';
    }).join('');
  }

  /** 按需向本机网关取原图（只读报价表，结果缓存，不会重复解几百 MB 的 xlsx） */
  async function fetchOriginal(id) {
    if (state.originalCache[id]) return state.originalCache[id];
    const r = await callApi('/v1/images/original?id=' + encodeURIComponent(id));
    if (!r.ok || !r.图片) throw new Error(r.hint || '取原图失败');
    state.originalCache[id] = r;
    return r;
  }

  /** 剪贴板只稳稳认 PNG：webp / jpeg 先过一遍 canvas */
  function toPngDataUrl(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片打不开'));
      img.onload = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = img.naturalWidth; cv.height = img.naturalHeight;
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, cv.width, cv.height);
          ctx.drawImage(img, 0, 0);
          resolve(cv.toDataURL('image/png'));
        } catch (e) { reject(e); }
      };
      img.src = src;
    });
  }

  async function copyImageToSystem(src) {
    const png = await toPngDataUrl(src);
    if (state.mode === 'electron' && window.bridge && window.bridge.copyImage) {
      const r = await window.bridge.copyImage({ dataUrl: png });
      if (!r || !r.ok) throw new Error((r && r.error) || '复制失败');
      return;
    }
    if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
      const bin = atob(png.split(',')[1] || '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) }),
      ]);
      return;
    }
    throw new Error('这个环境不支持复制图片，请点「另存为」保存到电脑后再拖进微信');
  }

  async function saveImageToDisk(dataUrl, filename) {
    if (state.mode === 'electron' && window.bridge && window.bridge.saveImage) {
      const r = await window.bridge.saveImage({ dataUrl, filename });
      if (r && r.ok) toast('已保存到：' + r.path);
      else if (r && !r.canceled) toast('另存失败：' + (r.error || ''), true);
      return;
    }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename || '产品图.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('已开始下载原图，请到浏览器下载目录找');
  }

  /** 把每一张客户图的比对结果都写成「真实数据」交给模型，避免它自己看图猜价格 */
  function imageContextText() {
    const imgs = state.images;
    if (!imgs.length) return '';
    const blocks = imgs.map((it, i) => {
      const list = (it.result && it.result.候选) || [];
      const tag = `客户图片 ${i + 1}（${it.name}）`;
      if (!list.length) {
        return `${tag}：本机图片指纹库未命中${it.status === 'error' ? '（比对失败）' : ''}（或还没建索引）。` +
          '这一款的型号、价格、货期一律写「待人工补充」，禁止编造。';
      }
      const picked = list.find((m) => m.id === it.pickedId);
      const head = picked
        ? `客服已确认采用：型号 ${picked.型号 || '（原表未填型号）'}${picked.型号 ? '' : picked.名称 ? `，产品名称 ${picked.名称}（只是原表描述，不能当型号）` : ''}，出厂价 ${picked.价格 != null ? (picked.价格原文 || picked.价格) : '原表未填'} ${picked.币种 || ''}，货期 ${picked.货期 || '未填'}。${picked.价格 == null ? '这一行没填价格，价格一律写「待人工补充」，禁止从别行借数字。' : ''}`
        : '客服尚未确认型号：只有低置信候选，价格与型号一律写「待人工补充」，禁止编造。';
      const lines = list.slice(0, 4).map((m, j) => {
        const label = m.id === it.pickedId ? '【已确认采用】' : '候选';
        return `${label}${j + 1}：型号 ${m.型号 || '（原表未填型号）'}｜产品名称 ${m.名称 || '未填'}｜相似度 ${Math.round((m.相似度 || 0) * 100)}%（${m.置信度}置信）｜` +
          `出厂价 ${m.价格 != null ? (m.价格原文 || m.价格) : '原表未填'} ${m.币种 || ''}｜货期 ${m.货期 || '未填'}｜` +
          `来源 ${m.文件} 工作表「${m.工作表}」第 ${m.行号} 行（${m.关联方式}）`;
      });
      return `${tag}：${head}\n${lines.join('\n')}`;
    });
    return '\n\n【客户图片比对结果】（本机把客户产品图与报价表内嵌图片比对，仅供人工核对）\n' +
      blocks.join('\n') + '\n' +
      '表内价格是出厂价 / 内部价，不是对外正式报价；中文说明里必须写出来源文件名、工作表、行号并提醒人工核对。';
  }

  /** hover 浮层：资料库缩略图墙，网关直接内嵌 dataURL，<img> 不用带鉴权头 */
  async function loadImagePreview(force) {
    const grid = $('imagePopGrid');
    if (state.previewLoaded && !force) return;
    grid.innerHTML = '<div class="image-pop-empty">正在读取资料库缩略图…</div>';
    try {
      const r = await callApi(`/v1/images/preview?limit=${IMG_PAGE}&offset=${state.previewOffset}`);
      if (!r.ok || !r.items.length) {
        if (state.previewOffset > 0) {
          state.previewOffset = 0;
          return loadImagePreview(true);
        }
        grid.innerHTML = `<div class="image-pop-empty">${esc(r.hint || '还没有可预览的产品图')}<br>点右上角「重建图片索引」开始（只读取原文件，不改动你的资料）。</div>`;
        $('imagePopStat').textContent = '尚未建立图片索引';
        state.previewLoaded = true;
        return;
      }
      grid.innerHTML = r.items.map((it) => {
        const label = it.型号 || '未关联型号';
        const price = it.价格 != null ? `${curSymbol(it.币种)}${it.价格}` : '';
        const tip = `${it.文件}${it.工作表 ? ' · ' + it.工作表 : ''}${it.行号 ? ' · 第 ' + it.行号 + ' 行' : ''}`;
        return `<div class="image-cell" data-src="${esc(it.缩略图)}" title="${esc(tip)}">` +
          `<img src="${esc(it.缩略图)}" alt="${esc(label)}" loading="lazy" />` +
          `<span><b>${esc(label)}</b> ${esc(price)}</span></div>`;
      }).join('');
      $('imagePopStat').textContent = `共 ${r.总数} 张 · ${r.有型号} 张有型号 · 显示第 ${state.previewOffset + 1}–${state.previewOffset + r.items.length} 张`;
      state.previewLoaded = true;
    } catch (e) {
      grid.innerHTML = `<div class="image-pop-empty">读取失败：${esc(e.message || e)}<br>请确认后台服务在运行。</div>`;
    }
  }

  function positionImagePopover() {
    const pop = $('imagePopover');
    const r = $('btnPickImage').getBoundingClientRect();
    const w = Math.min(460, window.innerWidth - 16);
    pop.style.width = w + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    const h = pop.offsetHeight || 340;
    pop.style.top = Math.max(8, r.top - h - 8) + 'px';
  }

  async function pollImageBuild() {
    for (let i = 0; i < 160; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      let s;
      try { s = await callApi('/v1/images/status'); } catch (_) { continue; }
      const st = s.构建状态 || {};
      $('imagePopTip').textContent = st.running
        ? `正在重建：${st.phase || ''} · ${st.done || 0}/${st.total || 0} · ${st.message || ''}`
        : (st.摘要 || st.message || '重建结束');
      if (!st.running) {
        $('btnRebuildImages').disabled = false;
        state.previewLoaded = false;
        state.previewOffset = 0;
        await refreshImageStatus();
        await loadImagePreview(true);
        toast(st.error ? '重建没成功：' + st.error : '图片索引已更新，可以开始按图查价了', !!st.error);
        return;
      }
    }
    $('btnRebuildImages').disabled = false;
    $('imagePopTip').textContent = '重建还在进行，刷新这个气泡可以看到最新进度。';
  }

  async function rebuildImages() {
    try {
      const r = await callApi('/v1/images/rebuild', 'POST', {});
      toast(r.提示 || '已开始重建图片索引');
      if (!r.ok) return;
      $('btnRebuildImages').disabled = true;
      $('imagePopTip').textContent = '正在后台重建，进度会在这里刷新…';
      await pollImageBuild();
    } catch (e) {
      toast('重建失败：' + (e.message || e), true);
    }
  }

  function setupImagePicker() {
    const btn = $('btnPickImage');
    const file = $('imageFile');
    const pop = $('imagePopover');
    let hideTimer = null;
    const cancelHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
    const hideLater = (ms) => { cancelHide(); hideTimer = setTimeout(() => pop.classList.add('hidden'), ms); };
    const show = () => {
      cancelHide();
      pop.classList.remove('hidden');
      positionImagePopover();
      if (!state.previewLoaded) loadImagePreview(false);
    };
    btn.addEventListener('mouseenter', show);
    btn.addEventListener('focus', show);
    btn.addEventListener('mouseleave', () => hideLater(280));
    btn.addEventListener('blur', () => hideLater(280));
    pop.addEventListener('mouseenter', cancelHide);
    pop.addEventListener('mouseleave', () => hideLater(200));

    btn.onclick = () => file.click();
    $('btnClearImage').onclick = clearPickedImage;
    $('imageMatches').onclick = (e) => {
      const card = e.target.closest('.img-card');
      if (!card) return;
      const cur = activeImage();
      if (!cur) return;
      cur.pickedId = card.dataset.id;
      renderMatches();
      renderPendingImage();
      syncOutImages();
      const m = (cur.result.候选 || []).find((x) => x.id === cur.pickedId);
      toast(m ? `已采用 ${m.型号 || '这张未关联型号的图'}；生成前请核对 ${m.文件} 第 ${m.行号} 行` : '已选择这个候选');
    };
    $('imagePopGrid').onclick = (e) => {
      const cell = e.target.closest('.image-cell');
      if (cell) showLightbox(cell.dataset.src || '');
    };
    $('imageLightbox').onclick = () => $('imageLightbox').classList.add('hidden');
    $('btnImageNextPage').onclick = () => {
      state.previewOffset += IMG_PAGE;
      state.previewLoaded = false;
      loadImagePreview(true);
    };
    $('btnImagePrevPage').onclick = () => {
      state.previewOffset = Math.max(0, state.previewOffset - IMG_PAGE);
      state.previewLoaded = false;
      loadImagePreview(true);
    };
    $('btnRebuildImages').onclick = rebuildImages;
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#imagePopover') && !e.target.closest('#btnPickImage')) pop.classList.add('hidden');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      cancelHide();
      pop.classList.add('hidden');
      $('imageLightbox').classList.add('hidden');
    });
  }

  /** 系统剪贴板里的位图 → File（桌面窗口 Ctrl+V 兜底用） */
  function dataUrlToFile(dataUrl, name) {
    const parts = String(dataUrl).split(',');
    const mime = /data:([^;]+)/.exec(parts[0])?.[1] || 'image/png';
    const bin = atob(parts[1] || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime });
  }

  /** 聊天框图片输入（粘贴 / 拖拽 / 多选）与图片输出（放大 / 复制 / 另存 / 进会话记录） */
  function setupChatImages() {
    const composer = $('composer');
    const input = $('input');
    const file = $('imageFile');

    file.onchange = (e) => {
      const list = e.target.files ? Array.from(e.target.files) : [];
      if (list.length) addImageFiles(list);
      file.value = '';
    };

    // 输入框上的缩略图条：点卡片切换当前候选、点图放大、× 移除单张
    $('pendingImage').onclick = (e) => {
      const item = e.target.closest('.ci-item');
      if (!item) return;
      const uid = item.dataset.uid;
      const actEl = e.target.closest('[data-act]');
      const act = actEl ? actEl.dataset.act : '';
      const it = state.images.find((x) => x.uid === uid);
      if (!it) return;
      if (act === 'del') return removeImage(uid);
      if (act === 'view') return showLightbox(it.dataUrl);
      state.activeImageUid = uid;
      renderPendingImage();
      renderMatches();
      setImageMsg((it.result && it.result.hint) || '', !!(it.result && !it.result.ok));
    };

    // Ctrl+V 贴图：优先网页 clipboardData；桌面窗口再兜底读系统剪贴板里的位图
    document.addEventListener('paste', async (e) => {
      const t = e.target;
      if (t && t !== input && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const dt = e.clipboardData;
      const files = [];
      if (dt && dt.items) {
        for (const it of dt.items) {
          if (it.kind === 'file' && String(it.type || '').startsWith('image/')) {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        }
      }
      if (!files.length && dt && dt.files) {
        for (const f of dt.files) if (String(f.type || '').startsWith('image/')) files.push(f);
      }
      if (files.length) {
        e.preventDefault();
        await addImageFiles(files, '剪贴板图片.png');
        return;
      }
      // 复制的是文字就到此为止，别把系统剪贴板里残留的旧图翻出来
      const types = dt && dt.types ? Array.from(dt.types) : [];
      if (types.includes('text/plain') || types.includes('Text')) return;
      if (state.mode === 'electron' && window.bridge && window.bridge.readClipboardImage && document.activeElement === input) {
        try {
          const r = await window.bridge.readClipboardImage();
          if (r && r.ok && r.dataUrl) await addImageFiles([dataUrlToFile(r.dataUrl, '剪贴板图片.png')]);
        } catch (_) { /* 剪贴板里没图，正常 */ }
      }
    });

    // 拖入图片；同时阻止 Electron / 浏览器把拖到别处的图片当成「打开这个文件」
    const isFileDrag = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    let dragDepth = 0;
    composer.addEventListener('dragenter', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); dragDepth++; composer.classList.add('drop-active');
    });
    composer.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    });
    composer.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) composer.classList.remove('drop-active');
    });
    composer.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      composer.classList.remove('drop-active');
      const list = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
      if (list.length) await addImageFiles(list);
    });
    document.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      if (!isFileDrag(e) || composer.contains(e.target)) return;
      e.preventDefault();
      toast('把图片拖到下面的输入框里就行');
    });

    // 回复稿里的产品图：看原图 / 复制进剪贴板 / 另存为原图
    $('outImagesGrid').onclick = async (e) => {
      const card = e.target.closest('.out-card');
      const actEl = e.target.closest('[data-act]');
      if (!card || !actEl) return;
      const act = actEl.dataset.act;
      actEl.classList.add('busy');
      actEl.disabled = true;
      try {
        const orig = await fetchOriginal(card.dataset.id);
        if (act === 'view') { showLightbox(orig.图片); return; }
        if (act === 'copy') {
          await copyImageToSystem(orig.图片);
          toast(`已复制 ${orig.型号 || '产品图'} 的原图，可直接粘到微信；价格请核对 ${orig.文件}${orig.行号 ? ' 第 ' + orig.行号 + ' 行' : ''}`);
        } else if (act === 'save') {
          await saveImageToDisk(orig.图片, orig.文件名);
        }
      } catch (err) {
        const label = act === 'copy' ? '复制图片没成功：' : act === 'save' ? '另存没成功：' : '打开原图没成功：';
        toast(label + ((err && err.message) || err) + '；可先放大缩略图后截图代替', true);
      } finally {
        actEl.classList.remove('busy');
        actEl.disabled = false;
      }
    };
    $('btnOutToThread').onclick = () => {
      const list = state.outImages || [];
      if (!list.length) return toast('还没有确认型号的产品图', true);
      appendMessage('draft', '我方随稿产品图 · 待人工发送', '', {
        images: list.map((m) => ({ src: m.缩略图, caption: m.型号 || '产品图' })),
      });
      toast('已放进上面的会话记录；图片不会自动发给客户');
    };
  }

  /* ==================== 我的资料库：一键整理 / 关联状态 ==================== */

  function setKbMsg(text, kind) {
    const el = $('kbMsg');
    el.textContent = text;
    el.className = 'kb-msg' + (kind ? ' ' + kind : '');
    el.classList.remove('hidden');
  }

  async function refreshKbStatus() {
    const badge = $('kbSummary');
    try {
      const s = await callApi('/v1/library/status');
      state.kbStatus = s;
      if (s.已整理) {
        badge.textContent = `已关联 ${s.统计.报价表数} 个报价表 · ${s.统计.型号数} 个型号 · ${s.统计.报价行数} 行`;
        badge.className = 'stream-state db-stat ' + (s.需要重新整理 ? 'warn' : 'ok');
        if (s.需要重新整理) {
          setKbMsg('资料文件夹里有新增或改过的文件，程序会自动重新整理；也可以现在点「整理资料」。', 'wait');
        }
      } else {
        badge.textContent = '还没整理 · 点「我的资料库」';
        badge.className = 'stream-state db-stat warn';
      }
    } catch (_) {
      badge.textContent = '后台服务没连上';
      badge.className = 'stream-state db-stat warn';
    }
  }

  async function organizeKb() {
    const btn = $('btnOrganize');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ 正在整理…';
    setKbMsg('正在读取资料文件夹……几百 MB 的报价表也只要几秒，你的原文件不会被改动。', 'wait');
    try {
      const r = await callApi('/v1/library/organize', 'POST', { force: !!$('kbForce').checked });
      setKbMsg(`${r.摘要}（用时 ${r.耗时毫秒} 毫秒）`, r.ok ? '' : 'err');
      const tips = r.建议 || [];
      if (tips.length) {
        $('kbSuggest').innerHTML = '<b>整理建议：</b><br>' + tips.map((t) => '· ' + esc(t)).join('<br>');
        $('kbSuggest').classList.remove('hidden');
      } else {
        $('kbSuggest').classList.add('hidden');
      }
      await refreshKbStatus();
      if (r.ok) toast('资料整理好了，现在问报价会去你的表里查');
    } catch (e) {
      setKbMsg('整理没成功：' + (e.message || e) + '。请确认「一键启动」的黑窗口还开着。', 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /** 桌面窗口版用系统默认程序打开；浏览器版用在线清单 / 提示路径 */
  async function openKbPath(kind) {
    if (state.mode === 'electron' && window.bridge && window.bridge.openKbPath) {
      const r = await window.bridge.openKbPath(kind);
      if (r && r.ok === false) toast('打开失败：' + (r.error || ''), true);
      return;
    }
    if (kind === 'list') window.open(`${state.gatewayUrl}/docs/library`, '_blank');
    else toast('资料文件夹在程序目录的 data\\客服资料库，也可以在黑窗口菜单按 7 打开');
  }

  function setLearnMsg(text, isErr) {
    const el = $('learnMsg');
    el.textContent = text;
    el.className = 'learn-msg' + (isErr ? ' err' : '');
    el.classList.remove('hidden');
  }

  async function checkWorkBuddy(showDetail) {
    const b = $('btnCheckWB');
    b.textContent = '连接器：检查中…';
    b.className = 'wb-badge';
    try {
      const j = await callApi('/v1/workbuddy/status');
      b.textContent = j.level === 'connected' ? '连接器：已连上'
        : j.level === 'needs_restart' ? '连接器：需重开一次'
        : '连接器：未接入';
      b.className = 'wb-badge ' + (j.level === 'connected' ? 'ok' : j.level === 'not_configured' ? 'err' : '');
      if (showDetail) {
        const lines = (j.checks || []).map((c) => `  ${c.ok ? '√' : '×'} ${c.name}`).join('\n');
        setLearnMsg(
          `【连接检查】${j.message}\n${lines}\n【怎么办】${j.hint}\n\n` +
          `提示：绿灯只代表 WorkBuddy 能调用本程序查资料，不代表这个窗口的回复由 WorkBuddy 的 AI 生成。` +
          `本窗口的「生成回复稿」用的是本机模板助手；想让 WorkBuddy 帮你写，点「交给 WorkBuddy 写」按钮。\n\n` +
          `最直接的确认办法：在 WorkBuddy 里说「查看客服助手状态」或「查一下这款现货的报价」，` +
          `能返回后台状态或资料库已关联的型号数，就说明真的连上了。`,
          j.level === 'not_configured',
        );
      }
    } catch (e) {
      b.textContent = '连接器：检查失败';
      b.className = 'wb-badge err';
      if (showDetail) setLearnMsg('检查失败：' + (e.message || e) + '。请确认黑窗口还开着。', true);
    }
  }

  const LOCALE_LABELS = { 'es-MX': '西班牙语（墨西哥）', en: '英语', 'en-US': '英语（美国）', 'pt-BR': '葡萄牙语（巴西）' };
  const STAGE_LABELS = { promote: '开发新客户', negotiate: '议价 / 谈判', followup: '跟进 / 催单', complex_quote: '复杂报价', draft_only: '只写个草稿' };
  const COUNTRY_LABELS = { MX: '墨西哥', US: '美国', BR: '巴西', ES: '西班牙', DE: '德国', OTHER: '其他 / 未指定' };

  /** 生成一段能直接粘进 WorkBuddy 的中文指令：让 WorkBuddy 用自己的模型 + 本机的真实资料起草 */
  async function toWorkBuddy() {
    let text = $('input').value.trim();
    const imgCtx = imageContextText();
    if (!text && state.images.length) text = `客户发来 ${state.images.length} 张产品图片，想问这几款的价格和货期。`;
    if (!text) return toast('请把客户消息粘贴到输入框，或先贴一张客户图片', true);
    const locale = $('localeSelect').value;
    const country = $('countryInput').value;
    const stage = $('stageSelect').value;
    const name = $('nameInput').value.trim() || '（未填）';
    const cmd = [
      '请用「客服回复助手」连接器帮我起草一封给客户的回复。先调用你的工具查真实资料（报价表、图片证书、成功案例、话术库），再动笔；不要编造价格、交期或文件名。',
      '',
      '【客户原话】',
      text,
      ...(imgCtx ? ['', imgCtx] : []),
      '',
      '【客户背景】',
      `国家：${COUNTRY_LABELS[country] || country}；阶段：${STAGE_LABELS[stage] || stage}；称呼：${name}；回复语种：${LOCALE_LABELS[locale] || locale}；渠道：微信 / 企业微信`,
      '',
      '【要求】',
      `1. 先用「【回复稿】」标记给一段能直接发给客户的正文，用${LOCALE_LABELS[locale] || locale}写，语气贴合上面的客户阶段；这一段里绝对不要出现中文、翻译、注解或文件名；`,
      '2. 再用「【中文翻译】」标记把上面的正文逐句翻译成中文，方便我这个不懂外文的人核对；',
      '3. 最后用「【中文说明】」列出查到的资料来源（文件名 + 第几行）和本次参考的成功案例 / 话术经验；',
      '4. 价格、MOQ、交期必须来自报价表真实数据；没查到就写「需要人工补充」，绝不编数字；',
      '5. 不要自动发送给客户，这只是草稿；',
      '6. 如果这次回复我满意，我会回来在程序里点「成了，记成功」，你也可以顺手帮我优化话术库。',
    ].join('\n');
    try {
      await copyToClipboard(cmd);
      toast('指令已复制，切到 WorkBuddy 对话，按 Ctrl+V 粘贴后发送即可');
      setLearnMsg('【已复制给 WorkBuddy 的指令】\n' + cmd + '\n\n现在切到 WorkBuddy 按 Ctrl+V 粘贴发送，它会用自己的模型 + 本机真实资料写回信。');
    } catch (e) {
      toast('复制失败：' + (e.message || e), true);
    }
  }

  function renderHistory(rows) {
    if (!rows.length) {
      $('history').innerHTML = '<div class="hint">还没有记录。生成一次回复稿，或者导入成功案例后就会出现在这里。</div>';
      return;
    }
    $('history').innerHTML = rows.map((r) => {
      const cls = r.label === 'success' ? 'ok' : r.label === 'failure' ? 'bad' : 'none';
      return `<div class="hist-row">
        <div class="hist-head">
          <span><span class="hist-tag ${cls}">${esc(r.标记)}</span> · ${esc(r.场景)} · ${esc(r.来源)}</span>
          <span>${esc(r.时间)}</span>
        </div>
        <div class="hist-text"><b>客户：</b>${esc(r.客户消息)}</div>
        ${r.原因 ? `<div class="hist-text"><b>备注：</b>${esc(r.原因)}</div>` : ''}
        <div class="hist-text"><b>编号：</b>${esc(r.id)}</div>
      </div>`;
    }).join('');
  }

  async function loadLearnStats() {
    try {
      const j = await callApi('/v1/learning/records?limit=20');
      const s = j.stats || {};
      $('learnSummary').textContent = `已学 ${s.labeled || 0} 条（成功 ${s.success || 0} / 失败 ${s.failure || 0}），共 ${s.total || 0} 条记录`;
      renderHistory(j.data || []);
    } catch (_) {
      $('learnSummary').textContent = '学习记录暂不可用';
    }
  }

  async function markOutcome(label) {
    if (!state.recordId) return toast('请先生成一次回复稿，才有可以标记的记录', true);
    const note = $('learnNote').value.trim();
    try {
      const j = await callApi('/v1/learning/mark', 'POST', { id: state.recordId, label, note });
      setLearnMsg(
        `【${label === 'success' ? '已记为成功案例' : '已记为失败教训'}】${j.提示}\n` +
        `${j.script_summary}\n\n` +
        `下一次生成回复稿时会自动参考。想让 WorkBuddy 继续帮你优化，就在 WorkBuddy 里说「帮我优化话术」。`,
      );
      $('learnNote').value = '';
      await loadLearnStats();
      toast(label === 'success' ? '已记为成功案例，话术库已更新' : '已记为失败教训，话术库已更新');
    } catch (e) {
      setLearnMsg('标记失败：' + (e.message || e), true);
    }
  }

  async function rebuildScripts() {
    try {
      const j = await callApi('/v1/scripts/rebuild', 'POST', {});
      setLearnMsg(`【已重新学习】${j.summary}\n\n话术库文件：${j.file}\n可以用记事本打开自己改，改完不用重启，下一次生成就生效。`);
      await loadLearnStats();
    } catch (e) {
      setLearnMsg('重新学习失败：' + (e.message || e), true);
    }
  }

  async function viewScripts() {
    const url = `${state.gatewayUrl}/docs/scripts`;
    if (state.mode === 'electron' && window.bridge && window.bridge.openUrl) {
      const r = await window.bridge.openUrl(url);
      if (r && r.ok === false) toast('打开失败：' + (r.error || ''), true);
    } else {
      window.open(url, '_blank');
    }
  }

  /**
   * 顶部「重启程序」：要按两次，避免手滑把还没复制的草稿弄丢。
   * 桌面版交给主进程真正重启整个 Electron 程序（并顺手补启后台服务）；
   * 浏览器版没有「程序」可重启，就刷新页面 + 重新连接，并提示黑窗口是否还开着。
   */
  async function restartApp() {
    const btn = $('btnRestart');
    const label = '重启程序';
    if (!state.restartArmed) {
      state.restartArmed = true;
      btn.textContent = '再点一次确认';
      btn.classList.add('armed');
      toast('重启会重新加载窗口并重新连接后台服务，当前没复制的草稿会丢失。确认就再点一次；6 秒内不点会自动取消。');
      clearTimeout(restartApp._timer);
      restartApp._timer = setTimeout(() => {
        state.restartArmed = false;
        btn.textContent = label;
        btn.classList.remove('armed');
      }, 6000);
      return;
    }
    clearTimeout(restartApp._timer);
    state.restartArmed = false;
    btn.textContent = label;
    btn.classList.remove('armed');

    if (state.mode === 'electron' && window.bridge && window.bridge.restart) {
      try {
        const r = await window.bridge.restart();
        toast((r && r.message) || '正在重启，窗口会闪一下后自动回来…');
      } catch (e) {
        toast('重启没成功：' + (e.message || e) + '。请关掉窗口后重新双击「一键启动.bat」。', true);
      }
      return;
    }
    let alive = false;
    try {
      const r = await fetch(state.gatewayUrl + '/v1/health', { signal: AbortSignal.timeout(1500) });
      alive = r.ok;
    } catch (_) {}
    try { sessionStorage.setItem('tcs_restart_hint', alive ? '1' : '0'); } catch (_) {}
    toast('正在重新加载页面…');
    setTimeout(() => location.reload(), 350);
  }

  function bind() {
    $('btnGenerate').onclick = generate;
    $('btnRestart').onclick = restartApp;
    // 点一下左上角状态标签 = 立刻重新探活（刚在菜单里填完密钥时用）
    $('statusBadge').onclick = () => {
      setStatus('wait', '正在重新检查…');
      loadAgents(true).then(() => toast('已重新检查 AI 连接状态'));
    };
    $('btnCopy').onclick = async () => {
      if (!state.cleanDraft) return;
      await copyToClipboard(state.cleanDraft);
      toast('草稿已复制：只有外文正文，不含中文翻译和注解（这一步不会记录为发送）');
    };
    $('btnSend').onclick = onSend;
    $('confirmBox').onchange = (e) => {
      state.confirmed = e.target.checked;
      applyConfirm();
    };
    $('btnSettings').onclick = () => $('settings').classList.toggle('hidden');
    $('btnSaveSettings').onclick = () => {
      if (state.mode === 'electron') return toast('桌面窗口版的连接设置由程序自动管理，不用改', true);
      state.gatewayUrl = $('gatewayUrlInput').value.trim() || location.origin;
      state.token = $('tokenInput').value.trim();
      localStorage.setItem('tcs_gateway', state.gatewayUrl);
      localStorage.setItem('tcs_token', state.token);
      if (state.ws) { const old = state.ws; state.ws = null; old.close(); }
      connectWS();
      loadAgents();
      toast('已保存，正在重新连接');
    };
    $('btnHide').onclick = () => {
      if (state.mode === 'electron' && window.bridge) window.bridge.hide();
      else toast('浏览器版不用隐藏窗口，直接切到别的窗口即可');
    };
    $('btnHelp').onclick = async () => {
      // 点 ? 顺手把可能被收起的说明段恢复，再打开完整说明书
      $('guideBar').classList.remove('hidden');
      $('wbNotice').classList.remove('hidden');
      if (state.mode === 'electron' && window.bridge && window.bridge.openManual) {
        const r = await window.bridge.openManual();
        if (r && r.ok === false) toast('说明书打开失败：' + (r.error || ''), true);
      } else {
        window.open(`${state.gatewayUrl}/docs/manual`, '_blank');
      }
    };
    // 说明已经收进悬停气泡、不再常驻占地方，旧的「永久隐藏」开关就不需要了
    $('btnHideGuide').onclick = () => $('guideBar').classList.add('hidden');
    $('attachments').onclick = async (e) => {
      const btn = e.target.closest('button[data-path]');
      if (!btn) return;
      await copyToClipboard(btn.getAttribute('data-path'));
      toast('文件路径已复制');
    };
    $('input').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate(); }
    });
    $('btnCheckWB').onclick = () => checkWorkBuddy(true);
    $('btnToWorkBuddy').onclick = toWorkBuddy;
    $('btnToWorkBuddy2').onclick = toWorkBuddy;
    $('btnHideWBNotice').onclick = () => $('wbNotice').classList.add('hidden');
    $('btnOrganize').onclick = organizeKb;
    $('btnViewList').onclick = () => openKbPath('list');
    $('btnOpenKb').onclick = () => openKbPath('kb');
    $('btnMarkSuccess').onclick = () => markOutcome('success');
    $('btnMarkFailure').onclick = () => markOutcome('failure');
    $('btnRebuild').onclick = rebuildScripts;
    $('btnViewScripts').onclick = viewScripts;
    $('btnToggleHistory').onclick = () => {
      $('history').classList.toggle('hidden');
      if (!$('history').classList.contains('hidden')) loadLearnStats();
    };
  }

  /* ============ 布局增强：说明收纳 / 模块可调 / 客户信息折叠 ============ */

  /** 顶栏 ? 悬停出整份说明，移开自动收起；每个模块标题的小 ? 就地看该模块说明 */
  function setupPopovers() {
    const help = $('helpPopover');
    const tip = $('tipPopover');
    const helpBtn = $('btnHelp');
    if (!help || !tip || !helpBtn) return;
    let timer = null;
    const cancelHide = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const hideLater = (el, ms) => {
      cancelHide();
      timer = setTimeout(() => el.classList.add('hidden'), ms);
    };
    const showHelp = () => {
      cancelHide();
      tip.classList.add('hidden');
      help.classList.remove('hidden');
    };
    helpBtn.addEventListener('mouseenter', showHelp);
    helpBtn.addEventListener('focus', showHelp);
    helpBtn.addEventListener('mouseleave', () => hideLater(help, 220));
    helpBtn.addEventListener('blur', () => hideLater(help, 220));
    help.addEventListener('mouseenter', cancelHide);
    help.addEventListener('mouseleave', () => hideLater(help, 160));

    const showTip = (btn) => {
      const panel = btn.closest('.panel');
      const src = panel && panel.dataset.tip ? $(panel.dataset.tip) : null;
      cancelHide();
      help.classList.add('hidden');
      tip.innerHTML = src ? src.innerHTML : '把鼠标移到顶部的 ? 可以看完整使用说明。';
      tip.classList.remove('hidden');
      const r = btn.getBoundingClientRect();
      const w = Math.min(300, window.innerWidth - 20);
      tip.style.width = w + 'px';
      tip.style.left = Math.max(10, Math.min(r.left, window.innerWidth - w - 10)) + 'px';
      let top = r.bottom + 6;
      if (top + tip.offsetHeight > window.innerHeight - 10) top = Math.max(10, r.top - tip.offsetHeight - 6);
      tip.style.top = top + 'px';
    };
    document.querySelectorAll('.panel-head .tip-btn').forEach((btn) => {
      btn.addEventListener('mouseenter', () => showTip(btn));
      btn.addEventListener('focus', () => showTip(btn));
      btn.addEventListener('mouseleave', () => hideLater(tip, 180));
      btn.addEventListener('blur', () => hideLater(tip, 180));
    });
    tip.addEventListener('mouseenter', cancelHide);
    tip.addEventListener('mouseleave', () => hideLater(tip, 160));

    // 点别处 / 按 Esc 立刻收起，不让气泡留在屏幕上挡内容
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#helpPopover') && !e.target.closest('#btnHelp')) help.classList.add('hidden');
      if (!e.target.closest('.tip-btn') && !e.target.closest('#tipPopover')) tip.classList.add('hidden');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { cancelHide(); help.classList.add('hidden'); tip.classList.add('hidden'); }
    });
  }

  /** 四个面板：内容包进统一滚动容器，底部加拖拽手柄，可折叠、可记住高度 */
  function setupPanels() {
    const PANEL_NAMES = { thread: '客户消息', kb: '资料库', draft: '回复稿', learn: '话术学习' };
    document.querySelectorAll('.panel[data-panel]').forEach((panel) => {
      const key = panel.dataset.panel;
      const head = panel.querySelector(':scope > .panel-head');
      if (!head) return;

      const content = document.createElement('div');
      content.className = 'panel-content';
      [...panel.children].forEach((el) => { if (el !== head) content.appendChild(el); });
      const handle = document.createElement('div');
      handle.className = 'panel-resize-handle';
      handle.title = '按住拖动调整这个模块的高度；双击恢复默认';
      panel.append(content, handle);
      panel.classList.add('is-resizable');

      const foldBtn = head.querySelector('.fold-btn');
      if (localStorage.getItem('tcs_fold_' + key) === '1') panel.classList.add('collapsed');
      if (foldBtn) {
        foldBtn.onclick = (e) => {
          e.stopPropagation();
          const folded = panel.classList.toggle('collapsed');
          localStorage.setItem('tcs_fold_' + key, folded ? '1' : '0');
        };
      }

      const saved = Number(localStorage.getItem('tcs_height_' + key) || 0);
      if (saved >= 60) {
        panel.style.height = saved + 'px';
        panel.classList.add('user-sized');
      }

      let startY = 0;
      let startH = 0;
      let dragging = false;
      handle.addEventListener('pointerdown', (e) => {
        if (panel.classList.contains('collapsed')) return;
        dragging = true;
        startY = e.clientY;
        startH = panel.getBoundingClientRect().height;
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        document.body.classList.add('resizing');
        e.preventDefault();
      });
      handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const h = Math.max(60, Math.min(900, startH + e.clientY - startY));
        panel.style.height = h + 'px';
        panel.classList.add('user-sized');
      });
      const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('resizing');
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
        localStorage.setItem('tcs_height_' + key, String(Math.round(panel.getBoundingClientRect().height)));
      };
      handle.addEventListener('pointerup', endDrag);
      handle.addEventListener('pointercancel', endDrag);
      handle.addEventListener('dblclick', () => {
        panel.style.height = '';
        panel.classList.remove('user-sized');
        localStorage.removeItem('tcs_height_' + key);
        toast('「' + (PANEL_NAMES[key] || key) + '」已恢复默认高度');
      });
    });
  }

  /** 顶部工具条 → 右侧抽屉：资料库 / 话术学习平时收起，点一下才出来，用完再点收起 */
  function setupDrawer() {
    const drawer = $('drawer');
    const scrim = $('drawerScrim');
    const title = $('drawerTitle');
    const kbBtn = $('btnDrawerKb');
    const learnBtn = $('btnDrawerLearn');
    const kbPane = $('drawerKb');
    const learnPane = $('drawerLearn');
    let current = '';

    const paint = () => {
      const open = current !== '';
      drawer.classList.toggle('hidden', !open);
      scrim.classList.toggle('hidden', !open);
      drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
      kbBtn.classList.toggle('active', current === 'kb');
      learnBtn.classList.toggle('active', current === 'learn');
      kbPane.classList.toggle('hidden', current !== 'kb');
      learnPane.classList.toggle('hidden', current !== 'learn');
      title.textContent = current === 'kb' ? '我的资料库' : current === 'learn' ? '话术学习' : '';
    };
    const close = () => { current = ''; paint(); };
    const toggle = (which) => { current = current === which ? '' : which; paint(); };

    kbBtn.onclick = () => toggle('kb');
    learnBtn.onclick = () => toggle('learn');
    $('btnDrawerClose').onclick = close;
    scrim.onclick = close;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) close(); });
    paint();
  }

  /** 右侧中文对照栏可整条收起，把宽度还给左边的原文与外文正文 */
  function setupRail() {
    const rail = $('workRail');
    const btn = $('btnRailToggle');
    let collapsed = localStorage.getItem('tcs_rail_collapsed') === '1';
    const paint = () => {
      rail.classList.toggle('collapsed', collapsed);
      btn.textContent = collapsed ? '‹' : '收起 ›';
      btn.title = collapsed ? '展开中文对照栏' : '收起中文对照栏；收起后左边更宽';
    };
    paint();
    btn.onclick = () => {
      collapsed = !collapsed;
      try { localStorage.setItem('tcs_rail_collapsed', collapsed ? '1' : '0'); } catch (_) {}
      paint();
    };
  }

  function setupCustomerTranslation() {
    $('btnTranslateCustomer').onclick = () => translateCustomer($('input').value.trim());
  }

  function setupManualTranslation() {
    const input = $('manualTranslateInput');
    const btn = $('btnManualTranslate');
    const copyBtn = $('btnManualCopy');
    if (!input || !btn || !copyBtn) return;
    btn.onclick = () => translateManual();
    copyBtn.onclick = () => copyManualTranslation();
    input.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        translateManual();
      }
    });
  }

  /* ============ 客户档案：本地 Excel 存档 / 老客户搜索 / 历史会话回显 ============ */

  const CUSTOMER_LS = 'tcs_customers_v1';
  const EMPTY_THREAD = '<div class="thread-empty">还没有会话记录。把客户消息粘贴到下面，点「生成回复稿」就会出现在这里。</div>';
  let customerBackend = null;
  let customerCache = [];
  let pickerTimer = null;
  let listTimer = null;
  let historyCustomer = '';

  function fieldText(id) {
    const el = $(id);
    if (!el) return '';
    return (el.tagName === 'SELECT' ? (el.selectedOptions[0]?.textContent || '') : (el.value || '')).trim();
  }

  function collectProfile() {
    return {
      name: ($('nameInput')?.value || '').trim(),
      source: $('sourceSelect')?.value || '',
      sourceCustom: ($('sourceCustomInput')?.value || '').trim(),
      stage: $('stageSelect')?.value || '',
      stageLabel: fieldText('stageSelect'),
      country: $('countryInput')?.value || '',
      countryLabel: fieldText('countryInput'),
      locale: $('localeSelect')?.value || '',
      localeLabel: fieldText('localeSelect'),
      saved: !!($('saveCustomerBox') && $('saveCustomerBox').checked),
    };
  }
  function sourceLabel() {
    const p = collectProfile();
    if (!p.source) return '';
    return p.source === '自定义' ? (p.sourceCustom || '自定义') : p.source;
  }

  /** 桌面窗口版走主进程写 Excel；浏览器版退到 localStorage，界面行为一致 */
  function getCustomerBackend() {
    if (customerBackend) return customerBackend;
    if (state.mode === 'electron' && window.bridge && window.bridge.customerList) {
      customerBackend = {
        excel: true,
        list: () => window.bridge.customerList(),
        load: (n) => window.bridge.customerLoad(n),
        save: (p) => window.bridge.customerSave(p),
        append: (e) => window.bridge.customerAppend(e),
        open: () => window.bridge.customerOpen(),
      };
      return customerBackend;
    }
    const read = () => {
      try {
        const d = JSON.parse(localStorage.getItem(CUSTOMER_LS) || '{}');
        return d && d.customers ? d : { customers: {} };
      } catch (_) { return { customers: {} }; }
    };
    const write = (d) => localStorage.setItem(CUSTOMER_LS, JSON.stringify(d));
    const now = () => new Date().toLocaleString('zh-CN', { hour12: false });
    const summary = (c) => ({
      name: c.name,
      source: c.source === '自定义' ? (c.sourceCustom || '自定义') : (c.source || '未填'),
      stageLabel: c.stageLabel || '', countryLabel: c.countryLabel || '', localeLabel: c.localeLabel || '',
      firstAt: c.firstAt || '', lastAt: c.lastAt || '', count: (c.chats || []).length, saved: c.saved !== false,
    });
    customerBackend = {
      excel: false,
      list: async () => ({ ok: true, customers: Object.values(read().customers).map(summary) }),
      load: async (n) => {
        const c = read().customers[n];
        return c ? { ok: true, customer: c } : { ok: false, error: '没找到这个客户的存档' };
      },
      save: async (p) => {
        if (!p.name) return { ok: false, error: '客户名称不能为空' };
        const d = read();
        const c = d.customers[p.name] || { name: p.name, firstAt: now(), chats: [] };
        Object.assign(c, p, { name: p.name, lastAt: c.lastAt || now() });
        if (!Array.isArray(c.chats)) c.chats = [];
        d.customers[p.name] = c;
        write(d);
        return { ok: true, customer: summary(c) };
      },
      append: async (e) => {
        if (!e.name) return { ok: false };
        const d = read();
        if (!d.customers[e.name]) {
          await customerBackend.save(Object.assign({ name: e.name }, e.profile || {}));
          return customerBackend.append(e);
        }
        const c = d.customers[e.name];
        c.chats.push({
          at: now(), direction: e.direction || '客户', kind: e.kind || '',
          text: String(e.text || ''), stage: e.stage || '', session: e.session || '',
        });
        if (c.chats.length > 2000) c.chats = c.chats.slice(-2000);
        c.lastAt = c.chats[c.chats.length - 1].at;
        write(d);
        return { ok: true };
      },
      open: async () => ({ ok: false, error: '浏览器版不生成 Excel。请用「一键启动」菜单 2 的窗口版查看 data/客户档案.xlsx。' }),
    };
    return customerBackend;
  }

  function showCustomerMsg(text, isErr) {
    const el = $('customerMsg');
    if (el) { el.textContent = text || ''; el.classList.toggle('err', !!isErr); }
    if (isErr && text) toast(text, true);
  }

  /** 每条新消息自动进档案；历史回显带 historical 标记，不重复写 */
  function recordChat(kind, head, body) {
    try {
      const box = $('saveCustomerBox');
      if (!box || !box.checked) return;
      const p = collectProfile();
      if (!p.name) { showCustomerMsg('没填客户名称，这条聊天没存档', true); return; }
      const text = String(body || '').trim();
      if (!text) return;
      getCustomerBackend().append({
        name: p.name,
        direction: kind === 'draft' ? '我方' : '客户',
        kind: String(head || ''),
        text,
        stage: p.stageLabel,
        session: state.sessionId,
        profile: p,
      }).then((r) => {
        if (r && r.error) showCustomerMsg(r.error, true);
        else if (r && r.ok) showCustomerMsg(getCustomerBackend().excel ? '已写入 客户档案.xlsx' : '已存到本机浏览器');
      }).catch((e) => showCustomerMsg('存档失败：' + (e && e.message ? e.message : e), true));
    } catch (e) {
      showCustomerMsg('存档失败：' + (e && e.message ? e.message : e), true);
    }
  }

  async function refreshCustomerList() {
    try {
      const r = await getCustomerBackend().list();
      customerCache = (r && r.customers) || [];
      if (r && r.error) showCustomerMsg(r.error, true);
    } catch (_) { customerCache = []; }
    return customerCache;
  }

  function hidePicker() {
    clearTimeout(pickerTimer);
    const p = $('customerPicker');
    if (p) p.classList.add('hidden');
  }

  /** 候选面板用 fixed 定位，浮在输入框下方，不占布局高度、不被展开区裁掉 */
  function showPicker() {
    const picker = $('customerPicker');
    const input = $('nameInput');
    if (!picker || !input) return;
    const q = (input.value || '').trim().toLowerCase();
    const matched = customerCache
      .filter((c) => !q || String(c.name || '').toLowerCase().includes(q) || String(c.source || '').toLowerCase().includes(q))
      .sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')))
      .slice(0, 30);
    const r = input.getBoundingClientRect();
    const w = Math.min(250, window.innerWidth - 20);
    picker.style.width = w + 'px';
    picker.style.left = Math.max(10, Math.min(r.left, window.innerWidth - w - 10)) + 'px';
    if (window.innerHeight - r.bottom < 150 && r.top > 200) {
      picker.style.top = '';
      picker.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    } else {
      picker.style.bottom = '';
      picker.style.top = Math.max(6, Math.min(r.bottom + 4, window.innerHeight - 220)) + 'px';
    }
    let html = '<div class="cp-head">输入名字可搜索老客户，点一条即可载入；直接输入新名字就是新建客户</div>';
    if (!matched.length) {
      html += `<div class="cp-empty">${customerCache.length ? '没有匹配的客户，直接输入即可新建' : '还没有存过客户。勾选「保存客户资料与聊天记录」后就会出现在这里。'}</div>`;
    } else {
      for (const c of matched) {
        html += `<button type="button" class="cp-item" data-name="${esc(c.name)}"><span class="cp-name">${esc(c.name)}</span><span class="cp-meta">${esc(c.source || '未填')} · ${c.count || 0} 条聊天 · 最近 ${esc(c.lastAt || '—')}</span></button>`;
      }
    }
    picker.innerHTML = html;
    picker.classList.remove('hidden');
    picker.querySelectorAll('.cp-item').forEach((btn) => {
      btn.onclick = () => {
        hidePicker();
        selectCustomer(btn.getAttribute('data-name'));
      };
    });
  }

  function toggleSourceCustom() {
    const wrap = $('sourceCustomWrap');
    if (wrap) wrap.classList.toggle('hidden', $('sourceSelect')?.value !== '自定义');
  }

  function applyProfile(c) {
    const set = (id, v) => { const el = $(id); if (el && v != null && v !== '') el.value = v; };
    set('nameInput', c.name);
    set('stageSelect', c.stage);
    set('countryInput', c.country);
    set('localeSelect', c.locale);
    set('sourceSelect', c.source || '');
    set('sourceCustomInput', c.sourceCustom || '');
    toggleSourceCustom();
  }

  function clearHistoryView() {
    const bar = $('historyBar');
    if (!bar || bar.classList.contains('hidden')) return;
    $('thread').querySelectorAll('.msg.history').forEach((el) => el.remove());
    bar.classList.add('hidden');
    historyCustomer = '';
    if (!$('thread').querySelector('.msg')) $('thread').innerHTML = EMPTY_THREAD;
    updateThreadCount();
  }

  /** 选老客户：填回资料 + 把之前的聊天按「最新在上」铺进会话记录 */
  function renderCustomerHistory(c) {
    const thread = $('thread');
    thread.innerHTML = '';
    const chats = (c.chats || []).slice();
    for (const m of chats) {
      appendMessage(m.direction === '我方' ? 'draft' : 'customer',
        `历史 · ${m.kind || (m.direction === '我方' ? '我方回复稿' : '客户消息')}`,
        m.text, { historical: true, at: m.at });
    }
    if (!chats.length) thread.innerHTML = '<div class="thread-empty">这个客户还没有聊天记录。</div>';
    historyCustomer = c.name;
    $('historyBarText').textContent = `已载入「${c.name}」的历史聊天 ${chats.length} 条（灰底虚线）`;
    $('historyBar').classList.remove('hidden');
    thread.scrollTop = 0;
    updateThreadCount();
  }

  async function selectCustomer(name) {
    const r = await getCustomerBackend().load(name);
    if (!r || !r.ok || !r.customer) return toast((r && r.error) || '没读到这个客户', true);
    const c = r.customer;
    applyProfile(c);
    const box = $('saveCustomerBox');
    if (box) {
      box.checked = c.saved !== false;
      localStorage.setItem('tcs_save_customer', box.checked ? '1' : '0');
    }
    renderCustomerHistory(c);
    syncContextSummary();
    showCustomerMsg(`已载入「${c.name}」的资料，之后的新聊天会继续记到他名下`);
    toast(`已载入 ${c.name} 的资料和 ${(c.chats || []).length} 条历史聊天`);
  }

  function syncContextSummary() {
    const label = $('contextSummaryText');
    if (!label) return;
    const parts = [fieldText('stageSelect'), fieldText('countryInput'), fieldText('nameInput') || '未填客户', fieldText('localeSelect')];
    const src = sourceLabel();
    if (src) parts.push(src);
    const agent = fieldText('agentSelect');
    if (agent && agent !== '自动选择（推荐）') parts.push(agent);
    label.textContent = parts.filter(Boolean).join(' · ');
    const tag = $('contextSaveTag');
    if (tag) {
      const on = $('saveCustomerBox') && $('saveCustomerBox').checked;
      tag.classList.toggle('hidden', !on);
      tag.textContent = getCustomerBackend().excel ? '已存档' : '浏览器存档';
    }
  }

  function setupCustomers() {
    const box = $('saveCustomerBox');
    const input = $('nameInput');
    const picker = $('customerPicker');
    if (!box || !input || !picker) return;

    box.checked = localStorage.getItem('tcs_save_customer') === '1';
    toggleSourceCustom();
    syncContextSummary();

    $('sourceSelect').addEventListener('change', () => { toggleSourceCustom(); syncContextSummary(); });
    $('sourceCustomInput').addEventListener('input', syncContextSummary);

    box.addEventListener('change', async () => {
      localStorage.setItem('tcs_save_customer', box.checked ? '1' : '0');
      syncContextSummary();
      if (!box.checked) {
        const p = collectProfile();
        // 同步表格里的「存档状态」为已暂停，原有聊天记录一条不删
        if (p.name) getCustomerBackend().save(Object.assign({}, p, { saved: false })).catch(() => {});
        showCustomerMsg('已暂停存档，原有记录保留');
        return;
      }
      const p = collectProfile();
      if (!p.name) { showCustomerMsg('先填客户名称，再勾存档', true); return; }
      const r = await getCustomerBackend().save(p);
      await refreshCustomerList();
      showCustomerMsg(r && r.ok
        ? (getCustomerBackend().excel ? '已建档，之后的聊天会自动写进 客户档案.xlsx' : '已建档（浏览器版暂不生成 Excel）')
        : ((r && r.error) || '建档失败'), !r || !r.ok);
      if (r && r.ok) toast('已建档：' + p.name);
    });

    input.addEventListener('focus', () => refreshCustomerList().then(showPicker));
    input.addEventListener('input', () => {
      syncContextSummary();
      if (historyCustomer && input.value.trim() !== historyCustomer) clearHistoryView();
      clearTimeout(listTimer);
      listTimer = setTimeout(() => refreshCustomerList().then(showPicker), 120);
    });
    input.addEventListener('blur', () => { pickerTimer = setTimeout(hidePicker, 180); });
    picker.addEventListener('mouseenter', () => clearTimeout(pickerTimer));
    picker.addEventListener('mouseleave', () => { pickerTimer = setTimeout(hidePicker, 160); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePicker(); });

    $('btnOpenCustomers').onclick = async () => {
      const r = await getCustomerBackend().open();
      if (!r || !r.ok) toast((r && r.error) || '打开失败', true);
      else if (r.error) showCustomerMsg(r.error, true);
    };
    $('btnClearHistory').onclick = clearHistoryView;
    refreshCustomerList();
  }

  /** 客户信息：默认收成一行摘要，展开后改任何字段摘要都跟着变 */
  function setupContextBar() {
    const bar = $('contextBar');
    const btn = $('contextSummary');
    if (!bar || !btn) return;
    const ids = ['agentSelect', 'stageSelect', 'countryInput', 'nameInput', 'localeSelect', 'sourceSelect', 'sourceCustomInput'];
    const open = localStorage.getItem('tcs_context_open') === '1';
    bar.classList.toggle('collapsed', !open);
    btn.classList.toggle('open', open);
    btn.onclick = () => {
      const nowOpen = bar.classList.contains('collapsed');
      bar.classList.toggle('collapsed', !nowOpen);
      btn.classList.toggle('open', nowOpen);
      localStorage.setItem('tcs_context_open', nowOpen ? '1' : '0');
      if (!nowOpen) hidePicker();
    };
    ids.forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', syncContextSummary);
      el.addEventListener('input', syncContextSummary);
    });
    syncContextSummary();
  }

  function setupLayout() {
    try { setupPopovers(); } catch (e) { console.warn('说明气泡初始化失败', e); }
    try { setupPanels(); } catch (e) { console.warn('模块尺寸初始化失败', e); }
    try { setupContextBar(); } catch (e) { console.warn('客户信息栏初始化失败', e); }
    try { setupDrawer(); } catch (e) { console.warn('工具抽屉初始化失败', e); }
    try { setupRail(); } catch (e) { console.warn('中文对照栏初始化失败', e); }
    try { setupCustomerTranslation(); } catch (e) { console.warn('客户消息翻译初始化失败', e); }
    try { setupManualTranslation(); } catch (e) { console.warn('手动翻译初始化失败', e); }
    try { setupImagePicker(); } catch (e) { console.warn('图片识别按钮初始化失败', e); }
    try { setupChatImages(); } catch (e) { console.warn('聊天框图片输入初始化失败', e); }
  }

  /** 顶栏快捷键徽标：一眼看到当前生效的是 X 还是被占用后的备用键，点一下重新抢回 X */
  function setupHotkeyBadge() {
    const badge = $('hotkeyBadge');
    const live = $('hotkeyLive');
    if (!badge || state.mode !== 'electron' || !window.bridge) return;
    badge.classList.remove('hidden');
    const paint = (s) => {
      if (!s || !s.label) return;
      const short = s.label.replace('Ctrl+Shift+', '').split('（')[0] || '?';
      badge.textContent = '快捷键 ' + short;
      badge.classList.toggle('hotkey-badge-warn', !!s.blocked);
      badge.title = `当前唤起快捷键：${s.label}`
        + (s.blocked ? '（Ctrl+Shift+X 被别的程序占用）' : '')
        + '。窗口常驻显示，点别处不会消失；点这个徽标可重新尝试 Ctrl+Shift+X。';
      if (live) live.textContent = s.blocked
        ? `当前生效：${s.label} — X 被占用，托盘「唤起快捷键」可换成别的键，或点顶栏快捷键徽标重试。`
        : `当前生效：${s.label} — 窗口常驻显示，只有按快捷键 / 点右上角 × 才隐藏。`;
    };
    if (window.bridge.onHotkey) window.bridge.onHotkey(paint);
    if (window.bridge.getHotkey) window.bridge.getHotkey().then(paint).catch(() => {});
    badge.onclick = async () => {
      if (!window.bridge.retryHotkey) return;
      try {
        const r = await window.bridge.retryHotkey();
        if (r && r.status) paint(r.status);
        if (r && r.message) toast(r.message, !r.ok);
      } catch (e) {
        toast('重试快捷键失败：' + (e && e.message ? e.message : e), true);
      }
    };
  }

  async function init() {
    await initConfig();
    $('sessionLabel').textContent = '本次会话：' + state.sessionId;
    bind();
    setupLayout();
    setupHotkeyBadge();
    setupCustomers();
    applyConfirm();
    await loadAgents();
    checkWorkBuddy(false);
    loadLearnStats();
    refreshKbStatus();
    refreshImageStatus();
    // 浏览器版点完「重启程序」刷新回来后，给一句看得懂的交代
    try {
      const hint = sessionStorage.getItem('tcs_restart_hint');
      if (hint !== null) {
        sessionStorage.removeItem('tcs_restart_hint');
        setTimeout(() => toast(
          hint === '1'
            ? '已重新加载完成，后台服务连接正常'
            : '页面已重新加载，但后台服务没连上：请回到黑窗口重新选 1，或重新双击「一键启动.bat」',
          hint !== '1',
        ), 400);
      }
    } catch (_) {}
  }
  init();
})();
