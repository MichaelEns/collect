/*
 * Collection and sharing setup.
 *
 * A device may keep several independent collections. The active collection is
 * the only one the checklist edits, and switching never combines progress.
 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const collections = window.CollectCollections;

  const MESSAGES = {
    off: '',
    syncing: 'Saving…',
    ok: 'Everything is saved and shared.',
    offline: 'No connection just now — it will catch up on its own.',
    error: 'Could not reach sharing. Your collection is safe on this device.',
    'bad-code': 'That code was not recognised. Check the four words.',
  };

  let sharesTicket = 0;

  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      const previous = button.textContent;
      button.textContent = 'Copied!';
      setTimeout(() => { button.textContent = previous; }, 1500);
    } catch { /* the code remains visible */ }
  }

  function roleText(role) {
    if (role === 'owner') return 'Owner — can rename, share, and change everything.';
    if (role === 'contributor') return 'Contributor — can add finds and personal photos.';
    return 'View only — changes are disabled for this collection.';
  }

  function renderCollections() {
    const select = $('collection-select');
    const active = collections.active();
    const known = collections.all();
    select.innerHTML = '';
    for (const collection of known) {
      const option = document.createElement('option');
      option.value = collection.id;
      option.textContent = collection.name;
      option.selected = collection.id === active.id;
      select.appendChild(option);
    }
    $('collection-access').textContent = roleText(active.role);
    $('collection-remove').hidden = active.id === 'primary';
  }

  async function renderShares() {
    const sync = window.CollectSync;
    const active = collections.active();
    const host = $('sync-shares');
    const list = $('sync-share-list');
    host.hidden = active.role !== 'owner' || !active.code;
    list.innerHTML = '';
    if (host.hidden) return;

    const ticket = ++sharesTicket;
    let shares = [];
    try { shares = await sync.shares(); } catch { /* status explains network failures */ }
    if (ticket !== sharesTicket || active.id !== collections.activeId()) return;

    if (!shares.length) {
      const empty = document.createElement('li');
      empty.className = 'sync-hint';
      empty.textContent = 'No sharing codes yet.';
      list.appendChild(empty);
      return;
    }

    for (const share of shares) {
      const row = document.createElement('li');

      const code = document.createElement('button');
      code.type = 'button';
      code.className = 'sync-code';
      code.textContent = share.code;
      code.setAttribute('aria-label', `Copy ${share.role} sharing code`);
      code.addEventListener('click', () => copy(share.code, code));
      row.appendChild(code);

      const role = document.createElement('span');
      role.className = 'share-role';
      role.textContent = share.role === 'viewer'
        ? 'Can only view'
        : 'Can add and change finds';
      row.appendChild(role);

      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'link-button danger';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', async () => {
        if (!window.confirm(
          `Revoke ${share.code}?\n\nDevices using it will stop syncing. Their local copy stays.`,
        )) return;
        revoke.disabled = true;
        try {
          await sync.revokeShare(share.code);
          await renderShares();
        } finally {
          revoke.disabled = false;
        }
      });
      row.appendChild(revoke);
      list.appendChild(row);
    }
  }

  function render() {
    const sync = window.CollectSync;
    if (!sync) return;
    renderCollections();
    const active = collections.active();
    const code = sync.getCode();
    const joining = !$('sync-join').hidden;

    $('sync-title').textContent = `Keep ${active.name} safe`;
    $('sync-off').hidden = Boolean(code) || joining;
    $('sync-on').hidden = !code;
    if (code) {
      $('sync-code').textContent = code;
      $('sync-join').hidden = true;
      if (active.role === 'owner') {
        $('sync-code-label').textContent =
          'Your owner code — keep it private and use it to recover this collection:';
        $('sync-code-warning').textContent =
          'This owner code can rename, share, and fully change the collection.';
      } else {
        $('sync-code-label').textContent =
          `This device uses a ${active.role} sharing code:`;
        $('sync-code-warning').textContent = active.role === 'viewer'
          ? 'This code can see the collection but cannot change it.'
          : 'This code can add finds and personal photos but cannot manage sharing.';
      }
    }

    const { status, detail, lastSyncAt } = sync.status();
    let text = MESSAGES[status] !== undefined ? MESSAGES[status] : detail;
    if (status === 'ok' && lastSyncAt) {
      const minutes = Math.floor((Date.now() - lastSyncAt) / 60000);
      if (minutes >= 1) {
        text = `Last saved ${minutes} minute${minutes === 1 ? '' : 's'} ago.`;
      }
    }
    const statusElement = $('sync-status');
    statusElement.textContent = text || '';
    statusElement.className = 'sync-status' +
      (stateIsBad(sync.status().status) ? ' bad' : '');
    void renderShares();
  }

  function stateIsBad(status) {
    return status === 'bad-code' || status === 'error';
  }

  function wire() {
    const sync = window.CollectSync;
    if (!sync) return;

    const busy = async (button, label, work) => {
      const previous = button.textContent;
      button.disabled = true;
      button.textContent = label;
      try {
        await work();
      } finally {
        button.disabled = false;
        button.textContent = previous;
        render();
      }
    };

    $('collection-select').addEventListener('change', (event) => {
      sync.selectCollection(event.target.value);
      render();
    });

    $('collection-new').addEventListener('click', () => {
      const name = window.prompt(
        'What should this collection be called?',
        "Grandma's House",
      );
      if (!name || !name.trim()) return;
      sync.addLocal(name);
      render();
    });

    $('collection-rename').addEventListener('click', async (event) => {
      const active = collections.active();
      const name = window.prompt('Collection name:', active.name);
      if (!name || !name.trim() || name.trim() === active.name) return;
      await busy(event.target, 'Renaming…', () => sync.rename(name));
    });

    $('collection-add-open').addEventListener('click', () => {
      $('collection-add').hidden = false;
      $('collection-add-code').focus();
    });
    $('collection-add-cancel').addEventListener('click', () => {
      $('collection-add').hidden = true;
      $('collection-add-code').value = '';
    });
    $('collection-add-go').addEventListener('click', (event) =>
      busy(event.target, 'Adding…', async () => {
        if (await sync.add($('collection-add-code').value)) {
          $('collection-add').hidden = true;
          $('collection-add-code').value = '';
        }
      }));
    $('collection-add-code').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') $('collection-add-go').click();
    });

    $('collection-remove').addEventListener('click', () => {
      const active = collections.active();
      if (!window.confirm(
        `Remove ${active.name} from this device?\n\n` +
        'Its shared copy and copies on other devices are not deleted.',
      )) return;
      sync.removeActive();
      render();
    });

    $('sync-start').addEventListener('click', (event) =>
      busy(event.target, 'Turning on…', async () => {
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
    $('sync-join-go').addEventListener('click', (event) =>
      busy(event.target, 'Joining…', async () => {
        if (await sync.join($('sync-code-input').value)) {
          $('sync-code-input').value = '';
          $('sync-join').hidden = true;
        }
      }));
    $('sync-code-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') $('sync-join-go').click();
    });

    $('sync-copy').addEventListener('click', (event) =>
      copy(sync.getCode(), event.target));
    $('sync-now').addEventListener('click', (event) =>
      busy(event.target, 'Saving…', () => sync.syncNow()));
    $('sync-stop').addEventListener('click', () => {
      if (!window.confirm(
        'Stop sharing this collection on this device?\n\n' +
        'Its local progress stays here. Other devices keep their copies.',
      )) return;
      sync.stop();
      render();
    });

    $('sync-share-create').addEventListener('click', (event) =>
      busy(event.target, 'Making…', async () => {
        const share = await sync.createShare($('sync-share-role').value);
        await renderShares();
        if (share) {
          const role = share.role === 'viewer' ? 'view' : 'contribute';
          window.alert(
            `The ${role} code is:\n\n${share.code}\n\n` +
            'Tap the code in the list to copy it.',
          );
        }
      }));

    document.addEventListener('collect:sync-state', render);
    document.addEventListener('collect:collections-updated', renderCollections);
    document.addEventListener('collect:collection-changed', render);
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
}());
