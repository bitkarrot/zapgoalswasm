window.LNbitsBridge = (() => {
  let port = null
  let context = null
  let sequence = 0
  const pending = new Map()
  const listeners = new Set()
  const parentOrigin = (() => {
    try { return new URL(document.referrer).origin } catch (_) { return location.origin }
  })()

  function handle(message) {
    if (!message) return
    if (message.type === 'lnbits-extension:event') {
      listeners.forEach(listener => listener(message))
      return
    }
    if (message.type !== 'lnbits-extension:response') return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    message.ok ? request.resolve(message.data) : request.reject(new Error(message.error || 'Bridge request failed'))
  }

  function request(action, data = {}) {
    return new Promise((resolve, reject) => {
      if (!port) return reject(new Error('Bridge not connected'))
      const id = `zg-${++sequence}`
      pending.set(id, {resolve, reject})
      port.postMessage({type: 'lnbits-extension:request', id, action, ...data})
    })
  }

  function connect() {
    if (port) return Promise.resolve(context)
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => reject(new Error('Bridge connection timeout')), 10000)
      channel.port1.onmessage = event => {
        const message = event.data || {}
        if (message.type !== 'lnbits-extension:connected') return handle(message)
        clearTimeout(timer)
        port = channel.port1
        port.onmessage = event => handle(event.data)
        request('context').then(value => { context = value; resolve(value) }).catch(reject)
      }
      parent.postMessage({type: 'lnbits-extension:connect', id: `connect-${++sequence}`}, parentOrigin, [channel.port2])
    })
  }

  return {
    connect,
    context: () => context,
    callApi: (method, path, body) => request('api', {method: method.toUpperCase(), path, body}),
    notify: (message, type = 'info') => request('ui.notify', {message, type}),
    openInNewTab: url => request('navigation.open_new_tab', {url}),
    replaceRoute: path => request('navigation.replace', {path}),
    subscribePayment: (paymentHash, subscriptionId) => request('payment.subscribe', {paymentHash, subscriptionId}),
    unsubscribePayment: subscriptionId => request('payment.unsubscribe', {subscriptionId}),
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) }
  }
})()
