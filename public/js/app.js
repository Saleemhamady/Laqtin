// Laqtin front-end: small, dependency-free progressive enhancement.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const csrf = $('meta[name="csrf-token"]')?.content;
  const LETTERS = 'ABCDEFGHIJ';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  async function api(url, body) {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

  function toast(text, type = 'success') {
    $('[data-toast]')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    wrap.dataset.toast = '';
    wrap.innerHTML = `<div class="alert ${type}"><span>${esc(text)}</span></div>`;
    document.body.appendChild(wrap);
    setTimeout(() => wrap.remove(), 3500);
  }

  // ---------- chrome ----------
  setTimeout(() => $('[data-toast]')?.remove(), 4000);
  $('[data-toggle-nav]')?.addEventListener('click', () => $('#nav').classList.toggle('open'));
  document.addEventListener('click', (e) => {
    const menu = $('.user-menu[open]');
    if (menu && !menu.contains(e.target)) menu.removeAttribute('open');
  });
  document.addEventListener('submit', (e) => {
    const msg = e.target.dataset.confirm;
    if (msg && !confirm(msg)) e.preventDefault();
  });
  $$('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.submit()));

  // Signup: the WhatsApp number is required for learners.
  $$('[data-role-form]').forEach((form) => {
    const sync = () => {
      const role = form.querySelector('input[name=role]:checked')?.value || 'student';
      const tag = form.querySelector('[data-optional]');
      if (tag) tag.hidden = role === 'student';
    };
    form.addEventListener('change', sync);
    sync();
  });

  // File pickers show the chosen file and accept drag & drop.
  $$('[data-dropzone]').forEach((zone) => {
    const input = zone.querySelector('input[type=file]');
    const label = zone.querySelector('[data-file-label]');
    const show = () => {
      const f = input.files?.[0];
      if (f && label) label.innerHTML = `<span class="file-name">${esc(f.name)}</span> · ${(f.size / 1048576).toFixed(1)} MB`;
    };
    input.addEventListener('change', show);
    ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, () => zone.classList.remove('drag')));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; show(); }
    });
  });

  // Upload forms: disable the button and show progress text while big videos upload.
  $$('form[enctype="multipart/form-data"]').forEach((form) => {
    form.addEventListener('submit', () => {
      const hasFile = $$('input[type=file]', form).some((i) => i.files?.length);
      const btn = $('button.primary, button.secondary', form);
      if (btn) setTimeout(() => { btn.disabled = true; btn.textContent = hasFile ? 'Uploading…' : 'Saving…'; });
    });
  });

  // Open the collapsed section a link points to (e.g. #q-12 after saving a question).
  if (location.hash) {
    const target = document.getElementById(location.hash.slice(1));
    if (target?.tagName === 'DETAILS') target.open = true;
  }

  // ---------- question builder ----------
  $$('[data-builder]').forEach((form) => {
    const list = $('[data-options]', form);
    const addBtn = $('[data-add-option]', form);
    const pq = $('[data-preview-q]', form);
    const po = $('[data-preview-opts]', form);
    const prompt = $('[data-prompt]', form);

    const reindex = () => {
      const rows = $$('.opt-row', list);
      rows.forEach((row, i) => {
        $('input[type=radio]', row).value = i;
        $('input[type=text]', row).placeholder = `Option ${LETTERS[i]}`;
        $('[data-remove-option]', row).disabled = rows.length <= 2;
      });
      addBtn.disabled = rows.length >= 10;
      render();
    };
    const render = () => {
      pq.textContent = `❓ ${prompt.value.trim() || 'Your question'}`;
      po.innerHTML = $$('.opt-row', list)
        .map((row, i) => {
          const v = $('input[type=text]', row).value.trim();
          if (!v) return '';
          const chosen = $('input[type=radio]', row).checked ? ' chosen' : '';
          return `<div class="opt${chosen}"><span class="radio"></span>${LETTERS[i]}. ${esc(v)}</div>`;
        })
        .join('');
    };
    addBtn.addEventListener('click', () => {
      const row = $('.opt-row', list).cloneNode(true);
      $('input[type=text]', row).value = '';
      $('input[type=radio]', row).checked = false;
      list.appendChild(row);
      reindex();
      $('input[type=text]', row).focus();
    });
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove-option]');
      if (!btn) return;
      btn.closest('.opt-row').remove();
      reindex();
    });
    form.addEventListener('input', render);
    form.addEventListener('change', render);
    form.addEventListener('submit', (e) => {
      const rows = $$('.opt-row', list);
      const checked = rows.find((r) => $('input[type=radio]', r).checked);
      const filled = rows.filter((r) => $('input[type=text]', r).value.trim()).length;
      if (filled < 2) {
        e.preventDefault();
        toast('Add at least two answer options.', 'error');
      } else if (checked && !$('input[type=text]', checked).value.trim()) {
        e.preventDefault();
        toast('The correct answer can’t be empty.', 'error');
      }
    });
    reindex();
  });

  // ---------- lesson player ----------
  async function markWatched(lessonId) {
    try {
      await api(`/api/lessons/${lessonId}/watched`, {});
      $('[data-mark-watched]')?.remove();
      const badge = $('[data-watched-badge]');
      if (badge) badge.hidden = false;
      refreshChats();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  $('[data-mark-watched]')?.addEventListener('click', (e) => markWatched(e.currentTarget.dataset.markWatched));
  const tracked = $('video[data-track-watch]');
  const watchBtn = $('[data-mark-watched]');
  if (tracked && watchBtn) {
    let sent = false;
    const check = () => {
      if (sent || !tracked.duration) return;
      if (tracked.currentTime / tracked.duration >= 0.9) { sent = true; markWatched(watchBtn.dataset.markWatched); }
    };
    tracked.addEventListener('timeupdate', check);
    tracked.addEventListener('ended', check);
  }

  // ---------- practice questions ----------
  function attachmentHtml(r) {
    let html = '';
    const f = r.explanationFile;
    if (f) {
      if (f.kind === 'video') html += `<video src="${esc(f.url)}" controls playsinline preload="metadata"></video>`;
      else if (f.kind === 'html') html += `<iframe src="${esc(f.url)}" sandbox="allow-scripts allow-popups allow-forms" title="Explanation" loading="lazy"></iframe>`;
      else if (f.kind === 'image') html += `<img src="${esc(f.url)}" alt="Explanation">`;
      else if (f.kind === 'audio') html += `<audio src="${esc(f.url)}" controls style="width:100%"></audio>`;
      else html += `<a class="btn secondary sm" href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name || 'Open explanation')}</a>`;
    }
    const v = r.explanationEmbed;
    if (v) {
      if (v.type === 'youtube' || v.type === 'vimeo') html += `<div class="player" style="margin-top:8px"><iframe src="${esc(v.src)}" allowfullscreen loading="lazy" title="Explanation video"></iframe></div>`;
      else if (v.type === 'file') html += `<video src="${esc(v.src)}" controls playsinline preload="metadata" style="margin-top:8px"></video>`;
      else html += `<a class="btn secondary sm" href="${esc(v.src)}" target="_blank" rel="noopener" style="margin-top:8px">Open explanation</a>`;
    }
    return html ? `<div class="attach">${html}</div>` : '';
  }

  function showResult(box, r) {
    $$('.option', box).forEach((btn, i) => {
      btn.disabled = true;
      if (i === r.correctIndex) btn.classList.add('correct');
      else if (i === r.selected) btn.classList.add('wrong');
    });
    const fb = $('[data-feedback]', box);
    fb.hidden = false;
    fb.innerHTML =
      `<div class="verdict ${r.correct ? 'ok' : 'no'}">${r.correct ? 'Correct!' : `Not quite — the answer is ${LETTERS[r.correctIndex]}.`}</div>` +
      (r.explanation ? `<div>${esc(r.explanation)}</div>` : '') +
      attachmentHtml(r);
  }

  $$('[data-question]').forEach((box) => {
    box.addEventListener('click', async (e) => {
      const btn = e.target.closest('.option');
      if (!btn || btn.disabled) return;
      const index = Number(btn.dataset.index);
      if (box.hasAttribute('data-preview')) {
        const correctIndex = Number(box.dataset.correct);
        return showResult(box, { correct: index === correctIndex, correctIndex, selected: index, explanation: '(Explanation shows here)' });
      }
      $$('.option', box).forEach((b) => (b.disabled = true));
      try {
        showResult(box, await api(`/api/questions/${box.dataset.question}/answer`, { index }));
        refreshChats();
      } catch (err) {
        $$('.option', box).forEach((b) => (b.disabled = false));
        toast(err.message, 'error');
      }
    });
  });

  // ---------- WhatsApp conversation mirror ----------
  const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  const fmt = (s) => linkify(s).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  const time = (iso) => {
    const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const STATE_TEXT = {
    pending: 'Setting up your group…',
    awaiting_join: 'Waiting for you to join the group',
    awaiting_watch: 'Waiting for the lesson to be watched',
    quizzing: 'Waiting for your answer',
    done: 'Course complete 🎓',
    error: 'Delivery paused',
    stopped: 'Paused — resume anytime',
  };

  const chats = $$('[data-chat]').map((el) => ({ el, id: el.dataset.chat, interactive: el.dataset.interactive === '1', last: 0, votes: new Map(), polls: [] }));

  function render(chat, messages, state) {
    const body = $('[data-chat-body]', chat.el);
    if (chat.last === 0) body.innerHTML = '';
    for (const m of messages) {
      chat.last = Math.max(chat.last, m.id);
      if (m.kind === 'vote') {
        chat.votes.set(m.body.pollId, m.body.option);
        const el = document.createElement('div');
        el.className = 'msg in';
        el.innerHTML = `${esc(m.body.option)}<span class="time">${time(m.created_at)}</span>`;
        body.appendChild(el);
        continue;
      }
      const el = document.createElement('div');
      el.className = `msg ${m.direction === 'out' ? 'out' : 'in'}`;
      if (m.kind === 'video') {
        el.classList.add('media');
        el.innerHTML = `<video src="${esc(m.body.video)}" controls preload="none" playsinline></video><div class="cap">${fmt(m.body.caption)}<span class="time">${time(m.created_at)}</span></div>`;
      } else if (m.kind === 'poll') {
        el.classList.add('poll');
        el.dataset.pollMsg = m.id;
        el.dataset.ref = m.ref || '';
        el._poll = m;
        chat.polls.push(el);
      } else {
        el.innerHTML = `${fmt(m.body.text)}<span class="time">${time(m.created_at)}</span>`;
      }
      body.appendChild(el);
    }
    // (Re)draw polls so the chosen option and clickability stay current.
    const current = state && (state.wa_state === 'quizzing' ? `question:${state.current_question_id}` : state.wa_state === 'awaiting_watch' ? `watch:${state.current_lesson_id}` : null);
    for (const el of chat.polls) {
      const m = el._poll;
      const voted = chat.votes.get(m.external_id);
      const open = chat.interactive && !voted && m.ref === current;
      el.innerHTML =
        `<div class="q">${fmt(m.body.name)}</div><div class="sel">Select one</div>` +
        m.body.options.map((o, i) => `<${open ? 'button type="button"' : 'div'} class="opt${voted === o ? ' chosen' : ''}" data-opt="${i}"><span class="radio"></span>${esc(o)}</${open ? 'button' : 'div'}>`).join('') +
        `<span class="time">${time(m.created_at)}</span>`;
    }
    if (!body.children.length) body.innerHTML = '<div class="chat-empty">Your WhatsApp messages will appear here.</div>';
    if (messages.length) body.scrollTop = body.scrollHeight;
    if (state) $('[data-chat-state]', chat.el).textContent = state.wa_error ? `${STATE_TEXT.error}: ${state.wa_error}` : STATE_TEXT[state.wa_state] || 'Live';
  }

  async function poll(chat) {
    try {
      const data = await api(`/api/enrollments/${chat.id}/messages?after=${chat.last}`);
      render(chat, data.messages, data.state);
    } catch {
      /* offline — try again next tick */
    }
  }
  function refreshChats() {
    chats.forEach((c) => setTimeout(() => poll(c), 300));
  }
  chats.forEach((chat) => {
    chat.el.addEventListener('click', async (e) => {
      const opt = e.target.closest('button.opt');
      if (!opt) return;
      const pollEl = opt.closest('[data-poll-msg]');
      $$('button.opt', pollEl).forEach((b) => (b.disabled = true));
      opt.classList.add('chosen');
      try {
        await api(`/api/enrollments/${chat.id}/simulate-vote`, { messageId: Number(pollEl.dataset.pollMsg), optionIndex: Number(opt.dataset.opt) });
        setTimeout(() => poll(chat), 400);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    poll(chat);
    setInterval(() => document.visibilityState === 'visible' && poll(chat), 4000);
  });

  // ---------- admin: refresh when the WhatsApp link state changes ----------
  const wa = $('[data-wa-status]');
  if (wa && wa.dataset.waStatus !== 'ready') {
    setInterval(async () => {
      try {
        const s = await api('/admin/status.json');
        const img = $('.qr img', wa);
        if (s.state !== wa.dataset.waStatus || (s.qr && !img)) return location.reload();
        if (img && s.qr) img.src = s.qr;
      } catch {}
    }, 5000);
  }
})();
