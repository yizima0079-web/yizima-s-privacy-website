(() => {
  const config = window.GUESTBOOK_CONFIG;
  const form = document.querySelector('#guestbook-form');
  if (!config?.url || !config?.anonKey || !form) return;

  const input = document.querySelector('#guestbook-input');
  const count = document.querySelector('#guestbook-count');
  const status = document.querySelector('#guestbook-status');
  const list = document.querySelector('#guestbook-list');
  const total = document.querySelector('#guestbook-total');
  const submit = form.querySelector('button[type="submit"]');
  const storageKey = 'yizima-guestbook-visitor-v1';
  const endpoint = `${config.url}/rest/v1`;
  const headers = { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}` };

  function visitorId() {
    try {
      let id = localStorage.getItem(storageKey);
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(storageKey, id);
      }
      return id;
    } catch {
      return crypto.randomUUID();
    }
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '刚刚';
    return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function setStatus(message, kind = '') {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function renderMessages(messages) {
    list.replaceChildren();
    total.textContent = `${messages.length} 张便签`;
    if (!messages.length) {
      const empty = document.createElement('p');
      empty.className = 'guestbook-empty';
      empty.textContent = '这里还空着。留一张便签，做第一个路过的人。';
      list.append(empty);
      return;
    }
    messages.forEach((message, index) => {
      const note = document.createElement('article');
      note.className = 'guestbook-note';
      note.style.setProperty('--note-turn', `${[-1.1, .7, -.45, 1.15, -.65][index % 5]}deg`);
      const content = document.createElement('p');
      content.textContent = message.content;
      const date = document.createElement('time');
      date.dateTime = message.created_at;
      date.textContent = formatDate(message.created_at);
      note.append(content, date);
      list.append(note);
    });
  }

  async function loadMessages() {
    list.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(`${endpoint}/guestbook_messages?select=id,content,created_at&order=created_at.desc&limit=40`, {
        headers,
        cache: 'no-store'
      });
      if (!response.ok) throw new Error('留言暂时没能加载，请稍后刷新。');
      const messages = await response.json();
      renderMessages(Array.isArray(messages) ? messages : []);
      if (status.dataset.kind === 'error') setStatus('请友善留言。每条留言最多 280 字，同一浏览器提交后需间隔 30 秒。');
    } catch (error) {
      total.textContent = '读取暂不可用';
      list.replaceChildren();
      const failed = document.createElement('p');
      failed.className = 'guestbook-empty';
      failed.textContent = '留言暂时没有连上，请稍后再试。';
      list.append(failed);
      setStatus(error.message || '留言暂时没能加载，请稍后刷新。', 'error');
    } finally {
      list.setAttribute('aria-busy', 'false');
    }
  }

  input.addEventListener('input', () => {
    count.textContent = `${[...input.value].length} / 280`;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const content = input.value.trim();
    if (!content || [...content].length > 280) {
      setStatus('留言请填写 1–280 个字。', 'error');
      input.focus();
      return;
    }
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    setStatus('正在贴上这张便签…');
    try {
      const response = await fetch(`${endpoint}/rpc/submit_guestbook_message`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ p_content: content, p_visitor_id: visitorId() })
      });
      if (response.status === 429) throw new Error('提交太快啦，稍等 30 秒再贴下一张。');
      if (!response.ok) {
        const detail = await response.text();
        if (detail.includes('rate_limited')) throw new Error('提交太快啦，稍等 30 秒再贴下一张。');
        if (detail.includes('invalid_content_length')) throw new Error('留言请控制在 1–280 个字。');
        throw new Error('便签没有贴上，请稍后再试。');
      }
      input.value = '';
      count.textContent = '0 / 280';
      setStatus('贴好啦，谢谢你留下这句话。', 'success');
      await loadMessages();
      setStatus('贴好啦，谢谢你留下这句话。', 'success');
    } catch (error) {
      setStatus(error.message || '便签没有贴上，请稍后再试。', 'error');
    } finally {
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
    }
  });

  loadMessages();
})();
