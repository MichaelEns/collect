/*
 * The sharing panel.
 *
 * Kept apart from both app.js (which owns the collection) and sync.js (which
 * owns the wire) because it is neither: it is the small amount of screen a
 * grown-up touches once, during setup, and then never again.
 *
 * The wording avoids "account", "sign in" and "password", none of which exist
 * here. What does exist is four words on a sticky note.
 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  /*
   * Plain language, because the person reading a failure is either a child or
   * a parent in a hurry. "Not synced yet" beats "NetworkError", and being
   * offline is a normal state for this app rather than a fault.
   */
  const MESSAGES = {
    off: '',
    syncing: 'Saving…',
    ok: 'Everything is saved and shared.',
    offline: 'No connection just now — it will catch up on its own.',
    error: 'Could not reach sharing. Your collection is safe on this device.',
    'bad-code': 'That code was not recognised. Check the four words.',
  };

  function render() {
    const sync = window.CollectSync;
    if (!sync) return;
    const code = sync.getCode();
    const joining = !$('sync-join').hidden;

    $('sync-off').hidden = Boolean(code) || joining;
    $('sync-on').hidden = !code;
    if (code) {
      $('sync-code').textContent = code;
      $('sync-join').hidden = true;
    }

    const { status, detail, lastSyncAt } = sync.status();
    let text = MESSAGES[status] !== undefined ? MESSAGES[status] : detail;
    if (status === 'ok' && lastSyncAt) {
      const mins = Math.floor((Date.now() - lastSyncAt) / 60000);
      if (mins >= 1) text = `Last saved ${mins} minute${mins === 1 ? '' : 's'} ago.`;
    }
    const el = $('sync-status');
    el.textContent = text || '';
    el.className = 'sync-status' + (status === 'bad-code' || status === 'error' ? ' bad' : '');
  }

  function wire() {
    const sync = window.CollectSync;
    if (!sync) return;

    const busy = async (button, label, work) => {
      const was = button.textContent;
      button.disabled = true;
      button.textContent = label;
      try { await work(); } finally { button.disabled = false; button.textContent = was; render(); }
    };

    $('sync-start').addEventListener('click', (e) => busy(e.target, 'Turning on…', async () => {
      try { await sync.create(); } catch { /* status carries it */ }
    }));

    $('sync-join-open').addEventListener('click', () => {
      $('sync-join').hidden = false;
      $('sync-off').hidden = true;
      $('sync-code-input').focus();
    });

    $('sync-join-cancel').addEventListener('click', () => {
      $('sync-join').hidden = true;
      render();
    });

    $('sync-join-go').addEventListener('click', (e) => busy(e.target, 'Joining…', async () => {
      const ok = await sync.join($('sync-code-input').value);
      if (ok) { $('sync-code-input').value = ''; $('sync-join').hidden = true; }
    }));

    $('sync-code-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') $('sync-join-go').click();
    });

    $('sync-copy').addEventListener('click', async (event) => {
      try {
        await navigator.clipboard.writeText(sync.getCode());
        const button = event.target;
        button.textContent = 'Copied!';
        setTimeout(() => { button.textContent = 'Copy it'; }, 1500);
      } catch { /* clipboard refused; the code is on screen to read anyway */ }
    });

    $('sync-now').addEventListener('click', (e) => busy(e.target, 'Saving…', () => sync.syncNow()));

    $('sync-stop').addEventListener('click', () => {
      // Worth a confirm: the collection stays on this device, but the other
      // devices stop hearing about it, and that is not obvious from the button.
      const sure = window.confirm(
        'Stop sharing on this device?\n\n'
        + 'Your collection stays here. Other devices keep their own copy, and '
        + 'the two stop keeping up with each other.'
      );
      if (sure) sync.stop();
      render();
    });

    document.addEventListener('collect:sync-state', render);
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
}());
