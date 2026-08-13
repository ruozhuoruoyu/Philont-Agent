const traceItems = [...document.querySelectorAll('.trace li')];
let stage = 1;

function advanceTrace() {
  stage = stage % traceItems.length + 1;
  traceItems.forEach((item, index) => {
    item.classList.toggle('done', index < stage - 1);
    item.classList.toggle('active', index === stage - 1);
    const state = item.querySelector(':scope > i');
    if (state) state.textContent = index < stage - 1 ? '✓' : '';
  });
  const ledger = document.querySelector('.ledger code');
  if (ledger) {
    const messages = [
      'pursuit checkpoint restored',
      'plan coverage under review',
      'grant scoped to pursuit-17',
      'tool result appended to ledger',
      'completion claim checked',
    ];
    ledger.lastChild.textContent = ` ${messages[stage - 1]}`;
  }
}

if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  window.setInterval(advanceTrace, 2200);
}

const copyButton = document.querySelector('[data-copy]');
copyButton?.addEventListener('click', async () => {
  const commands = 'git clone https://github.com/ruozhuoruoyu/Philont-Agent.git\ncd Philont-Agent\n./scripts/start.sh';
  const status = document.querySelector('[data-copy-status]');
  try {
    await navigator.clipboard.writeText(commands);
    copyButton.textContent = 'COPIED';
    if (status) status.textContent = 'Commands copied to clipboard.';
  } catch {
    if (status) status.textContent = 'Copy unavailable; select the commands manually.';
  }
  window.setTimeout(() => { copyButton.textContent = 'COPY'; }, 1800);
});
