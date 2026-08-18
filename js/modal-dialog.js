const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElements(container) {
  return [...container.querySelectorAll(FOCUSABLE)].filter((element) => (
    !element.hidden && element.getAttribute('aria-hidden') !== 'true'
  ));
}

/** Add background inertness, scroll lock, focus containment and restoration. */
export function activateModalDialog(overlay, { trigger = null, initialFocus = null, onEscape = null } = {}) {
  if (!(overlay instanceof HTMLElement)) return { release() {} };
  const dialog = overlay.matches('[role="dialog"]') ? overlay : overlay.querySelector('[role="dialog"]');
  const returnFocus = trigger instanceof HTMLElement ? trigger : document.activeElement;
  const background = [...document.body.children]
    .filter((element) => element !== overlay && element instanceof HTMLElement)
    .map((element) => ({
      element,
      inert: Boolean(element.inert),
      ariaHidden: element.getAttribute('aria-hidden'),
    }));
  background.forEach(({ element }) => {
    element.inert = true;
    element.setAttribute('aria-hidden', 'true');
  });
  document.body.classList.add('modal-open');
  let released = false;

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onEscape?.();
      return;
    }
    if (event.key !== 'Tab' || !dialog) return;
    const focusable = focusableElements(dialog);
    if (!focusable.length) {
      event.preventDefault();
      if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  overlay.addEventListener('keydown', onKeyDown);
  window.setTimeout(() => {
    if (released) return;
    const target = initialFocus instanceof HTMLElement ? initialFocus : focusableElements(dialog || overlay)[0] || dialog;
    target?.focus?.();
  }, 0);

  return {
    release({ restoreFocus = true } = {}) {
      if (released) return;
      released = true;
      overlay.removeEventListener('keydown', onKeyDown);
      background.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      });
      document.body.classList.remove('modal-open');
      if (restoreFocus && returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
    },
  };
}
