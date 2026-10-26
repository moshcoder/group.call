// group.call: the one script. Copies text, keeps a room page live, follows a
// room pass checkout, and registers the service worker. Pages work without it.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]')
    if (!b) return
    try {
      await navigator.clipboard.writeText(b.dataset.copy)
      const was = b.textContent
      b.textContent = 'Copied'
      setTimeout(() => (b.textContent = was), 1500)
    } catch {}
  })

  // Who is on the line, as they come and go.
  const live = document.querySelector('[data-live]')
  if (live && 'EventSource' in window) {
    const people = live.querySelector('[data-people]')
    const count = live.querySelector('[data-count]')
    const log = live.querySelector('[data-log]')
    const time = (ms) => new Date(ms).toISOString().slice(11, 16)
    const source = new EventSource(live.dataset.live)
    source.addEventListener('room', (m) => {
      const e = JSON.parse(m.data)
      count.textContent = String(e.live.length)
      people.innerHTML = e.live.length
        ? e.live.map((p) => `<li class="${esc(p.kind)}"><span class="dot" aria-hidden="true"></span>${esc(p.name)} <span class="muted">${p.kind === 'agent' ? 'agent' : 'on the phone'}</span></li>`).join('')
        : '<li class="empty muted">Nobody on the line.</li>'
      if (e.type === 'hello') return
      const what = e.type === 'join' ? 'joined' : e.type === 'leave' ? 'left' : e.type === 'invite' ? esc(e.text) : `said: “${esc(e.text)}”`
      const li = document.createElement('li')
      li.innerHTML = `<span class="muted">${time(e.at)}</span> ${esc(e.who)} ${what}`
      if (log.children.length === 1 && log.firstElementChild.classList.contains('muted')) log.firstElementChild.remove()
      log.prepend(li)
    })
  }

  // A room pass checkout: wait for CoinPay to see the payment.
  const pass = document.querySelector('[data-pass]')
  if (pass && pass.dataset.status === 'pending') {
    const tick = async () => {
      try {
        const r = await fetch(pass.dataset.pass, { cache: 'no-store' })
        if (r.ok && (await r.json()).status !== 'pending') return location.reload()
      } catch {}
      setTimeout(tick, 5000)
    }
    setTimeout(tick, 5000)
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
})()
