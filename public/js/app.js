// Laqtine front-end: small, dependency-free progressive enhancement.
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

  // Enroll form: show the right hint for WhatsApp vs Telegram.
  $$('form').forEach((f) => {
    const radios = $$('input[name=channel][type=radio]', f);
    if (!radios.length) return;
    const sync = () => {
      const ch = radios.find((r) => r.checked)?.value || 'whatsapp';
      $$('[data-for-channel]', f).forEach((el) => (el.hidden = el.dataset.forChannel !== ch));
    };
    radios.forEach((r) => r.addEventListener('change', sync));
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

  // ---------- Cloudflare Stream: teacher uploads ----------
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };

  function watchStream(lessonId, onText) {
    const tick = async () => {
      try {
        const s = await api(`/teach/lessons/${lessonId}/stream/refresh`, {});
        if (s.state === 'ready') return location.reload();
        if (s.state === 'error') return onText(`Cloudflare couldn’t process this video${s.error ? ` (${s.error})` : ''}. Please upload it again.`, true);
        onText(s.state === 'uploading' ? 'Waiting for the upload to finish…' : `Preparing the video for streaming${s.pct ? ` — ${Math.round(s.pct)}%` : ''}…`);
      } catch (err) {
        onText(err.message, true);
      }
      setTimeout(tick, 5000);
    };
    tick();
  }

  $$('[data-stream-status]').forEach((box) => {
    if (box.dataset.state === 'error') return;
    watchStream(box.dataset.streamStatus, (t, bad) => {
      $('[data-stream-text]', box).textContent = t;
      box.classList.toggle('error', Boolean(bad));
      box.classList.toggle('info', !bad);
    });
  });

  $$('[data-stream-upload]').forEach((zone) => {
    const input = $('input[type=file]', zone);
    const wrap = $('[data-upload-progress]', zone);
    const bar = $('.progress > span', wrap);
    const text = $('[data-upload-text]', wrap);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 200 * 1024 * 1024) return toast('Videos can be up to 200 MB. Try exporting at 720p.', 'error');
      wrap.hidden = false;
      input.disabled = true;
      try {
        const { uploadURL } = await api(`/teach/lessons/${zone.dataset.streamUpload}/stream/upload`, {});
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', uploadURL);
          xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return;
            const pct = Math.round((e.loaded / e.total) * 100);
            bar.style.width = `${pct}%`;
            text.textContent = `Uploading… ${pct}%`;
          };
          xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
          xhr.onerror = () => reject(new Error('Upload failed — check your connection and try again.'));
          const fd = new FormData();
          fd.append('file', file);
          xhr.send(fd);
        });
        bar.style.width = '100%';
        watchStream(zone.dataset.streamUpload, (t, bad) => {
          text.textContent = t;
          if (bad) toast(t, 'error');
        });
      } catch (err) {
        wrap.hidden = true;
        input.disabled = false;
        toast(err.message, 'error');
      }
    });
  });

  // ---------- video player: adaptive streaming, speed, resume ----------
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function setupPlayer(wrap) {
    const video = $('video', wrap);
    const note = $('[data-player-note]', wrap);
    const saver = $('[data-datasaver]', wrap);
    let hls = null;

    // Adaptive streaming (HLS). Safari plays it natively; elsewhere hls.js does.
    const src = video.dataset.hls;
    if (src) {
      const maxH = Number(video.dataset.maxHeight) || 720;
      const capFor = () => (saver?.checked ? 360 : maxH);
      const applyCap = () => {
        if (!hls?.levels?.length) return;
        let idx = 0;
        hls.levels.forEach((l, i) => { if ((l.height || 0) <= capFor()) idx = i; });
        hls.autoLevelCapping = idx;
      };
      if (saver) saver.checked = store.get('laqtine.datasaver') === '1';
      if (window.Hls?.isSupported()) {
        // Start conservatively (about 0.5 Mbps) so playback begins fast on mobile data.
        hls = new window.Hls({ capLevelToPlayerSize: true, abrEwmaDefaultEstimate: 500000, maxBufferLength: 30 });
        hls.on(window.Hls.Events.MANIFEST_PARSED, applyCap);
        hls.on(window.Hls.Events.ERROR, (_, d) => {
          if (!d.fatal) return;
          if (d.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            note.textContent = 'Connection lost — retrying…';
            setTimeout(() => hls.startLoad(), 3000);
          } else if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        });
        hls.loadSource(src);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
        if (saver) saver.closest('label').hidden = true; // Safari picks the quality itself
      } else {
        note.textContent = 'This browser can’t play the video.';
      }
      saver?.addEventListener('change', () => {
        store.set('laqtine.datasaver', saver.checked ? '1' : '0');
        applyCap();
      });
    }

    // Playback speed, remembered across lessons.
    const speeds = $$('[data-speed]', wrap);
    const setSpeed = (v) => {
      video.playbackRate = v;
      speeds.forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === v));
      store.set('laqtine.speed', String(v));
    };
    speeds.forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.speed))));
    const saved = Number(store.get('laqtine.speed'));
    if (saved) {
      setSpeed(saved);
      video.addEventListener('loadedmetadata', () => (video.playbackRate = saved), { once: true });
    }

    // Resume where the student stopped, and keep saving their position.
    const lesson = wrap.dataset.lesson;
    if (!lesson) return;
    const resume = Number(wrap.dataset.resume) || 0;
    video.addEventListener(
      'loadedmetadata',
      () => {
        if (resume > 5 && resume < video.duration - 15) {
          video.currentTime = resume;
          note.innerHTML = `Resumed at ${fmtTime(resume)} · <button type="button" class="link-btn" data-restart>Start over</button>`;
          $('[data-restart]', note).addEventListener('click', () => {
            video.currentTime = 0;
            note.textContent = '';
          });
        }
      },
      { once: true }
    );
    let lastSent = -1;
    const save = (force) => {
      const t = Math.floor(video.currentTime || 0);
      if (!force && Math.abs(t - lastSent) < 10) return;
      lastSent = t;
      fetch(`/api/lessons/${lesson}/position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ seconds: t }),
        keepalive: true,
        credentials: 'same-origin',
      }).catch(() => {});
    };
    video.addEventListener('timeupdate', () => !video.paused && save(false));
    video.addEventListener('pause', () => save(true));
    window.addEventListener('pagehide', () => save(true));
  }
  // hls.js loads with `defer` after this file, so wait until every script has run.
  document.addEventListener('DOMContentLoaded', () => $$('[data-player]').forEach(setupPlayer));

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

  const chats = $$('[data-chat]').map((el) => ({ el, id: el.dataset.chat, channel: el.dataset.channel, initial: el.dataset.initialState, interactive: el.dataset.interactive === '1', last: 0, votes: new Map(), polls: [] }));

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
      // Telegram quizzes reveal the answer inside the poll itself; mirror that.
      const quiz = chat.channel === 'telegram' && chat.results?.[m.ref];
      const open = chat.interactive && !voted && !quiz && m.ref === current;
      const cls = (o, i) => (quiz ? (i === quiz.correctIndex ? ' right' : i === quiz.selected ? ' wrongpick' : '') : voted === o ? ' chosen' : '');
      el.innerHTML =
        `<div class="q">${fmt(m.body.name)}</div><div class="sel">${quiz ? 'Quiz' : 'Select one'}</div>` +
        m.body.options.map((o, i) => `<${open ? 'button type="button"' : 'div'} class="opt${cls(o, i)}" data-opt="${i}"><span class="radio"></span>${esc(o)}</${open ? 'button' : 'div'}>`).join('') +
        (quiz && quiz.explanation ? `<div class="quiz-ex">💡 ${esc(quiz.explanation)}</div>` : '') +
        `<span class="time">${time(m.created_at)}</span>`;
    }
    if (!body.children.length) body.innerHTML = '<div class="chat-empty">Your WhatsApp messages will appear here.</div>';
    if (messages.length) body.scrollTop = body.scrollHeight;
    if (state) {
      const waitText = chat.channel === 'telegram' ? 'Waiting for you to connect Telegram' : STATE_TEXT.awaiting_join;
      $('[data-chat-state]', chat.el).textContent = state.wa_error ? `${STATE_TEXT.error}: ${state.wa_error}` : state.wa_state === 'awaiting_join' ? waitText : STATE_TEXT[state.wa_state] || 'Live';
      // Just connected (e.g. pressed Start in Telegram): refresh the page banners.
      if (chat.initial === 'awaiting_join' && state.wa_state !== 'awaiting_join') location.reload();
    }
  }

  async function poll(chat) {
    try {
      const data = await api(`/api/enrollments/${chat.id}/messages?after=${chat.last}`);
      chat.results = data.results || {};
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
