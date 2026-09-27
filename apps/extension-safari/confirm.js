const params = new URLSearchParams(location.search);
const requestId = params.get('requestId');
document.getElementById('title').textContent = params.get('title') || '(untitled tab)';
document.getElementById('url').textContent = params.get('url') || '';

function respond(allow) {
  browser.runtime.sendMessage({ type: 'borrow-confirm-result', requestId, allow }).finally(() => window.close());
}
document.getElementById('allow').onclick = () => respond(true);
document.getElementById('deny').onclick = () => respond(false);
